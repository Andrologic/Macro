//! Internal catalog reads. The native owner retires results from replaced pools.
use super::{conversation_content::error, CommandResult, DbPool};
use crate::db::{models::*, repository};
use tauri::State;

fn owner_error(expected: bool) -> super::CommandError {
    super::command_error(if expected {
        "stale_revision"
    } else {
        "unavailable"
    })
}
fn check_owner(
    owner: &DbPool,
    ready: &crate::core::db_state::DbReady,
    expected: bool,
) -> CommandResult<()> {
    if !owner.catalog_is_current(ready) {
        return Err(owner_error(expected));
    }
    Ok(())
}
pub(crate) async fn version(
    owner: &DbPool,
    input: ConversationCatalogVersionInput,
) -> CommandResult<ConversationCatalogToken> {
    // Initialization details remain in DbPool diagnostics, never in catalog IPC.
    let ready = owner
        .wait_until_ready_context()
        .await
        .map_err(|_| owner_error(input.expected_token.is_some()))?;
    check_owner(owner, &ready, input.expected_token.is_some())?;
    let result =
        repository::conversation_catalog_version(&ready.pool, &ready.catalog_generation, &input)
            .await;
    check_owner(owner, &ready, input.expected_token.is_some())?;
    result.map_err(error)
}
pub(crate) async fn page(
    owner: &DbPool,
    input: ConversationCatalogPageInput,
) -> CommandResult<ConversationCatalogPage> {
    // Initialization details remain in DbPool diagnostics, never in catalog IPC.
    let ready = owner
        .wait_until_ready_context()
        .await
        .map_err(|_| owner_error(input.expected_token.is_some()))?;
    check_owner(owner, &ready, input.expected_token.is_some())?;
    let result =
        repository::conversation_catalog_page(&ready.pool, &ready.catalog_generation, &input).await;
    check_owner(owner, &ready, input.expected_token.is_some())?;
    result.map_err(error)
}
#[tauri::command]
pub async fn db_conversation_catalog_version(
    pool: State<'_, DbPool>,
    input: ConversationCatalogVersionInput,
) -> CommandResult<ConversationCatalogToken> {
    version(&pool, input).await
}
#[tauri::command]
pub async fn db_conversation_catalog_page(
    pool: State<'_, DbPool>,
    input: ConversationCatalogPageInput,
) -> CommandResult<ConversationCatalogPage> {
    page(&pool, input).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::conversation_content::tests::probe_pool;
    use std::sync::atomic::Ordering::SeqCst;
    async fn read_catalog(
        owner: &DbPool,
        read_page: bool,
        expected: bool,
    ) -> CommandResult<ConversationCatalogToken> {
        let expected_token = expected.then(|| ConversationCatalogToken {
            version: 1,
            generation: "0".repeat(32),
            incarnation: "1".repeat(32),
            revision: "0".into(),
        });
        if read_page {
            page(
                owner,
                ConversationCatalogPageInput {
                    expected_token,
                    after: None,
                    limit: 100,
                },
            )
            .await
            .map(|page| page.token)
        } else {
            version(owner, ConversationCatalogVersionInput { expected_token }).await
        }
    }
    fn bounded_owner_error(result: CommandResult<ConversationCatalogToken>, expected: bool) {
        let Err(error) = result else {
            panic!("unavailable owner returned a catalog token")
        };
        let code = if expected {
            "stale_revision"
        } else {
            "unavailable"
        };
        // Check length first so regressions never print the unbounded diagnostic.
        assert_eq!(error.message.len(), code.len());
        assert_eq!(error.message, code);
        assert!(serde_json::to_vec(&error).unwrap().len() <= 64);
    }
    #[tokio::test]
    async fn failed_owner_before_call_has_bounded_catalog_errors_and_keeps_diagnostic() {
        let owner = DbPool::default();
        let diagnostic = "synthetic-initialization-detail".repeat(200_000);
        assert_eq!(diagnostic.len(), 6_200_000);
        owner.set_failed(diagnostic.clone()).await;
        for read_page in [false, true] {
            for expected in [false, true] {
                bounded_owner_error(read_catalog(&owner, read_page, expected).await, expected);
            }
        }
        assert!(
            matches!(owner.current(), super::super::DbInitializationState::Failed(message) if message == diagnostic)
        );
        let generic = owner.wait_until_ready_context().await.unwrap_err();
        assert_eq!(generic.message.len(), diagnostic.len() + 32);
        assert!(generic.message.ends_with(&diagnostic));
    }
    #[tokio::test]
    async fn failed_owner_during_wait_has_bounded_catalog_errors() {
        use std::future::{poll_fn, Future};
        use std::task::Poll;
        for read_page in [false, true] {
            for expected in [false, true] {
                let owner = DbPool::default();
                let request = read_catalog(&owner, read_page, expected);
                tokio::pin!(request);
                assert!(poll_fn(|cx| Poll::Ready(request.as_mut().poll(cx).is_pending())).await);
                owner
                    .set_failed("synthetic-initialization-detail".repeat(200_000))
                    .await;
                bounded_owner_error(request.await, expected);
            }
        }
    }
    #[tokio::test]
    async fn initializing_owner_timeout_has_bounded_catalog_errors() {
        let owner = DbPool::default();
        let start = tokio::time::Instant::now();
        // test-util is not enabled. All four unchanged 15s waits run concurrently.
        futures::future::join_all((0..4).map(|case| {
            let owner = &owner;
            async move {
                let expected = case % 2 == 1;
                bounded_owner_error(read_catalog(owner, case >= 2, expected).await, expected);
            }
        }))
        .await;
        assert!(start.elapsed() >= std::time::Duration::from_secs(15));
        assert!(matches!(
            owner.current(),
            super::super::DbInitializationState::Initializing
        ));
    }
    #[tokio::test]
    async fn generations_are_atomic_and_pending_results_are_retired() {
        for action in ["replace", "initializing", "failed"] {
            for read_page in [false, true] {
                let dir = tempfile::tempdir().unwrap();
                let pool = crate::db::create_pool(&dir.path().join("synthetic.db"))
                    .await
                    .unwrap();
                sqlx::query("INSERT INTO conversations(id,title,created_at,updated_at) VALUES ('a','A','x','x')").execute(&pool).await.unwrap();
                pool.close().await;
                let (pool, probe) = probe_pool(&dir).await;
                let owner = DbPool::default();
                owner.set_ready(pool.clone()).await;
                let token = version(&owner, ConversationCatalogVersionInput::default())
                    .await
                    .unwrap();
                assert_eq!(
                    token.generation,
                    owner
                        .wait_until_ready_context()
                        .await
                        .unwrap()
                        .catalog_generation
                );
                probe.catalog_pause.store(true, SeqCst);
                let task_owner = owner.clone();
                let expected = token.clone();
                let task = tokio::spawn(async move {
                    if read_page {
                        page(
                            &task_owner,
                            ConversationCatalogPageInput {
                                expected_token: Some(expected),
                                after: None,
                                limit: 100,
                            },
                        )
                        .await
                        .map(|p| p.token)
                    } else {
                        version(
                            &task_owner,
                            ConversationCatalogVersionInput {
                                expected_token: Some(expected),
                            },
                        )
                        .await
                    }
                });
                tokio::time::timeout(std::time::Duration::from_secs(2), async {
                    while !probe.catalog_started.load(SeqCst) {
                        tokio::time::sleep(std::time::Duration::from_millis(1)).await;
                    }
                })
                .await
                .unwrap();
                match action {
                    "replace" => owner.set_ready(pool.clone()).await,
                    "initializing" => owner.set_initializing().await,
                    _ => owner.set_failed("synthetic").await,
                }
                probe.catalog_release.store(true, SeqCst);
                assert_eq!(task.await.unwrap().unwrap_err().message, "stale_revision");
                owner.set_ready(pool.clone()).await;
                let next = version(&owner, ConversationCatalogVersionInput::default())
                    .await
                    .unwrap();
                assert_eq!(next.incarnation, token.incarnation);
                assert_eq!(next.revision, token.revision);
                assert_ne!(next.generation, token.generation);
                assert_eq!(
                    version(
                        &owner,
                        ConversationCatalogVersionInput {
                            expected_token: Some(token)
                        }
                    )
                    .await
                    .unwrap_err()
                    .message,
                    "stale_revision"
                );
                pool.close().await;
            }
        }
    }
}
