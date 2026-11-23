use super::*;
use crate::db::create_pool;

async fn set_run(pool: &SqlitePool, run: serde_json::Value) {
    sqlx::query("UPDATE engine_flow030_runs SET state_json=? WHERE system_id='run'")
        .bind(run.to_string())
        .execute(pool)
        .await
        .unwrap();
}

#[tokio::test]
async fn snooze_survives_restart_and_only_same_thread_activity_wakes_it() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("operate.db");
    let pool = create_pool(&path).await.unwrap();
    let initial = serde_json::json!({"verdict": null, "instances":[{"id":"agent"}, {"id":"other"}],
        "activations":[{"id":"a", "instanceId":"agent", "phase":"running", "physical":true}]});
    sqlx::query(
        "INSERT INTO engine_flow030_runs VALUES ('run','flow','snapshot','epoch','{}','{}',?)",
    )
    .bind(initial.to_string())
    .execute(&pool)
    .await
    .unwrap();
    let until_ms = chrono::Utc::now().timestamp_millis() + 600_000;
    update(
        &pool,
        "run",
        "snapshot",
        OperateInboxAction::Snooze {
            instance_id: "agent".into(),
            activity: 0,
            until_ms,
            for_request: false,
        },
    )
    .await
    .unwrap();
    pool.close().await;
    let pool = create_pool(&path).await.unwrap();
    async fn read(pool: &SqlitePool) -> OperateThreadFacts {
        read_threads(&mut *pool.acquire().await.unwrap(), "run", "flow")
            .await
            .unwrap()
            .into_iter()
            .find(|thread| thread.instance_id == "agent")
            .unwrap()
    }
    let record = read(&pool).await;
    assert_eq!(record.snooze_until_ms, Some(until_ms));
    assert_eq!(record.snoozed_at_activity, Some(record.activity));
    let mut other = initial.clone();
    other["activations"]
        .as_array_mut()
        .unwrap()
        .push(serde_json::json!({"id":"b","instanceId":"other","phase":"done"}));
    set_run(&pool, other.clone()).await;
    assert_eq!(read(&pool).await, record);
    other["activations"][0]["phase"] = serde_json::json!("done");
    set_run(&pool, other).await;
    let woke = read(&pool).await;
    assert_ne!(woke.snoozed_at_activity, Some(woke.activity));
    assert!(update(
        &pool,
        "run",
        "snapshot",
        OperateInboxAction::Snooze {
            instance_id: "agent".into(),
            activity: 0,
            until_ms,
            for_request: false,
        }
    )
    .await
    .is_err());
    update(
        &pool,
        "run",
        "snapshot",
        OperateInboxAction::DismissWake {
            instance_id: "agent".into(),
            snoozed_at_activity: 0,
            until_ms,
        },
    )
    .await
    .unwrap();
    assert_eq!(read(&pool).await.snooze_until_ms, None);
}

#[tokio::test]
async fn finished_runs_become_read_only_when_opened_after_physical_end() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("operate.db");
    let pool = create_pool(&path).await.unwrap();
    sqlx::query(
        "INSERT INTO engine_flow030_runs VALUES ('run','flow','snapshot','epoch','{}','{}','{}')",
    )
    .execute(&pool)
    .await
    .unwrap();
    set_run(
        &pool,
        serde_json::json!({"verdict":"cancelled","activations":[{"physical":true}]}),
    )
    .await;
    update(&pool, "run", "snapshot", OperateInboxAction::MarkOpened)
        .await
        .unwrap();
    let unread: (Option<i64>, bool) =
        sqlx::query_as("SELECT finished_at_ms,opened FROM operate_inbox_runs")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(unread, (None, false));
    set_run(
        &pool,
        serde_json::json!({"verdict":"cancelled","activations":[{"physical":false}]}),
    )
    .await;
    update(
        &pool,
        "run",
        "wrong-snapshot",
        OperateInboxAction::MarkOpened,
    )
    .await
    .unwrap();
    let ended: (i64, i64, bool) =
        sqlx::query_as("SELECT started_at_ms,finished_at_ms,opened FROM operate_inbox_runs")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(ended.1 >= ended.0 && !ended.2);
    update(&pool, "run", "snapshot", OperateInboxAction::MarkOpened)
        .await
        .unwrap();
    pool.close().await;
    let pool = create_pool(&path).await.unwrap();
    let opened: bool = sqlx::query_scalar("SELECT opened FROM operate_inbox_runs")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(opened);
}
