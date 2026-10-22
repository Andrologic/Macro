//! Ordered exact response journal. Semantic validation belongs to the trusted host;
//! attribution, retained bytes, sequence continuity and physical termination do not.
use super::*;
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Emission {
    pub context: EngineContext,
    pub provider_attempt_id: String,
    pub sequence: String,
    pub identity: String,
    pub kind: String,
    pub body_json: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Closure {
    pub owner: EngineOwner,
    pub work: EngineWork,
    pub cursor: String,
    pub digest: String,
    pub validation_json: String,
}
pub(crate) async fn append(pool: &SqlitePool, emission: Emission) -> Result<bool> {
    decimal(&emission.sequence)?;
    require(
        emission.sequence != "0",
        "Response sequence must be positive",
    )?;
    opaque(&emission.identity)?;
    opaque(&emission.provider_attempt_id)?;
    require(
        ["message", "publication", "rejectedPublication"].contains(&emission.kind.as_str()),
        "Unknown response kind",
    )?;
    validate_json(&emission.body_json)?;
    let mut connection = pool.acquire().await?;
    let mut tx = durable(&mut connection).await?;
    let stored = load(&mut tx, &emission.context.work.system_start_id).await?;
    context(&stored, &emission.context)?;
    let work = &emission.context.work;
    let closed: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM engine_response_closures WHERE system_id=? AND activation_id=?",
    )
    .bind(&work.system_start_id)
    .bind(&work.activation_id)
    .fetch_one(&mut *tx)
    .await?;
    require(closed == 0, "Response collection is closed")?;
    let key = effect_key(&EngineEffectIdentity::Provider {
        provider_attempt_id: emission.provider_attempt_id.clone(),
    })?;
    let registered:String=sqlx::query_scalar("SELECT record_json FROM engine_effects WHERE system_id=? AND activation_id=? AND effect_key=?").bind(&work.system_start_id).bind(&work.activation_id).bind(key).fetch_optional(&mut *tx).await?.ok_or_else(||failure("CORRELATION","providerAttemptId","Unregistered response attempt"))?;
    let effect: EngineEffect = serde_json::from_str(&registered)?;
    require(
        record_equal(&effect.context, &emission.context)?,
        "Response attempt attribution mismatch",
    )?;
    if let Some(previous)=sqlx::query_scalar::<_,String>("SELECT payload_json FROM engine_responses WHERE system_id=? AND activation_id=? AND (sequence=? OR identity=?)").bind(&work.system_start_id).bind(&work.activation_id).bind(&emission.sequence).bind(&emission.identity).fetch_optional(&mut *tx).await? {
   require(record_equal(&serde_json::from_str::<Emission>(&previous)?,&emission)?,"Conflicting response retransmission")?;
   tx.commit().await?;return Ok(false);
 }
    let (count,bytes):(i64,i64)=sqlx::query_as("SELECT count(*),coalesce(sum(length(CAST(payload_json AS BLOB))),0) FROM engine_responses WHERE system_id=? AND activation_id=?").bind(&work.system_start_id).bind(&work.activation_id).fetch_one(&mut *tx).await?;
    let raw = encode(&emission)?;
    require(
        count < 10000 && bytes + raw.len() as i64 <= 4_000_000,
        "Response collection limit exceeded",
    )?;
    sqlx::query("INSERT INTO engine_responses VALUES (?,?,?,?,?)")
        .bind(&work.system_start_id)
        .bind(&work.activation_id)
        .bind(&emission.sequence)
        .bind(&emission.identity)
        .bind(raw)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(true)
}
async fn retained(db: &mut SqliteConnection, work: &EngineWork) -> Result<Vec<Emission>> {
    let raw:Vec<String>=sqlx::query_scalar("SELECT payload_json FROM engine_responses WHERE system_id=? AND activation_id=? ORDER BY length(sequence),sequence").bind(&work.system_start_id).bind(&work.activation_id).fetch_all(db).await?;
    raw.into_iter()
        .map(|s| Ok(serde_json::from_str(&s)?))
        .collect()
}
fn digest(events: &[Emission]) -> Result<String> {
    let mut digest = Sha256::new();
    for event in events {
        let bytes = encode(event)?;
        digest.update((bytes.len() as u64).to_be_bytes());
        digest.update(bytes.as_bytes());
    }
    Ok(format!("{:x}", digest.finalize()))
}
pub(crate) async fn read(
    pool: &SqlitePool,
    owner_value: &EngineOwner,
    work: &EngineWork,
) -> Result<(Vec<Emission>, String)> {
    let mut connection = pool.acquire().await?;
    let mut tx = durable(&mut connection).await?;
    let stored = load(&mut tx, &work.system_start_id).await?;
    live(&stored.state, owner_value, work)?;
    let events = retained(&mut tx, work).await?;
    let hash = digest(&events)?;
    tx.commit().await?;
    Ok((events, hash))
}
pub(crate) async fn close(pool: &SqlitePool, closure: Closure) -> Result<Closure> {
    decimal(&closure.cursor)?;
    validate_json(&closure.validation_json)?;
    let mut connection = pool.acquire().await?;
    let mut tx = durable(&mut connection).await?;
    let mut stored = load(&mut tx, &closure.work.system_start_id).await?;
    live(&stored.state, &closure.owner, &closure.work)?;
    if let Some(previous) = sqlx::query_scalar::<_, String>(
        "SELECT receipt_json FROM engine_response_closures WHERE system_id=? AND activation_id=?",
    )
    .bind(&closure.work.system_start_id)
    .bind(&closure.work.activation_id)
    .fetch_optional(&mut *tx)
    .await?
    {
        let previous: Closure = serde_json::from_str(&previous)?;
        require(
            record_equal(&previous, &closure)?,
            "Conflicting response closure",
        )?;
        tx.commit().await?;
        return Ok(previous);
    }
    let (unresolved, uncertain): (i64, i64) = sqlx::query_as("SELECT count(*),coalesce(sum(status='uncertain'),0) FROM engine_effects WHERE system_id=? AND activation_id=? AND status<>'ended'")
        .bind(&closure.work.system_start_id).bind(&closure.work.activation_id).fetch_one(&mut *tx).await?;
    if uncertain != 0 {
        return Err(failure(
            "NATIVE_UNCERTAIN",
            "responses",
            "Response owner has effects without a confirmed physical end",
        ));
    }
    if unresolved != 0 {
        return Err(failure(
            "STOP_PENDING",
            "responses",
            "Response owner still has unresolved effects",
        ));
    }
    let events = retained(&mut tx, &closure.work).await?;
    require(
        closure.cursor == events.len().to_string(),
        "Response cursor does not cover emissions",
    )?;
    for (index, event) in events.iter().enumerate() {
        require(
            event.sequence == (index + 1).to_string(),
            "Response transport has a hole",
        )?;
    }
    require(
        closure.digest == digest(&events)?,
        "Response validation does not describe retained bytes",
    )?;
    // The host must return a tagged success or normative failure, never an untyped boolean.
    let validation: serde_json::Value = serde_json::from_str(&closure.validation_json)?;
    require(
        matches!(
            validation.get("kind").and_then(|v| v.as_str()),
            Some("success" | "failure")
        ),
        "Missing response validation outcome",
    )?;
    if validation["kind"] == "failure" {
        require(
            validation["code"] == "OUTPUT_CONSTRAINT",
            "Unknown response failure code",
        )?;
    }
    sqlx::query("INSERT INTO engine_response_closures VALUES (?,?,?)")
        .bind(&closure.work.system_start_id)
        .bind(&closure.work.activation_id)
        .bind(encode(&closure)?)
        .execute(&mut *tx)
        .await?;
    stored
        .state
        .closed_responses
        .insert(closure.work.activation_id.clone(), closure.cursor.clone());
    save(&mut tx, &closure.work.system_start_id, &stored.state).await?;
    tx.commit().await?;
    Ok(closure)
}
