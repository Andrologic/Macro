use super::*;
use tempfile::TempDir;

async fn fixture() -> (TempDir, SqlitePool) {
    let dir = tempfile::tempdir().unwrap();
    let pool = crate::db::create_pool(&dir.path().join("synthetic.db"))
        .await
        .unwrap();
    for id in ["a", "b", "c"] {
        sqlx::query("INSERT INTO conversations(id,title,created_at,updated_at) VALUES (?, 'Synthetic', '2026-01-01', '2026-01-01')").bind(id).execute(&pool).await.unwrap();
    }
    (dir, pool)
}
async fn message(pool: &SqlitePool, id: &str, owner: &str, role: &str, content: &str) {
    sqlx::query("INSERT INTO messages(id,conversation_id,role,content,created_at) VALUES (?,?,?,?,'2026-01-01T00:00:00Z')").bind(id).bind(owner).bind(role).bind(content).execute(pool).await.unwrap();
}
async fn token(pool: &SqlitePool, id: &str) -> ConversationContentToken {
    conversation_content_version(pool, id).await.unwrap()
}
fn metadata_input(id: &str) -> ConversationContentMetadataInput {
    ConversationContentMetadataInput {
        conversation_id: id.into(),
        expected_token: None,
        after: None,
        limit: 100,
    }
}
async fn window_input(pool: &SqlitePool, id: &str, ids: &[&str]) -> ConversationContentWindowInput {
    ConversationContentWindowInput {
        conversation_id: id.into(),
        expected_token: token(pool, id).await,
        ids: ids.iter().map(|id| (*id).into()).collect(),
    }
}
fn code<T: std::fmt::Debug>(result: DbResult<T>, expected: &str) {
    assert!(
        matches!(&result,Err(DbError::Validation(s)) if s == expected),
        "{result:?}"
    );
}
fn admitted<T: serde::Serialize>(value: &T, estimate: u64) {
    let n = serde_json::to_vec(value).unwrap().len() as u64;
    assert!(
        n <= estimate && estimate <= MAX_BYTES,
        "serialized={n}, estimate={estimate}"
    );
}

#[tokio::test]
async fn version_incarnation_overflow_rollback_reopen_and_missing_stamp() {
    let (dir, pool) = fixture().await;
    let initial = token(&pool, "a").await;
    check_token(&initial).unwrap();
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("UPDATE conversations SET title='rolled back' WHERE id='a'")
        .execute(&mut *tx)
        .await
        .unwrap();
    assert_ne!(token_in(&mut tx, "a", None).await.unwrap(), initial);
    assert_eq!(token(&pool, "a").await, initial);
    tx.rollback().await.unwrap();
    assert_eq!(token(&pool, "a").await, initial);
    sqlx::query("UPDATE conversation_content_versions SET revision=9223372036854775807 WHERE conversation_id='a'").execute(&pool).await.unwrap();
    let max = token(&pool, "a").await;
    assert_eq!(max.revision, "9223372036854775807");
    sqlx::query("UPDATE conversations SET title='overflow' WHERE id='a'")
        .execute(&pool)
        .await
        .unwrap();
    let wrapped = token(&pool, "a").await;
    assert_ne!(wrapped.incarnation, max.incarnation);
    assert!(wrapped.revision.parse::<i64>().unwrap() < 10);
    pool.close().await;
    let pool = crate::db::create_pool(&dir.path().join("synthetic.db"))
        .await
        .unwrap();
    assert_eq!(token(&pool, "a").await, wrapped);
    sqlx::query("DELETE FROM conversations WHERE id='a'")
        .execute(&pool)
        .await
        .unwrap();
    code(conversation_content_version(&pool, "a").await, "not_found");
    sqlx::query("INSERT INTO conversations(id,title,created_at,updated_at) VALUES ('a','New','2026','2026')").execute(&pool).await.unwrap();
    assert_ne!(token(&pool, "a").await.incarnation, wrapped.incarnation);
    sqlx::query("DELETE FROM conversation_content_versions WHERE conversation_id='a'")
        .execute(&pool)
        .await
        .unwrap();
    code(
        conversation_content_version(&pool, "a").await,
        "unavailable",
    );
    pool.close().await;
}

#[tokio::test]
async fn provenance_exact_namespace_and_all_observed_tables_invalidate() {
    let (_dir, pool) = fixture().await;
    message(&pool, "m", "a", "assistant", "é").await;
    message(&pool, "n", "b", "assistant", "other").await;
    let mut before = token(&pool, "a").await;
    for key in [
        "macroPilot:conversation-captures:v1:x",
        "Chat:assistant-visible-provenance:v1:m",
        "chat:assistant-visible-provenance:v1:mx",
        "chat:assistant-visible-provenance:v1:",
    ] {
        sqlx::query("INSERT INTO app_settings VALUES (?, '{}', 'now')")
            .bind(key)
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(token(&pool, "a").await, before);
    }
    for sql in [
        "INSERT INTO app_settings VALUES ('chat:assistant-visible-provenance:v1:m','raw','now')",
        "UPDATE app_settings SET updated_at='later' WHERE key='chat:assistant-visible-provenance:v1:m'",
        "UPDATE app_settings SET key='chat:assistant-visible-provenance:v1:n' WHERE key='chat:assistant-visible-provenance:v1:m'",
        "UPDATE messages SET role='user' WHERE id='m'",
        "UPDATE messages SET created_at='2025' WHERE id='m'",
        "UPDATE messages SET hidden_context='annex' WHERE id='m'",
        "UPDATE conversation_management SET archived=1 WHERE conversation_id='a'",
        "UPDATE conversation_response_versions SET read_revision=revision WHERE message_id='m'",
    ] {
        let b=token(&pool,"b").await;
        sqlx::query(sqlx::AssertSqlSafe(sql)).execute(&pool).await.unwrap();
        let next=token(&pool,"a").await;
        assert_ne!(next,before,"{sql}"); before=next;
        if sql.contains("SET key=") { assert_ne!(token(&pool,"b").await,b); }
    }
    let b = token(&pool, "b").await;
    // The existing response FK rejects an ID rename. Its statement rollback
    // must also discard all token changes. A conversation-only move is legal.
    assert!(
        sqlx::query("UPDATE messages SET conversation_id='b', id='moved' WHERE id='m'")
            .execute(&pool)
            .await
            .is_err()
    );
    assert_eq!(token(&pool, "a").await, before);
    assert_eq!(token(&pool, "b").await, b);
    sqlx::query("UPDATE messages SET conversation_id='b' WHERE id='m'")
        .execute(&pool)
        .await
        .unwrap();
    assert_ne!(token(&pool, "a").await, before);
    assert_ne!(token(&pool, "b").await, b);
    let moved = token(&pool, "b").await;
    sqlx::query("DELETE FROM messages WHERE id='m'")
        .execute(&pool)
        .await
        .unwrap();
    assert_ne!(token(&pool, "b").await, moved);
    pool.close().await;
}

#[tokio::test]
async fn metadata_empty_exact_anchor_totals_and_body_order() {
    let (_dir, pool) = fixture().await;
    let empty = conversation_content_metadata(&pool, &metadata_input("a"))
        .await
        .unwrap();
    assert!(empty.items.is_empty() && empty.next_after.is_none());
    assert_eq!(empty.opening.unwrap().total_exportable, "0");
    for (id, role) in [("m-z", "user"), ("m-a", "assistant"), ("m-tool", "tool")] {
        message(&pool, id, "a", role, "hello").await;
    }
    let mut input = metadata_input("a");
    input.limit = 1;
    let page = conversation_content_metadata(&pool, &input).await.unwrap();
    assert_eq!(page.items[0].id, "m-a");
    assert_eq!(page.opening.as_ref().unwrap().total_raw, "3");
    assert_eq!(page.opening.as_ref().unwrap().total_exportable, "2");
    admitted(&page, page.admission_estimate_bytes);
    input.expected_token = Some(page.token.clone());
    input.after = page.next_after;
    let page2 = conversation_content_metadata(&pool, &input).await.unwrap();
    assert!(page2.opening.is_none());
    assert_eq!(page2.items[0].role, "tool");
    assert!(serde_json::to_value(&page2)
        .unwrap()
        .get("opening")
        .is_none());
    input.after.as_mut().unwrap().created_at = "different".into();
    code(
        conversation_content_metadata(&pool, &input).await,
        "validation_failed",
    );
    let w = conversation_content_window(&pool, &window_input(&pool, "a", &["m-z", "m-a"]).await)
        .await
        .unwrap();
    assert_eq!(
        w.items.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
        ["m-z", "m-a"]
    );
    admitted(&w, w.admission_estimate_bytes);
    let mut input = metadata_input("a");
    input.expected_token = Some(page.token);
    sqlx::query("UPDATE messages SET content='changed' WHERE id='m-a'")
        .execute(&pool)
        .await
        .unwrap();
    code(
        conversation_content_metadata(&pool, &input).await,
        "stale_revision",
    );
    pool.close().await;
}

#[tokio::test]
async fn validates_full_requested_set_and_request_before_sql() {
    let (_dir, pool) = fixture().await;
    message(&pool, "good", "a", "user", "x").await;
    message(&pool, "other", "b", "user", "x").await;
    message(&pool, "tool", "a", "tool", "x").await;
    for ids in [
        vec![],
        vec!["good", "good"],
        vec!["good", "missing"],
        vec!["good", "other"],
        vec!["good", "tool"],
        vec!["bad/id"],
    ] {
        code(
            conversation_content_window(&pool, &window_input(&pool, "a", &ids).await).await,
            "validation_failed",
        );
    }
    let token = token(&pool, "a").await;
    pool.close().await;
    let input = ConversationContentWindowInput {
        conversation_id: "a".into(),
        expected_token: token.clone(),
        ids: vec!["x".into(); 101],
    };
    code(
        conversation_content_window(&pool, &input).await,
        "validation_failed",
    );
    let input = ConversationContentMetadataInput {
        conversation_id: "a".into(),
        expected_token: Some(token),
        after: Some(ConversationContentAnchor {
            id: "good".into(),
            created_at: "x".repeat(MAX_BYTES as usize),
        }),
        limit: 1,
    };
    code(
        conversation_content_metadata(&pool, &input).await,
        "resource_limit",
    );
}

#[tokio::test]
async fn concurrent_commit_between_admission_and_fetch_keeps_one_snapshot() {
    let (_dir, pool) = fixture().await;
    message(&pool, "m", "a", "assistant", "before").await;
    sqlx::query("INSERT INTO app_settings VALUES ('chat:assistant-visible-provenance:v1:m','receipt-before','now')").execute(&pool).await.unwrap();
    let input = window_input(&pool, "a", &["m"]).await;
    let original_revision: i64 = sqlx::query_scalar(
        "SELECT revision FROM conversation_response_versions WHERE message_id='m'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let mut reader = pool.begin().await.unwrap();
    let pinned = token_in(&mut reader, "a", Some(&input.expected_token))
        .await
        .unwrap();
    let sizes = body_sizes(&mut reader, &input).await.unwrap();
    let count = admit_body(&sizes).unwrap().0;
    let (go, ready) = tokio::sync::oneshot::channel();
    let (done, committed) = tokio::sync::oneshot::channel();
    let writer_pool = pool.clone();
    let writer = tokio::spawn(async move {
        ready.await.unwrap();
        let mut tx = writer_pool.begin().await.unwrap();
        sqlx::query("UPDATE messages SET content='after' WHERE id='m'")
            .execute(&mut *tx)
            .await
            .unwrap();
        sqlx::query("UPDATE app_settings SET value_json='receipt-after' WHERE key='chat:assistant-visible-provenance:v1:m'").execute(&mut *tx).await.unwrap();
        tx.commit().await.unwrap();
        done.send(()).unwrap();
    });
    go.send(()).unwrap();
    committed.await.unwrap();
    let old = fetch_body(&mut reader, &sizes[..count]).await.unwrap();
    assert_eq!(old[0].content, "before");
    assert_eq!(
        old[0].response_revision_decimal,
        Some(original_revision.to_string())
    );
    assert_eq!(old[0].provenance_json.as_deref(), Some("receipt-before"));
    assert_eq!(token_in(&mut reader, "a", None).await.unwrap(), pinned);
    reader.commit().await.unwrap();
    writer.await.unwrap();
    code(
        conversation_content_window(&pool, &input).await,
        "stale_revision",
    );
    let new = conversation_content_window(&pool, &window_input(&pool, "a", &["m"]).await)
        .await
        .unwrap();
    assert_eq!(new.items[0].content, "after");
    assert_eq!(
        new.items[0].provenance_json.as_deref(),
        Some("receipt-after")
    );
    pool.close().await;
}

#[tokio::test]
async fn replace_conflicts_cover_all_victims_and_failed_dml_rolls_back() {
    for recursive in [false, true] {
        for table in [
            "messages",
            "app_settings",
            "conversation_management",
            "conversation_response_versions",
        ] {
            for update in [false, true] {
                let (_dir, pool) = fixture().await;
                // Keep the real management, response and FTS triggers installed.
                for (id, owner) in [("ma", "a"), ("mb", "b"), ("mc", "c")] {
                    message(&pool, id, owner, "user", "same").await;
                }
                // One connection owns this fixture's PRAGMA and every tested DML.
                let mut db = pool.acquire().await.unwrap();
                sqlx::query(if recursive {
                    "PRAGMA recursive_triggers=ON"
                } else {
                    "PRAGMA recursive_triggers=OFF"
                })
                .execute(&mut *db)
                .await
                .unwrap();
                if table == "app_settings" {
                    for id in ["ma", "mb", "mc"] {
                        sqlx::query("INSERT INTO app_settings VALUES (?,'raw','now')")
                            .bind(format!("{PROVENANCE_PREFIX}{id}"))
                            .execute(&mut *db)
                            .await
                            .unwrap();
                    }
                }
                if table == "conversation_response_versions" {
                    sqlx::query("INSERT INTO conversation_response_versions SELECT id,conversation_id,1,0 FROM messages").execute(&mut *db).await.unwrap();
                }
                let key = match table {
                    "messages" => "id",
                    "app_settings" => "key",
                    "conversation_management" => "conversation_id",
                    _ => "message_id",
                };
                let a = if table == "app_settings" {
                    format!("{PROVENANCE_PREFIX}ma")
                } else if table == "conversation_management" {
                    "a".into()
                } else {
                    "ma".into()
                };
                let b = if table == "app_settings" {
                    format!("{PROVENANCE_PREFIX}mb")
                } else if table == "conversation_management" {
                    "b".into()
                } else {
                    "mb".into()
                };
                let c = if table == "app_settings" {
                    format!("{PROVENANCE_PREFIX}mc")
                } else if table == "conversation_management" {
                    "c".into()
                } else {
                    "mc".into()
                };
                let rowid: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
                    "SELECT rowid FROM {table} WHERE {key}=?"
                )))
                .bind(&b)
                .fetch_one(&mut *db)
                .await
                .unwrap();
                let mut before = Vec::new();
                for id in ["a", "b", "c"] {
                    before.push(token_in(&mut db, id, None).await.unwrap());
                }
                let sql = if update {
                    format!(
                        "UPDATE OR REPLACE {table} SET {key}=?, rowid=?{} WHERE {key}=?",
                        if table == "messages" || table == "conversation_response_versions" {
                            ",conversation_id='c'"
                        } else {
                            ""
                        }
                    )
                } else {
                    match table {
                    "messages"=>"INSERT OR REPLACE INTO messages(id,rowid,conversation_id,role,content,created_at) VALUES (?,?,'c','user','same','2026')".into(),
                    "app_settings"=>"INSERT OR REPLACE INTO app_settings(key,rowid,value_json,updated_at) VALUES (?,?,'replaced','now')".into(),
                    "conversation_management"=>"INSERT OR REPLACE INTO conversation_management(conversation_id,rowid) VALUES (?,?)".into(),
                    _=>"INSERT OR REPLACE INTO conversation_response_versions(message_id,rowid,conversation_id,revision) VALUES (?,?,'c',1)".into(),
                }
                };
                let mut query = sqlx::query(sqlx::AssertSqlSafe(sql)).bind(&a).bind(rowid);
                if update {
                    query = query.bind(&c);
                }
                query.execute(&mut *db).await.unwrap();
                for (index, id) in ["a", "b", "c"].into_iter().enumerate() {
                    if index < 2
                        || update
                        || table == "messages"
                        || table == "conversation_response_versions"
                    {
                        assert_ne!(
                            token_in(&mut db, id, None).await.unwrap(),
                            before[index],
                            "{table} update={update} recursive={recursive} owner={id}"
                        );
                    }
                }
                // A failed statement must not leak a BEFORE victim bump.
                let unchanged = token_in(&mut db, "a", None).await.unwrap();
                let result=sqlx::query("INSERT OR REPLACE INTO messages(id,rowid,conversation_id,role,content,created_at) VALUES ('ma',999,'missing','user','x','2026')").execute(&mut *db).await;
                assert!(result.is_err());
                assert_eq!(token_in(&mut db, "a", None).await.unwrap(), unchanged);
                drop(db);
                pool.close().await;
            }
        }
    }
}

// A real engine trace witness, scoped to a single-connection synthetic pool.
// Interruption makes an unexpected body/descriptor SELECT fail before decoding.
pub(crate) struct FetchProbe {
    pub(crate) catalogs: std::sync::atomic::AtomicUsize,
    pub(crate) catalog_pause: std::sync::atomic::AtomicBool,
    pub(crate) catalog_started: std::sync::atomic::AtomicBool,
    pub(crate) catalog_release: std::sync::atomic::AtomicBool,
    pub(crate) bodies: std::sync::atomic::AtomicUsize,
    pub(crate) descriptors: std::sync::atomic::AtomicUsize,
    pub(crate) deny: std::sync::atomic::AtomicU8,
    pub(crate) oversized_rows: std::sync::atomic::AtomicUsize,
}
unsafe extern "C" fn trace_fetch(
    event: u32,
    context: *mut std::ffi::c_void,
    statement: *mut std::ffi::c_void,
    _: *mut std::ffi::c_void,
) -> i32 {
    use std::sync::atomic::Ordering::SeqCst;
    // SAFETY: SQLite owns an Arc through the probe-owner function until close;
    // both trace events supply a live statement.
    let probe = unsafe { &*(context as *const FetchProbe) };
    let stmt = statement as *mut libsqlite3_sys::sqlite3_stmt;
    if event == libsqlite3_sys::SQLITE_TRACE_ROW as u32 {
        // Observe actual engine result values before SQLx duplicates the row.
        // typeof/CASE projections must never emit an oversized TEXT or BLOB.
        for column in 0..unsafe { libsqlite3_sys::sqlite3_column_count(stmt) } {
            let kind = unsafe { libsqlite3_sys::sqlite3_column_type(stmt, column) };
            if matches!(
                kind,
                libsqlite3_sys::SQLITE_TEXT | libsqlite3_sys::SQLITE_BLOB
            ) && unsafe { libsqlite3_sys::sqlite3_column_bytes(stmt, column) } as u64 > MAX_BYTES
            {
                probe.oversized_rows.fetch_add(1, SeqCst);
            }
        }
        return 0;
    }
    if event != libsqlite3_sys::SQLITE_TRACE_STMT as u32 {
        return 0;
    }
    let sql =
        unsafe { std::ffi::CStr::from_ptr(libsqlite3_sys::sqlite3_sql(stmt)) }.to_string_lossy();
    if sql.starts_with("SELECT incarnation, revision FROM conversation_catalog_version")
        && probe.catalog_pause.load(SeqCst)
    {
        probe.catalog_started.store(true, SeqCst);
        let end = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !probe.catalog_release.load(SeqCst) && std::time::Instant::now() < end {
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
    }
    let body = sql.starts_with("SELECT m.id, m.conversation_id, m.role, m.content,");
    let descriptor = sql.starts_with("SELECT id, conversation_id, role, created_at FROM messages");
    let catalog = sql.starts_with("SELECT id, title, description, scope_mode, task_id, group_id, project_id, provider_id, model_id, reasoning_effort, created_at, updated_at, last_message, message_count, is_pinned FROM conversations WHERE rowid =");
    if catalog {
        probe.catalogs.fetch_add(1, SeqCst);
    }
    if body {
        probe.bodies.fetch_add(1, SeqCst);
    }
    if descriptor {
        probe.descriptors.fetch_add(1, SeqCst);
    }
    if (probe.deny.load(SeqCst) == 4 && (sql.contains("messages") || sql.contains("COUNT(")))
        || (catalog && probe.deny.load(SeqCst) == 5)
        || (body && probe.deny.load(SeqCst) == 1)
        || (descriptor && probe.deny.load(SeqCst) == 2)
    {
        unsafe {
            libsqlite3_sys::sqlite3_interrupt(libsqlite3_sys::sqlite3_db_handle(stmt));
        }
    }
    0
}
unsafe extern "C" fn probe_owner_function(
    context: *mut libsqlite3_sys::sqlite3_context,
    _: i32,
    _: *mut *mut libsqlite3_sys::sqlite3_value,
) {
    // SAFETY: SQLite supplies its live function context.
    unsafe {
        libsqlite3_sys::sqlite3_result_null(context);
    }
}
unsafe extern "C" fn drop_probe_owner(context: *mut std::ffi::c_void) {
    // SAFETY: exactly the Arc transferred to sqlite3_create_function_v2, called
    // once by SQLite on connection destruction or failed registration.
    unsafe {
        drop(std::sync::Arc::from_raw(context as *const FetchProbe));
    }
}
pub(crate) async fn probe_pool(dir: &TempDir) -> (SqlitePool, std::sync::Arc<FetchProbe>) {
    let options = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(dir.path().join("synthetic.db"))
        .foreign_keys(true);
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .unwrap();
    let probe = std::sync::Arc::new(FetchProbe {
        catalogs: 0.into(),
        catalog_pause: false.into(),
        catalog_started: false.into(),
        catalog_release: false.into(),
        bodies: 0.into(),
        descriptors: 0.into(),
        deny: 0.into(),
        oversized_rows: 0.into(),
    });
    let mut connection = pool.acquire().await.unwrap();
    let mut handle = connection.lock_handle().await.unwrap();
    // SQLite keeps its own Arc until connection destruction, including when a
    // test panics before stop_probe. The destructor releases that owner only
    // after no engine callback can still use it.
    let owner = std::sync::Arc::into_raw(probe.clone()).cast_mut().cast();
    // SAFETY: exclusive SQLx handle; SQLite receives one Arc with an exact
    // matching destructor. This inert test function is never invoked by SQL.
    let registered = unsafe {
        libsqlite3_sys::sqlite3_create_function_v2(
            handle.as_raw_handle().as_ptr(),
            c"c1a_probe_owner".as_ptr(),
            0,
            libsqlite3_sys::SQLITE_UTF8,
            owner,
            Some(probe_owner_function),
            None,
            None,
            Some(drop_probe_owner),
        )
    };
    // SQLite invokes the destructor even if registration fails.
    assert_eq!(registered, libsqlite3_sys::SQLITE_OK);
    // SAFETY: exclusive handle, fixed callback, lifetime anchored above.
    assert_eq!(
        unsafe {
            libsqlite3_sys::sqlite3_trace_v2(
                handle.as_raw_handle().as_ptr(),
                (libsqlite3_sys::SQLITE_TRACE_STMT | libsqlite3_sys::SQLITE_TRACE_ROW) as u32,
                Some(trace_fetch),
                owner,
            )
        },
        libsqlite3_sys::SQLITE_OK
    );
    drop(handle);
    drop(connection);
    (pool, probe)
}

#[tokio::test]
async fn admission_refuses_before_fetch_and_probe_has_active_negative_control() {
    use std::sync::atomic::Ordering::SeqCst;
    let (dir, pool) = fixture().await;
    message(&pool, "small", "a", "user", "short").await;
    message(&pool, "big", "a", "assistant", "short").await;
    sqlx::query(
        "INSERT INTO app_settings VALUES ('chat:assistant-visible-provenance:v1:big',?,'now')",
    )
    .bind("é".repeat(400_000))
    .execute(&pool)
    .await
    .unwrap();
    pool.close().await;
    let (pool, probe) = probe_pool(&dir).await;
    probe.deny.store(4, SeqCst);
    token(&pool, "a").await;
    assert_eq!(probe.bodies.load(SeqCst), 0);
    probe.deny.store(1, SeqCst);
    let big = window_input(&pool, "a", &["big"]).await;
    code(
        conversation_content_window(&pool, &big).await,
        "resource_limit",
    );
    assert_eq!(probe.bodies.load(SeqCst), 0);
    // Validates missing IDs even beyond an individually inadmissible first row.
    let invalid = window_input(&pool, "a", &["big", "missing"]).await;
    code(
        conversation_content_window(&pool, &invalid).await,
        "validation_failed",
    );
    assert_eq!(probe.bodies.load(SeqCst), 0);
    let small = window_input(&pool, "a", &["small"]).await;
    code(
        conversation_content_window(&pool, &small).await,
        "unavailable",
    );
    assert_eq!(
        probe.bodies.load(SeqCst),
        1,
        "witness must actually interrupt an admitted fetch"
    );
    probe.deny.store(0, SeqCst);
    let prefix =
        conversation_content_window(&pool, &window_input(&pool, "a", &["small", "big"]).await)
            .await
            .unwrap();
    assert_eq!(prefix.consumed_count, 1);
    assert_eq!(probe.bodies.load(SeqCst), 2);
    admitted(&prefix, prefix.admission_estimate_bytes);
    // A catalogue reads descriptors despite the unusable future receipt.
    let page = conversation_content_metadata(&pool, &metadata_input("a"))
        .await
        .unwrap();
    assert_eq!(page.items.len(), 2);
    assert_eq!(probe.bodies.load(SeqCst), 2);
    sqlx::query("UPDATE conversations SET description=? WHERE id='a'")
        .bind("x".repeat(700_000))
        .execute(&pool)
        .await
        .unwrap();
    code(
        conversation_content_metadata(&pool, &metadata_input("a")).await,
        "resource_limit",
    );
    assert_eq!(probe.descriptors.load(SeqCst), 2);
    // No connection/statement retains the C callback after close.
    stop_probe(&pool).await;
    drop(probe);
}

#[tokio::test]
async fn descriptor_admission_counts_actual_long_anchor_before_fetch() {
    use std::sync::atomic::Ordering::SeqCst;
    let (dir, pool) = fixture().await;
    message(&pool, "a-long", "a", "user", "small").await;
    message(&pool, "z-small", "a", "user", "small").await;
    sqlx::query("UPDATE messages SET created_at=? WHERE id='a-long'")
        .bind("0".repeat(360_000))
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
    let (pool, probe) = probe_pool(&dir).await;
    probe.deny.store(2, SeqCst);
    let mut input = metadata_input("a");
    input.limit = 1;
    // The descriptor fits alone, but its actual continuation anchor doubles the date.
    code(
        conversation_content_metadata(&pool, &input).await,
        "resource_limit",
    );
    assert_eq!(probe.descriptors.load(SeqCst), 0);
    input.limit = 2;
    code(
        conversation_content_metadata(&pool, &input).await,
        "unavailable",
    );
    assert_eq!(probe.descriptors.load(SeqCst), 1);
    probe.deny.store(0, SeqCst);
    let complete = conversation_content_metadata(&pool, &input).await.unwrap();
    assert_eq!(complete.items.len(), 2);
    assert!(complete.next_after.is_none());
    admitted(&complete, complete.admission_estimate_bytes);
    stop_probe(&pool).await;
    drop(probe);
}

#[tokio::test]
async fn useful_fields_receipt_utf8_escapes_null_and_omitted_annexes() {
    let (_dir, pool) = fixture().await;
    let content = "é🙂\"\\\n\0".repeat(500);
    message(&pool, "m", "a", "assistant", &content).await;
    sqlx::query("UPDATE messages SET completion_reason='completed', provider_turn_state_json=?, tool_traces_json='[]', hidden_context=?, provider_input_items_json=?, context_refs_json=?, generation_attempts_json=?, turn_id=? WHERE id='m'")
        .bind("{\"é\":\"🙂\"}").bind("h".repeat(800_000)).bind("i".repeat(800_000)).bind("c".repeat(800_000)).bind("g".repeat(800_000)).bind("t".repeat(800_000)).execute(&pool).await.unwrap();
    let receipt = "\"\\\0é🙂".repeat(1000);
    sqlx::query(
        "INSERT INTO app_settings VALUES ('chat:assistant-visible-provenance:v1:m',?,'now')",
    )
    .bind(&receipt)
    .execute(&pool)
    .await
    .unwrap();
    let w = conversation_content_window(&pool, &window_input(&pool, "a", &["m"]).await)
        .await
        .unwrap();
    assert_eq!(w.items[0].content, content);
    assert_eq!(
        w.items[0].provenance_json.as_deref(),
        Some(receipt.as_str())
    );
    assert_eq!(
        w.items[0].provider_turn_state_json.as_deref(),
        Some("{\"é\":\"🙂\"}")
    );
    assert_eq!(
        serde_json::to_value(&w.items[0])
            .unwrap()
            .as_object()
            .unwrap()
            .len(),
        10
    );
    admitted(&w, w.admission_estimate_bytes);
    for field in ["content", "tool_traces_json", "provider_turn_state_json"] {
        let mut tx = pool.begin().await.unwrap();
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "UPDATE messages SET {field}=? WHERE id='m'"
        )))
        .bind("x".repeat(700_000))
        .execute(&mut *tx)
        .await
        .unwrap();
        tx.commit().await.unwrap();
        code(
            conversation_content_window(&pool, &window_input(&pool, "a", &["m"]).await).await,
            "resource_limit",
        );
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "UPDATE messages SET {field}='small' WHERE id='m'"
        )))
        .execute(&pool)
        .await
        .unwrap();
    }
    message(&pool, "user", "a", "user", "null fields").await;
    let w = conversation_content_window(&pool, &window_input(&pool, "a", &["user"]).await)
        .await
        .unwrap();
    assert!(w.items[0].completion_reason.is_none() && w.items[0].provenance_json.is_none());
    admitted(&w, w.admission_estimate_bytes);
    assert!(text_cost(u64::MAX).is_err() && add(u64::MAX, 1).is_err());
    pool.close().await;
}

#[tokio::test]
async fn ten_thousand_descriptors_then_explicit_windows_are_exhaustive() {
    use std::sync::atomic::Ordering::SeqCst;
    let (dir, pool) = fixture().await;
    let mut tx = pool.begin().await.unwrap();
    for n in 0..10_000 {
        sqlx::query("INSERT INTO messages(id,conversation_id,role,content,created_at) VALUES (?,'a',?,'small',?)")
            .bind(format!("m{n:05}")).bind(if n%2==0 {"user"}else{"assistant"})
            .bind(if n%3==0 {"2026-01-01T00:00:00+01:00"}else if n%3==1 {"2026-01-01T00:00:00-01:00"}else{"2026-01-01T00:00:00Z"})
            .execute(&mut *tx).await.unwrap();
    }
    tx.commit().await.unwrap();
    pool.close().await;
    let (pool, probe) = probe_pool(&dir).await;
    let mut input = metadata_input("a");
    let mut descriptors = Vec::new();
    let mut retained = 0;
    loop {
        let page = conversation_content_metadata(&pool, &input).await.unwrap();
        admitted(&page, page.admission_estimate_bytes);
        if input.after.is_none() {
            assert_eq!(page.opening.as_ref().unwrap().total_exportable, "10000");
        } else {
            assert!(page.opening.is_none());
        }
        retained += serde_json::to_vec(&page).unwrap().len() + page.items.len() * 128;
        assert_eq!(probe.bodies.load(SeqCst), 0);
        descriptors.extend(page.items);
        input.expected_token = Some(page.token);
        input.after = page.next_after;
        if input.after.is_none() {
            break;
        }
    }
    assert!(retained < 24 * 1024 * 1024);
    assert_eq!(descriptors.len(), 10_000);
    assert_eq!(
        descriptors
            .iter()
            .map(|d| &d.id)
            .collect::<HashSet<_>>()
            .len(),
        10_000
    );
    // Data required by the unchanged TS localeCompare/ID sort are exact. Here an
    // explicit reverse-ID order also proves that body windows never apply BINARY.
    descriptors.sort_by(|a, b| b.id.cmp(&a.id));
    let expected = token(&pool, "a").await;
    let mut consumed = 0;
    for chunk in descriptors.chunks(100) {
        let w = conversation_content_window(
            &pool,
            &ConversationContentWindowInput {
                conversation_id: "a".into(),
                expected_token: expected.clone(),
                ids: chunk.iter().map(|d| d.id.clone()).collect(),
            },
        )
        .await
        .unwrap();
        assert_eq!(
            w.items.iter().map(|m| &m.id).collect::<Vec<_>>(),
            chunk.iter().map(|d| &d.id).collect::<Vec<_>>()
        );
        for (body, d) in w.items.iter().zip(chunk) {
            assert_eq!(body.created_at, d.created_at);
            assert_eq!(body.role, d.role);
        }
        consumed += w.consumed_count as usize;
        admitted(&w, w.admission_estimate_bytes);
        assert_eq!(probe.bodies.load(SeqCst), consumed);
    }
    assert_eq!(consumed, 10_000);
    pool.close().await;
    drop(probe);
}

async fn stop_probe(pool: &SqlitePool) {
    let mut connection = pool.acquire().await.unwrap();
    let mut handle = connection.lock_handle().await.unwrap();
    // SAFETY: exclusive handle; unregister before pool close. SQLite owns its
    // separate context reference until the actual connection destruction.
    assert_eq!(
        unsafe {
            libsqlite3_sys::sqlite3_trace_v2(
                handle.as_raw_handle().as_ptr(),
                0,
                None,
                std::ptr::null_mut(),
            )
        },
        libsqlite3_sys::SQLITE_OK
    );
    drop(handle);
    drop(connection);
    pool.close().await;
}

#[tokio::test]
async fn migration_backfill_stamp_failure_rolls_back_and_schema_damage_is_rejected() {
    let (dir, pool) = fixture().await;
    crate::db::inactive_storage::tests::remove_reference_schema_in(
        &mut *pool.acquire().await.unwrap(),
    )
    .await;
    message(&pool, "old", "a", "assistant", "old content").await;
    sqlx::query("INSERT INTO app_settings VALUES ('chat:assistant-visible-provenance:v1:old','old receipt','now')").execute(&pool).await.unwrap();
    crate::db::conversation_catalog::remove_reference_schema(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM schema_migrations WHERE version=14")
        .execute(&pool)
        .await
        .unwrap();
    remove_reference_schema(&pool).await.unwrap();
    sqlx::raw_sql("DELETE FROM schema_migrations WHERE version=13; CREATE TRIGGER reject_content_stamp BEFORE INSERT ON schema_migrations WHEN NEW.version=13 BEGIN SELECT RAISE(ABORT,'synthetic migration failure'); END;").execute(&pool).await.unwrap();
    assert!(crate::db::run_migrations(&pool).await.is_err());
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT COUNT(*) FROM sqlite_master WHERE name='conversation_content_versions' OR name GLOB 'content_versions_*'").fetch_one(&pool).await.unwrap(),0);
    sqlx::query("DROP TRIGGER reject_content_stamp")
        .execute(&pool)
        .await
        .unwrap();
    crate::db::run_migrations(&pool).await.unwrap();
    let w = conversation_content_window(&pool, &window_input(&pool, "a", &["old"]).await)
        .await
        .unwrap();
    assert_eq!(w.items[0].content, "old content");
    assert_eq!(w.items[0].provenance_json.as_deref(), Some("old receipt"));
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM conversation_content_versions")
            .fetch_one(&pool)
            .await
            .unwrap(),
        3
    );
    sqlx::query("DROP TRIGGER content_versions_messages_insert")
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
    assert!(crate::db::create_pool(&dir.path().join("synthetic.db"))
        .await
        .is_err());
}

#[tokio::test]
async fn conversation_creation_trigger_order_replace_and_id_changes() {
    for recursive in [false, true] {
        let (_dir, pool) = fixture().await;
        let mut db = pool.acquire().await.unwrap();
        sqlx::query(if recursive {
            "PRAGMA recursive_triggers=ON"
        } else {
            "PRAGMA recursive_triggers=OFF"
        })
        .execute(&mut *db)
        .await
        .unwrap();
        // Exercise both creation orders with the actual stored trigger definitions.
        let management: String = sqlx::query_scalar(
            "SELECT sql FROM sqlite_master WHERE name='conversation_management_insert'",
        )
        .fetch_one(&mut *db)
        .await
        .unwrap();
        let content: String = sqlx::query_scalar(
            "SELECT sql FROM sqlite_master WHERE name='content_versions_conversations_insert'",
        )
        .fetch_one(&mut *db)
        .await
        .unwrap();
        for reverse in [false, true] {
            sqlx::raw_sql("DROP TRIGGER conversation_management_insert; DROP TRIGGER content_versions_conversations_insert;").execute(&mut *db).await.unwrap();
            for sql in if reverse {
                [&content, &management]
            } else {
                [&management, &content]
            } {
                sqlx::raw_sql(sqlx::AssertSqlSafe(sql.as_str()))
                    .execute(&mut *db)
                    .await
                    .unwrap();
            }
            let id = if reverse {
                "new-reverse"
            } else {
                "new-forward"
            };
            sqlx::query("INSERT INTO conversations(id,title,created_at,updated_at) VALUES (?,'Synthetic','now','now')").bind(id).execute(&mut *db).await.unwrap();
            check_token(&token_in(&mut db, id, None).await.unwrap()).unwrap();
        }
        let old = token_in(&mut db, "a", None).await.unwrap();
        sqlx::query("INSERT OR REPLACE INTO conversations(id,title,created_at,updated_at) VALUES ('a','Replaced','now','now')").execute(&mut *db).await.unwrap();
        assert_ne!(
            token_in(&mut db, "a", None).await.unwrap().incarnation,
            old.incarnation
        );
        let before = token_in(&mut db, "a", None).await.unwrap();
        // Existing management FK makes this rename illegal. No partial stamp survives.
        assert!(
            sqlx::query("UPDATE OR REPLACE conversations SET id='b' WHERE id='a'")
                .execute(&mut *db)
                .await
                .is_err()
        );
        assert_eq!(token_in(&mut db, "a", None).await.unwrap(), before);
        sqlx::query("DELETE FROM conversation_management WHERE conversation_id IN ('a','b')")
            .execute(&mut *db)
            .await
            .unwrap();
        sqlx::query("UPDATE OR REPLACE conversations SET id='b' WHERE id='a'")
            .execute(&mut *db)
            .await
            .unwrap();
        code(token_in(&mut db, "a", None).await, "not_found");
        assert_ne!(
            token_in(&mut db, "b", None).await.unwrap().incarnation,
            before.incarnation
        );
        drop(db);
        pool.close().await;
    }
}

#[tokio::test]
async fn orphan_provenance_and_real_cas_invalidate_only_owners() {
    let (_dir, pool) = fixture().await;
    let a = token(&pool, "a").await;
    let key = format!("{PROVENANCE_PREFIX}later");
    assert!(
        crate::db::repository::compare_and_swap_app_setting(&pool, &key, None, "orphan")
            .await
            .unwrap()
            .applied
    );
    assert_eq!(token(&pool, "a").await, a);
    message(&pool, "later", "a", "assistant", "body").await;
    let before = window_input(&pool, "a", &["later"]).await;
    assert_eq!(
        conversation_content_window(&pool, &before)
            .await
            .unwrap()
            .items[0]
            .provenance_json
            .as_deref(),
        Some("orphan")
    );
    assert!(
        crate::db::repository::compare_and_swap_app_setting(&pool, &key, Some("orphan"), "new")
            .await
            .unwrap()
            .applied
    );
    code(
        conversation_content_window(&pool, &before).await,
        "stale_revision",
    );
    let after = token(&pool, "a").await;
    assert!(
        !crate::db::repository::compare_and_swap_app_setting(
            &pool,
            &key,
            Some("orphan"),
            "conflict"
        )
        .await
        .unwrap()
        .applied
    );
    assert_eq!(token(&pool, "a").await, after);
    assert!(
        crate::db::repository::compare_and_swap_app_setting(
            &pool,
            "macroPilot:conversation-captures:v1:synthetic",
            None,
            "journal"
        )
        .await
        .unwrap()
        .applied
    );
    assert_eq!(token(&pool, "a").await, after);
    pool.close().await;
}

#[tokio::test]
async fn opening_keeps_i64_decimal_precision_and_handles_unreadable_numeric_fields() {
    let (_dir, pool) = fixture().await;
    message(&pool, "m", "a", "assistant", "body").await;
    sqlx::query(
        "UPDATE conversation_management SET revision=9007199254740993 WHERE conversation_id='a'",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("UPDATE conversation_response_versions SET revision=9007199254740995,read_revision=9007199254740995 WHERE message_id='m'").execute(&pool).await.unwrap();
    let page = conversation_content_metadata(&pool, &metadata_input("a"))
        .await
        .unwrap();
    let metadata = &page.opening.as_ref().unwrap().metadata;
    assert_eq!(metadata.revision, "9007199254740993");
    assert_eq!(metadata.response_revision, "9007199254740995");
    assert_eq!(metadata.read_revision, "9007199254740995");
    admitted(&page, page.admission_estimate_bytes);
    sqlx::query("UPDATE conversations SET message_count='unreadable' WHERE id='a'")
        .execute(&pool)
        .await
        .unwrap();
    code(
        conversation_content_metadata(&pool, &metadata_input("a")).await,
        "unavailable",
    );
    pool.close().await;
}

#[tokio::test]
async fn native_runtime_diagnostic_is_schema15_wal_normal_fk() {
    let (_dir, pool) = fixture().await;
    let sqlite: String = sqlx::query_scalar("SELECT sqlite_version()")
        .fetch_one(&pool)
        .await
        .unwrap();
    let migrations: Vec<i64> =
        sqlx::query_scalar("SELECT version FROM schema_migrations ORDER BY version")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(migrations, [1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    let mut db = pool.acquire().await.unwrap();
    let journal: String = sqlx::query_scalar("PRAGMA journal_mode")
        .fetch_one(&mut *db)
        .await
        .unwrap();
    let synchronous: i64 = sqlx::query_scalar("PRAGMA synchronous")
        .fetch_one(&mut *db)
        .await
        .unwrap();
    let fk: i64 = sqlx::query_scalar("PRAGMA foreign_keys")
        .fetch_one(&mut *db)
        .await
        .unwrap();
    assert_eq!((journal.as_str(), synchronous, fk), ("wal", 1, 1));
    eprintln!(
        "C1A_DIAGNOSTIC {}",
        serde_json::json!({"pid":std::process::id(),"sqlite":sqlite,"migrations":migrations,"journal":journal,"synchronous":synchronous,"foreign_keys":fk,"timings":false,"memory_claim":false})
    );
    drop(db);
    pool.close().await;
}

#[tokio::test]
async fn opening_rejects_oversized_untyped_scalars_before_any_result_fetch() {
    use std::sync::atomic::Ordering::SeqCst;
    for (table, column, owner) in [
        ("conversation_management", "revision", "conversation_id"),
        ("conversation_management", "archived", "conversation_id"),
        ("conversations", "message_count", "id"),
        ("conversations", "is_pinned", "id"),
        (
            "conversation_response_versions",
            "revision",
            "conversation_id",
        ),
        (
            "conversation_response_versions",
            "read_revision",
            "conversation_id",
        ),
    ] {
        for blob in [false, true] {
            let (dir, pool) = fixture().await;
            message(&pool, "m", "a", "assistant", "small").await;
            let query = format!("UPDATE {table} SET {column} = ? WHERE {owner} = 'a'");
            if blob {
                sqlx::query(sqlx::AssertSqlSafe(query))
                    .bind(vec![b'x'; 5_000_000])
                    .execute(&pool)
                    .await
                    .unwrap();
            } else {
                sqlx::query(sqlx::AssertSqlSafe(query))
                    .bind("x".repeat(5_000_000))
                    .execute(&pool)
                    .await
                    .unwrap();
            }
            validate_schema(&mut pool.acquire().await.unwrap())
                .await
                .unwrap();
            assert_eq!(
                sqlx::query_scalar::<_, String>("PRAGMA integrity_check")
                    .fetch_one(&pool)
                    .await
                    .unwrap(),
                "ok"
            );
            assert!(sqlx::query("PRAGMA foreign_key_check")
                .fetch_all(&pool)
                .await
                .unwrap()
                .is_empty());
            pool.close().await;
            let (pool, probe) = probe_pool(&dir).await;
            code(
                conversation_content_metadata(&pool, &metadata_input("a")).await,
                "unavailable",
            );
            let oversized = probe.oversized_rows.load(SeqCst);
            assert_eq!(oversized, 0, "{table}.{column} blob={blob}: oversized scalar crossed an SQL result before refusal");
            assert_eq!(probe.bodies.load(SeqCst), 0);
            assert_eq!(probe.descriptors.load(SeqCst), 0);
            // Active negative control: select exactly the stored value without
            // a guard. The same engine witness must observe its 5 MB payload.
            let control = format!("SELECT {column} FROM {table} WHERE {owner} = 'a'");
            drop(
                sqlx::query(sqlx::AssertSqlSafe(control))
                    .fetch_one(&pool)
                    .await
                    .unwrap(),
            );
            assert_eq!(
                probe.oversized_rows.load(SeqCst),
                1,
                "inactive ROW witness for {table}.{column} blob={blob}"
            );
            eprintln!(
                "C1A_NUMERIC_ADMISSION {}",
                serde_json::json!({"table":table,"column":column,"kind":if blob {"blob"}else{"text"},"port_oversized_rows":oversized,"negative_control_oversized_rows":probe.oversized_rows.load(SeqCst)})
            );
            stop_probe(&pool).await;
            drop(probe);
        }
    }
}

#[tokio::test]
async fn opening_rejects_small_text_real_and_null_scalars_without_coercion() {
    for (table, column, owner) in [
        ("conversation_management", "revision", "conversation_id"),
        ("conversation_management", "archived", "conversation_id"),
        ("conversations", "message_count", "id"),
        ("conversations", "is_pinned", "id"),
        (
            "conversation_response_versions",
            "revision",
            "conversation_id",
        ),
        (
            "conversation_response_versions",
            "read_revision",
            "conversation_id",
        ),
    ] {
        for value in ["'invalid'", "1.5"] {
            let (_dir, pool) = fixture().await;
            message(&pool, "m", "a", "assistant", "small").await;
            sqlx::query(sqlx::AssertSqlSafe(format!(
                "UPDATE {table} SET {column}={value} WHERE {owner}='a'"
            )))
            .execute(&pool)
            .await
            .unwrap();
            code(
                conversation_content_metadata(&pool, &metadata_input("a")).await,
                "unavailable",
            );
            pool.close().await;
        }
    }
    for column in ["message_count", "is_pinned"] {
        let (_dir, pool) = fixture().await;
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "UPDATE conversations SET {column}=NULL WHERE id='a'"
        )))
        .execute(&pool)
        .await
        .unwrap();
        code(
            conversation_content_metadata(&pool, &metadata_input("a")).await,
            "unavailable",
        );
        pool.close().await;
    }
}

#[tokio::test]
async fn opening_preserves_pending_derived_revision_above_js_integer_precision() {
    let (_dir, pool) = fixture().await;
    message(&pool, "m", "a", "assistant", "small").await;
    sqlx::query("UPDATE conversation_response_versions SET revision=9007199254740997,read_revision=0 WHERE message_id='m'").execute(&pool).await.unwrap();
    let page = conversation_content_metadata(&pool, &metadata_input("a"))
        .await
        .unwrap();
    let metadata = &page.opening.as_ref().unwrap().metadata;
    assert_eq!(metadata.response_revision, "9007199254740997");
    assert_eq!(metadata.read_revision, "9007199254740996");
    admitted(&page, page.admission_estimate_bytes);
    pool.close().await;
}

#[tokio::test]
async fn response_revision_is_exact_optional_and_admitted_before_raw_fetch() {
    use std::sync::atomic::Ordering::SeqCst;
    let (dir, initial) = fixture().await;
    message(&initial, "answer", "a", "assistant", "final").await;
    message(&initial, "user", "a", "user", "sent").await;
    sqlx::query("UPDATE conversation_response_versions SET revision=9007199254740993 WHERE message_id='answer'").execute(&initial).await.unwrap();
    let w = conversation_content_window(
        &initial,
        &window_input(&initial, "a", &["answer", "user"]).await,
    )
    .await
    .unwrap();
    assert_eq!(
        w.items[0].response_revision_decimal.as_deref(),
        Some("9007199254740993")
    );
    assert_eq!(w.items[1].response_revision_decimal, None);
    admitted(&w, w.admission_estimate_bytes);
    sqlx::query("DELETE FROM conversation_response_versions WHERE message_id='answer'")
        .execute(&initial)
        .await
        .unwrap();
    let w = conversation_content_window(&initial, &window_input(&initial, "a", &["answer"]).await)
        .await
        .unwrap();
    assert_eq!(w.items[0].response_revision_decimal, None);
    sqlx::query("INSERT INTO conversation_response_versions VALUES('answer','b',1,0)")
        .execute(&initial)
        .await
        .unwrap();
    initial.close().await;
    let (pool, probe) = probe_pool(&dir).await;
    code(
        conversation_content_window(&pool, &window_input(&pool, "a", &["answer"]).await).await,
        "unavailable",
    );
    assert_eq!(probe.bodies.load(SeqCst), 0);
    sqlx::query(
        "UPDATE conversation_response_versions SET conversation_id='a' WHERE message_id='answer'",
    )
    .execute(&pool)
    .await
    .unwrap();
    for blob in [false, true] {
        let value = "x".repeat(MAX_BYTES as usize + 1);
        if blob {
            sqlx::query(
                "UPDATE conversation_response_versions SET revision=? WHERE message_id='answer'",
            )
            .bind(value.as_bytes())
            .execute(&pool)
            .await
            .unwrap();
        } else {
            sqlx::query(
                "UPDATE conversation_response_versions SET revision=? WHERE message_id='answer'",
            )
            .bind(&value)
            .execute(&pool)
            .await
            .unwrap();
        }
        code(
            conversation_content_window(&pool, &window_input(&pool, "a", &["answer"]).await).await,
            "unavailable",
        );
        assert_eq!(probe.bodies.load(SeqCst), 0);
        assert_eq!(probe.oversized_rows.load(SeqCst), usize::from(blob));
        sqlx::query(
            "SELECT revision FROM conversation_response_versions WHERE message_id='answer'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(probe.oversized_rows.load(SeqCst), usize::from(blob) + 1);
    }
    stop_probe(&pool).await;
    drop(probe);
}
