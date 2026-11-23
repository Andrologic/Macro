//! The standalone initializer must match Macro's actual migration chain.
use super::*;
use sqlx::{Connection, SqlitePool};

async fn objects(pool: &SqlitePool) -> Vec<(String, String, String, String)> {
    sqlx::query_as("SELECT type,name,tbl_name,coalesce(sql,'') FROM sqlite_schema WHERE (tbl_name LIKE 'engine_flow030_%' OR tbl_name LIKE 'engine_start030_%') AND name NOT GLOB 'macro_operate_*' ORDER BY type,name")
        .fetch_all(pool).await.unwrap()
}
async fn constraint_probe(pool: &SqlitePool) {
    let mut db = pool.acquire().await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("PRAGMA foreign_keys")
            .fetch_one(&mut *db)
            .await
            .unwrap(),
        1
    );
    let mut tx = db.begin_with("BEGIN IMMEDIATE").await.unwrap();
    sqlx::query("INSERT INTO engine_flow030_runs VALUES('schema-system','schema-run','schema-snapshot','schema-epoch','{}','{}','{}')").execute(&mut *tx).await.unwrap();
    sqlx::query("INSERT INTO engine_start030_requests VALUES('schema-request','{\"entry\":{\"deliveryId\":\"schema-delivery\"}}','schema-system','schema-run','schema-snapshot','schema-epoch','{}','{}')").execute(&mut *tx).await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, String>(
            "SELECT system_id FROM engine_start030_entries WHERE delivery_id='schema-delivery'"
        )
        .fetch_one(&mut *tx)
        .await
        .unwrap(),
        "schema-system"
    );
    assert!(sqlx::query(
        "UPDATE engine_start030_requests SET capture_json='[]' WHERE request_id='schema-request'"
    )
    .execute(&mut *tx)
    .await
    .is_err());
    assert!(
        sqlx::query("DELETE FROM engine_start030_entries WHERE delivery_id='schema-delivery'")
            .execute(&mut *tx)
            .await
            .is_err()
    );
    assert!(
        sqlx::query("INSERT INTO engine_start030_entries VALUES('missing-parent','absent')")
            .execute(&mut *tx)
            .await
            .is_err()
    );
    tx.rollback().await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM engine_start030_entries WHERE delivery_id='schema-delivery'"
        )
        .fetch_one(&mut *db)
        .await
        .unwrap(),
        0
    );
    assert!(sqlx::query("INSERT INTO engine_flow030_runs VALUES('invalid','invalid','invalid','invalid','invalid-json','{}','{}')").execute(&mut *db).await.is_err());
    let violations = sqlx::query("PRAGMA foreign_key_check")
        .fetch_all(&mut *db)
        .await
        .unwrap();
    assert!(violations.is_empty());
}

#[tokio::test]
async fn standalone_post042_matches_migrated_macro_schema_and_constraints() {
    let temp = tempfile::tempdir().unwrap();
    let macro_pool = create_pool(&temp.path().join("macro.sqlite"))
        .await
        .unwrap();
    let standalone_file = argentic_runtime::sqlite::create_file(&temp.path().join("engine.sqlite"))
        .await
        .unwrap();
    let standalone_memory = argentic_runtime::sqlite::memory().await.unwrap();
    let before: Vec<(i64, String, String)> =
        sqlx::query_as("SELECT version,name,applied_at FROM schema_migrations ORDER BY version")
            .fetch_all(&macro_pool)
            .await
            .unwrap();
    let expected = objects(&macro_pool).await;
    assert!(!expected.is_empty());
    for pool in [&standalone_file, &standalone_memory] {
        assert_eq!(objects(pool).await, expected);
    }
    for pool in [&macro_pool, &standalone_file, &standalone_memory] {
        constraint_probe(pool).await;
    }
    let after = sqlx::query_as::<_, (i64, String, String)>(
        "SELECT version,name,applied_at FROM schema_migrations ORDER BY version",
    )
    .fetch_all(&macro_pool)
    .await
    .unwrap();
    assert_eq!(before, after);
    macro_pool.close().await;
    standalone_file.close().await;
    standalone_memory.close().await;
}

#[tokio::test]
async fn macro_retains_call_clock_and_retirement_migration_ids() {
    let temp = tempfile::tempdir().unwrap();
    let pool = crate::db::create_pool(&temp.path().join("migrations.db"))
        .await
        .unwrap();
    let migrations: Vec<(i64, String)> = sqlx::query_as(
        "SELECT version,name FROM schema_migrations WHERE version BETWEEN 39 AND 42 ORDER BY version",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        migrations,
        vec![
            (39, "039_execution_call_protocol030".into()),
            (40, "040_execution_flow_human_clock030".into()),
            (41, "041_execution_flow_interrupted030".into()),
            (42, "042_retire_execution020".into())
        ]
    );
}
