//! Readback of 040 uses the same native deadline and pause checks as COMMIT.
use super::*;
use std::collections::BTreeMap;
type NativeError = Box<dyn std::error::Error + Send + Sync>;
type Result<T> = std::result::Result<T, NativeError>;
fn failure(_: &str, _: &str, message: &str) -> NativeError {
    message.to_owned().into()
}
fn require(ok: bool, message: &str) -> Result<()> {
    if ok {
        Ok(())
    } else {
        Err(failure("CORRELATION", "human", message))
    }
}
fn human_comment_is_empty030(comment: &str) -> bool {
    comment.chars().all(|c| matches!(c,'\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'))
}
#[path = "human_answer030.rs"]
mod answer;
use answer::HumanAnswer030;
#[path = "human_clock_verify030.rs"]
mod core;
use core::*;
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HumanProjection030 {
    pub answers: Vec<Value>,
    pub timeout_ids: Vec<String>,
}
fn parsed(row: &sqlx::sqlite::SqliteRow, key: &str) -> Result<Value> {
    Ok(serde_json::from_str(row.try_get(key)?)?)
}
fn rows_json(value: &Value, key: &str) -> Result<Vec<Value>> {
    Ok(value[key].as_array().ok_or("Missing clock array")?.clone())
}
pub(super) async fn verify(
    db: &mut SqliteConnection,
    state: &FlowState030,
    plan: &FlowPlan030,
) -> Result<HumanProjection030> {
    let id = &state.identity;
    let exists: i64 = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='engine_flow030_clock')",
    )
    .fetch_one(&mut *db)
    .await?;
    let requires_clock = state
        .activations
        .iter()
        .filter(|a| a.start_effect_id.is_some())
        .any(|a| {
            let step = plan
                .steps
                .iter()
                .find(|s| Some(&s.address) == a.step.as_ref());
            step.is_some_and(|s| s.r#type == "approval" || s.timeout_ms_json.is_some())
                || a.agent.as_ref().is_some_and(|name| {
                    plan.agents.iter().any(|agent| {
                        agent["agentName"] == *name
                            && agent["agentDeclarationJson"]
                                .as_str()
                                .and_then(|s| serde_json::from_str::<Value>(s).ok())
                                .is_some_and(|a| {
                                    a.get("answerTimeoutMs").is_some() || a["planFirst"] == "ask"
                                })
                    })
                })
        });
    if exists == 0 {
        require(!requires_clock, "Required human clock schema absent")?;
        return Ok(HumanProjection030::default());
    }
    let clocks =
        sqlx::query("SELECT * FROM engine_flow030_clock WHERE system_id=? AND invocation_id=?")
            .bind(&id.system_start_id)
            .bind(&id.flow_invocation_id)
            .fetch_all(&mut *db)
            .await?;
    let events=sqlx::query("SELECT * FROM engine_flow030_clock_events WHERE system_id=? AND invocation_id=? ORDER BY rowid").bind(&id.system_start_id).bind(&id.flow_invocation_id).fetch_all(&mut *db).await?;
    let work_rows=sqlx::query("SELECT * FROM engine_flow030_clock_works WHERE system_id=? AND invocation_id=? ORDER BY rowid").bind(&id.system_start_id).bind(&id.flow_invocation_id).fetch_all(&mut *db).await?;
    let request_rows=sqlx::query("SELECT * FROM engine_flow030_human_requests WHERE system_id=? AND invocation_id=? ORDER BY rowid").bind(&id.system_start_id).bind(&id.flow_invocation_id).fetch_all(&mut *db).await?;
    if clocks.is_empty() {
        require(
            !requires_clock && events.is_empty() && work_rows.is_empty() && request_rows.is_empty(),
            "Clock parent absent",
        )?;
        return Ok(HumanProjection030::default());
    }
    require(clocks.len() == 1, "Duplicate clock")?;
    let clock = &clocks[0];
    let native_owner=sqlx::query("SELECT owner_epoch,generation FROM engine_flow030_owners WHERE system_id=? AND invocation_id=?").bind(&id.system_start_id).bind(&id.flow_invocation_id).fetch_one(&mut *db).await?;
    require(
        clock.get::<&str, _>("owner_epoch") == native_owner.get::<&str, _>("owner_epoch")
            && clock.get::<&str, _>("generation") == native_owner.get::<&str, _>("generation"),
        "Clock owner differs",
    )?;
    let owner =
        json!({"systemStartId":id.system_start_id,"ownerEpoch":clock.get::<&str,_>("owner_epoch")});
    let mut works = Vec::<Work>::new();
    let mut requests = Vec::<Request>::new();
    let mut submissions = Vec::<Submission>::new();
    let mut previous = String::new();
    let mut observed = 0u64;
    let mut last = json!({});
    let mut journal = Vec::<Value>::new();
    for (index, row) in events.iter().enumerate() {
        let ticket = parsed(row, "ticket_json")?;
        require(
            ticket["identity"] == serde_json::to_value(id)?
                && ticket["owner"] == owner
                && ticket["eventId"] == row.get::<&str, _>("event_id")
                && ticket["expectedRevision"] == index.to_string()
                && ticket["stateJson"] == previous,
            "Clock ticket correlation",
        )?;
        let envelope: Value = serde_json::from_str(
            ticket["eventJson"]
                .as_str()
                .ok_or("Clock event JSON absent")?,
        )?;
        let event = &envelope["event"];
        let kind = event["kind"].as_str().ok_or("Clock event kind absent")?;
        let now = ms(envelope["nowMs"].as_str().ok_or("Clock time absent")?)?;
        require(
            now >= observed
                && envelope["owner"] == owner
                && envelope["eventId"] == ticket["eventId"],
            "Clock event identity/time",
        )?;
        match kind {
            "admit" | "approval" => {
                let work_id = event["workId"].as_str().ok_or("Work id absent")?;
                require(
                    !works.iter().any(|w| w.id == work_id),
                    "Duplicate work clock",
                )?;
                let r = work_rows
                    .iter()
                    .find(|r| r.get::<&str, _>("activation_id") == work_id)
                    .ok_or("Clock work row absent")?;
                let work = parsed(r, "work_json")?;
                let activation = state
                    .activations
                    .iter()
                    .find(|a| a.id == work_id)
                    .ok_or("Clock activation absent")?;
                let step = plan
                    .steps
                    .iter()
                    .find(|s| Some(&s.address) == activation.step.as_ref())
                    .ok_or("Clock step absent")?;
                require(
                    r.get::<&str, _>("owner_epoch") == clock.get::<&str, _>("owner_epoch")
                        && r.get::<&str, _>("generation") == clock.get::<&str, _>("generation")
                        && work["identity"] == serde_json::to_value(id)?
                        && work["owner"] == owner
                        && work["generation"] == clock.get::<&str, _>("generation")
                        && work["kind"] == step.r#type,
                    "Clock work metadata",
                )?;
                let start = r.get::<&str, _>("start_effect_id");
                require(
                    activation.start_effect_id.as_deref() == Some(start)
                        && work["reference"]
                            == json!({"activationId":activation.id,"startEffectId":start,"agentInstanceId":activation.instance_id})
                        && r.get::<Option<String>, _>("timeout_json") == step.timeout_ms_json,
                    "Clock work reference/duration",
                )?;
                let origin=sqlx::query("SELECT started_ms FROM engine_flow030_handoff_clock WHERE system_id=? AND invocation_id=? AND start_effect_id=? AND owner_epoch=? AND generation=?")
                    .bind(&id.system_start_id).bind(&id.flow_invocation_id).bind(start).bind(clock.get::<&str,_>("owner_epoch")).bind(clock.get::<&str,_>("generation")).fetch_one(&mut *db).await?;
                let started = r.get::<&str, _>("admitted_ms");
                require(
                    origin.get::<&str, _>("started_ms") == started
                        && event["startedAtMs"] == started
                        && event["timeoutMs"] == json!(step.timeout_ms_json),
                    "Clock origin/duration",
                )?;
                let declaration: Value = serde_json::from_str(&step.declaration_json)?;
                let agent_declaration = step
                    .agent
                    .as_ref()
                    .and_then(|name| plan.agents.iter().find(|a| a["agentName"] == *name))
                    .and_then(|a| a["agentDeclarationJson"].as_str())
                    .map(serde_json::from_str::<Value>)
                    .transpose()?;
                let answer_limit = agent_declaration
                    .as_ref()
                    .unwrap_or(&declaration)
                    .get("answerTimeoutMs")
                    .map(Value::to_string);
                require(
                    r.get::<Option<String>, _>("answer_timeout_json") == answer_limit
                        && event
                            .get("answerTimeoutMs")
                            .map_or(kind == "approval", |limit| *limit == json!(answer_limit)),
                    "Authored answer duration differs",
                )?;
                works.push(Work {
                    id: work_id.into(),
                    kind: step.r#type.clone(),
                    start: ms(started)?,
                    timeout: r.get("timeout_json"),
                    answer_timeout: r.get("answer_timeout_json"),
                    snapshot: json!({}),
                    retired: false,
                });
            }
            "open" | "associate" | "answer" | "approvalAnswer" | "ack" | "retire" | "tick" => {}
            _ => return Err("Unknown clock event".into()),
        }
        if kind == "open" || kind == "approval" {
            let request_id = event["requestId"].as_str().ok_or("Request id absent")?;
            require(
                !requests.iter().any(|r| r.id == request_id),
                "Duplicate request",
            )?;
            let r = request_rows
                .iter()
                .find(|r| r.get::<&str, _>("request_id") == request_id)
                .ok_or("Request row absent")?;
            let ids = if kind == "approval" {
                vec![event["workId"]
                    .as_str()
                    .ok_or("Approval work absent")?
                    .to_owned()]
            } else {
                serde_json::from_value(event["workIds"].clone())?
            };
            require(
                ids.len() == 1
                    && works.iter().any(|w| w.id == ids[0])
                    && (kind == "approval" || event["reviewer"] == "person"),
                "Request ownership",
            )?;
            let mut request = Request {
                id: request_id.into(),
                kind: r.get("kind"),
                works: ids,
                opened: ms(r.get("opened_ms"))?,
                duration: None,
                resolution: None,
                acknowledged: false,
                proven: false,
            };
            require(
                (kind == "approval" && request.kind == "approval"
                    || event["requestKind"] == request.kind)
                    && request.opened
                        == if kind == "approval" {
                            ms(event["startedAtMs"]
                                .as_str()
                                .ok_or("Approval time absent")?)?
                        } else {
                            now
                        },
                "Request opening",
            )?;
            request.duration = duration(&request, &works)?;
            requests.push(request);
        }
        if kind == "associate" {
            require(
                requests.iter().any(|r| {
                    Some(r.id.as_str()) == event["requestId"].as_str() && r.kind == "question"
                }),
                "Only questions can reassociate",
            )?;
        }
        if kind == "answer" || kind == "approvalAnswer" {
            let receipt_id = event["nativeReceiptId"]
                .as_str()
                .ok_or("Answer receipt absent")?;
            let row=sqlx::query("SELECT * FROM engine_flow030_human_submissions WHERE system_id=? AND invocation_id=? AND receipt_id=?")
                .bind(&id.system_start_id).bind(&id.flow_invocation_id).bind(receipt_id).fetch_one(&mut *db).await?;
            require(
                !submissions.iter().any(|s| s.id == receipt_id)
                    && event["requestId"] == row.get::<&str, _>("request_id")
                    && now == ms(row.get("received_ms"))?,
                "Native answer receipt",
            )?;
            let answer: HumanAnswer030 = serde_json::from_str(row.get("answer_json"))?;
            require(
                ["person", "synthetic-person"].contains(&row.get::<&str, _>("origin")),
                "Answer origin differs",
            )?;
            let matches = match &answer {
                HumanAnswer030::Approval { choice, comment } => {
                    kind == "approvalAnswer"
                        && event["choice"] == *choice
                        && event["comment"] == *comment
                }
                HumanAnswer030::Decision { decision, comment } => {
                    kind == "answer"
                        && event["answer"] == json!({"decision":decision,"comment":comment})
                }
                HumanAnswer030::Question { answer_json } => {
                    let _: Value = serde_json::from_str(answer_json)?;
                    kind == "answer" && event["answer"].is_null()
                }
            };
            require(matches, "Answer event differs from native submission")?;
            submissions.push(Submission {
                id: receipt_id.into(),
                request: row.get("request_id"),
                received: now,
                answer,
                accepted: None,
            });
        }
        if kind == "ack" {
            let r = requests
                .iter_mut()
                .find(|r| Some(r.id.as_str()) == event["requestId"].as_str())
                .ok_or("Ack request absent")?;
            require(r.resolution.is_some(), "Ack before resolution")?;
            r.acknowledged = true;
        }
        let output = parsed(row, "output_json")?;
        let receipt: Value = serde_json::from_str(
            output["receiptJson"]
                .as_str()
                .ok_or("Clock receipt absent")?,
        )?;
        validate_projection(
            works.clone(),
            requests.clone(),
            submissions.clone(),
            observed,
            &envelope,
            &receipt,
        )?;
        journal.push(json!({"eventJson":ticket["eventJson"],"receiptJson":output["receiptJson"]}));
        let state_json = output["stateJson"].as_str().ok_or("Clock state absent")?;
        let clock_state: Value = serde_json::from_str(state_json)?;
        require(
            clock_state
                == json!({"format":"macro-agsdl-human-clock-journal/1","owner":owner,"options":serde_json::from_str::<Value>(ticket["optionsJson"].as_str().ok_or("Clock options absent")?)?,"entries":journal}),
            "Clock journal differs",
        )?;
        for w in &mut works {
            if kind == "retire" && event["workId"] == w.id {
                w.retired = true;
            }
            for item in rows_json(&receipt, if w.retired { "retiredClocks" } else { "clocks" })? {
                if item["workId"] == w.id {
                    w.snapshot = item["snapshot"].clone();
                }
            }
        }
        for r in &mut requests {
            for snapshot in rows_json(&receipt, "requests")? {
                if snapshot["requestId"] == r.id {
                    r.works = serde_json::from_value(snapshot["workIds"].clone())?;
                    r.duration = serde_json::from_value(snapshot["answerTimeoutMs"].clone())?;
                }
            }
            for resolution in rows_json(&receipt, "pendingResolutions")? {
                if resolution["requestId"] == r.id {
                    r.resolution = Some(resolution);
                    r.proven = true;
                }
            }
        }
        for s in &mut submissions {
            for a in rows_json(&receipt, "nativeAnswers")? {
                if a["nativeReceiptId"] == s.id {
                    s.accepted = a["accepted"].as_bool();
                }
            }
        }
        previous = state_json.into();
        observed = now;
        last = receipt;
    }
    require(
        clock.get::<&str, _>("revision") == events.len().to_string()
            && clock.get::<&str, _>("state_json") == previous
            && (events.is_empty()
                || parsed(clock, "receipt_json")? == last
                    && ms(clock.get("observed_ms"))? == observed),
        "Final clock differs",
    )?;
    require(
        works.len() == work_rows.len() && requests.len() == request_rows.len(),
        "Orphan clock facts",
    )?;
    let submission_rows=sqlx::query("SELECT receipt_id,accepted FROM engine_flow030_human_submissions WHERE system_id=? AND invocation_id=?").bind(&id.system_start_id).bind(&id.flow_invocation_id).fetch_all(&mut *db).await?;
    require(
        submission_rows.len() == submissions.len(),
        "Orphan native submission",
    )?;
    for row in submission_rows {
        require(
            submissions.iter().any(|s| {
                s.id == row.get::<&str, _>("receipt_id")
                    && s.accepted == row.get::<Option<bool>, _>("accepted")
            }),
            "Submission arbitration differs",
        )?;
    }
    let mut projection = HumanProjection030::default();
    for w in &works {
        let r = work_rows
            .iter()
            .find(|r| r.get::<&str, _>("activation_id") == w.id)
            .unwrap();
        require(
            r.get::<i64, _>("retired") == i64::from(w.retired)
                && parsed(r, "snapshot_json")? == w.snapshot,
            "Stored work snapshot differs",
        )?;
        let a = state.activations.iter().find(|a| a.id == w.id).unwrap();
        require(
            w.kind == "approval" || a.result.is_none() || w.retired,
            "Terminal clock remains active",
        )?;
    }
    for r in &requests {
        verify_existing(r, &submissions)?;
        let row = request_rows
            .iter()
            .find(|row| row.get::<&str, _>("request_id") == r.id)
            .unwrap();
        require(
            parsed(row, "work_ids_json")? == json!(r.works)
                && parsed(row, "deadline_json")?
                    == json!({"openedAtMs":r.opened.to_string(),"timeoutMs":r.duration}),
            "Request snapshot differs",
        )?;
        if let Some(resolution) = &r.resolution {
            let mut expected = resolution.clone();
            expected["reason"] = json!(if resolution["expired"] != true {
                "answer"
            } else if r.kind == "approval" {
                "approvalTimeout"
            } else {
                "answerTimeout"
            });
            require(
                parsed(row, "resolution_json")? == expected
                    && row.get::<&str, _>("revision") == "1"
                    && row.get::<&str, _>("delivery") == "acknowledged"
                    && r.acknowledged,
                "Resolution/readback differs",
            )?;
            let proof=sqlx::query("SELECT p.resolution_json,e.output_json FROM engine_flow030_human_resolution_proofs p JOIN engine_flow030_clock_events e USING(system_id,invocation_id,event_id) WHERE p.system_id=? AND p.invocation_id=? AND p.request_id=?")
                .bind(&id.system_start_id).bind(&id.flow_invocation_id).bind(&r.id).fetch_one(&mut *db).await?;
            require(
                parsed(&proof, "resolution_json")? == expected,
                "Native resolution proof differs",
            )?;
            let proof_output = parsed(&proof, "output_json")?;
            let proof_receipt: Value = serde_json::from_str(
                proof_output["receiptJson"]
                    .as_str()
                    .ok_or("Proof receipt absent")?,
            )?;
            require(
                rows_json(&proof_receipt, "pendingResolutions")?.contains(resolution),
                "Proof event differs",
            )?;
            if r.kind == "approval" {
                let a = state
                    .activations
                    .iter()
                    .find(|a| r.works == [a.id.clone()])
                    .ok_or("Approval activation absent")?;
                let payload = parsed(row, "payload_json")?;
                let step = plan
                    .steps
                    .iter()
                    .find(|s| Some(&s.address) == a.step.as_ref())
                    .ok_or("Approval step absent")?;
                let declaration: Value = serde_json::from_str(&step.declaration_json)?;
                let choices = declaration["next"]
                    .as_object()
                    .ok_or("Approval choices absent")?
                    .keys()
                    .cloned()
                    .collect::<Vec<_>>();
                let message = a
                    .message_json
                    .as_ref()
                    .map(|s| serde_json::from_str::<Value>(s))
                    .transpose()?
                    .unwrap_or(json!({}));
                require(
                    payload["choices"] == json!(choices)
                        && payload["message"] == message
                        && payload["step"] == json!(a.step)
                        && payload["work"]
                            == json!({"activationId":a.id,"startEffectId":a.start_effect_id,"agentInstanceId":a.instance_id}),
                    "Approval presentation differs",
                )?;

                let expected = if resolution["expired"] == true {
                    json!(WorkResultRecord030::Failed {
                        error: Failure030::new("APPROVAL_TIMEOUT")
                    })
                } else {
                    json!(WorkResultRecord030::Completed {output_json:json!({"choice":resolution["answer"]["choice"],"comment":resolution["answer"]["comment"],"message":payload["message"]}).to_string(), route_key:resolution["answer"]["choice"].as_str().map(str::to_owned)})
                };
                require(
                    serde_json::to_value(&a.result)? == expected,
                    "Approval terminal differs",
                )?;
            } else if resolution["expired"] == true {
                for id in &r.works {
                    let a = state
                        .activations
                        .iter()
                        .find(|a| &a.id == id)
                        .ok_or("Answered work absent")?;
                    let mut answer = json!({"work":a.step.as_ref().map(|s|s.join("/")).unwrap_or_default(),"answer":"no"});
                    if let Some(occurrence) = &a.occurrence {
                        answer["item"] = serde_json::from_str(&occurrence.item_index)?;
                    }
                    projection.answers.push(answer);
                }
            }
        } else {
            require(
                row.get::<Option<String>, _>("resolution_json").is_none(),
                "Invented resolution",
            )?;
        }
    }
    let controls = sqlx::query(
        "SELECT * FROM engine_flow030_clock_controls WHERE system_id=? AND invocation_id=?",
    )
    .bind(&id.system_start_id)
    .bind(&id.flow_invocation_id)
    .fetch_all(&mut *db)
    .await?;
    for a in &state.activations {
        if matches!(&a.result,Some(WorkResultRecord030::Failed {error}) if error.code=="TIMEOUT") {
            require(
                controls
                    .iter()
                    .any(|r| r.get::<&str, _>("activation_id") == a.id),
                "Missing timeout control",
            )?;
        }
    }
    for row in controls {
        let id = row.get::<&str, _>("activation_id");
        let w = works
            .iter()
            .find(|w| w.id == id)
            .ok_or("Timeout work absent")?;
        require(
            w.snapshot["expired"] == true
                && row.get::<i64, _>("joined") == 1
                && row.get::<&str, _>("reason") == "TIMEOUT",
            "Timeout control differs",
        )?;
        let a = state
            .activations
            .iter()
            .find(|a| a.id == id)
            .ok_or("Timed out activation absent")?;
        require(
            matches!(&a.result,Some(WorkResultRecord030::Failed {error}) if error.code=="TIMEOUT"),
            "Timeout terminal differs",
        )?;
        let observed = row.get::<&str, _>("observed_ms");
        let mut proven = false;
        for event in &events {
            let ticket = parsed(event, "ticket_json")?;
            let envelope: Value =
                serde_json::from_str(ticket["eventJson"].as_str().ok_or("Clock event absent")?)?;
            let output = parsed(event, "output_json")?;
            let receipt: Value = serde_json::from_str(
                output["receiptJson"]
                    .as_str()
                    .ok_or("Clock output absent")?,
            )?;
            if envelope["nowMs"] == observed {
                proven = receipt["expiredWorkIds"]
                    .as_array()
                    .is_some_and(|ids| ids.contains(&json!(id)));
                if proven {
                    break;
                }
            }
        }
        require(proven, "Timeout control has no native clock decision")?;
        projection.timeout_ids.push(id.into());
    }
    Ok(projection)
}
