//! SQL facts for the shared native human/clock verifier.
use super::*;
#[path = "db/agsdl_execution/v030/human_clock_verify030.rs"]
mod core;
pub(super) use core::ms;
use core::*;
async fn facts(
    broker: &HumanBroker030,
    db: &mut SqliteConnection,
) -> Result<(Vec<Work>, Vec<Request>, Vec<Submission>)> {
    let works = sqlx::query("SELECT * FROM engine_flow030_clock_works WHERE system_id=? AND invocation_id=? ORDER BY rowid")
        .bind(&broker.identity.system_start_id).bind(&broker.identity.flow_invocation_id).fetch_all(&mut *db).await?;
    let works = works
        .iter()
        .map(|r| {
            Ok(Work {
                id: r.get("activation_id"),
                kind: r.get("kind"),
                start: ms(r.get("admitted_ms"))?,
                timeout: r.get("timeout_json"),
                answer_timeout: r.get("answer_timeout_json"),
                snapshot: serde_json::from_str(r.get("snapshot_json"))?,
                retired: r.get::<i64, _>("retired") != 0,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let rows = sqlx::query("SELECT r.*,p.resolution_json AS proof_json,e.output_json AS proof_output FROM engine_flow030_human_requests r LEFT JOIN engine_flow030_human_resolution_proofs p ON p.system_id=r.system_id AND p.invocation_id=r.invocation_id AND p.request_id=r.request_id LEFT JOIN engine_flow030_clock_events e ON e.system_id=p.system_id AND e.invocation_id=p.invocation_id AND e.event_id=p.event_id WHERE r.system_id=? AND r.invocation_id=? ORDER BY r.rowid")
        .bind(&broker.identity.system_start_id).bind(&broker.identity.flow_invocation_id).fetch_all(&mut *db).await?;
    let mut requests = rows
        .iter()
        .map(|r| {
            Ok(Request {
                id: r.get("request_id"),
                kind: r.get("kind"),
                works: serde_json::from_str(r.get("work_ids_json"))?,
                opened: ms(r.get("opened_ms"))?,
                duration: None,
                resolution: r
                    .get::<Option<String>, _>("resolution_json")
                    .map(|s| serde_json::from_str(&s).map(strip_reason))
                    .transpose()?,
                acknowledged: r.get::<&str, _>("delivery") == "acknowledged",
                proven: r.get::<Option<String>, _>("resolution_json").is_some()
                    && r.get::<Option<String>, _>("proof_json")
                        == r.get::<Option<String>, _>("resolution_json")
                    && r.get::<Option<String>, _>("proof_output").is_some(),
            })
        })
        .collect::<Result<Vec<_>>>()?;
    for request in &mut requests {
        request.duration = duration(request, &works)?;
    }
    let rows = sqlx::query("SELECT * FROM engine_flow030_human_submissions WHERE system_id=? AND invocation_id=? ORDER BY rowid")
        .bind(&broker.identity.system_start_id).bind(&broker.identity.flow_invocation_id).fetch_all(&mut *db).await?;
    let submissions = rows
        .iter()
        .map(|r| {
            Ok(Submission {
                id: r.get("receipt_id"),
                request: r.get("request_id"),
                received: ms(r.get("received_ms"))?,
                answer: serde_json::from_str(r.get("answer_json"))?,
                accepted: r.get("accepted"),
            })
        })
        .collect::<Result<Vec<_>>>()?;
    Ok((works, requests, submissions))
}

pub(super) async fn validate_stored(
    broker: &HumanBroker030,
    db: &mut SqliteConnection,
    request_id: &str,
) -> Result<()> {
    let (_, requests, submissions) = facts(broker, db).await?;
    let request = requests
        .iter()
        .find(|r| r.id == request_id)
        .ok_or_else(|| failure("CORRELATION", "human", "Native request absent"))?;
    require(request.resolution.is_some(), "Native resolution absent")?;
    verify_existing(request, &submissions)
}

/// Validate ALL authorities and their metadata before the caller writes any of
/// them. The pure journal's byte correlation alone grants no decision.
pub(super) async fn validate(
    broker: &HumanBroker030,
    db: &mut SqliteConnection,
    envelope: &Value,
    receipt: &Value,
) -> Result<()> {
    let row = broker.clock_row(db).await?;
    let previous = ms(row.get("observed_ms"))?;
    let (works, requests, submissions) = facts(broker, db).await?;
    validate_projection(works, requests, submissions, previous, envelope, receipt)
}
