use sqlx::{sqlite::SqliteConnectOptions, Connection, SqliteConnection};

#[tokio::test]
async fn invalid_sqlite_types_emit_negative_json_and_exit_one() {
    for schema in [
        "CREATE TABLE engine_flow030_runs(system_id TEXT,invocation_id TEXT,snapshot_id BLOB,epoch TEXT,source_json TEXT,plan_json TEXT,state_json TEXT); INSERT INTO engine_flow030_runs VALUES('system','invocation',x'736e617073686f74','epoch','{}','{}','{}')",
        "CREATE TABLE engine_flow030_runs(system_id TEXT,invocation_id TEXT,snapshot_id INTEGER,epoch TEXT,source_json TEXT,plan_json TEXT,state_json TEXT); INSERT INTO engine_flow030_runs VALUES('system','invocation',1,'epoch','{}','{}','{}')",
    ] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("unexpected-types.sqlite");
        let mut db = SqliteConnection::connect_with(
            &SqliteConnectOptions::new().filename(&path).create_if_missing(true),
        ).await.unwrap();
        sqlx::raw_sql(schema).execute(&mut db).await.unwrap();
        db.close().await.unwrap();
        let output = std::process::Command::new(env!("CARGO_BIN_EXE_agsdl_flow030_replay"))
            .arg(&path).args(["system", "invocation"]).output().unwrap();
        assert_eq!(output.status.code(), Some(1), "{}", String::from_utf8_lossy(&output.stderr));
        let verdict: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(verdict["ok"], false);
        assert_eq!(verdict["divergence"]["field"], "database");
        assert!(!String::from_utf8_lossy(&output.stderr).contains("panicked"));
    }
}
