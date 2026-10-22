//! Native requests are single use. A durable possiblySent record precedes every
//! write to stdio; missing receipts survive restart and never authorize a replay.
use super::*;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NativeOperation {
    pub context: EngineContext,
    pub effect: EngineEffectIdentity,
    pub operation_id: String,
    pub adapter: String,
    pub version: String,
    pub profile_digest: String,
    pub method: String,
    pub request_json: String,
}

pub(crate) async fn admit(pool: &SqlitePool, operation: &NativeOperation) -> Result<()> {
    opaque(&operation.operation_id)?;
    opaque(&operation.profile_digest)?;
    validate_json(&operation.request_json)?;
    require(
        (operation.adapter == "codex-app-server-v1" && operation.version == "0.163.0")
            || (operation.adapter == "claude-sdk-v1" && operation.version == "0.3.308"),
        "Native adapter version is unavailable",
    )?;
    require(
        match operation.adapter.as_str() {
            "codex-app-server-v1" => {
                ["thread/start", "thread/resume", "turn/start"].contains(&operation.method.as_str())
            }
            "claude-sdk-v1" => [
                "session/create",
                "session/resume",
                "query/start",
                "query/result",
            ]
            .contains(&operation.method.as_str()),
            _ => false,
        },
        "Native operation is unavailable",
    )?;
    let work = &operation.context.work;
    let agent = work
        .agent_instance_id
        .as_deref()
        .ok_or_else(|| failure("CORRELATION", "agent", "Native operation requires an Agent"))?;
    let mut connection = pool.acquire().await?;
    let mut tx = durable(&mut connection).await?;
    let stored = load(&mut tx, &work.system_start_id).await?;
    context(&stored, &operation.context)?;
    let activation = activation(&stored.state, work)?;
    require(
        activation.work_state == "active"
            && matches!(activation.stop_state, EngineStopState::None)
            && matches!(stored.state.stop, EngineStopState::None),
        "Native work is stopped or uncertain",
    )?;
    require(
        matches!(operation.effect, EngineEffectIdentity::Provider { .. }),
        "Native operation must belong to a provider effect",
    )?;
    let effect_key = effect_key(&operation.effect)?;
    let effect: String = sqlx::query_scalar("SELECT record_json FROM engine_effects WHERE system_id=? AND activation_id=? AND effect_key=? AND status='pending'")
        .bind(&work.system_start_id).bind(&work.activation_id).bind(&effect_key).fetch_optional(&mut *tx).await?
        .ok_or_else(|| failure("CORRELATION", "effect", "Native process has no pending owned effect"))?;
    let effect: EngineEffect = serde_json::from_str(&effect)?;
    require(
        record_equal(&effect.context, &operation.context)?,
        "Native operation effect attribution differs",
    )?;
    let existing: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM engine_native_operations WHERE system_id=? AND operation_id=?",
    )
    .bind(&work.system_start_id)
    .bind(&operation.operation_id)
    .fetch_one(&mut *tx)
    .await?;
    require(
        existing == 0,
        "Native operation may already have been sent; replay is forbidden",
    )?;
    sqlx::query(
        "INSERT INTO engine_native_operations VALUES (?,?,?,?,?,?,?,?,?,?,?,'possiblySent',NULL)",
    )
    .bind(&work.system_start_id)
    .bind(&work.activation_id)
    .bind(&effect_key)
    .bind(&operation.operation_id)
    .bind(agent)
    .bind(encode(&operation.context)?)
    .bind(&operation.adapter)
    .bind(&operation.version)
    .bind(&operation.profile_digest)
    .bind(&operation.method)
    .bind(&operation.request_json)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

/// Records only observed references, never an authoritative model validation.
pub(crate) async fn received(
    pool: &SqlitePool,
    operation: &NativeOperation,
    references_json: &str,
) -> Result<()> {
    validate_json(references_json)?;
    let work = &operation.context.work;
    let mut connection = pool.acquire().await?;
    let mut tx = durable(&mut connection).await?;
    let row = sqlx::query("SELECT context_json,effect_key,adapter,version,profile_digest,method,request_json,references_json FROM engine_native_operations WHERE system_id=? AND operation_id=?")
        .bind(&work.system_start_id).bind(&operation.operation_id).fetch_optional(&mut *tx).await?
        .ok_or_else(|| failure("CORRELATION", "operation", "Native operation was not admitted"))?;
    require(
        record_equal(
            &serde_json::from_str::<EngineContext>(row.get("context_json"))?,
            &operation.context,
        )? && row.get::<&str, _>("effect_key") == effect_key(&operation.effect)?
            && row.get::<&str, _>("adapter") == operation.adapter
            && row.get::<&str, _>("version") == operation.version
            && row.get::<&str, _>("profile_digest") == operation.profile_digest
            && row.get::<&str, _>("method") == operation.method
            && row.get::<&str, _>("request_json") == operation.request_json,
        "Native receipt attribution differs",
    )?;
    if let Some(previous) = row.get::<Option<&str>, _>("references_json") {
        require(
            previous == references_json,
            "Native receipt contradicts retained references",
        )?;
    } else {
        sqlx::query("UPDATE engine_native_operations SET state='received',references_json=? WHERE system_id=? AND operation_id=?")
            .bind(references_json).bind(&work.system_start_id).bind(&operation.operation_id).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(())
}

/// Reads private observations after reopen. No public projection includes them.
pub(crate) async fn read_instance(
    pool: &SqlitePool,
    system: &str,
    agent: &str,
) -> Result<Vec<(NativeOperation, Option<String>)>> {
    let rows = sqlx::query("SELECT context_json,record_json AS effect_json,operation_id,adapter,version,profile_digest,method,request_json,references_json FROM engine_native_operations n JOIN engine_effects e ON e.system_id=n.system_id AND e.effect_key=n.effect_key WHERE n.system_id=? AND agent_instance_id=? ORDER BY n.rowid")
        .bind(system).bind(agent).fetch_all(pool).await?;
    rows.into_iter()
        .map(|row| {
            Ok((
                NativeOperation {
                    context: serde_json::from_str(row.get("context_json"))?,
                    operation_id: row.get("operation_id"),
                    effect: serde_json::from_str::<EngineEffect>(row.get("effect_json"))?.effect,
                    adapter: row.get("adapter"),
                    version: row.get("version"),
                    profile_digest: row.get("profile_digest"),
                    method: row.get("method"),
                    request_json: row.get("request_json"),
                },
                row.get("references_json"),
            ))
        })
        .collect()
}
