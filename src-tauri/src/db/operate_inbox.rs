use super::agsdl_execution::discovery030::{self, RunListRequest030, RunSummary030};
use argentic_runtime::persistence::{failure, opaque, require, Result};
use serde::{Deserialize, Serialize};
use sqlx::{Row, SqliteConnection, SqlitePool};

pub(crate) const DELETE_SCHEMA_VERSION: i64 = 52;
pub(crate) const DELETE_SCHEMA_NAME: &str = "052_operate_delete";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct OperateRunFacts {
    #[ts(type = "number | null")]
    pub started_at_ms: Option<i64>,
    #[ts(type = "number | null")]
    pub finished_at_ms: Option<i64>,
    pub opened: bool,
    pub stopped_by_user: bool,
    pub failed_instance_ids: Vec<String>,
    pub threads: Vec<OperateThreadFacts>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct OperateThreadFacts {
    pub instance_id: String,
    #[ts(type = "number")]
    pub activity: i64,
    #[ts(type = "number | null")]
    pub activity_at_ms: Option<i64>,
    #[ts(type = "number | null")]
    pub snoozed_at_activity: Option<i64>,
    #[ts(type = "number | null")]
    pub snooze_until_ms: Option<i64>,
    pub snoozed_for_request: bool,
}

#[derive(Debug, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct PublicRunSummary030 {
    #[serde(flatten)]
    #[ts(flatten)]
    pub summary: RunSummary030,
    pub inbox: OperateRunFacts,
}

#[derive(Debug, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct RunPage030 {
    pub runs: Vec<PublicRunSummary030>,
    pub next_cursor: Option<String>,
}

pub(crate) async fn list_runs(pool: &SqlitePool, request: RunListRequest030) -> Result<RunPage030> {
    let mut tx = pool.begin().await?;
    let page = discovery030::list_runs_in_transaction030(&mut tx, request).await?;
    let mut runs = Vec::with_capacity(page.runs.len());
    for mut summary in page.runs {
        let row = sqlx::query(
            "SELECT inbox.started_at_ms, coalesce(inbox.finished_at_ms,
               CAST(unixepoch(interruption.interrupted_at) * 1000 AS INTEGER)) AS finished_at_ms, inbox.opened,
               EXISTS(SELECT 1 FROM engine_flow030_system_stop_requests st
                      WHERE st.system_id=inbox.system_id AND st.invocation_id=inbox.invocation_id AND st.event_id IS NOT NULL) AS user_stop
             FROM operate_inbox_runs inbox
             LEFT JOIN engine_flow030_interruptions interruption ON interruption.system_id=inbox.system_id
             WHERE inbox.system_id=? AND inbox.invocation_id=?",
        ).bind(&summary.system_start_id).bind(&summary.flow_invocation_id).fetch_one(&mut *tx).await?;
        let inbox = OperateRunFacts {
            started_at_ms: row.try_get("started_at_ms")?,
            finished_at_ms: row.try_get("finished_at_ms")?,
            opened: row.try_get("opened")?,
            stopped_by_user: row.try_get("user_stop")?,
            failed_instance_ids: std::mem::take(&mut summary.failed_instance_ids),
            threads: read_threads(
                &mut tx,
                &summary.system_start_id,
                &summary.flow_invocation_id,
            )
            .await?,
        };
        runs.push(PublicRunSummary030 { summary, inbox });
    }
    tx.commit().await?;
    Ok(RunPage030 {
        runs,
        next_cursor: page.next_cursor,
    })
}

async fn read_threads(
    connection: &mut SqliteConnection,
    system_id: &str,
    invocation_id: &str,
) -> Result<Vec<OperateThreadFacts>> {
    let rows = sqlx::query("SELECT instance_id,activity,activity_at_ms,snoozed_at_activity,snooze_until_ms,snoozed_for_request
        FROM operate_inbox_threads WHERE system_id=? AND invocation_id=? ORDER BY instance_id")
        .bind(system_id).bind(invocation_id).fetch_all(connection).await?;
    rows.iter()
        .map(|row| {
            Ok(OperateThreadFacts {
                instance_id: row.try_get("instance_id")?,
                activity: row.try_get("activity")?,
                activity_at_ms: row.try_get("activity_at_ms")?,
                snoozed_at_activity: row.try_get("snoozed_at_activity")?,
                snooze_until_ms: row.try_get("snooze_until_ms")?,
                snoozed_for_request: row.try_get("snoozed_for_request")?,
            })
        })
        .collect()
}

#[derive(Deserialize, ts_rs::TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum OperateInboxAction {
    MarkOpened,
    Snooze {
        instance_id: String,
        #[ts(type = "number")]
        activity: i64,
        #[ts(type = "number")]
        until_ms: i64,
        for_request: bool,
    },
    DismissWake {
        instance_id: String,
        #[ts(type = "number")]
        snoozed_at_activity: i64,
        #[ts(type = "number")]
        until_ms: i64,
    },
}

pub(crate) async fn update(
    pool: &SqlitePool,
    system_id: &str,
    snapshot_id: &str,
    action: OperateInboxAction,
) -> Result<()> {
    opaque(system_id)?;
    opaque(snapshot_id)?;
    match action {
        OperateInboxAction::MarkOpened => {
            sqlx::query("UPDATE operate_inbox_runs AS inbox SET opened=1
                WHERE inbox.system_id=? AND EXISTS (
                    SELECT 1 FROM engine_flow030_runs r WHERE r.system_id=inbox.system_id
                      AND r.invocation_id=inbox.invocation_id AND r.snapshot_id=?
                      AND ((r.state_json ->> '$.verdict' IS NOT NULL
                        AND NOT EXISTS(SELECT 1 FROM json_each(r.state_json, '$.activations') WHERE value ->> '$.physical'=1))
                        OR (r.plan_json ->> '$.versions.contract'='agsdl-0.4.0' AND EXISTS(
                          SELECT 1 FROM engine_flow030_interruptions i WHERE i.system_id=r.system_id)))
                )")
                .bind(system_id).bind(snapshot_id).execute(pool).await?;
        }
        OperateInboxAction::Snooze {
            instance_id,
            activity,
            until_ms,
            for_request,
        } => {
            opaque(&instance_id)?;
            let now = chrono::Utc::now().timestamp_millis();
            require(
                until_ms > now && until_ms <= 8_640_000_000_000_000,
                "Invalid snooze date",
            )?;
            let result = sqlx::query("INSERT INTO operate_inbox_threads
                (system_id, invocation_id, instance_id, snoozed_at_activity, snooze_until_ms, snoozed_for_request)
                SELECT r.system_id,r.invocation_id,?,?,?,? FROM engine_flow030_runs r
                WHERE r.system_id=? AND r.snapshot_id=?
                  AND (r.state_json ->> '$.verdict' IS NULL
                    OR EXISTS(SELECT 1 FROM json_each(r.state_json, '$.activations') WHERE value ->> '$.physical'=1))
                  AND EXISTS(SELECT 1 FROM json_each(r.state_json, '$.instances') WHERE value ->> '$.id'=?)
                  AND coalesce((SELECT t.activity FROM operate_inbox_threads t WHERE
                      t.system_id=r.system_id AND t.invocation_id=r.invocation_id AND t.instance_id=?),0)=?
                ON CONFLICT(system_id, invocation_id, instance_id) DO UPDATE SET
                    snoozed_at_activity=excluded.snoozed_at_activity, snooze_until_ms=excluded.snooze_until_ms,
                    snoozed_for_request=excluded.snoozed_for_request")
                .bind(&instance_id).bind(activity).bind(until_ms).bind(for_request)
                .bind(system_id).bind(snapshot_id).bind(&instance_id).bind(&instance_id).bind(activity)
                .execute(pool).await?;
            if result.rows_affected() == 0 {
                return Err(failure(
                    "REVISION_CONFLICT",
                    "",
                    "Thread changed before snoozing",
                ));
            }
        }
        OperateInboxAction::DismissWake {
            instance_id,
            snoozed_at_activity,
            until_ms,
        } => {
            sqlx::query("UPDATE operate_inbox_threads AS t SET snoozed_at_activity=NULL, snooze_until_ms=NULL, snoozed_for_request=0
                WHERE t.system_id=? AND t.instance_id=? AND t.snoozed_at_activity=? AND t.snooze_until_ms=?
                  AND (t.activity<>t.snoozed_at_activity OR t.snooze_until_ms<=?)
                  AND EXISTS(SELECT 1 FROM engine_flow030_runs r WHERE r.system_id=t.system_id
                    AND r.invocation_id=t.invocation_id AND r.snapshot_id=?)")
                .bind(system_id).bind(instance_id).bind(snoozed_at_activity).bind(until_ms)
                .bind(chrono::Utc::now().timestamp_millis()).bind(snapshot_id).execute(pool).await?;
        }
    }
    Ok(())
}

pub(crate) async fn remove_delete_reference_schema(
    connection: &mut SqliteConnection,
) -> crate::db::DbResult<()> {
    if super::table_exists(connection, "operate_run_deletions".into()).await? {
        sqlx::raw_sql(include_str!("migrations/052_operate_delete_reference.sql"))
            .execute(&mut *connection)
            .await?;
    }
    Ok(())
}

pub(crate) async fn remove_reference_schema(
    connection: &mut SqliteConnection,
) -> crate::db::DbResult<()> {
    remove_delete_reference_schema(connection).await?;
    sqlx::raw_sql(
        "DROP TRIGGER IF EXISTS macro_operate_work_progress;
         DROP TRIGGER IF EXISTS macro_operate_human_changed;
         DROP TRIGGER IF EXISTS macro_operate_human_opened;
         DROP TRIGGER IF EXISTS macro_operate_flow_activity;
         DROP TRIGGER IF EXISTS macro_operate_run_started;
         DROP TABLE IF EXISTS operate_inbox_threads;
         DROP TABLE IF EXISTS operate_inbox_runs;",
    )
    .execute(connection)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests;

mod operator_controls;
pub(crate) use operator_controls::{control_run, read_runtime};
