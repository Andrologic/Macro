use super::*;
use argentic_runtime::api::RuntimeProjectionScope030;
use sqlx::{Connection, Row};

/// Delete rows first. The existing startup sweep retries any filesystem
/// cleanup interrupted after the transaction commits.
pub(crate) async fn delete_run(
    pool: &SqlitePool,
    data: &Path,
    host: &Path,
    scope: RuntimeProjectionScope030,
) -> Result<()> {
    let lease = resources::launch_lease(host).await?;
    let archive_schema = schema_ready(pool).await?;
    delete_records(pool, &scope, archive_schema).await?;
    if archive_schema {
        resources::cleanup_locked(pool, data, host, lease)
            .await
            .map_err(|error| {
                tracing::warn!(code = %error.code, "Run removed; archive cleanup will be retried");
                failure(
                    "DELETE_CLEANUP_PENDING",
                    "run",
                    "Run deleted; resource cleanup is pending",
                )
            })?;
    }
    Ok(())
}

async fn delete_records(
    pool: &SqlitePool,
    scope: &RuntimeProjectionScope030,
    archive_schema: bool,
) -> Result<()> {
    let mut connection = pool.acquire().await?;
    let mut tx = connection.begin_with("BEGIN IMMEDIATE").await?;
    let system = &scope.system_start_id;
    let row = sqlx::query(
        "SELECT r.invocation_id,r.snapshot_id,r.source_json,
                (r.state_json ->> '$.verdict' IS NOT NULL OR
                 (r.plan_json ->> '$.versions.contract'='agsdl-0.4.0' AND i.system_id IS NOT NULL))
                 AND NOT EXISTS(SELECT 1 FROM json_each(r.state_json,'$.activations')
                                WHERE value ->> '$.physical'=1) AS finished
         FROM engine_flow030_runs r LEFT JOIN engine_flow030_interruptions i USING(system_id)
         WHERE r.system_id=?",
    )
    .bind(system)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(row) = row else { return Ok(()) };
    let source: EngineSourceRevision = serde_json::from_str(row.try_get("source_json")?)?;
    if row.try_get::<String, _>("snapshot_id")? != scope.snapshot_id || source != scope.source {
        return Err(failure(
            "CORRELATION",
            "scope",
            "Delete target differs from the retained run",
        ));
    }
    if !row.try_get::<bool, _>("finished")? {
        return Err(failure(
            "RUN_NOT_FINISHED",
            "run",
            "The run has not finished",
        ));
    }

    sqlx::query("INSERT INTO operate_run_deletions(system_id, invocation_id) VALUES (?,?)")
        .bind(system)
        .bind(row.try_get::<String, _>("invocation_id")?)
        .execute(&mut *tx)
        .await?;
    if archive_schema {
        sqlx::query("DELETE FROM architect_launch_runs WHERE system_id=?")
            .bind(system)
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query("DELETE FROM architect_version_uses WHERE kind='execution' AND owner_id=?")
        .bind(system)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM engine_ui_intents WHERE admission_system030_id=?")
        .bind(system)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "DELETE FROM engine_flow030_call_causes WHERE call_id IN
                 (SELECT call_id FROM engine_flow030_calls WHERE system_id=?)",
    )
    .bind(system)
    .execute(&mut *tx)
    .await?;
    // Argentic creates this auxiliary table on first startup fencing.
    if sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema
        WHERE type='table' AND name='engine_flow030_interruption_clock')",
    )
    .fetch_one(&mut *tx)
    .await?
    {
        sqlx::query("DELETE FROM engine_flow030_interruption_clock WHERE system_id=?")
            .bind(system)
            .execute(&mut *tx)
            .await?;
    }
    // The engine's journals use explicit foreign keys; delete children first.
    // Operate's inbox and the transaction authorization cascade with the run.
    for table in [
        "engine_start030_entries",
        "engine_start030_requests",
        "engine_flow030_interruptions",
        "engine_flow030_owners",
        "engine_flow030_human_resolution_proofs",
        "engine_flow030_human_submissions",
        "engine_flow030_human_requests",
        "engine_flow030_clock_controls",
        "engine_flow030_clock_works",
        "engine_flow030_clock_events",
        "engine_flow030_clock",
        "engine_flow030_handoff_clock",
        "engine_flow030_route_content_receipts",
        "engine_flow030_route_content_contexts",
        "engine_flow030_route_source_attestations",
        "engine_flow030_work_checks",
        "engine_flow030_work_events",
        "engine_flow030_work_state",
        "engine_flow030_work_authorizations",
        "engine_flow030_work_admissions",
        "engine_flow030_call_diagnostics",
        "engine_flow030_calls",
        "engine_flow030_system_stop_requests",
        "engine_flow030_no_admissions",
        "engine_flow030_handoffs",
        "engine_flow030_occurrence_provenance",
        "engine_flow030_preparations",
        "engine_flow030_outbox",
        "engine_flow030_events",
        "engine_flow030_runs",
    ] {
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "DELETE FROM {table} WHERE system_id=?"
        )))
        .bind(system)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}
