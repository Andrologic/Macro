use super::*;
use tempfile::TempDir;
const GENERATION: &str = "0123456789abcdef0123456789abcdef";
async fn fixture() -> (TempDir, SqlitePool) {
    let dir = tempfile::tempdir().unwrap();
    let pool = crate::db::create_pool(&dir.path().join("synthetic.db"))
        .await
        .unwrap();
    (dir, pool)
}
async fn seed(db: &SqlitePool, id: &str) {
    sqlx::query("INSERT INTO conversations(id,title,created_at,updated_at) VALUES (?, 'Synthetic é界', 'historical date', '2026-01-01')").bind(id).execute(db).await.unwrap();
}
fn input() -> ConversationCatalogPageInput {
    ConversationCatalogPageInput {
        expected_token: None,
        after: None,
        limit: 100,
    }
}
async fn version(pool: &SqlitePool) -> ConversationCatalogToken {
    conversation_catalog_version(
        pool,
        GENERATION,
        &ConversationCatalogVersionInput::default(),
    )
    .await
    .unwrap()
}
fn code<T: std::fmt::Debug>(result: DbResult<T>, expected: &str) {
    assert!(
        matches!(&result, Err(DbError::Validation(c)) if c == expected),
        "{result:?}"
    );
}
fn admitted(page: &ConversationCatalogPage) {
    let actual = serde_json::to_vec(page).unwrap().len() as u64;
    assert!(actual <= page.admission_estimate_bytes && page.admission_estimate_bytes <= MAX_BYTES);
    assert!(page.items.len() <= LIMIT);
}
#[tokio::test]
async fn every_field_invalidates_and_unrelated_settings_do_not() {
    let (_dir, pool) = fixture().await;
    seed(&pool, "a").await;
    let mut db = pool.acquire().await.unwrap();
    // ID updates are ordinary SQL only when the caller permits their foreign keys.
    sqlx::query("PRAGMA foreign_keys=OFF")
        .execute(&mut *db)
        .await
        .unwrap();
    for field in CONVERSATION_FIELDS
        .iter()
        .chain(["message_count", "is_pinned"].iter())
    {
        let before = token_in(&mut db, GENERATION, None).await.unwrap();
        let value = if matches!(*field, "message_count" | "is_pinned") {
            "-3"
        } else {
            "'changed'"
        };
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "UPDATE conversations SET {field}={value}"
        )))
        .execute(&mut *db)
        .await
        .unwrap();
        let after = token_in(&mut db, GENERATION, None).await.unwrap();
        assert_ne!(before, after, "{field}");
    }
    let before = token_in(&mut db, GENERATION, None).await.unwrap();
    sqlx::query("UPDATE conversations SET title=title")
        .execute(&mut *db)
        .await
        .unwrap();
    assert_ne!(before, token_in(&mut db, GENERATION, None).await.unwrap());
    let before = token_in(&mut db, GENERATION, None).await.unwrap();
    sqlx::query("INSERT INTO app_settings VALUES ('synthetic-journal','{}','now')")
        .execute(&mut *db)
        .await
        .unwrap();
    assert_eq!(before, token_in(&mut db, GENERATION, None).await.unwrap());
    sqlx::query("PRAGMA foreign_keys=ON")
        .execute(&mut *db)
        .await
        .unwrap();
    drop(db);
    pool.close().await;
}
#[tokio::test]
async fn replace_covers_text_keys_explicit_rowid_and_double_victims() {
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
        for statement in [
            "INSERT INTO conversations(rowid,id,title,created_at,updated_at) VALUES (11,'a','A','x','x'),(22,'b','B','x','x'),(33,'c','C','x','x')",
            "INSERT OR REPLACE INTO conversations(rowid,id,title,created_at,updated_at) VALUES (22,'a','REPLACE double victim','x','x')",
            "UPDATE OR REPLACE conversations SET rowid=33 WHERE id='a'",
            "INSERT INTO conversations(id,title,created_at,updated_at) VALUES ('d','D','x','x') ON CONFLICT(id) DO UPDATE SET title=excluded.title",
            "INSERT INTO conversations(id,title,created_at,updated_at) VALUES ('d','upsert','x','x') ON CONFLICT(id) DO UPDATE SET title=excluded.title",
            "UPDATE OR REPLACE conversations SET id='d' WHERE id='a'",
            "DELETE FROM conversations",
            "INSERT INTO conversations(id,title,created_at,updated_at) VALUES ('d','same ID recreated','x','x')",
        ] {
            // ID renames need the caller to permit existing child foreign keys.
            let renames_id=statement.starts_with("UPDATE OR REPLACE conversations SET id=");
            if renames_id {sqlx::query("PRAGMA foreign_keys=OFF").execute(&mut *db).await.unwrap();}
            let before=token_in(&mut db, GENERATION, None).await.unwrap();
            sqlx::query(statement).execute(&mut *db).await.unwrap_or_else(|error|panic!("{statement}: {error}"));
            if renames_id {sqlx::query("PRAGMA foreign_keys=ON").execute(&mut *db).await.unwrap();}
            assert_ne!(before,token_in(&mut db, GENERATION, None).await.unwrap(),"recursive={recursive}: {statement}");
        }
        let before = token_in(&mut db, GENERATION, None).await.unwrap();
        sqlx::query("INSERT OR IGNORE INTO conversations(id,title,created_at,updated_at) VALUES ('d','ignored','x','x')").execute(&mut *db).await.unwrap();
        assert_eq!(before, token_in(&mut db, GENERATION, None).await.unwrap());
        drop(db);
        pool.close().await;
    }
}
#[tokio::test]
async fn rollback_savepoint_abort_overflow_and_two_connections() {
    let (_dir, pool) = fixture().await;
    seed(&pool, "a").await;
    let before = version(&pool).await;
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("UPDATE conversations SET title='uncommitted'")
        .execute(&mut *tx)
        .await
        .unwrap();
    assert_ne!(before, token_in(&mut tx, GENERATION, None).await.unwrap());
    assert_eq!(before, version(&pool).await);
    tx.rollback().await.unwrap();
    assert_eq!(before, version(&pool).await);
    let mut db = pool.acquire().await.unwrap();
    sqlx::raw_sql("SAVEPOINT synthetic; UPDATE conversations SET title='savepoint'; ROLLBACK TO synthetic; RELEASE synthetic;").execute(&mut *db).await.unwrap();
    assert_eq!(before, token_in(&mut db, GENERATION, None).await.unwrap());
    assert!(sqlx::query("INSERT INTO conversations(id,title,created_at,updated_at) VALUES ('b','B','x','x'),('a','duplicate','x','x')").execute(&mut *db).await.is_err());
    assert_eq!(before, token_in(&mut db, GENERATION, None).await.unwrap());
    sqlx::query("UPDATE conversation_catalog_version SET revision=9223372036854775807")
        .execute(&mut *db)
        .await
        .unwrap();
    let max = token_in(&mut db, GENERATION, None).await.unwrap();
    assert_eq!(max.revision, "9223372036854775807");
    sqlx::raw_sql("SAVEPOINT overflow; UPDATE conversations SET title='wrapped'; ROLLBACK TO overflow; RELEASE overflow;").execute(&mut *db).await.unwrap();
    assert_eq!(max, token_in(&mut db, GENERATION, None).await.unwrap());
    sqlx::query("UPDATE conversations SET title='wrapped'")
        .execute(&mut *db)
        .await
        .unwrap();
    let wrapped = token_in(&mut db, GENERATION, None).await.unwrap();
    assert_ne!(wrapped.incarnation, max.incarnation);
    assert_eq!(wrapped.revision, "0");
    drop(db);
    code(
        conversation_catalog_version(
            &pool,
            GENERATION,
            &ConversationCatalogVersionInput {
                expected_token: Some(max),
            },
        )
        .await,
        "stale_revision",
    );
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("DELETE FROM conversations")
        .execute(&mut *tx)
        .await
        .unwrap();
    assert_eq!(wrapped, version(&pool).await);
    tx.commit().await.unwrap();
    assert_ne!(wrapped, version(&pool).await);
    pool.close().await;
}
#[tokio::test]
async fn binary_pages_preserve_all_values_and_count() {
    let (_dir, pool) = fixture().await;
    let empty = conversation_catalog_page(&pool, GENERATION, &input())
        .await
        .unwrap();
    admitted(&empty);
    assert_eq!(empty.total_raw.as_deref(), Some("0"));
    assert!(empty.next_after.is_none());
    let mut ids = (0..103).map(|i| format!("id-{i:03}")).collect::<Vec<_>>();
    ids.extend(["é", "Z", "界", "a\0b", ""].map(str::to_string));
    for id in &ids {
        seed(&pool, id).await;
    }
    sqlx::query("UPDATE conversations SET description='\"\n\t\u{0001}',last_message='é界🙂',scope_mode='Unknown',is_pinned=-3,message_count=-2").execute(&pool).await.unwrap();
    ids.sort();
    let token = version(&pool).await;
    let mut seen = Vec::new();
    let mut request = input();
    request.expected_token = Some(token.clone());
    loop {
        let page = conversation_catalog_page(&pool, GENERATION, &request)
            .await
            .unwrap();
        admitted(&page);
        assert_eq!(page.token, token);
        assert_eq!(
            page.total_raw.as_deref(),
            if request.after.is_none() {
                Some("108")
            } else {
                None
            }
        );
        for c in &page.items {
            assert_eq!(c.scope_mode, "Unknown");
            assert_eq!(c.created_at, "historical date");
            assert!(c.is_pinned);
            assert_eq!(c.message_count, -2);
        }
        seen.extend(page.items.iter().map(|c| c.id.clone()));
        request.after = page.next_after;
        if request.after.is_none() {
            break;
        }
    }
    assert_eq!(seen, ids);
    let legacy = super::super::repository::list_conversations(&pool)
        .await
        .unwrap();
    let mut legacy_values = legacy
        .iter()
        .map(|c| (c.id.clone(), serde_json::to_value(c).unwrap()))
        .collect::<Vec<_>>();
    legacy_values.sort_by(|a, b| a.0.cmp(&b.0));
    request = input();
    request.limit = 1;
    let first = conversation_catalog_page(&pool, GENERATION, &request)
        .await
        .unwrap();
    admitted(&first);
    assert_eq!(
        serde_json::to_value(&first.items[0]).unwrap(),
        legacy_values[0].1
    );
    assert_eq!(first.next_after.as_ref().unwrap().id, legacy_values[0].0);
    pool.close().await;
}
#[tokio::test]
async fn mutations_between_pages_and_final_version_retire_the_assembly() {
    let (_dir, pool) = fixture().await;
    seed(&pool, "a").await;
    seed(&pool, "b").await;
    for statement in [
        "UPDATE conversations SET provider_id='changed' WHERE id='b'",
        "INSERT INTO conversations(id,title,created_at,updated_at) VALUES ('c','C','x','x')",
        "DELETE FROM conversations WHERE id='c'",
        "INSERT OR REPLACE INTO conversations(id,title,created_at,updated_at) VALUES ('b','replaced','x','x')",
        "DELETE FROM conversations WHERE id='b'; INSERT INTO conversations(id,title,created_at,updated_at) VALUES ('b','recreated','x','x')",
    ] {
        let mut request=input();request.limit=1;
        let first=conversation_catalog_page(&pool,GENERATION,&request).await.unwrap();
        sqlx::raw_sql(statement).execute(&pool).await.unwrap();
        request.expected_token=Some(first.token.clone());request.after=first.next_after;
        code(conversation_catalog_page(&pool,GENERATION,&request).await,"stale_revision");
        code(conversation_catalog_version(&pool,GENERATION,&ConversationCatalogVersionInput{expected_token:Some(first.token)}).await,"stale_revision");
    }
    pool.close().await;
}
#[tokio::test]
async fn input_errors_refuse_before_sql_and_real_anchor_is_required() {
    let (_dir, pool) = fixture().await;
    seed(&pool, "a").await;
    let token = version(&pool).await;
    let mut request = input();
    request.expected_token = Some(token.clone());
    request.after = Some(ConversationCatalogAnchor {
        id: "absent".into(),
    });
    code(
        conversation_catalog_page(&pool, GENERATION, &request).await,
        "validation_failed",
    );
    pool.close().await;
    for revision in ["01", "+1", "-0", "-1", "1e3", "9223372036854775808", ""] {
        let mut bad = token.clone();
        bad.revision = revision.into();
        code(
            conversation_catalog_version(
                &pool,
                GENERATION,
                &ConversationCatalogVersionInput {
                    expected_token: Some(bad),
                },
            )
            .await,
            "validation_failed",
        );
    }
    for limit in [0, 101, u32::MAX] {
        let mut r = input();
        r.limit = limit;
        code(
            conversation_catalog_page(&pool, GENERATION, &r).await,
            "validation_failed",
        );
    }
    let mut r = input();
    r.after = Some(ConversationCatalogAnchor { id: "a".into() });
    code(
        conversation_catalog_page(&pool, GENERATION, &r).await,
        "validation_failed",
    );
    r.expected_token = Some(token.clone());
    r.after = Some(ConversationCatalogAnchor {
        id: "x".repeat(MAX_BYTES as usize),
    });
    code(
        conversation_catalog_page(&pool, GENERATION, &r).await,
        "resource_limit",
    );
    let mut other = token;
    other.generation = "f".repeat(32);
    code(
        conversation_catalog_version(
            &pool,
            GENERATION,
            &ConversationCatalogVersionInput {
                expected_token: Some(other),
            },
        )
        .await,
        "stale_revision",
    );
}
#[tokio::test]
async fn admission_refuses_all_large_fields_before_fetch_with_active_engine_witness() {
    use crate::db::conversation_content::tests::probe_pool;
    use std::sync::atomic::Ordering::SeqCst;
    for field in CONVERSATION_FIELDS
        .iter()
        .chain(["message_count", "is_pinned"].iter())
    {
        for blob in [false, true] {
            let (dir, pool) = fixture().await;
            seed(&pool, "a").await;
            let mut db = pool.acquire().await.unwrap();
            sqlx::query("PRAGMA foreign_keys=OFF")
                .execute(&mut *db)
                .await
                .unwrap();
            let query = format!("UPDATE conversations SET {field}=?");
            if blob {
                sqlx::query(sqlx::AssertSqlSafe(query))
                    .bind(vec![b'x'; 5_000_000])
                    .execute(&mut *db)
                    .await
                    .unwrap();
            } else {
                sqlx::query(sqlx::AssertSqlSafe(query))
                    .bind("x".repeat(5_000_000))
                    .execute(&mut *db)
                    .await
                    .unwrap();
            }
            drop(db);
            pool.close().await;
            let (pool, probe) = probe_pool(&dir).await;
            probe.deny.store(5, SeqCst);
            let error = if blob || matches!(*field, "message_count" | "is_pinned") {
                "unavailable"
            } else {
                "resource_limit"
            };
            code(
                conversation_catalog_page(&pool, GENERATION, &input()).await,
                error,
            );
            assert_eq!(probe.catalogs.load(SeqCst), 0, "{field}, blob={blob}");
            assert_eq!(probe.oversized_rows.load(SeqCst), 0, "{field}, blob={blob}");
            probe.deny.store(0, SeqCst);
            sqlx::query(sqlx::AssertSqlSafe(format!(
                "SELECT {field} FROM conversations"
            )))
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(
                probe.oversized_rows.load(SeqCst),
                1,
                "inactive ROW witness for {field}"
            );
            eprintln!("C2_CATALOG_ADMISSION field={field} blob={blob} raw_fetches=0 oversized_rows=0 negative_control=1");
            pool.close().await;
        }
    }
    let (dir, pool) = fixture().await;
    seed(&pool, "a").await;
    pool.close().await;
    let (pool, probe) = probe_pool(&dir).await;
    probe.deny.store(5, SeqCst);
    code(
        conversation_catalog_page(&pool, GENERATION, &input()).await,
        "unavailable",
    );
    assert_eq!(probe.catalogs.load(SeqCst), 1, "inactive STMT witness");
    probe.deny.store(0, SeqCst);
    admitted(
        &conversation_catalog_page(&pool, GENERATION, &input())
            .await
            .unwrap(),
    );
    pool.close().await;
}
#[tokio::test]
async fn scalar_types_i32_ranges_and_late_candidate_fail_before_any_fetch() {
    use crate::db::conversation_content::tests::probe_pool;
    use std::sync::atomic::Ordering::SeqCst;
    for field in ["message_count", "is_pinned"] {
        for value in ["NULL", "1.5", "2147483648", "-2147483649", "x'01'", "'bad'"] {
            let (dir, pool) = fixture().await;
            seed(&pool, "a").await;
            seed(&pool, "z").await;
            sqlx::query(sqlx::AssertSqlSafe(format!(
                "UPDATE conversations SET {field}={value} WHERE id='z'"
            )))
            .execute(&pool)
            .await
            .unwrap();
            pool.close().await;
            let (pool, probe) = probe_pool(&dir).await;
            probe.deny.store(5, SeqCst);
            code(
                conversation_catalog_page(&pool, GENERATION, &input()).await,
                "unavailable",
            );
            assert_eq!(probe.catalogs.load(SeqCst), 0);
            pool.close().await;
        }
    }
}
#[tokio::test]
async fn exact_budget_anchor_duplication_and_snapshot_between_admit_and_fetch() {
    let (_dir, pool) = fixture().await;
    seed(&pool, "a").await;
    let max = ((MAX_BYTES - 4096 - 2048) / 6) as usize;
    let fixed_text_bytes = 8; // Four one-byte fields plus scope_mode Chat.
    sqlx::query("UPDATE conversations SET id='a',title='b',created_at='c',updated_at='d',description=?,scope_mode='Chat'")
        .bind("x".repeat(max-fixed_text_bytes)).execute(&pool).await.unwrap();
    let page = conversation_catalog_page(&pool, GENERATION, &input())
        .await
        .unwrap();
    admitted(&page);
    // Derive the exact next threshold from the same numeric admission inputs.
    let mut tx = pool.begin().await.unwrap();
    let mut r = input();
    let (_, _, estimate) = admit(&mut tx, &r).await.unwrap();
    tx.rollback().await.unwrap();
    let delta = ((MAX_BYTES - estimate) / 6) as usize;
    sqlx::query("UPDATE conversations SET description=description || ?")
        .bind("x".repeat(delta))
        .execute(&pool)
        .await
        .unwrap();
    admitted(
        &conversation_catalog_page(&pool, GENERATION, &input())
            .await
            .unwrap(),
    );
    sqlx::query("UPDATE conversations SET description=description || 'x'")
        .execute(&pool)
        .await
        .unwrap();
    code(
        conversation_catalog_page(&pool, GENERATION, &input()).await,
        "resource_limit",
    );
    sqlx::query("UPDATE conversations SET description='before'")
        .execute(&pool)
        .await
        .unwrap();
    let mut tx = pool.begin().await.unwrap();
    let token = token_in(&mut tx, GENERATION, None).await.unwrap();
    let (ids, _, _) = admit(&mut tx, &r).await.unwrap();
    sqlx::query("UPDATE conversations SET description='after'")
        .execute(&pool)
        .await
        .unwrap();
    let rows = fetch(&mut tx, &ids).await.unwrap();
    assert_eq!(rows[0].description.as_deref(), Some("before"));
    tx.commit().await.unwrap();
    assert_ne!(token, version(&pool).await);
    sqlx::query("DELETE FROM conversations")
        .execute(&pool)
        .await
        .unwrap();
    seed(&pool, &"x".repeat(360_000)).await;
    seed(&pool, "z").await;
    r.limit = 1;
    code(
        conversation_catalog_page(&pool, GENERATION, &r).await,
        "resource_limit",
    );
    pool.close().await;
}
#[tokio::test]
async fn missing_or_modified_schema_is_unavailable_without_repair() {
    for mutation in [
        "DROP TRIGGER catalog_version_conversations_insert",
        "DROP TABLE conversation_catalog_version",
        "DELETE FROM conversation_catalog_version",
        "DELETE FROM schema_migrations WHERE version=14",
        "UPDATE schema_migrations SET name='wrong' WHERE version=14",
        "CREATE TRIGGER catalog_version_unexpected AFTER INSERT ON conversations BEGIN SELECT 1; END",
        "DROP TRIGGER catalog_version_conversations_update; CREATE TRIGGER catalog_version_conversations_update AFTER UPDATE ON conversations BEGIN SELECT 1; END",
        "PRAGMA ignore_check_constraints=ON; UPDATE conversation_catalog_version SET incarnation=x'01'",
        "PRAGMA ignore_check_constraints=ON; UPDATE conversation_catalog_version SET revision=-1",
    ] {
        let (dir,pool)=fixture().await;seed(&pool,"a").await;
        sqlx::raw_sql(mutation).execute(&pool).await.unwrap();
        code(conversation_catalog_version(&pool,GENERATION,&ConversationCatalogVersionInput::default()).await,"unavailable");
        pool.close().await;
        assert!(crate::db::create_pool(&dir.path().join("synthetic.db")).await.is_err(),"repaired {mutation}");
    }
}
#[tokio::test]
async fn migration14_stamp_failure_rolls_back_and_reopen_preserves_durable_token() {
    let (dir, pool) = fixture().await;
    seed(&pool, "a").await;
    let before = version(&pool).await;
    pool.close().await;
    let pool = crate::db::create_pool(&dir.path().join("synthetic.db"))
        .await
        .unwrap();
    assert_eq!(before, version(&pool).await);
    remove_reference_schema(&pool).await.unwrap();
    sqlx::raw_sql("DELETE FROM schema_migrations WHERE version=14; CREATE TRIGGER reject_catalog_stamp BEFORE INSERT ON schema_migrations WHEN NEW.version=14 BEGIN SELECT RAISE(ABORT,'synthetic'); END").execute(&pool).await.unwrap();
    assert!(crate::db::run_migrations(&pool).await.is_err());
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT COUNT(*) FROM sqlite_master WHERE name='conversation_catalog_version' OR name GLOB 'catalog_version_*'").fetch_one(&pool).await.unwrap(),0);
    sqlx::query("DROP TRIGGER reject_catalog_stamp")
        .execute(&pool)
        .await
        .unwrap();
    crate::db::run_migrations(&pool).await.unwrap();
    assert_ne!(before.incarnation, version(&pool).await.incarnation);
    assert_eq!(
        conversation_catalog_page(&pool, GENERATION, &input())
            .await
            .unwrap()
            .items
            .len(),
        1
    );
    pool.close().await;
}

#[tokio::test]
async fn null_id_and_oversized_singleton_refuse_before_raw_fetch() {
    use crate::db::conversation_content::tests::probe_pool;
    use std::sync::atomic::Ordering::SeqCst;
    for (field, blob) in [
        ("incarnation", false),
        ("incarnation", true),
        ("revision", false),
        ("revision", true),
    ] {
        let (dir, pool) = fixture().await;
        let mut db = pool.acquire().await.unwrap();
        sqlx::query("PRAGMA ignore_check_constraints=ON")
            .execute(&mut *db)
            .await
            .unwrap();
        let query = format!("UPDATE conversation_catalog_version SET {field}=?");
        if blob {
            sqlx::query(sqlx::AssertSqlSafe(query))
                .bind(vec![b'x'; 5_000_000])
                .execute(&mut *db)
                .await
                .unwrap();
        } else {
            sqlx::query(sqlx::AssertSqlSafe(query))
                .bind("x".repeat(5_000_000))
                .execute(&mut *db)
                .await
                .unwrap();
        }
        drop(db);
        pool.close().await;
        let (pool, probe) = probe_pool(&dir).await;
        code(
            conversation_catalog_version(
                &pool,
                GENERATION,
                &ConversationCatalogVersionInput::default(),
            )
            .await,
            "unavailable",
        );
        assert_eq!(probe.oversized_rows.load(SeqCst), 0);
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "SELECT {field} FROM conversation_catalog_version"
        )))
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(probe.oversized_rows.load(SeqCst), 1);
        pool.close().await;
    }
    let (dir, pool) = fixture().await;
    sqlx::query(
        "INSERT INTO conversations(id,title,created_at,updated_at) VALUES (NULL,'Null ID','x','x')",
    )
    .execute(&pool)
    .await
    .unwrap();
    pool.close().await;
    let (pool, probe) = probe_pool(&dir).await;
    probe.deny.store(5, SeqCst);
    code(
        conversation_catalog_page(&pool, GENERATION, &input()).await,
        "unavailable",
    );
    assert_eq!(probe.catalogs.load(SeqCst), 0);
    pool.close().await;
}
