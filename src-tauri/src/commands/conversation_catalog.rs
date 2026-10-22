//! Internal catalog reads. The native owner retires results from replaced pools.
use super::{conversation_content::error, CommandResult, DbPool};
use crate::db::{models::*, repository};
use tauri::State;

fn check_owner(
    owner: &DbPool,
    ready: &crate::core::db_state::DbReady,
    expected: bool,
) -> CommandResult<()> {
    if !owner.catalog_is_current(ready) {
        return Err(super::command_error(if expected {
            "stale_revision"
        } else {
            "unavailable"
        }));
    }
    Ok(())
}
pub(crate) async fn version(
    owner: &DbPool,
    input: ConversationCatalogVersionInput,
) -> CommandResult<ConversationCatalogToken> {
    let ready = owner.wait_until_ready_context().await?;
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
    let ready = owner.wait_until_ready_context().await?;
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
                owner.set_ready(pool.clone());
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
                    "replace" => owner.set_ready(pool.clone()),
                    "initializing" => owner.set_initializing(),
                    _ => owner.set_failed("synthetic"),
                }
                probe.catalog_release.store(true, SeqCst);
                assert_eq!(task.await.unwrap().unwrap_err().message, "stale_revision");
                owner.set_ready(pool.clone());
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
