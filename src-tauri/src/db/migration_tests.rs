use super::*;
use sqlx::Connection;
use tempfile::TempDir;

#[tokio::test]
async fn flow_owner_migration_defers_capture_reference_without_accepting_orphans() {
    let temp = TempDir::new().unwrap();
    let pool = create_pool(&temp.path().join("flow-owner.db"))
        .await
        .unwrap();
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("INSERT INTO engine_flow030_owners VALUES (?,?,?,?,?,?,?,?)")
        .bind("system")
        .bind("flow")
        .bind("snapshot")
        .bind("capture")
        .bind("owner")
        .bind("generation")
        .bind("live")
        .bind("a".repeat(64))
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("INSERT INTO engine_flow030_runs VALUES (?,?,?,?,?,?,?)")
        .bind("system")
        .bind("flow")
        .bind("snapshot")
        .bind("capture")
        .bind("{}")
        .bind("{}")
        .bind("{}")
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert!(
        sqlx::query("UPDATE engine_flow030_owners SET capture_epoch='other'")
            .execute(&pool)
            .await
            .is_err()
    );
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("INSERT INTO engine_flow030_owners VALUES (?,?,?,?,?,?,?,?)")
        .bind("orphan")
        .bind("flow")
        .bind("snapshot")
        .bind("capture")
        .bind("owner")
        .bind("generation")
        .bind("live")
        .bind("a".repeat(64))
        .execute(&mut *tx)
        .await
        .unwrap();
    assert!(tx.commit().await.is_err());
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM engine_flow030_owners")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
}

#[tokio::test]
async fn accepts_develop_v9_with_historical_pilot_v5_stamp() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("develop.db");
    let mut old = fixture(&path, true).await;
    old.close().await.unwrap();
    let pool = create_pool(&path).await.unwrap();
    {
        let mut c = pool.acquire().await.unwrap();
        drop_agsdl(&mut c).await;
        drop_develop_after9(&mut c).await;
    }
    sqlx::raw_sql(include_str!(
        "migrations/006_pilot_tool_trace_revisions.sql"
    ))
    .execute(&pool)
    .await
    .unwrap();
    sqlx::raw_sql("DELETE FROM schema_migrations WHERE version >= 10; UPDATE schema_migrations SET name = '005_pilot_tool_trace_revisions' WHERE version = 5;")
        .execute(&pool).await.unwrap();
    pool.close().await;
    let reopened = create_pool(&path).await.unwrap();
    let mut connection = reopened.acquire().await.unwrap();
    assert_preserved(&mut connection).await;
    let names: Vec<(i64, String)> = sqlx::query_as(
        "SELECT version, name FROM schema_migrations WHERE version >= 6 ORDER BY version",
    )
    .fetch_all(&mut *connection)
    .await
    .unwrap();
    assert_eq!(
        names,
        vec![
            (6, "006_generation_attempts".into()),
            (7, "007_tool_invocations".into()),
            (8, "008_agent_run_transitions".into()),
            (9, "009_conversation_goals".into()),
            (10, "010_pilot_tool_trace_revisions".into()),
            (11, "011_conversation_management".into()),
            (12, "012_pilot_files".into()),
            (13, "013_conversation_content_versions".into()),
            (14, "014_conversation_catalog_version".into()),
            (15, "015_inactive_storage".into()),
            (16, "016_source_capture".into()),
            (17, "017_chat_admission".into()),
            (18, "018_connect_transfer".into()),
            (19, "019_connect_publication".into()),
            (20, "020_tool_results".into()),
            (21, "021_agsdl_execution".into()),
            (22, "022_execution_host".into()),
            (23, "023_execution_ui_intents".into()),
            (24, "024_execution_process_receipts".into()),
            (25, "025_visible_message_search".into()),
            (26, "026_execution_native_operations".into()),
            (27, "027_execution_work_protocol".into()),
            (28, "028_execution_work_admission".into()),
            (29, "029_execution_human_public".into()),
            (30, "030_execution_flow".into()),
            (31, "031_execution_start_entry".into()),
            (32, "032_execution_ui_intent_start030".into()),
            (33, "033_execution_flow_owner030".into()),
        ]
    );
}

#[tokio::test]
async fn upgrades_local_pilot_v7_without_reusing_develop_migration_numbers() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("pilot.db");
    let mut old = fixture(&path, true).await;
    old.close().await.unwrap();
    let pool = create_pool(&path).await.unwrap();
    let mut connection = pool.acquire().await.unwrap();
    drop_v9(&mut connection).await;
    sqlx::raw_sql("DROP TABLE agent_run_transitions; DROP TABLE tool_invocations; ALTER TABLE messages DROP COLUMN generation_attempts_json; DELETE FROM schema_migrations WHERE version >= 6; INSERT INTO schema_migrations VALUES (6, '006_pilot_tool_trace_revisions', 'original-pilot-time'), (7, '007_conversation_management', 'original-pilot-time');")
        .execute(&mut *connection).await.unwrap();
    drop(connection);
    pool.close().await;
    let pool = create_pool(&path).await.unwrap();
    let mut connection = pool.acquire().await.unwrap();
    assert_preserved(&mut connection).await;
    let timestamps: Vec<String> = sqlx::query_scalar(
        "SELECT applied_at FROM schema_migrations WHERE version IN (10,11) ORDER BY version",
    )
    .fetch_all(&mut *connection)
    .await
    .unwrap();
    assert_eq!(
        timestamps,
        vec!["original-pilot-time", "original-pilot-time"]
    );
    assert!(table_exists(&mut connection, "tool_invocations".into())
        .await
        .unwrap());
    assert!(table_exists(&mut connection, "conversation_goals".into())
        .await
        .unwrap());
}

/// Optional upgrade rehearsal: only a temporary copy of the supplied fixture is opened.
#[tokio::test]
#[ignore = "requires MACRO_DB_UPGRADE_FIXTURE; never migrates the supplied file"]
async fn rehearses_upgrade_on_external_database_copy() {
    use sha2::{Digest, Sha256};
    let source = PathBuf::from(std::env::var_os("MACRO_DB_UPGRADE_FIXTURE").expect("fixture path"));
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("rehearsal.db");
    std::fs::copy(&source, &path).unwrap();
    let wal = PathBuf::from(format!("{}-wal", source.display()));
    if wal.exists() {
        std::fs::copy(wal, temp.path().join("rehearsal.db-wal")).unwrap();
    }
    async fn transcript_fingerprint(connection: &mut SqliteConnection) -> Vec<u8> {
        let rows: Vec<(String, String, String)> =
            sqlx::query_as("SELECT id, content, created_at FROM messages ORDER BY id")
                .fetch_all(connection)
                .await
                .unwrap();
        let mut digest = Sha256::new();
        for (id, content, date) in rows {
            for field in [id, content, date] {
                digest.update((field.len() as u64).to_le_bytes());
                digest.update(field.as_bytes());
            }
        }
        digest.finalize().to_vec()
    }
    let mut before = SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&path))
        .await
        .unwrap();
    let fingerprint = transcript_fingerprint(&mut before).await;
    before.close().await.unwrap();
    let pool = create_pool(&path)
        .await
        .expect("fixture upgrade must succeed");
    let mut after = pool.acquire().await.unwrap();
    assert_eq!(
        transcript_fingerprint(&mut after).await,
        fingerprint,
        "transcript changed during upgrade"
    );
    assert_eq!(
        list_applied_migrations(&mut after)
            .await
            .unwrap()
            .iter()
            .max(),
        Some(&33)
    );
}

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

pub(crate) async fn drop_develop_after9(c: &mut SqliteConnection) {
    let agsdl: Vec<(i64, String, String)> =
        sqlx::query_as("SELECT version,name,applied_at FROM schema_migrations WHERE version>=20")
            .fetch_all(&mut *c)
            .await
            .unwrap();
    chat_admission::remove_reference_schema_in(c).await.unwrap();
    crate::local_backup::remove_reference_e_schema(c, &[])
        .await
        .unwrap();
    conversation_catalog::remove_reference_schema_in(c)
        .await
        .unwrap();
    let names: Vec<String> = sqlx::query_scalar(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND name GLOB 'content_versions_*'",
    )
    .fetch_all(&mut *c)
    .await
    .unwrap();
    for name in names {
        sqlx::query(sqlx::AssertSqlSafe(format!("DROP TRIGGER {name}")))
            .execute(&mut *c)
            .await
            .unwrap();
    }
    sqlx::query("DROP TABLE conversation_content_versions")
        .execute(&mut *c)
        .await
        .unwrap();
    for statement in [
        "DROP TABLE pilot_file_chunks",
        "DROP TABLE pilot_file_sends",
        "DROP TABLE pilot_message_attachments",
        "DROP TABLE pilot_file_transfers",
        "DROP TABLE pilot_file_sources",
        "DROP TABLE pilot_file_binding_history",
        "DROP TABLE pilot_file_authorities",
    ] {
        sqlx::query(statement).execute(&mut *c).await.unwrap();
    }
    for statement in [
        "DROP TRIGGER conversation_management_insert",
        "DROP TRIGGER conversation_management_update",
        "DROP TRIGGER conversation_response_insert",
        "DROP TRIGGER conversation_response_update",
        "DROP TABLE conversation_response_versions",
        "DROP TABLE conversation_action_receipts",
        "DROP TABLE conversation_management",
        "DROP TRIGGER messages_tool_trace_revision_insert",
        "DROP TRIGGER messages_tool_trace_revision_delete",
        "DROP TRIGGER messages_tool_trace_revision_update_same_conversation",
        "DROP TRIGGER messages_tool_trace_revision_update_conversation",
        "DROP TABLE conversation_tool_trace_revisions",
        "DELETE FROM schema_migrations WHERE version >= 10",
    ] {
        sqlx::query(statement).execute(&mut *c).await.unwrap();
    }
    sqlx::query("DELETE FROM schema_migrations WHERE version BETWEEN 10 AND 19")
        .execute(&mut *c)
        .await
        .unwrap();
    for (v, n, d) in agsdl {
        sqlx::query("INSERT OR IGNORE INTO schema_migrations VALUES (?,?,?)")
            .bind(v)
            .bind(n)
            .bind(d)
            .execute(&mut *c)
            .await
            .unwrap();
    }
}

pub(crate) async fn drop_human_public(c: &mut SqliteConnection) {
    migration_history::remove_reference_schema(c, &[20, 21, 22, 23, 24, 25, 26, 27, 28])
        .await
        .unwrap();
    sqlx::query("DELETE FROM schema_migrations WHERE version>=29")
        .execute(c)
        .await
        .unwrap();
}

pub(crate) async fn drop_agsdl(c: &mut SqliteConnection) {
    migration_history::remove_reference_schema(c, &[])
        .await
        .unwrap();
    sqlx::query("DELETE FROM schema_migrations WHERE version>=20")
        .execute(c)
        .await
        .unwrap();
}

async fn drop_visible_search(connection: &mut SqliteConnection) {
    drop_human_public(connection).await;
    sqlx::raw_sql(
        "DROP TRIGGER messages_search_insert;
         DROP TRIGGER messages_search_delete;
         DROP TRIGGER messages_search_update;
         DROP TRIGGER messages_search_update_insert;
         DROP TABLE message_search;
         DROP VIEW message_search_content;
         DROP TABLE engine_work_admission030;
         DROP TABLE engine_human_link_events030;
         DROP TABLE engine_human_works030;
         DROP TABLE engine_human_requests030;
         DROP TABLE engine_work_checks030;
         DROP TABLE engine_work_events030;
         DROP TABLE engine_work_protocol030;
         DROP TABLE engine_native_operations;
         DELETE FROM schema_migrations WHERE version IN (25,26,27,28);",
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
    drop_agsdl(connection).await;
    inactive_storage::tests::remove_reference_schema_in(connection).await;
    conversation_catalog::remove_reference_schema_in(connection)
        .await
        .unwrap();
    sqlx::query("DELETE FROM schema_migrations WHERE version=14")
        .execute(&mut *connection)
        .await
        .unwrap();
    let names: Vec<String> = sqlx::query_scalar(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND name GLOB 'content_versions_*'",
    )
    .fetch_all(&mut *connection)
    .await
    .unwrap();
    for name in names {
        sqlx::query(sqlx::AssertSqlSafe(format!("DROP TRIGGER {name}")))
            .execute(&mut *connection)
            .await
            .unwrap();
    }
    sqlx::raw_sql(
        "DROP TABLE conversation_content_versions; DELETE FROM schema_migrations WHERE version=13;",
    )
    .execute(&mut *connection)
    .await
    .unwrap();
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
    first: *const std::ffi::c_char,
    _: *const std::ffi::c_char,
    _: *const std::ffi::c_char,
    _: *const std::ffi::c_char,
) -> i32 {
    // F attests this read-only connection configuration. Other PRAGMAs,
    // including legacy table_info inspection, remain denied.
    if action == 19
        && !first.is_null()
        && unsafe { std::ffi::CStr::from_ptr(first) }.to_bytes() == b"trusted_schema"
    {
        return 0;
    }
    // SQLITE_DELETE, INSERT, READ, SELECT, TRANSACTION, UPDATE, FUNCTION.
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
        24
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
    drop_develop_after9(&mut c).await;
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
    sqlx::raw_sql("CREATE TRIGGER fail_engine_stamp BEFORE INSERT ON schema_migrations WHEN NEW.version = 21 BEGIN SELECT RAISE(ABORT,'synthetic'); END;").execute(&mut *c).await.unwrap();
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
    drop_develop_after9(&mut connection).await;
    sqlx::query("DROP TABLE migration_identity_history")
        .execute(&mut connection)
        .await
        .unwrap();
    if visible_search {
        drop_agsdl(&mut connection).await;
        apply_migration(
            &mut connection,
            10,
            "010_visible_message_search".into(),
            MIGRATION_010_SQL.into(),
        )
        .await
        .unwrap();
    } else {
        drop_human_public(&mut connection).await;
        sqlx::raw_sql(
            "DROP TABLE engine_work_admission030;
        DROP TABLE engine_human_link_events030;
        DROP TABLE engine_human_works030;
        DROP TABLE engine_human_requests030;
        DROP TABLE engine_work_checks030;
        DROP TABLE engine_work_events030;
        DROP TABLE engine_work_protocol030;
        DELETE FROM schema_migrations WHERE version IN (27,28);",
        )
        .execute(&mut connection)
        .await
        .unwrap();
        for (v, n) in [
            (20, "010_tool_results"),
            (21, "011_agsdl_execution"),
            (22, "012_execution_host"),
            (23, "013_execution_ui_intents"),
            (24, "014_execution_process_receipts"),
            (25, "015_parallel_v10_reconciliation"),
            (26, "016_execution_native_operations"),
        ] {
            let target = if v == 25 {
                15
            } else if v == 26 {
                16
            } else {
                v - 10
            };
            sqlx::query("UPDATE schema_migrations SET version=?,name=? WHERE version=?")
                .bind(target)
                .bind(n)
                .bind(v)
                .execute(&mut connection)
                .await
                .unwrap();
        }
    }
    connection
}

#[tokio::test]
async fn legacy_protocol_identities_are_normalized_without_losing_admission_data() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("protocol-identities.db");
    let mut old = published_branch_database(&path, false).await;
    for (version, name, sql) in [
        (
            17,
            "017_execution_work_protocol",
            include_str!("migrations/017_execution_work_protocol.sql"),
        ),
        (
            18,
            "018_execution_work_admission",
            include_str!("migrations/018_execution_work_admission.sql"),
        ),
    ] {
        apply_migration(&mut old, version, name.into(), sql.into())
            .await
            .unwrap();
    }
    sqlx::raw_sql("INSERT INTO engine_systems VALUES ('run','request','{}','{}','[]','{}');
        INSERT INTO engine_work_protocol030 VALUES ('run','work','{}','{}','{}','{}','0');
        INSERT INTO engine_work_admission030 VALUES ('run','work','{ \"limit\":9007199254740993 }','{ \"proof\":true }');")
        .execute(&mut old).await.unwrap();
    let ticket = r#"{ "ticket":9007199254740993 }"#;
    let effect = r#"{ "command":"synthetic" }"#;
    sqlx::query(
        "INSERT INTO engine_work_events030 VALUES ('run','work','event',NULL,NULL,?,NULL,NULL)",
    )
    .bind(ticket)
    .execute(&mut old)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO engine_effects VALUES ('run','work','check:one',?,'pending',NULL,NULL)",
    )
    .bind(effect)
    .execute(&mut old)
    .await
    .unwrap();
    sqlx::query("INSERT INTO engine_work_checks030 VALUES ('run','check','work','event','check:one',1,NULL,NULL)")
        .execute(&mut old).await.unwrap();
    old.close().await.unwrap();
    let upgraded = create_pool(&path).await.unwrap();
    let event_ticket: String = sqlx::query_scalar(
        "SELECT ticket_json FROM engine_work_events030 WHERE system_id='run' AND event_id='event'",
    )
    .fetch_one(&upgraded)
    .await
    .unwrap();
    assert_eq!(event_ticket, ticket);
    let check: (i64, String) = sqlx::query_as("SELECT c.claimed,e.record_json FROM engine_work_checks030 c JOIN engine_effects e ON e.system_id=c.system_id AND e.effect_key=c.effect_key WHERE c.system_id='run' AND c.check_id='check'")
        .fetch_one(&upgraded).await.unwrap();
    assert_eq!(check, (1, effect.into()));
    let names: Vec<(i64, String)> = sqlx::query_as("SELECT version,name FROM schema_migrations WHERE version IN (17,18,27,28) ORDER BY version")
        .fetch_all(&upgraded).await.unwrap();
    assert_eq!(
        names,
        vec![
            (17, "017_chat_admission".into()),
            (18, "018_connect_transfer".into()),
            (27, "027_execution_work_protocol".into()),
            (28, "028_execution_work_admission".into())
        ]
    );
    let old_names: Vec<(i64, String)> = sqlx::query_as("SELECT version,name FROM migration_identity_history WHERE name LIKE '%execution_work_%' ORDER BY version")
        .fetch_all(&upgraded).await.unwrap();
    assert_eq!(
        old_names,
        vec![
            (17, "017_execution_work_protocol".into()),
            (18, "018_execution_work_admission".into())
        ]
    );
    let admission: (String, String) = sqlx::query_as("SELECT options_json,evidence_json FROM engine_work_admission030 WHERE system_id='run' AND activation_id='work'")
        .fetch_one(&upgraded).await.unwrap();
    assert_eq!(admission.0, r#"{ "limit":9007199254740993 }"#);
    assert_eq!(admission.1, r#"{ "proof":true }"#);
    upgraded.close().await;
    create_pool(&path).await.unwrap().close().await;
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
        for stamp in &stamps {
            let canonical = migration_history::NAMES
                .get((stamp.0 - 1) as usize)
                .is_some_and(|n| *n == stamp.1);
            let table = if canonical {
                "schema_migrations"
            } else {
                "migration_identity_history"
            };
            let query =
                format!("SELECT version,name,applied_at FROM {table} WHERE version=? AND name=?");
            assert_eq!(
                sqlx::query_as::<_, (i64, String, String)>(sqlx::AssertSqlSafe(query))
                    .bind(stamp.0)
                    .bind(&stamp.1)
                    .fetch_one(&upgraded)
                    .await
                    .unwrap(),
                *stamp
            );
        }
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT max(version) FROM schema_migrations")
                .fetch_one(&upgraded)
                .await
                .unwrap(),
            33
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
        sqlx::raw_sql("CREATE TRIGGER reject_join BEFORE INSERT ON schema_migrations WHEN new.version=19 BEGIN SELECT RAISE(ABORT,'synthetic'); END;")
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

#[tokio::test]
async fn protocol017_upgrades_v16_without_rewriting_snapshots_and_rolls_back_failed_stamp() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("protocol-upgrade.db");
    let pool = create_pool(&path).await.unwrap();
    drop_human_public(&mut *pool.acquire().await.unwrap()).await;
    sqlx::raw_sql("DROP TABLE engine_work_admission030;
        DROP TABLE engine_human_link_events030;
        DROP TABLE engine_human_works030;
        DROP TABLE engine_human_requests030;
        DROP TABLE engine_work_checks030;
        DROP TABLE engine_work_events030;
        DROP TABLE engine_work_protocol030;
        DELETE FROM schema_migrations WHERE version IN (27,28);
        INSERT INTO engine_systems VALUES ('historical','request','{}','{ \"versions\":{\"contract\":\"agsdl-0.2.0\"},\"exact\":9007199254740993 }','[]','{}');
        CREATE TRIGGER fail_protocol_stamp BEFORE INSERT ON schema_migrations WHEN NEW.version=27 BEGIN SELECT RAISE(ABORT,'synthetic'); END;")
        .execute(&pool).await.unwrap();
    let snapshot: String =
        sqlx::query_scalar("SELECT snapshot_json FROM engine_systems WHERE system_id='historical'")
            .fetch_one(&pool)
            .await
            .unwrap();
    let stamps: Vec<(i64, String, String)> =
        sqlx::query_as("SELECT version,name,applied_at FROM schema_migrations ORDER BY version")
            .fetch_all(&pool)
            .await
            .unwrap();
    pool.close().await;
    assert!(create_pool(&path).await.is_err());
    let mut connection =
        SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&path))
            .await
            .unwrap();
    assert!(
        !table_exists(&mut connection, "engine_work_protocol030".into())
            .await
            .unwrap()
    );
    assert_eq!(
        sqlx::query_as::<_, (i64, String, String)>(
            "SELECT version,name,applied_at FROM schema_migrations ORDER BY version"
        )
        .fetch_all(&mut connection)
        .await
        .unwrap(),
        stamps
    );
    sqlx::query("DROP TRIGGER fail_protocol_stamp")
        .execute(&mut connection)
        .await
        .unwrap();
    connection.close().await.unwrap();
    let upgraded = create_pool(&path).await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, String>(
            "SELECT snapshot_json FROM engine_systems WHERE system_id='historical'"
        )
        .fetch_one(&upgraded)
        .await
        .unwrap(),
        snapshot
    );
    assert_eq!(sqlx::query_as::<_, (i64,String,String)>("SELECT version,name,applied_at FROM schema_migrations WHERE version<27 ORDER BY version").fetch_all(&upgraded).await.unwrap(), stamps);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM engine_work_protocol030")
            .fetch_one(&upgraded)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT max(version) FROM schema_migrations")
            .fetch_one(&upgraded)
            .await
            .unwrap(),
        33
    );
    assert_eq!(
        sqlx::query("PRAGMA foreign_key_check")
            .fetch_all(&upgraded)
            .await
            .unwrap()
            .len(),
        0
    );
    upgraded.close().await;
    create_pool(&path).await.unwrap().close().await;
}

#[tokio::test]
async fn admission018_upgrades_v17_and_rolls_back_failed_stamp() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("admission-upgrade.db");
    let pool = create_pool(&path).await.unwrap();
    drop_human_public(&mut *pool.acquire().await.unwrap()).await;
    sqlx::raw_sql("DROP TABLE engine_work_admission030;
        DELETE FROM schema_migrations WHERE version=28;
        INSERT INTO engine_systems VALUES ('historical18','request18','{}','{\"exact\":9007199254740993}','[]','{}');
        CREATE TRIGGER fail_admission_stamp BEFORE INSERT ON schema_migrations WHEN NEW.version=28 BEGIN SELECT RAISE(ABORT,'synthetic'); END;")
        .execute(&pool).await.unwrap();
    let original: String = sqlx::query_scalar(
        "SELECT snapshot_json FROM engine_systems WHERE system_id='historical18'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    pool.close().await;
    assert!(create_pool(&path).await.is_err());
    let mut connection =
        SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&path))
            .await
            .unwrap();
    assert!(
        !table_exists(&mut connection, "engine_work_admission030".into())
            .await
            .unwrap()
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM schema_migrations WHERE version=28")
            .fetch_one(&mut connection)
            .await
            .unwrap(),
        0
    );
    sqlx::query("DROP TRIGGER fail_admission_stamp")
        .execute(&mut connection)
        .await
        .unwrap();
    connection.close().await.unwrap();
    let upgraded = create_pool(&path).await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, String>(
            "SELECT snapshot_json FROM engine_systems WHERE system_id='historical18'"
        )
        .fetch_one(&upgraded)
        .await
        .unwrap(),
        original
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT max(version) FROM schema_migrations")
            .fetch_one(&upgraded)
            .await
            .unwrap(),
        33
    );
    assert!(sqlx::query("PRAGMA foreign_key_check")
        .fetch_all(&upgraded)
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn identity_ledger_refuses_conflicts_and_hostile_schema_before_displacing_stamps() {
    for visible_search in [false, true] {
        for variant in ["timestamp", "check", "uppercase-trigger"] {
            let temp = TempDir::new().unwrap();
            let path = temp.path().join("ledger.db");
            let mut old = published_branch_database(&path, visible_search).await;
            let ddl = if variant == "check" {
                "CREATE TABLE migration_identity_history (version INTEGER NOT NULL CHECK(version<0), name TEXT NOT NULL, applied_at TEXT NOT NULL, PRIMARY KEY(version,name))"
            } else {
                "CREATE TABLE migration_identity_history (version INTEGER NOT NULL, name TEXT NOT NULL, applied_at TEXT NOT NULL, PRIMARY KEY(version,name))"
            };
            sqlx::query(ddl).execute(&mut old).await.unwrap();
            if variant == "timestamp" {
                sqlx::query("INSERT INTO migration_identity_history SELECT version,name,'conflicting-date' FROM schema_migrations WHERE version=10")
                    .execute(&mut old).await.unwrap();
            }
            if variant == "uppercase-trigger" {
                sqlx::query("CREATE TRIGGER erase_previous AFTER INSERT ON \"MIGRATION_IDENTITY_HISTORY\" BEGIN DELETE FROM migration_identity_history WHERE version <> NEW.version; END")
                    .execute(&mut old).await.unwrap();
            }
            let before = schema(&mut old).await;
            let stamps: Vec<(i64, String, String)> = sqlx::query_as(
                "SELECT version,name,applied_at FROM schema_migrations ORDER BY version",
            )
            .fetch_all(&mut old)
            .await
            .unwrap();
            let ledger: Vec<(i64, String, String)> = sqlx::query_as(
                "SELECT version,name,applied_at FROM migration_identity_history ORDER BY version",
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
            assert_eq!(sqlx::query_as::<_, (i64, String, String)>("SELECT version,name,applied_at FROM migration_identity_history ORDER BY version").fetch_all(&mut old).await.unwrap(), ledger);
            old.close().await.unwrap();
        }
    }
}

/// Include develop and both visible-v10 engine states, not just the latest AgSDL.
pub(crate) async fn historical_database(path: &Path, variant: usize) -> SqliteConnection {
    if variant == 0 {
        create_pool(path).await.unwrap().close().await;
        let mut c = SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(path))
            .await
            .unwrap();
        drop_agsdl(&mut c).await;
        sqlx::query("DROP TABLE migration_identity_history")
            .execute(&mut c)
            .await
            .unwrap();
        return c;
    }
    let mut c = published_branch_database(path, variant == 1).await;
    if variant == 3 || variant == 4 {
        sqlx::query(
            "UPDATE schema_migrations SET name='010_visible_message_search' WHERE version=10",
        )
        .execute(&mut c)
        .await
        .unwrap();
    }
    if variant == 5 {
        migration_history::remove_reference_schema(&mut c, &[20, 21, 22, 23, 24])
            .await
            .unwrap();
        sqlx::query("DELETE FROM schema_migrations WHERE version>=15")
            .execute(&mut c)
            .await
            .unwrap();
    }
    if variant == 3 {
        sqlx::raw_sql("DROP TABLE engine_native_operations; DROP TRIGGER tool_result_requires_completion_insert; DROP TRIGGER tool_result_requires_completion_update; ALTER TABLE tool_invocations DROP COLUMN result_json; DELETE FROM schema_migrations WHERE version>=15;").execute(&mut c).await.unwrap();
    }
    c
}

#[tokio::test]
async fn flow030_migration_preserves_capture_and_rejects_cross_version_request_reuse() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("flow030.db");
    let pool = create_pool(&path).await.unwrap();
    sqlx::raw_sql("INSERT INTO engine_systems VALUES ('old','old-request','{}','{}','[]','{}');
        INSERT INTO engine_flow030_runs VALUES ('new','flow','snapshot','capture-epoch','{}','{}','{}');
        INSERT INTO engine_flow030_events VALUES ('new','flow','enter','{}','{}',NULL);
        INSERT INTO engine_flow030_outbox VALUES ('new','flow','effect','enter','{}','owner-epoch','pending',NULL);
        INSERT INTO engine_start030_requests VALUES ('new-request','{}','new','flow','snapshot','capture-epoch','{}','{}');")
        .execute(&pool).await.unwrap();
    for statement in [
        "UPDATE engine_flow030_runs SET plan_json='[]' WHERE system_id='new'",
        "UPDATE engine_start030_requests SET receipt_json='[]' WHERE request_id='new-request'",
        "INSERT INTO engine_systems VALUES ('collision','new-request','{}','{}','[]','{}')",
        "INSERT INTO engine_systems VALUES ('new','other-request','{}','{}','[]','{}')",
        "INSERT INTO engine_start030_requests VALUES ('old-request','{}','another','flow','snapshot','capture-epoch','{}','{}')",
        "INSERT INTO engine_start030_requests VALUES ('another-request','{}','old','flow','snapshot','capture-epoch','{}','{}')",
        "UPDATE engine_flow030_outbox SET status='settled' WHERE effect_id='effect'",
    ] {
        assert!(sqlx::query(statement).execute(&pool).await.is_err(), "{statement}");
    }
    pool.close().await;
    let reopened = create_pool(&path).await.unwrap();
    let persisted: (String, String) = sqlx::query_as("SELECT capture_epoch,receipt_json FROM engine_start030_requests WHERE request_id='new-request'")
        .fetch_one(&reopened).await.unwrap();
    assert_eq!(persisted, ("capture-epoch".into(), "{}".into()));
    let status: String = sqlx::query_scalar(
        "SELECT status FROM engine_flow030_outbox WHERE system_id='new' AND effect_id='effect'",
    )
    .fetch_one(&reopened)
    .await
    .unwrap();
    assert_eq!(status, "pending");
    reopened.close().await;
}

#[tokio::test]
async fn start030_entry_reservation_conflicts_with_both_execution_versions() {
    let temp = TempDir::new().unwrap();
    let pool = create_pool(&temp.path().join("flow-entries.db"))
        .await
        .unwrap();
    sqlx::raw_sql(
        r#"
        INSERT INTO engine_systems VALUES ('old','old-request','{}','{}','[]','{}');
        INSERT INTO engine_deliveries VALUES ('old-delivery','old-work','old','{}');
        INSERT INTO engine_flow030_runs VALUES ('new','flow','snapshot','epoch','{}','{}','{}');
        INSERT INTO engine_flow030_runs VALUES ('other','flow','snapshot','epoch','{}','{}','{}');
    "#,
    )
    .execute(&pool)
    .await
    .unwrap();
    let conflicting = r#"INSERT INTO engine_start030_requests VALUES ('bad','{"entry":{"deliveryId":"old-delivery"}}','new','flow','snapshot','epoch','{}','{}')"#;
    assert!(sqlx::query(conflicting).execute(&pool).await.is_err());
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM engine_start030_requests WHERE request_id='bad'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(count, 0);
    sqlx::query(r#"INSERT INTO engine_start030_requests VALUES ('new-request','{"entry":{"deliveryId":"new-delivery"}}','new','flow','snapshot','epoch','{}','{}')"#).execute(&pool).await.unwrap();
    assert!(
        sqlx::query("DELETE FROM engine_start030_entries WHERE delivery_id='new-delivery'")
            .execute(&pool)
            .await
            .is_err()
    );
    assert!(sqlx::query(
        "INSERT INTO engine_deliveries VALUES ('new-delivery','another-work','old','{}')"
    )
    .execute(&pool)
    .await
    .is_err());
    assert!(sqlx::query(r#"INSERT INTO engine_start030_requests VALUES ('other-request','{"entry":{"deliveryId":"new-delivery"}}','other','flow','snapshot','epoch','{}','{}')"#).execute(&pool).await.is_err());
    pool.close().await;
}

#[tokio::test]
async fn intent032_rebuild_rolls_back_and_refuses_case_variant_inbound_foreign_keys() {
    let mut db = SqliteConnection::connect("sqlite::memory:").await.unwrap();
    sqlx::raw_sql("PRAGMA foreign_keys=ON; CREATE TABLE engine_systems(system_id TEXT PRIMARY KEY,request_id TEXT UNIQUE); CREATE TABLE engine_deliveries(delivery_id TEXT PRIMARY KEY);")
        .execute(&mut db).await.unwrap();
    for sql in [
        include_str!("migrations/013_execution_ui_intents.sql"),
        include_str!("migrations/030_execution_flow.sql"),
        include_str!("migrations/031_execution_start_entry.sql"),
    ] {
        sqlx::raw_sql(sql).execute(&mut db).await.unwrap();
    }
    sqlx::raw_sql("INSERT INTO engine_systems VALUES('old','request'); INSERT INTO engine_ui_intents(intent_id,format_version,project_id,plan_id,branch,conversation_id,kind,request_id,payload_json,status,revision,admission_system_id) VALUES('i','1','p','plan','feature/test','c','start','request','{}','admitted','1','old');").execute(&mut db).await.unwrap();
    let old_schema: String =
        sqlx::query_scalar("SELECT sql FROM sqlite_schema WHERE name='engine_ui_intents'")
            .fetch_one(&mut db)
            .await
            .unwrap();
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut db)
        .await
        .unwrap();
    sqlx::raw_sql(include_str!(
        "migrations/032_execution_ui_intent_start030.sql"
    ))
    .execute(&mut db)
    .await
    .unwrap();
    sqlx::query("ROLLBACK").execute(&mut db).await.unwrap();
    let schema: String =
        sqlx::query_scalar("SELECT sql FROM sqlite_schema WHERE name='engine_ui_intents'")
            .fetch_one(&mut db)
            .await
            .unwrap();
    assert_eq!(schema, old_schema);
    let old: (String, String) = sqlx::query_as(
        "SELECT status,admission_system_id FROM engine_ui_intents WHERE intent_id='i'",
    )
    .fetch_one(&mut db)
    .await
    .unwrap();
    assert_eq!(old, ("admitted".into(), "old".into()));
    sqlx::query("CREATE TABLE dependent_intent(id TEXT REFERENCES ENGINE_UI_INTENTS(intent_id))")
        .execute(&mut db)
        .await
        .unwrap();
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut db)
        .await
        .unwrap();
    assert!(sqlx::raw_sql(include_str!(
        "migrations/032_execution_ui_intent_start030.sql"
    ))
    .execute(&mut db)
    .await
    .is_err());
    sqlx::query("ROLLBACK").execute(&mut db).await.unwrap();
    let schema: String =
        sqlx::query_scalar("SELECT sql FROM sqlite_schema WHERE name='engine_ui_intents'")
            .fetch_one(&mut db)
            .await
            .unwrap();
    assert_eq!(schema, old_schema);
}
