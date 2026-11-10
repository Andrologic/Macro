//! Read the retained flow tables, including after host interruption. No replay.
use crate::db::agsdl_execution::{
    failure, flow030::FlowState030, public030::*, start030::StartCapture030, Result,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{Row, SqlitePool};

pub(crate) async fn read(
    pool: &SqlitePool,
    scope: HumanScope030,
    continuation: Option<HumanContinuation030>,
) -> Result<HumanPage030> {
    let mut tx = pool.begin().await?;
    let row = sqlx::query("SELECT c.capture_json,r.state_json,i.interrupted_at FROM engine_start030_requests c JOIN engine_flow030_runs r USING(system_id,invocation_id) LEFT JOIN engine_flow030_interruptions i USING(system_id) WHERE c.system_id=?")
        .bind(&scope.system_start_id).fetch_optional(&mut *tx).await?
        .ok_or_else(|| failure("NOT_FOUND", "scope", "Flow capture not found"))?;
    let capture: StartCapture030 = serde_json::from_str(row.get("capture_json"))?;
    if capture.source != scope.source {
        return Err(failure("CORRELATION", "scope", "Human scope differs"));
    }
    let state: FlowState030 = serde_json::from_str(row.get("state_json"))?;
    let interrupted = row.get::<Option<String>, _>("interrupted_at").is_some();
    let clock = sqlx::query("SELECT revision,receipt_json,observed_ms FROM engine_flow030_clock WHERE system_id=? AND invocation_id=?")
        .bind(&scope.system_start_id).bind(&capture.identity.flow_invocation_id).fetch_optional(&mut *tx).await?;
    let observed: Option<String> = clock.as_ref().map(|c| c.get("observed_ms"));
    let rows = sqlx::query("SELECT * FROM engine_flow030_human_requests WHERE system_id=? AND invocation_id=? ORDER BY rowid")
        .bind(&scope.system_start_id).bind(&capture.identity.flow_invocation_id).fetch_all(&mut *tx).await?;
    let mut requests = Vec::new();
    for row in rows {
        let id: String = row.get("request_id");
        let kind: &str = row.get("kind");
        let payload: Value = serde_json::from_str(row.get("payload_json"))?;
        let work_ids: Vec<String> = serde_json::from_str(row.get("work_ids_json"))?;
        let resolution: Option<Value> = row
            .get::<Option<String>, _>("resolution_json")
            .map(|s| serde_json::from_str(&s))
            .transpose()?;
        let submission = sqlx::query("SELECT receipt_id,received_ms,origin,answer_json,accepted FROM engine_flow030_human_submissions WHERE system_id=? AND invocation_id=? AND request_id=? ORDER BY rowid DESC LIMIT 1")
            .bind(&scope.system_start_id).bind(&capture.identity.flow_invocation_id).bind(&id).fetch_optional(&mut *tx).await?;
        let human_answer = submission.as_ref().map(|s| -> Result<Value> { Ok(json!({"answer":serde_json::from_str::<Value>(s.get("answer_json"))?,"origin":if s.get::<&str,_>("origin")=="person" {"person"} else {"syntheticPerson"},"receivedAtMs":s.get::<String,_>("received_ms")})) }).transpose()?;
        let content = match kind {
            "approval" => {
                json!({"kind":"flowChoice","title":payload["title"].as_str().or_else(||payload["step"].as_array().and_then(|s|s.last()).and_then(Value::as_str)).unwrap_or(""),"description":payload["description"].as_str().unwrap_or(""),"messageJson":payload["message"].to_string(),"choices":payload["choices"]})
            }
            "ask" => {
                json!({"kind":"actionApproval","title":payload["title"].as_str().unwrap_or(""),"actionJson":payload.to_string()})
            }
            "plan" => json!({"kind":"plan","plan":payload["plan"].as_str().unwrap_or("")}),
            "question" => {
                json!({"kind":"question","question":payload["question"].as_str().unwrap_or(""),"expectedResponse":payload["expectedResponse"].as_str().unwrap_or(""),"answerContract":{"kind":"available","value":{"schemaJson":payload["schema"].to_string(),"protocol":"mcp"}}})
            }
            _ => return Err(failure("CORRELATION", "human", "Unknown request kind")),
        };
        let mut status = json!({"kind":"open"});
        if let Some(resolution) = resolution {
            let expired = resolution["expired"] == true;
            let receipt = submission
                .as_ref()
                .filter(|s| s.get::<Option<i64>, _>("accepted") == Some(1))
                .map(|s| s.get::<String, _>("receipt_id"))
                .unwrap_or_else(|| format!("human:{id}:timeout"));
            let answer = if expired && kind != "approval" {
                json!({"answer":{"kind":"decision","decision":"no","comment":""},"origin":"automaticTimeout","receivedAtMs":resolution["resolvedAtMs"]})
            } else if expired {
                Value::Null
            } else {
                human_answer.clone().unwrap_or(Value::Null)
            };
            let reason = if expired {
                if kind == "approval" {
                    "approvalTimeout"
                } else {
                    "answerTimeout"
                }
            } else {
                "person"
            };
            let resolved = json!({"receiptId":receipt,"resolvedAtMs":resolution["resolvedAtMs"],"accepted":true,"reason":reason,"answer":answer});
            status = if expired {
                json!({"kind":"expired","resolution":resolved})
            } else if row.get::<&str, _>("delivery") == "acknowledged" {
                json!({"kind":"consumed","receiptId":receipt,"resolutionReceiptId":id,"resolution":resolved})
            } else {
                json!({"kind":"resolved","receiptId":receipt,"resolution":resolved})
            };
        } else if interrupted || state.stopping || state.verdict.is_some() {
            status = json!({"kind":"cancelled","resolution":{"receiptId":format!("human:{id}:closed"),"resolvedAtMs":observed,"accepted":false,"reason":if interrupted {"revocation"} else if state.stopping {"stop"} else {"workEnded"},"answer":null}});
        } else if let (Some(submission), Some(answer)) = (&submission, &human_answer) {
            status = json!({"kind":"submitted","receiptId":submission.get::<String,_>("receipt_id"),"answer":answer});
        }
        let deadline: Value = serde_json::from_str(row.get("deadline_json"))?;
        let mut works = Vec::new();
        for work in &work_ids {
            let row = sqlx::query("SELECT snapshot_json,timeout_json FROM engine_flow030_clock_works WHERE system_id=? AND invocation_id=? AND activation_id=?")
                .bind(&scope.system_start_id).bind(&capture.identity.flow_invocation_id).bind(work).fetch_one(&mut *tx).await?;
            let snapshot: Value = serde_json::from_str(row.get("snapshot_json"))?;
            let elapsed = snapshot["elapsedMachineMs"].as_str().unwrap_or("0");
            // Exact authored exponents remain in timeoutMs; the receipt's elapsed
            // budget is projected without a lossy floating-point conversion.
            let remaining = row
                .get::<Option<String>, _>("timeout_json")
                .and_then(|s| s.parse::<u64>().ok())
                .zip(elapsed.parse::<u64>().ok())
                .map(|(limit, used)| limit.saturating_sub(used).to_string());
            works.push(json!({"workId":work,"machineElapsedMs":elapsed,"machineRemainingMs":remaining,"machinePaused":snapshot["openHumanRequests"].as_array().is_some_and(|a|!a.is_empty())}));
        }
        let clock_fact = observed.as_ref().map(|at|json!({"kind":"available","value":{"openedAtMs":deadline["openedAtMs"],"observedAtMs":at,"timeoutMs":deadline["timeoutMs"],"works":works}})).unwrap_or(json!({"kind":"unavailable","gap":"human-clock-observation"}));
        let occurrences: Vec<Value> = work_ids.iter().map(|work|json!({"workId":work,"activation":{"kind":"available","scope":{"systemStartId":scope.system_start_id,"source":scope.source,"snapshotId":capture.identity.snapshot_id},"activationId":work}})).collect();
        let facts = json!({"scope":scope,"id":id,"revision":row.get::<String,_>("revision"),"workIds":work_ids,"occurrences":occurrences,"content":content,"state":status,"clock":clock_fact});
        let legacy_content = match kind {
            "approval" => HumanContent030::Approval {
                message: payload["message"].to_string(),
                title: content["title"].as_str().unwrap_or("").into(),
                description: content["description"].as_str().unwrap_or("").into(),
                choices: serde_json::from_value(payload["choices"].clone())?,
            },
            "plan" => HumanContent030::Plan {
                plan: content["plan"].as_str().unwrap_or("").into(),
            },
            _ => HumanContent030::Question {
                question: content["question"].as_str().unwrap_or("").into(),
                expected_response: content["expectedResponse"].as_str().unwrap_or("").into(),
            },
        };
        requests.push(PublicHumanRequest030 {
            id,
            revision: row.get("revision"),
            status: status["kind"].as_str().unwrap().into(),
            work_ids,
            content: legacy_content,
            flow_json: Some(facts.to_string()),
        });
    }
    let cursor = format!("{:x}", Sha256::digest(serde_json::to_vec(&requests)?));
    let offset = match continuation {
        Some(next) if next.scope == scope && next.cursor == cursor => next.offset as usize,
        None => 0,
        _ => {
            return Err(failure(
                "CONFLICT",
                "continuation",
                "Human projection changed",
            ))
        }
    };
    if offset > requests.len() {
        return Err(failure(
            "CONFLICT",
            "continuation",
            "Human offset exceeds projection",
        ));
    }
    let total = requests.len();
    let page = requests.into_iter().skip(offset).take(64).collect();
    let next_page = (offset + 64 < total).then(|| HumanContinuation030 {
        scope: scope.clone(),
        cursor: cursor.clone(),
        offset: (offset + 64) as u32,
    });
    tx.commit().await?;
    Ok(HumanPage030 {
        scope,
        cursor,
        total: total.to_string(),
        requests: page,
        next_page,
    })
}
