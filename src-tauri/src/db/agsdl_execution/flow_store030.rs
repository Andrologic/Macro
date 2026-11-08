//! Durable reducer boundary. Only the native host may construct events or implement
//! authority checks. Every entry point requires an existing BEGIN IMMEDIATE transaction.
use super::flow030::{
    reduce, FlowEffect030, FlowEffectKind030, FlowEvent030, FlowEventKind030, FlowIdentity030,
    FlowInputError030, FlowPlan030, FlowReceipt030, FlowState030,
};
use serde_json::{json, Value};
use sqlx::{Row, SqliteConnection};
use std::{future::Future, pin::Pin};

pub(crate) type StoreResult<T> = Result<T, StoreError030>;
pub(crate) type CheckFuture<'a> = Pin<Box<dyn Future<Output = StoreResult<()>> + Send + 'a>>;

#[derive(Debug)]
pub(crate) enum StoreError030 {
    Sql(sqlx::Error),
    Json(serde_json::Error),
    Reducer(FlowInputError030),
    Authority,
    Missing,
    Conflict,
    Blocked,
    NotClaimable,
}
impl From<sqlx::Error> for StoreError030 {
    fn from(e: sqlx::Error) -> Self {
        Self::Sql(e)
    }
}
impl From<serde_json::Error> for StoreError030 {
    fn from(e: serde_json::Error) -> Self {
        Self::Json(e)
    }
}

/// Implemented by the 0.3 native owner, not by an IPC caller. Both checks must
/// read their authoritative rows on `db`, in the caller's immediate transaction.
/// `effect` verifies receipt, full occurrence, recipient, digest and provenance.
pub(crate) trait Authority030 {
    fn owner<'a>(
        &'a self,
        db: &'a mut SqliteConnection,
        identity: &'a FlowIdentity030,
    ) -> CheckFuture<'a>;
    fn effect<'a>(
        &'a self,
        db: &'a mut SqliteConnection,
        effect: &'a FlowEffect030,
    ) -> CheckFuture<'a>;
    fn settlement<'a>(
        &'a self,
        db: &'a mut SqliteConnection,
        effect: &'a FlowEffect030,
        receipt: &'a Value,
    ) -> CheckFuture<'a>;
    fn owner_epoch(&self) -> &str;
}

#[derive(Debug)]
pub(crate) enum Apply030 {
    Applied(FlowReceipt030),
    Replayed(FlowReceipt030),
    Diagnostic(Value),
}
#[derive(Debug)]
pub(crate) struct FlowView030 {
    pub state: FlowState030,
    pub events: Vec<Value>,
    pub effects: Vec<Value>,
}

async fn load(
    db: &mut SqliteConnection,
    identity: &FlowIdentity030,
) -> StoreResult<(String, FlowState030)> {
    let row = sqlx::query("SELECT snapshot_id, epoch, plan_json, state_json FROM engine_flow030_runs WHERE system_id=? AND invocation_id=?")
        .bind(&identity.system_start_id).bind(&identity.flow_invocation_id)
        .fetch_optional(&mut *db).await?.ok_or(StoreError030::Missing)?;
    if row.get::<String, _>("snapshot_id") != identity.snapshot_id
        || row.get::<String, _>("epoch") != identity.epoch
    {
        return Err(StoreError030::Authority);
    }
    let state: FlowState030 = serde_json::from_str(row.get::<&str, _>("state_json"))?;
    if state.identity != *identity {
        return Err(StoreError030::Authority);
    }
    Ok((row.get("plan_json"), state))
}

pub(crate) async fn initialize_tx<A: Authority030>(
    db: &mut SqliteConnection,
    authority: &A,
    identity: &FlowIdentity030,
    source_json: &str,
    plan_json: &str,
) -> StoreResult<()> {
    authority.owner(db, identity).await?;
    if identity.system_start_id.is_empty()
        || identity.flow_invocation_id.is_empty()
        || identity.snapshot_id.is_empty()
        || identity.epoch.is_empty()
    {
        return Err(StoreError030::Authority);
    }
    let source: Value = serde_json::from_str(source_json)?;
    let plan: FlowPlan030 = serde_json::from_str(plan_json)?;
    if source != plan.source {
        return Err(StoreError030::Conflict);
    }
    let state = serde_json::to_string(&FlowState030::new(identity.clone()))?;
    sqlx::query("INSERT INTO engine_flow030_runs(system_id,invocation_id,snapshot_id,epoch,source_json,plan_json,state_json) VALUES(?,?,?,?,?,?,?)")
        .bind(&identity.system_start_id).bind(&identity.flow_invocation_id).bind(&identity.snapshot_id).bind(&identity.epoch)
        .bind(source_json).bind(plan_json).bind(state).execute(&mut *db).await?;
    Ok(())
}

pub(crate) async fn apply_tx<A: Authority030>(
    db: &mut SqliteConnection,
    authority: &A,
    event: &FlowEvent030,
) -> StoreResult<Apply030> {
    let id = &event.identity;
    authority.owner(db, id).await?;
    let (plan_json, state) = load(db, id).await?;
    let encoded = serde_json::to_string(event)?;
    if let Some(row) = sqlx::query("SELECT event_json,receipt_json,diagnostic_json FROM engine_flow030_events WHERE system_id=? AND invocation_id=? AND event_id=?")
        .bind(&id.system_start_id).bind(&id.flow_invocation_id).bind(&event.event_id).fetch_optional(&mut *db).await? {
        if row.get::<String,_>("event_json") != encoded { return Err(StoreError030::Conflict); }
        if let Some(receipt) = row.get::<Option<String>,_>("receipt_json") { return Ok(Apply030::Replayed(serde_json::from_str(&receipt)?)); }
        return Ok(Apply030::Diagnostic(serde_json::from_str(row.get::<&str,_>("diagnostic_json"))?));
    }
    // A diagnostic is durable and non-retriable. Stop and its physical proofs
    // remain available; neither manufactures a verdict for the rejected event.
    let blocked: i64 = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM engine_flow030_events WHERE system_id=? AND invocation_id=? AND diagnostic_json IS NOT NULL)")
        .bind(&id.system_start_id).bind(&id.flow_invocation_id).fetch_one(&mut *db).await?;
    if blocked != 0
        && !matches!(&event.kind, FlowEventKind030::Stop)
        && !(state.stopping && matches!(&event.kind, FlowEventKind030::PhysicalEnded { .. }))
    {
        return Err(StoreError030::Blocked);
    }
    let plan: FlowPlan030 = serde_json::from_str(&plan_json)?;
    let transition = match reduce(&plan, &state, event) {
        Ok(t) => t,
        Err(FlowInputError030::UnspecifiedSharedCancellation {
            closing_join,
            affected_joins,
        }) => {
            let diagnostic = json!({"code":"UNSPECIFIED_SHARED_CANCELLATION","closingJoin":closing_join,"affectedJoins":affected_joins,"retryable":false});
            sqlx::query("INSERT INTO engine_flow030_events(system_id,invocation_id,event_id,event_json,diagnostic_json) VALUES(?,?,?,?,?)")
                .bind(&id.system_start_id).bind(&id.flow_invocation_id).bind(&event.event_id).bind(&encoded).bind(diagnostic.to_string()).execute(&mut *db).await?;
            return Ok(Apply030::Diagnostic(diagnostic));
        }
        Err(e) => return Err(StoreError030::Reducer(e)),
    };
    let receipt = serde_json::to_string(&transition.receipt)?;
    sqlx::query("INSERT INTO engine_flow030_events(system_id,invocation_id,event_id,event_json,receipt_json) VALUES(?,?,?,?,?)")
        .bind(&id.system_start_id).bind(&id.flow_invocation_id).bind(&event.event_id).bind(&encoded).bind(receipt).execute(&mut *db).await?;
    for effect in &transition.effects {
        sqlx::query("INSERT INTO engine_flow030_outbox(system_id,invocation_id,effect_id,event_id,effect_json,status,owner_epoch) VALUES(?,?,?,?,?,'pending',?)")
            .bind(&id.system_start_id).bind(&id.flow_invocation_id).bind(&effect.id).bind(&event.event_id)
            .bind(serde_json::to_string(effect)?).bind(authority.owner_epoch()).execute(&mut *db).await?;
    }
    let changed = sqlx::query("UPDATE engine_flow030_runs SET state_json=? WHERE system_id=? AND invocation_id=? AND state_json=?")
        .bind(serde_json::to_string(&transition.state)?).bind(&id.system_start_id).bind(&id.flow_invocation_id).bind(serde_json::to_string(&state)?)
        .execute(&mut *db).await?.rows_affected();
    if changed != 1 {
        return Err(StoreError030::Conflict);
    }
    Ok(Apply030::Applied(transition.receipt))
}

fn eligible(state: &FlowState030, effect: &FlowEffect030) -> bool {
    if effect.identity != state.identity {
        return false;
    }
    match &effect.kind {
        FlowEffectKind030::Start { work, .. } => {
            !state.stopping
                && state.verdict.is_none()
                && state.activations.iter().any(|a| {
                    a.id == work.activation_id
                        && a.phase == "running"
                        && a.start_effect_id.as_deref() == Some(effect.id.as_str())
                        && a.stop_effect_id.is_none()
                })
        }
        FlowEffectKind030::Steer {
            work,
            delivery_activation_id,
            ..
        } => {
            !state.stopping
                && state.verdict.is_none()
                && state.activations.iter().any(|a| {
                    a.id == work.activation_id
                        && a.phase == "running"
                        && a.start_effect_id.as_deref() == Some(work.start_effect_id.as_str())
                        && a.stop_effect_id.is_none()
                })
                && state
                    .activations
                    .iter()
                    .any(|a| &a.id == delivery_activation_id)
        }
        FlowEffectKind030::PrepareRoute { reference, .. } => {
            !state.stopping
                && state.verdict.is_none()
                && state
                    .preparations
                    .iter()
                    .any(|p| p.status == "pending" && p.reference == *reference)
        }
        FlowEffectKind030::StopWork { work, .. } => state.activations.iter().any(|a| {
            a.id == work.activation_id
                && a.physical
                && a.stop_effect_id.as_deref() == Some(effect.id.as_str())
        }),
        _ => true,
    }
}

/// Native host calls the verifier while holding the same immediate transaction.
/// After this returns, the claim is durable only once the caller commits. It is
/// deliberately recorded as uncertain before any external IO and never retried.
/// The returned value is not authority to dispatch: the native owner must hold
/// its admission exclusion across all eligibility changes, this transaction's
/// acknowledged commit, and synchronous transfer to a cancellable, joinable
/// owner. A failed or unknown commit must not result in any external IO.
pub(crate) async fn claim_tx<A: Authority030>(
    db: &mut SqliteConnection,
    authority: &A,
    id: &FlowIdentity030,
    effect_id: &str,
) -> StoreResult<FlowEffect030> {
    authority.owner(db, id).await?;
    let (_, state) = load(db, id).await?;
    let row = sqlx::query("SELECT effect_json,status,owner_epoch FROM engine_flow030_outbox WHERE system_id=? AND invocation_id=? AND effect_id=?")
        .bind(&id.system_start_id).bind(&id.flow_invocation_id).bind(effect_id).fetch_optional(&mut *db).await?.ok_or(StoreError030::Missing)?;
    if row.get::<String, _>("status") != "pending"
        || row.get::<String, _>("owner_epoch") != authority.owner_epoch()
    {
        return Err(StoreError030::NotClaimable);
    }
    let effect: FlowEffect030 = serde_json::from_str(row.get::<&str, _>("effect_json"))?;
    if effect.id != effect_id || !eligible(&state, &effect) {
        return Err(StoreError030::NotClaimable);
    }
    let blocked: i64 = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM engine_flow030_events WHERE system_id=? AND invocation_id=? AND diagnostic_json IS NOT NULL)")
        .bind(&id.system_start_id).bind(&id.flow_invocation_id).fetch_one(&mut *db).await?;
    if blocked != 0
        && !matches!(
            &effect.kind,
            FlowEffectKind030::StopWork { .. } | FlowEffectKind030::RunEnded { .. }
        )
    {
        return Err(StoreError030::Blocked);
    }
    authority.effect(db, &effect).await?;
    let changed = sqlx::query("UPDATE engine_flow030_outbox SET status='uncertain' WHERE system_id=? AND invocation_id=? AND effect_id=? AND status='pending' AND owner_epoch=?")
        .bind(&id.system_start_id).bind(&id.flow_invocation_id).bind(effect_id).bind(authority.owner_epoch()).execute(&mut *db).await?.rows_affected();
    if changed != 1 {
        return Err(StoreError030::NotClaimable);
    }
    Ok(effect)
}

pub(crate) async fn settle_tx<A: Authority030>(
    db: &mut SqliteConnection,
    authority: &A,
    id: &FlowIdentity030,
    effect_id: &str,
    receipt: &Value,
) -> StoreResult<()> {
    authority.owner(db, id).await?;
    load(db, id).await?;
    let row = sqlx::query("SELECT effect_json,status,settlement_json FROM engine_flow030_outbox WHERE system_id=? AND invocation_id=? AND effect_id=?")
        .bind(&id.system_start_id).bind(&id.flow_invocation_id).bind(effect_id).fetch_optional(&mut *db).await?.ok_or(StoreError030::Missing)?;
    let effect: FlowEffect030 = serde_json::from_str(row.get::<&str, _>("effect_json"))?;
    if effect.id != effect_id || effect.identity != *id {
        return Err(StoreError030::Authority);
    }
    authority.settlement(db, &effect, receipt).await?;
    let raw = serde_json::to_string(receipt)?;
    let status: String = row.get("status");
    if status == "settled" {
        return if row.get::<Option<String>, _>("settlement_json").as_deref() == Some(raw.as_str()) {
            Ok(())
        } else {
            Err(StoreError030::Conflict)
        };
    }
    if status != "uncertain" {
        return Err(StoreError030::NotClaimable);
    }
    sqlx::query("UPDATE engine_flow030_outbox SET status='settled',settlement_json=? WHERE system_id=? AND invocation_id=? AND effect_id=? AND status='uncertain'")
        .bind(raw).bind(&id.system_start_id).bind(&id.flow_invocation_id).bind(effect_id).execute(&mut *db).await?;
    Ok(())
}

pub(crate) async fn read_tx<A: Authority030>(
    db: &mut SqliteConnection,
    authority: &A,
    id: &FlowIdentity030,
) -> StoreResult<FlowView030> {
    authority.owner(db, id).await?;
    let (_, state) = load(db, id).await?;
    let rows = sqlx::query("SELECT event_json,receipt_json,diagnostic_json FROM engine_flow030_events WHERE system_id=? AND invocation_id=? ORDER BY rowid")
        .bind(&id.system_start_id).bind(&id.flow_invocation_id).fetch_all(&mut *db).await?;
    let mut events = Vec::new();
    for row in rows {
        events.push(json!({"event":serde_json::from_str::<Value>(row.get("event_json"))?,"receipt":row.get::<Option<String>,_>("receipt_json").map(|s|serde_json::from_str::<Value>(&s)).transpose()?,"diagnostic":row.get::<Option<String>,_>("diagnostic_json").map(|s|serde_json::from_str::<Value>(&s)).transpose()?}));
    }
    let rows = sqlx::query("SELECT effect_json,status,settlement_json FROM engine_flow030_outbox WHERE system_id=? AND invocation_id=? ORDER BY rowid")
        .bind(&id.system_start_id).bind(&id.flow_invocation_id).fetch_all(&mut *db).await?;
    let mut effects = Vec::new();
    for row in rows {
        effects.push(json!({"effect":serde_json::from_str::<Value>(row.get("effect_json"))?,"status":row.get::<String,_>("status"),"settlement":row.get::<Option<String>,_>("settlement_json").map(|s|serde_json::from_str::<Value>(&s)).transpose()?}));
    }
    Ok(FlowView030 {
        state,
        events,
        effects,
    })
}

#[cfg(test)]
#[path = "flow_store030_tests.rs"]
mod tests;
