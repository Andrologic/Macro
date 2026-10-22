use super::*;
use sqlx::Connection;
use tempfile::TempDir;

async fn fixture(path: &Path, stamped: bool) -> SqliteConnection {
    let mut connection = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true),
    )
    .await
    .unwrap();
    sqlx::raw_sql(include_str!("fixtures/pre_versioned.sql"))
        .execute(&mut connection)
        .await
        .unwrap();
    if stamped {
        ensure_schema_migrations_table(&mut connection)
            .await
            .unwrap();
        stamp_migration(&mut connection, 1, MIGRATION_001_NAME.into())
            .await
            .unwrap();
        stamp_migration(
            &mut connection,
            2,
            "002_disable_unconfigured_default_providers".into(),
        )
        .await
        .unwrap();
        apply_migration(
            &mut connection,
            3,
            MIGRATION_003_NAME.into(),
            MIGRATION_003_SQL.into(),
        )
        .await
        .unwrap();
        apply_migration(
            &mut connection,
            4,
            MIGRATION_004_NAME.into(),
            MIGRATION_004_SQL.into(),
        )
        .await
        .unwrap();
    }
    connection
}

async fn drop_visible_search(connection: &mut SqliteConnection) {
    sqlx::raw_sql(
        "DROP TRIGGER messages_search_insert;
         DROP TRIGGER messages_search_delete;
         DROP TRIGGER messages_search_update;
         DROP TRIGGER messages_search_update_insert;
         DROP TABLE message_search;
         DROP VIEW message_search_content;
         DELETE FROM schema_migrations WHERE version = 15;",
    )
    .execute(&mut *connection)
    .await
    .unwrap();
    sqlx::raw_sql(MIGRATION_004_SQL)
        .execute(&mut *connection)
        .await
        .unwrap();
}

/// Tables added after v11 are removed first so older migrations can replay.
const POST_V9_ENGINE_TABLES: [&str; 7] = [
    "DROP TABLE engine_effect_processes",
    "DROP TABLE engine_ui_intents",
    "DROP TABLE engine_prepared_terminals",
    "DROP TABLE engine_approvals",
    "DROP TABLE engine_host_captures",
    "DROP TABLE engine_response_closures",
    "DROP TABLE engine_responses",
];

async fn drop_v9(connection: &mut SqliteConnection) {
    drop_visible_search(connection).await;
    for statement in POST_V9_ENGINE_TABLES.iter().copied().chain([
        "DROP TABLE engine_events",
        "DROP TABLE engine_effects",
        "DROP TABLE engine_deliveries",
        "DROP TABLE engine_systems",
        "DROP TRIGGER tool_result_requires_completion_insert",
        "DROP TRIGGER tool_result_requires_completion_update",
        "ALTER TABLE tool_invocations DROP COLUMN result_json",
        "DELETE FROM schema_migrations WHERE version >= 10",
    ]) {
        sqlx::query(statement)
            .execute(&mut *connection)
            .await
            .unwrap();
    }

    sqlx::query("DROP TRIGGER conversation_goal_audit_run_status")
        .execute(&mut *connection)
        .await
        .unwrap();
    for statement in [
        "DROP TABLE conversation_goal_audit_runs",
        "DROP TABLE conversation_goal_audits",
        "DROP TABLE conversation_goals",
    ] {
        sqlx::query(statement)
            .execute(&mut *connection)
            .await
            .unwrap();
    }
    sqlx::query("DELETE FROM schema_migrations WHERE version = 9")
        .execute(&mut *connection)
        .await
        .unwrap();
}

async fn schema(connection: &mut SqliteConnection) -> Vec<(String, String, Option<String>)> {
    sqlx::query_as("SELECT type, name, sql FROM sqlite_master ORDER BY type, name")
        .fetch_all(connection)
        .await
        .unwrap()
}

async fn assert_preserved(connection: &mut SqliteConnection) {
    let message: (String, String, String) =
        sqlx::query_as("SELECT content, timestamp, created_at FROM messages WHERE id = 'message'")
            .fetch_one(&mut *connection)
            .await
            .unwrap();
    assert_eq!(
        message,
        (
            "Original message".into(),
            "2025-01-01".into(),
            "2025-01-01".into()
        )
    );
    let notes: Vec<String> = sqlx::query_scalar("SELECT value FROM fixture_notes")
        .fetch_all(&mut *connection)
        .await
        .unwrap();
    assert_eq!(notes, ["message"]);
    assert!(sqlx::query("INSERT INTO fixture_notes VALUES ('')")
        .execute(&mut *connection)
        .await
        .is_err());
    assert!(sqlx::query("INSERT INTO messages (id, conversation_id, role, content, timestamp) VALUES ('duplicate', 'conversation', 'user', 'Original message', '2025-01-01')")
        .execute(&mut *connection).await.is_err());
    assert!(sqlx::query("PRAGMA foreign_key_check")
        .fetch_optional(&mut *connection)
        .await
        .unwrap()
        .is_none());
    let found: String = sqlx::query_scalar(
        "SELECT content FROM message_search WHERE message_search MATCH 'Original'",
    )
    .fetch_one(&mut *connection)
    .await
    .unwrap();
    assert_eq!(found, "Original message");
}

#[tokio::test]
async fn adopts_unversioned_and_repairs_stamped_partial_schemas_once() {
    for stamped in [false, true] {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("fixture.db");
        let mut old = fixture(&path, stamped).await;
        let original_objects: Vec<_> = schema(&mut old)
            .await
            .into_iter()
            .filter(|(_, name, _)| name.starts_with("fixture_"))
            .collect();
        old.close().await.unwrap();
        let pool = create_pool(&path).await.unwrap();
        let mut connection = pool.acquire().await.unwrap();
        assert_preserved(&mut connection).await;
        assert_eq!(
            schema(&mut connection)
                .await
                .into_iter()
                .filter(|(_, name, _)| name.starts_with("fixture_"))
                .collect::<Vec<_>>(),
            original_objects
        );
        let versions = list_applied_migrations(&mut connection).await.unwrap();
        assert!(versions.contains(&5));
        assert_eq!(versions.contains(&2), stamped);
        let before = schema(&mut connection).await;
        let stamps: Vec<(i64, String)> =
            sqlx::query_as("SELECT version, applied_at FROM schema_migrations ORDER BY version")
                .fetch_all(&mut *connection)
                .await
                .unwrap();
        drop(connection);
        pool.close().await;
        let reopened = create_pool(&path).await.unwrap();
        let mut connection = reopened.acquire().await.unwrap();
        assert_preserved(&mut connection).await;
        assert_eq!(schema(&mut connection).await, before);
        assert_eq!(
            sqlx::query_as::<_, (i64, String)>(
                "SELECT version, applied_at FROM schema_migrations ORDER BY version"
            )
            .fetch_all(&mut *connection)
            .await
            .unwrap(),
            stamps
        );
        sqlx::query("DELETE FROM conversations WHERE id = 'conversation'")
            .execute(&mut *connection)
            .await
            .unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT count(*) FROM messages")
                .fetch_one(&mut *connection)
                .await
                .unwrap(),
            0
        );
    }
}

// Use SQLite's authorizer to catch attempted DDL, including CREATE IF NOT EXISTS
// which would leave schema_version unchanged. The callback borrows no Rust data.
type Authorizer = unsafe extern "C" fn(
    *mut std::ffi::c_void,
    i32,
    *const std::ffi::c_char,
    *const std::ffi::c_char,
    *const std::ffi::c_char,
    *const std::ffi::c_char,
) -> i32;
unsafe extern "C" {
    fn sqlite3_set_authorizer(
        db: *mut std::ffi::c_void,
        callback: Option<Authorizer>,
        context: *mut std::ffi::c_void,
    ) -> i32;
}
unsafe extern "C" fn deny_schema_work(
    _: *mut std::ffi::c_void,
    action: i32,
    _: *const std::ffi::c_char,
    _: *const std::ffi::c_char,
    _: *const std::ffi::c_char,
    _: *const std::ffi::c_char,
) -> i32 {
    // SQLITE_DELETE, INSERT, READ, SELECT, TRANSACTION, UPDATE, FUNCTION.
    // Deny PRAGMA too: the compatibility helpers inspect table_info.
    if [9, 18, 20, 21, 22, 23, 31].contains(&action) {
        0
    } else {
        1
    }
}

#[tokio::test]
async fn current_database_reopens_without_ddl_or_compatibility_inspection() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("current.db");
    create_pool(&path).await.unwrap().close().await;
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(&path)
                .foreign_keys(true),
        )
        .await
        .unwrap();
    {
        let mut connection = pool.acquire().await.unwrap();
        let mut handle = connection.lock_handle().await.unwrap();
        // SAFETY: the handle is locked, and the static callback never dereferences context.
        assert_eq!(
            unsafe {
                sqlite3_set_authorizer(
                    handle.as_raw_handle().as_ptr().cast(),
                    Some(deny_schema_work),
                    std::ptr::null_mut(),
                )
            },
            0
        );
    }
    run_migrations_local(pool.clone()).await.unwrap();
    let mut connection = pool.acquire().await.unwrap();
    assert!(
        sqlx::query("CREATE TABLE IF NOT EXISTS conversations (id TEXT)")
            .execute(&mut *connection)
            .await
            .is_err(),
        "authorizer must detect even no-op DDL"
    );
    assert!(sqlx::query("PRAGMA table_info(conversations)")
        .fetch_all(&mut *connection)
        .await
        .is_err());
}

#[tokio::test]
async fn failed_stamp_rolls_back_schema_data_and_versions_then_can_retry() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("failed.db");
    let mut connection = fixture(&path, true).await;
    sqlx::raw_sql("CREATE TRIGGER reject_v5 BEFORE INSERT ON schema_migrations WHEN new.version = 5 BEGIN SELECT RAISE(ABORT, 'injected migration failure'); END;")
        .execute(&mut connection).await.unwrap();
    let before = schema(&mut connection).await;
    assert!(create_pool(&path).await.is_err());
    assert_eq!(schema(&mut connection).await, before);
    assert_eq!(
        list_applied_migrations(&mut connection).await.unwrap(),
        HashSet::from([1, 2, 3, 4])
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT content FROM messages")
            .fetch_one(&mut connection)
            .await
            .unwrap(),
        "Original message"
    );
    sqlx::query("DROP TRIGGER reject_v5")
        .execute(&mut connection)
        .await
        .unwrap();
    connection.close().await.unwrap();
    let pool = create_pool(&path).await.unwrap();
    assert_preserved(&mut *pool.acquire().await.unwrap()).await;
}

#[tokio::test]
async fn tool_journal_migration_rolls_back_if_version_stamp_fails() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("tool-journal.db");
    create_pool(&path).await.unwrap().close().await;
    let mut connection = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(&path)
            .foreign_keys(true),
    )
    .await
    .unwrap();
    drop_v9(&mut connection).await;
    sqlx::query("DROP TABLE agent_run_transitions")
        .execute(&mut connection)
        .await
        .unwrap();
    sqlx::query("DELETE FROM schema_migrations WHERE version = 8")
        .execute(&mut connection)
        .await
        .unwrap();
    sqlx::query("DROP TABLE tool_invocations")
        .execute(&mut connection)
        .await
        .unwrap();
    sqlx::query("DELETE FROM schema_migrations WHERE version = 7")
        .execute(&mut connection)
        .await
        .unwrap();
    sqlx::raw_sql("CREATE TRIGGER reject_v7 BEFORE INSERT ON schema_migrations WHEN new.version = 7 BEGIN SELECT RAISE(ABORT, 'injected migration failure'); END;")
        .execute(&mut connection).await.unwrap();
    assert!(create_pool(&path).await.is_err());
    assert!(!table_exists(&mut connection, "tool_invocations".into())
        .await
        .unwrap());
    assert!(!list_applied_migrations(&mut connection)
        .await
        .unwrap()
        .contains(&7));
    sqlx::query("DROP TRIGGER reject_v7")
        .execute(&mut connection)
        .await
        .unwrap();
    connection.close().await.unwrap();
    let pool = create_pool(&path).await.unwrap();
    let mut connection = pool.acquire().await.unwrap();
    assert!(table_exists(&mut connection, "tool_invocations".into())
        .await
        .unwrap());
    assert!(list_applied_migrations(&mut connection)
        .await
        .unwrap()
        .contains(&7));
}

#[tokio::test]
async fn transition_migration_rolls_back_without_losing_v7_tool_journal() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("transitions.db");
    create_pool(&path).await.unwrap().close().await;
    let mut connection = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(&path)
            .foreign_keys(true),
    )
    .await
    .unwrap();
    drop_v9(&mut connection).await;
    sqlx::query("DROP TABLE agent_run_transitions")
        .execute(&mut connection)
        .await
        .unwrap();
    sqlx::query("DELETE FROM schema_migrations WHERE version = 8")
        .execute(&mut connection)
        .await
        .unwrap();
    sqlx::raw_sql("CREATE TRIGGER reject_v8 BEFORE INSERT ON schema_migrations WHEN new.version = 8 BEGIN SELECT RAISE(ABORT, 'injected migration failure'); END;")
        .execute(&mut connection).await.unwrap();
    assert!(create_pool(&path).await.is_err());
    assert!(
        !table_exists(&mut connection, "agent_run_transitions".into())
            .await
            .unwrap()
    );
    assert!(table_exists(&mut connection, "tool_invocations".into())
        .await
        .unwrap());
    let versions = list_applied_migrations(&mut connection).await.unwrap();
    assert!(versions.contains(&7));
    assert!(!versions.contains(&8));
    sqlx::query("DROP TRIGGER reject_v8")
        .execute(&mut connection)
        .await
        .unwrap();
    connection.close().await.unwrap();
    let pool = create_pool(&path).await.unwrap();
    let mut connection = pool.acquire().await.unwrap();
    assert!(
        table_exists(&mut connection, "agent_run_transitions".into())
            .await
            .unwrap()
    );
    assert!(table_exists(&mut connection, "tool_invocations".into())
        .await
        .unwrap());
}

#[tokio::test]
async fn goal_migration_rolls_back_without_losing_v8_transition_journal() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("goals.db");
    create_pool(&path).await.unwrap().close().await;
    let mut connection = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(&path)
            .foreign_keys(true),
    )
    .await
    .unwrap();
    drop_v9(&mut connection).await;
    sqlx::raw_sql("CREATE TRIGGER reject_v9 BEFORE INSERT ON schema_migrations WHEN new.version = 9 BEGIN SELECT RAISE(ABORT, 'injected migration failure'); END;")
        .execute(&mut connection).await.unwrap();
    assert!(create_pool(&path).await.is_err());
    assert!(!table_exists(&mut connection, "conversation_goals".into())
        .await
        .unwrap());
    assert!(
        table_exists(&mut connection, "agent_run_transitions".into())
            .await
            .unwrap()
    );
    assert!(!list_applied_migrations(&mut connection)
        .await
        .unwrap()
        .contains(&9));
    sqlx::query("DROP TRIGGER reject_v9")
        .execute(&mut connection)
        .await
        .unwrap();
    connection.close().await.unwrap();
    let pool = create_pool(&path).await.unwrap();
    let mut connection = pool.acquire().await.unwrap();
    assert!(table_exists(&mut connection, "conversation_goals".into())
        .await
        .unwrap());
    let versions = list_applied_migrations(&mut connection).await.unwrap();
    assert!(versions.contains(&8) && versions.contains(&9));
}

#[tokio::test]
async fn interrupted_transaction_leaves_no_partial_migration() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("interrupted.db");
    let mut connection = fixture(&path, true).await;
    let before = schema(&mut connection).await;
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut connection)
        .await
        .unwrap();
    run_migrations_on_connection(&mut connection).await.unwrap();
    assert!(list_applied_migrations(&mut connection)
        .await
        .unwrap()
        .contains(&5));
    // Close without COMMIT, as when a process exits before committing the migration.
    connection.close().await.unwrap();
    let mut reopened = SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&path))
        .await
        .unwrap();
    assert_eq!(schema(&mut reopened).await, before);
    assert!(!list_applied_migrations(&mut reopened)
        .await
        .unwrap()
        .contains(&5));
    reopened.close().await.unwrap();
    let pool = create_pool(&path).await.unwrap();
    assert_preserved(&mut *pool.acquire().await.unwrap()).await;
}

#[tokio::test]
async fn inconsistent_history_and_missing_core_column_fail_without_mutation() {
    for damage in [
        "INSERT INTO schema_migrations VALUES (99, 'future', 'date')",
        "DELETE FROM schema_migrations WHERE version = 3",
        "ALTER TABLE conversations DROP COLUMN title",
        "DROP TRIGGER messages_search_update",
    ] {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("inconsistent.db");
        let mut connection = fixture(&path, true).await;
        sqlx::query(sqlx::AssertSqlSafe(damage.to_string()))
            .execute(&mut connection)
            .await
            .unwrap();
        let before = schema(&mut connection).await;
        let versions = list_applied_migrations(&mut connection).await.unwrap();
        assert!(create_pool(&path).await.is_err(), "accepted {damage}");
        assert_eq!(schema(&mut connection).await, before);
        assert_eq!(
            list_applied_migrations(&mut connection).await.unwrap(),
            versions
        );
    }
}

#[tokio::test]
async fn orphaned_rows_fail_without_deleting_data() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("orphan.db");
    let mut connection = fixture(&path, true).await;
    sqlx::query("PRAGMA foreign_keys = OFF")
        .execute(&mut connection)
        .await
        .unwrap();
    sqlx::query("UPDATE messages SET conversation_id = 'absent'")
        .execute(&mut connection)
        .await
        .unwrap();
    let before = schema(&mut connection).await;
    assert!(matches!(
        create_pool(&path).await,
        Err(DbError::Migration(_))
    ));
    assert_eq!(schema(&mut connection).await, before);
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT conversation_id FROM messages")
            .fetch_one(&mut connection)
            .await
            .unwrap(),
        "absent"
    );
}

#[tokio::test]
async fn published_baseline_preserves_provider_and_model_data_through_v5() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("baseline.db");
    let mut connection = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true),
    )
    .await
    .unwrap();
    ensure_schema_migrations_table(&mut connection)
        .await
        .unwrap();
    for (version, name, sql) in [
        (1, MIGRATION_001_NAME, MIGRATION_001_SQL),
        (3, MIGRATION_003_NAME, MIGRATION_003_SQL),
        (4, MIGRATION_004_NAME, MIGRATION_004_SQL),
    ] {
        apply_migration(&mut connection, version, name.into(), sql.into())
            .await
            .unwrap();
    }
    sqlx::raw_sql("INSERT INTO provider_configs (id, name, provider_type, base_url, has_stored_api_key, created_at, updated_at) VALUES ('custom', 'Custom', 'openai', 'https://example.invalid', 1, 'original', 'original');
        INSERT INTO ai_models (id, provider_id, model_id, name, description, pricing_prompt, is_enabled, is_manual, first_seen_at, last_seen_at) VALUES ('model', 'custom', 'model', 'My model', 'Keep me', '0.42', 0, 1, 'first', 'last');")
        .execute(&mut connection).await.unwrap();
    connection.close().await.unwrap();
    let pool = create_pool(&path).await.unwrap();
    let row: (String, String, i64, i64, String, String, Option<i64>) = sqlx::query_as(
        "SELECT description, pricing_prompt, is_enabled, is_manual, first_seen_at, last_seen_at, context_window_tokens FROM ai_models WHERE id = 'model'",
    ).fetch_one(&pool).await.unwrap();
    assert_eq!(
        row,
        (
            "Keep me".into(),
            "0.42".into(),
            0,
            1,
            "first".into(),
            "last".into(),
            None
        )
    );
    assert_eq!(
        sqlx::query_as::<_, (i64, String)>(
            "SELECT has_stored_api_key, created_at FROM provider_configs WHERE id = 'custom'"
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        (1, "original".into())
    );
    assert!(sqlx::query("INSERT INTO ai_models (id, provider_id, model_id, name, first_seen_at, last_seen_at) VALUES ('orphan', 'absent', 'x', 'x', 'x', 'x')")
        .execute(&pool).await.is_err());
}

#[tokio::test]
async fn upgrades_pre_join_search_without_rewriting_messages_and_only_rebuilds_once() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("v9.db");
    let old = fixture(&path, true).await;
    old.close().await.unwrap();
    let current = create_pool(&path).await.unwrap();
    let mut connection = current.acquire().await.unwrap();
    drop_visible_search(&mut connection).await;
    let content = "<think>historicalneedle</think> Visible café answer";
    sqlx::query("UPDATE messages SET role = 'assistant', content = ? WHERE id = 'message'")
        .bind(content)
        .execute(&mut *connection)
        .await
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM message_search WHERE message_search MATCH 'historicalneedle'"
        )
        .fetch_one(&mut *connection)
        .await
        .unwrap(),
        1
    );
    drop(connection);
    current.close().await;

    let upgraded = create_pool(&path).await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM message_search WHERE message_search MATCH 'historicalneedle'"
        )
        .fetch_one(&upgraded)
        .await
        .unwrap(),
        0
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM message_search WHERE message_search MATCH 'cafe'"
        )
        .fetch_one(&upgraded)
        .await
        .unwrap(),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT content FROM messages WHERE id = 'message'")
            .fetch_one(&upgraded)
            .await
            .unwrap(),
        content
    );
    // A subsequent open must not silently rebuild the index again.
    sqlx::query("DELETE FROM message_search")
        .execute(&upgraded)
        .await
        .unwrap();
    upgraded.close().await;
    let reopened = create_pool(&path).await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM message_search WHERE message_search MATCH 'cafe'"
        )
        .fetch_one(&reopened)
        .await
        .unwrap(),
        0
    );
}

#[tokio::test]
async fn visible_search_migration_failure_restores_previous_index_atomically() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("rollback.db");
    let old = fixture(&path, true).await;
    old.close().await.unwrap();
    let current = create_pool(&path).await.unwrap();
    let mut connection = current.acquire().await.unwrap();
    drop_visible_search(&mut connection).await;
    sqlx::query("CREATE TABLE message_search_content (sentinel TEXT)")
        .execute(&mut *connection)
        .await
        .unwrap();
    drop(connection);
    current.close().await;
    assert!(create_pool(&path).await.is_err());
    let mut connection =
        SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&path))
            .await
            .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT max(version) FROM schema_migrations")
            .fetch_one(&mut connection)
            .await
            .unwrap(),
        14
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>(
            "SELECT content FROM message_search WHERE message_search MATCH 'Original'"
        )
        .fetch_one(&mut connection)
        .await
        .unwrap(),
        "Original message"
    );
    assert_eq!(sqlx::query_scalar::<_, i64>("SELECT count(*) FROM sqlite_master WHERE type = 'trigger' AND name IN ('messages_search_insert','messages_search_delete','messages_search_update')")
        .fetch_one(&mut connection).await.unwrap(), 3);
}

#[tokio::test]
async fn durable_engine_migrations_keep_missing_legacy_results_and_roll_back_failed_stamp() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("legacy-v9.db");
    let pool = create_pool(&path).await.unwrap();
    sqlx::query("INSERT INTO conversations (id,title,created_at,updated_at) VALUES ('legacy','Synthetic','date','date')").execute(&pool).await.unwrap();
    let mut c = pool.acquire().await.unwrap();
    drop_visible_search(&mut c).await;
    for statement in POST_V9_ENGINE_TABLES.iter().copied().chain([
        "DROP TABLE engine_events",
        "DROP TABLE engine_effects",
        "DROP TABLE engine_deliveries",
        "DROP TABLE engine_systems",
        "DROP TRIGGER tool_result_requires_completion_insert",
        "DROP TRIGGER tool_result_requires_completion_update",
        "ALTER TABLE tool_invocations DROP COLUMN result_json",
        "DELETE FROM schema_migrations WHERE version >= 10",
    ]) {
        sqlx::query(statement).execute(&mut *c).await.unwrap();
    }
    sqlx::query("INSERT INTO tool_invocations (conversation_id,turn_id,message_id,call_id,tool_name,effect_class,arguments_sha256,status,receipt_id,created_at,updated_at) VALUES ('legacy','turn','message','call','write','workspace_mutation',?,'completed','receipt','date','date')").bind("a".repeat(64)).execute(&mut *c).await.unwrap();
    sqlx::raw_sql("CREATE TRIGGER fail_engine_stamp BEFORE INSERT ON schema_migrations WHEN NEW.version = 11 BEGIN SELECT RAISE(ABORT,'synthetic'); END;").execute(&mut *c).await.unwrap();
    drop(c);
    pool.close().await;
    assert!(create_pool(&path).await.is_err());
    let mut c = SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&path))
        .await
        .unwrap();
    assert!(!table_columns(&mut c, "tool_invocations".into())
        .await
        .unwrap()
        .contains("result_json"));
    assert!(!table_exists(&mut c, "engine_systems".into()).await.unwrap());
    sqlx::query("DROP TRIGGER fail_engine_stamp")
        .execute(&mut c)
        .await
        .unwrap();
    c.close().await.unwrap();
    let upgraded = create_pool(&path).await.unwrap();
    let result: Option<String> =
        sqlx::query_scalar("SELECT result_json FROM tool_invocations WHERE call_id='call'")
            .fetch_one(&upgraded)
            .await
            .unwrap();
    assert!(result.is_none());
    let status: String =
        sqlx::query_scalar("SELECT status FROM tool_invocations WHERE call_id='call'")
            .fetch_one(&upgraded)
            .await
            .unwrap();
    assert_eq!(status, "completed");
}

/// Reproduce either published branch without changing its migration identities.
pub(crate) async fn published_branch_database(
    path: &Path,
    visible_search: bool,
) -> SqliteConnection {
    create_pool(path).await.unwrap().close().await;
    let mut connection = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(path)
            .foreign_keys(true),
    )
    .await
    .unwrap();
    drop_visible_search(&mut connection).await;
    if visible_search {
        for statement in POST_V9_ENGINE_TABLES.iter().copied().chain([
            "DROP TABLE engine_events",
            "DROP TABLE engine_effects",
            "DROP TABLE engine_deliveries",
            "DROP TABLE engine_systems",
            "DROP TRIGGER tool_result_requires_completion_insert",
            "DROP TRIGGER tool_result_requires_completion_update",
            "ALTER TABLE tool_invocations DROP COLUMN result_json",
            "DELETE FROM schema_migrations WHERE version >= 10",
        ]) {
            sqlx::query(statement)
                .execute(&mut connection)
                .await
                .unwrap();
        }
        apply_migration(
            &mut connection,
            10,
            "010_visible_message_search".into(),
            MIGRATION_010_SQL.into(),
        )
        .await
        .unwrap();
    }
    connection
}

#[tokio::test]
async fn joins_both_published_v10_histories_without_replacing_stamps_or_data() {
    for visible_search in [false, true] {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("published.db");
        let mut old = published_branch_database(&path, visible_search).await;
        sqlx::raw_sql("INSERT INTO conversations (id,title,created_at,updated_at) VALUES ('history','Synthetic','date','date');
            INSERT INTO messages (id,conversation_id,role,content,created_at) VALUES ('historical-message','history','assistant','<think>secretneedle</think> Visible café answer','date');")
            .execute(&mut old).await.unwrap();
        let stamps: Vec<(i64, String, String)> = sqlx::query_as(
            "SELECT version, name, applied_at FROM schema_migrations ORDER BY version",
        )
        .fetch_all(&mut old)
        .await
        .unwrap();
        if !visible_search {
            sqlx::raw_sql("INSERT INTO engine_systems VALUES ('system','request','{}','{\"keep\":true}','{}','{}');
                INSERT INTO tool_invocations (conversation_id,turn_id,message_id,call_id,tool_name,effect_class,arguments_sha256,status,receipt_id,created_at,updated_at,result_json) VALUES ('history','turn','historical-message','call','read','read_only','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','completed','receipt','date','date','{\"keep\":true}');")
                .execute(&mut old).await.unwrap();
        }
        old.close().await.unwrap();
        let upgraded = create_pool(&path).await.unwrap();
        assert_eq!(sqlx::query_as::<_, (i64,String,String)>(
            "SELECT version,name,applied_at FROM schema_migrations WHERE version < 15 ORDER BY version",
        ).fetch_all(&upgraded).await.unwrap()[..stamps.len()], stamps);
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT max(version) FROM schema_migrations")
                .fetch_one(&upgraded)
                .await
                .unwrap(),
            15
        );
        assert_eq!(
            sqlx::query_scalar::<_, String>(
                "SELECT content FROM messages WHERE id='historical-message'"
            )
            .fetch_one(&upgraded)
            .await
            .unwrap(),
            "<think>secretneedle</think> Visible café answer"
        );
        for (term, count) in [("secretneedle", 0), ("cafe", 1)] {
            assert_eq!(
                sqlx::query_scalar::<_, i64>(
                    "SELECT count(*) FROM message_search WHERE message_search MATCH ?"
                )
                .bind(term)
                .fetch_one(&upgraded)
                .await
                .unwrap(),
                count
            );
        }
        if !visible_search {
            assert_eq!(
                sqlx::query_scalar::<_, String>(
                    "SELECT snapshot_json FROM engine_systems WHERE system_id='system'"
                )
                .fetch_one(&upgraded)
                .await
                .unwrap(),
                "{\"keep\":true}"
            );
            assert_eq!(
                sqlx::query_scalar::<_, String>(
                    "SELECT result_json FROM tool_invocations WHERE call_id='call'"
                )
                .fetch_one(&upgraded)
                .await
                .unwrap(),
                "{\"keep\":true}"
            );
        }
        assert!(sqlx::query("INSERT INTO tool_invocations (conversation_id,turn_id,message_id,call_id,tool_name,effect_class,arguments_sha256,status,created_at,updated_at,result_json) VALUES ('history','turn','historical-message','invalid','read','read_only','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','pending','date','date','{}')").execute(&upgraded).await.is_err());
        // Both variants converge to the same schema and reopen without DDL or stamps.
        let mut c = upgraded.acquire().await.unwrap();
        let before = schema(&mut c).await;
        let all_stamps: Vec<(i64, String, String)> = sqlx::query_as(
            "SELECT version,name,applied_at FROM schema_migrations ORDER BY version",
        )
        .fetch_all(&mut *c)
        .await
        .unwrap();
        drop(c);
        upgraded.close().await;
        let reopened = create_pool(&path).await.unwrap();
        let mut c = reopened.acquire().await.unwrap();
        assert_eq!(schema(&mut c).await, before);
        assert_eq!(
            sqlx::query_as::<_, (i64, String, String)>(
                "SELECT version,name,applied_at FROM schema_migrations ORDER BY version"
            )
            .fetch_all(&mut *c)
            .await
            .unwrap(),
            all_stamps
        );
    }
}

#[tokio::test]
async fn joined_migration_rolls_back_both_branch_variants_and_rejects_unknown_v10_names() {
    for visible_search in [false, true] {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("rollback-join.db");
        let mut old = published_branch_database(&path, visible_search).await;
        sqlx::raw_sql("CREATE TRIGGER reject_join BEFORE INSERT ON schema_migrations WHEN new.version=15 BEGIN SELECT RAISE(ABORT,'synthetic'); END;")
            .execute(&mut old).await.unwrap();
        let before = schema(&mut old).await;
        let stamps: Vec<(i64, String, String)> = sqlx::query_as(
            "SELECT version,name,applied_at FROM schema_migrations ORDER BY version",
        )
        .fetch_all(&mut old)
        .await
        .unwrap();
        assert!(create_pool(&path).await.is_err());
        assert_eq!(schema(&mut old).await, before);
        assert_eq!(
            sqlx::query_as::<_, (i64, String, String)>(
                "SELECT version,name,applied_at FROM schema_migrations ORDER BY version"
            )
            .fetch_all(&mut old)
            .await
            .unwrap(),
            stamps
        );
        sqlx::raw_sql("DROP TRIGGER reject_join; UPDATE schema_migrations SET name='unknown_010' WHERE version=10;")
            .execute(&mut old).await.unwrap();
        let before = schema(&mut old).await;
        assert!(matches!(
            create_pool(&path).await,
            Err(DbError::Migration(_))
        ));
        assert_eq!(schema(&mut old).await, before);
        sqlx::query("UPDATE schema_migrations SET name=? WHERE version=10")
            .bind(if visible_search {
                "010_visible_message_search"
            } else {
                "010_tool_results"
            })
            .execute(&mut old)
            .await
            .unwrap();
        old.close().await.unwrap();
        create_pool(&path).await.unwrap().close().await;
    }
}
