use super::*;

#[tokio::test]
async fn schema_change_before_begin_refuses_without_retention() {
    let (_dir, pool, capture, _clock) = capture_fixture().await;
    sqlx::query("INSERT INTO conversation_citations(id,conversation_id,message_id,type,scope,source,title,content,created_at,updated_at) VALUES('citation','s','m','document','context','synthetic','Source','before','t','t')")
        .execute(&pool).await.unwrap();
    sqlx::query("DROP TRIGGER e_source_version_conversation_citations_update")
        .execute(&pool)
        .await
        .unwrap();
    let capture_id = capture
        .authority
        .as_ref()
        .unwrap()
        .read()
        .await
        .capture_id
        .clone();
    let result = capture
        .begin(&json(&Open {
            capture_id,
            conversation_id: "s".into(),
        }))
        .await;
    let retained: (i64, i64) = sqlx::query_as(
        "SELECT (SELECT COUNT(*) FROM e_source_captures),(SELECT COUNT(*) FROM e_inactive_domain)",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(
        result.is_err(),
        "begin accepted schema changed since Ready; retained journal/domain={retained:?}"
    );
    assert_eq!(retained, (0, 0));
}

async fn charges(pool: &SqlitePool) -> (i64, i64, i64, i64) {
    sqlx::query_as("SELECT (SELECT COUNT(*) FROM e_source_captures),(SELECT COALESCE(SUM(revision),0) FROM e_source_captures),(SELECT COALESCE(SUM(charge_bytes),0) FROM e_source_captures),(SELECT COUNT(*) FROM e_source_fragments)")
        .fetch_one(pool).await.unwrap()
}

#[tokio::test]
async fn valid_ddl_requires_new_opening_before_retries_or_admissions() {
    let (_dir, pool, capture, clock) = capture_fixture().await;
    let initial = begin(&capture).await;
    let request = json(&Copy {
        cursor: initial.cursor,
        expected_revision: initial.revision,
    });
    capture.copy_next(&request).await.unwrap();
    let before = charges(&pool).await;
    sqlx::query("CREATE TABLE unrelated_schema_change(value INTEGER)")
        .execute(&pool)
        .await
        .unwrap();
    let open = json(&Open {
        capture_id: initial.capture_id.clone(),
        conversation_id: "s".into(),
    });
    assert_eq!(capture.begin(&open).await.unwrap_err(), "stale_revision");
    assert_eq!(
        capture.copy_next(&request).await.unwrap_err(),
        "stale_revision"
    );
    assert_eq!(capture.seal_raw().await.unwrap_err(), "stale_revision");
    assert_eq!(capture.status().await.unwrap_err(), "stale_revision");
    assert_eq!(
        capture.readback(None, 1).await.unwrap_err(),
        "stale_revision"
    );
    assert_eq!(
        capture.readback_relations(None, 1).await.unwrap_err(),
        "stale_revision"
    );
    assert_eq!(capture.abort().await.unwrap_err(), "stale_revision");
    assert_eq!(capture.expire().await.unwrap_err(), "stale_revision");
    assert_eq!(charges(&pool).await, before);
    capture.owner.set_ready(pool.clone()).await.unwrap();
    assert!(capture.status().await.is_err());
    let new = authorized(
        capture.owner.clone(),
        uuid::Uuid::new_v4().to_string(),
        Mode::Continue,
        clock.clone(),
    )
    .await;
    begin(&new).await;
    let recovery = authorized(
        capture.owner.clone(),
        initial.capture_id,
        Mode::Recovery,
        clock,
    )
    .await;
    assert!(recovery.abort().await.is_ok());
}

#[tokio::test]
async fn publication_validates_arbitrary_pool_and_all_relevant_namespaces_without_repair() {
    let empty = sqlx::sqlite::SqlitePoolOptions::new()
        .min_connections(0)
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    let owner = DbPool::default();
    assert!(owner.set_ready(empty.clone()).await.is_err());
    assert!(matches!(owner.current(), DbInitializationState::Failed(_)));
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM sqlite_master")
            .fetch_one(&empty)
            .await
            .unwrap(),
        0
    );
    for mutation in [
        "DROP TRIGGER content_versions_messages_update",
        "DROP TRIGGER catalog_version_conversations_update",
        "DROP TRIGGER e_source_version_conversation_citations_update",
        "DELETE FROM schema_migrations WHERE version=13",
        "UPDATE schema_migrations SET name='wrong' WHERE version=14",
        "DELETE FROM schema_migrations WHERE version=15",
        "UPDATE schema_migrations SET name='wrong' WHERE version=16",
    ] {
        let (_dir, pool, capture, _clock) = capture_fixture().await;
        sqlx::query(mutation).execute(&pool).await.unwrap();
        let before: Vec<(String, Option<String>)> =
            sqlx::query_as("SELECT name,sql FROM sqlite_master ORDER BY name")
                .fetch_all(&pool)
                .await
                .unwrap();
        let stamps: Vec<(i64, String)> =
            sqlx::query_as("SELECT version,name FROM schema_migrations ORDER BY version")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert!(
            capture.owner.set_ready(pool.clone()).await.is_err(),
            "accepted {mutation}"
        );
        assert!(matches!(
            capture.owner.current(),
            DbInitializationState::Failed(_)
        ));
        assert_eq!(
            sqlx::query_as::<_, (String, Option<String>)>(
                "SELECT name,sql FROM sqlite_master ORDER BY name"
            )
            .fetch_all(&pool)
            .await
            .unwrap(),
            before
        );
        assert_eq!(
            sqlx::query_as::<_, (i64, String)>(
                "SELECT version,name FROM schema_migrations ORDER BY version"
            )
            .fetch_all(&pool)
            .await
            .unwrap(),
            stamps
        );
        assert_eq!(charges(&pool).await, (0, 0, 0, 0));
    }
}

#[tokio::test]
async fn sealed_read_uses_current_opening_while_preserving_historical_binding() {
    let (dir, pool, capture, clock) = capture_fixture().await;
    begin(&capture).await;
    copy_all(&capture).await;
    let sealed = capture.seal_raw().await.unwrap();
    sqlx::query("CREATE TABLE unrelated_schema_change(value INTEGER)")
        .execute(&pool)
        .await
        .unwrap();
    let before = charges(&pool).await;
    assert_eq!(capture.seal_raw().await.unwrap_err(), "stale_revision");
    assert_eq!(
        capture.readback(None, 32).await.unwrap_err(),
        "stale_revision"
    );
    assert_eq!(charges(&pool).await, before);
    capture.owner.set_initializing().await;
    pool.close().await;
    let reopened = create_pool(&dir.path().join("source.db")).await.unwrap();
    capture.owner.set_ready(reopened.clone()).await.unwrap();
    assert!(capture.readback(None, 32).await.is_err());
    let reader = authorized(
        capture.owner.clone(),
        sealed.receipt.capture_id,
        Mode::SealedRead,
        clock.clone(),
    )
    .await;
    let page = reader.readback(None, 32).await.unwrap();
    assert_eq!(page.binding, sealed.binding);
    assert_eq!(page.manifest.unwrap(), sealed.manifest);
    assert_ne!(
        schema(&mut *reopened.acquire().await.unwrap())
            .await
            .unwrap(),
        page.binding.schema
    );
    assert_eq!(charges(&reopened).await, before);
    capture.owner.set_initializing().await;
    sqlx::query("DROP TRIGGER e_source_version_conversation_citations_update")
        .execute(&reopened)
        .await
        .unwrap();
    reopened.close().await;
    assert!(create_pool(&dir.path().join("source.db")).await.is_err());
    // A raw pool bypassing create_pool must still fail the Ready boundary.
    let raw = sqlx::sqlite::SqlitePoolOptions::new()
        .min_connections(0)
        .max_connections(1)
        .connect_with(
            sqlx::sqlite::SqliteConnectOptions::new().filename(dir.path().join("source.db")),
        )
        .await
        .unwrap();
    assert!(capture.owner.set_ready(raw.clone()).await.is_err());
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT COUNT(*) FROM sqlite_master WHERE name='e_source_version_conversation_citations_update'").fetch_one(&raw).await.unwrap(), 0);
}
