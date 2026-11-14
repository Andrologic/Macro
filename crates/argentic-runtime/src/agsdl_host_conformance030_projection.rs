//! Seven-field projection and upstream pattern comparison. No replay verifier
//! or observer dependency: the caller supplies the drained native flow view.
use super::*;
use crate::persistence::flow_store030::FlowView030;
use sqlx::Row;

fn item(activation: &Activation030, value: &mut Value) {
    if activation.item_json.is_some() {
        value["item"] = serde_json::from_str(
            &activation
                .occurrence
                .as_ref()
                .expect("item occurrence")
                .item_index,
        )
        .unwrap();
    }
}
fn activation<'a>(view: &'a FlowView030, id: &str) -> &'a Activation030 {
    view.state
        .activations
        .iter()
        .find(|a| a.id == id)
        .expect("effect activation")
}

pub(super) async fn project(f: &Fixture, view: &FlowView030) -> Value {
    assert!(view.state.activations.iter().all(|a| !a.physical));
    let admitted = sqlx::query_scalar::<_, String>(
        "SELECT effect_id FROM engine_flow030_handoffs WHERE system_id=? AND invocation_id=?",
    )
    .bind(&f.identity.system_start_id)
    .bind(&f.identity.flow_invocation_id)
    .fetch_all(&f.pool)
    .await
    .unwrap()
    .into_iter()
    .collect::<std::collections::BTreeSet<_>>();
    let mut starts = BTreeMap::<String, u64>::new();
    let (mut messages, mut failures, mut cancelled, mut answers) =
        (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    for row in &view.effects {
        assert_eq!(row["status"], "settled", "undrained effect: {row}");
        let effect: FlowEffect030 = serde_json::from_value(row["effect"].clone()).unwrap();
        let delivery = match &effect.kind {
            FlowEffectKind030::Start {
                work,
                step: Some(step),
                message_json,
                ..
            } => {
                if !admitted.contains(&effect.id) {
                    continue;
                }
                *starts.entry(step.join("/")).or_default() += 1;
                Some((activation(view, &work.activation_id), message_json.clone()))
            }
            FlowEffectKind030::Steer {
                delivery_activation_id,
                message_json,
                ..
            } => {
                // Only consumption counts. A superseded offer is delivered by
                // its eventual Start or another accepted steer.
                let receipt: String = sqlx::query_scalar("SELECT settlement_json FROM engine_flow030_outbox WHERE system_id=? AND invocation_id=? AND effect_id=?")
                    .bind(&f.identity.system_start_id).bind(&f.identity.flow_invocation_id).bind(&effect.id).fetch_one(&f.pool).await.unwrap();
                let receipt: Value = serde_json::from_str(&receipt).unwrap();
                match receipt["kind"].as_str().unwrap() {
                    "nativeSteerConsumed030" => Some((
                        activation(view, delivery_activation_id),
                        Some(message_json.clone()),
                    )),
                    "nativeSteerSuperseded030" => None,
                    kind => panic!("Unprojectable steer settlement: {kind}"),
                }
            }
            FlowEffectKind030::Failure {
                activation_id,
                step: Some(step),
                error,
                ..
            } => {
                let mut value = json!({"step":step.join("/"),"code":error.code});
                item(activation(view, activation_id), &mut value);
                failures.push(value);
                None
            }
            FlowEffectKind030::StopWork { work, .. } => {
                let a = activation(view, &work.activation_id);
                // StopWork belongs to a group decision in these run scenarios.
                // Timeouts are failure controls, not group cancellations.
                let timeout: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM engine_flow030_clock_controls WHERE system_id=? AND invocation_id=? AND activation_id=?)")
                    .bind(&f.identity.system_start_id).bind(&f.identity.flow_invocation_id).bind(&a.id).fetch_one(&f.pool).await.unwrap();
                if a.start_effect_id
                    .as_ref()
                    .is_some_and(|id| admitted.contains(id))
                    && !timeout
                {
                    let mut value = json!({"step":a.step.as_ref().unwrap().join("/")});
                    item(a, &mut value);
                    cancelled.push(value);
                }
                None
            }
            _ => None,
        };
        if let Some((a, message)) = delivery {
            let message: Value = serde_json::from_str(message.as_deref().unwrap_or("{}")).unwrap();
            let mut value = json!({"to":a.step.as_ref().unwrap().join("/"),"prompt":message.get("prompt").cloned().unwrap_or(Value::Null)});
            item(a, &mut value);
            if let Some(raw) = &a.item_json {
                value["element"] = serde_json::from_str(raw).unwrap();
            }
            if let Some(resources) = message.get("resources").and_then(Value::as_object) {
                value["resources"] = Value::Object(
                    resources
                        .iter()
                        .map(|(name, source)| {
                            (name.clone(), source.get("value").unwrap_or(source).clone())
                        })
                        .collect(),
                );
            }
            if let Some(comments) = message.get("comments") {
                value["comments"] = comments.clone();
            }
            messages.push(value);
        }
    }
    // Compose wrappers have visits but no physical Start effect. A rejected
    // maxVisits delivery does not increment this count.
    for step in &f.plan.steps {
        if step.r#type == "compose" {
            let n: u64 = view.state.visits_at(&step.address).parse().unwrap();
            if n != 0 {
                starts.insert(step.address.join("/"), n);
            }
        }
    }
    let mut groups = view
        .state
        .groups
        .iter()
        .filter(|g| {
            matches!(
                g.decision.as_deref(),
                Some("done" | "incomplete" | "reached" | "missed")
            )
        })
        .collect::<Vec<_>>();
    groups.sort_by_key(|g| {
        g.decided_ordinal
            .as_ref()
            .expect("join decision order")
            .parse::<u64>()
            .unwrap()
    });
    let joins = groups
        .into_iter()
        .map(|g| {
            let output: Value =
                serde_json::from_str(g.output_json.as_deref().expect("join output")).unwrap();
            json!({"join":g.join.join("/"),"outcome":g.decision,"branches":output["branches"]})
        })
        .collect::<Vec<_>>();
    let rows = sqlx::query("SELECT kind,work_ids_json,resolution_json FROM engine_flow030_human_requests WHERE system_id=? AND invocation_id=? ORDER BY rowid")
        .bind(&f.identity.system_start_id).bind(&f.identity.flow_invocation_id).fetch_all(&f.pool).await.unwrap();
    for row in rows {
        let resolution: Option<String> = row.get("resolution_json");
        let resolution: Value =
            serde_json::from_str(resolution.as_deref().expect("unresolved human request")).unwrap();
        if row.get::<&str, _>("kind") != "approval" && resolution["expired"] == true {
            assert_eq!(resolution["reason"], "answerTimeout");
            if row.get::<&str, _>("kind") == "question" {
                // The native question protocol represents an automatic refusal
                // as expired, without manufacturing a person's answer JSON.
                assert_eq!(resolution["answer"]["kind"], "expired");
            } else {
                assert_eq!(resolution["answer"]["decision"], "no");
            }
            let ids: Vec<String> = serde_json::from_str(row.get("work_ids_json")).unwrap();
            for id in ids {
                let a = activation(view, &id);
                let mut value = json!({"work":a.step.as_ref().unwrap().join("/"),"answer":"no"});
                item(a, &mut value);
                answers.push(value);
            }
        }
    }
    json!({"run":view.state.verdict,"starts":starts,"messages":messages,"joins":joins,"failures":failures,"cancelled":cancelled,"answers":answers})
}

fn matches(expected: &Value, actual: &Value) -> bool {
    match (expected, actual) {
        (Value::Object(a), Value::Object(b)) => a
            .iter()
            .all(|(key, v)| b.get(key).is_some_and(|w| matches(v, w))),
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(v, w)| matches(v, w))
        }
        _ => expected == actual,
    }
}
fn unordered(expected: &[Value], actual: &[Value]) -> bool {
    fn assign(
        i: usize,
        expected: &[Value],
        actual: &[Value],
        used: &mut [Option<usize>],
        seen: &mut [bool],
    ) -> bool {
        for j in 0..actual.len() {
            if !seen[j] && matches(&expected[i], &actual[j]) {
                seen[j] = true;
                if used[j].is_none_or(|k| assign(k, expected, actual, used, seen)) {
                    used[j] = Some(i);
                    return true;
                }
            }
        }
        false
    }
    if expected.len() != actual.len() {
        return false;
    }
    let mut used = vec![None; actual.len()];
    (0..expected.len()).all(|i| {
        assign(
            i,
            expected,
            actual,
            &mut used,
            &mut vec![false; actual.len()],
        )
    })
}

pub(super) fn compare(expected: &Value, actual: &Value) -> Vec<String> {
    let mut errors = Vec::new();
    for (field, value) in expected.as_object().unwrap() {
        let ok = match field.as_str() {
            "run" | "joins" | "answers" => matches(value, &actual[field]),
            "starts" => value == &actual[field],
            "failures" | "cancelled" => {
                unordered(value.as_array().unwrap(), actual[field].as_array().unwrap())
            }
            "messages" => value.as_array().unwrap().iter().all(|pattern| {
                assert!(
                    !(pattern.get("nth").is_some() && pattern.get("item").is_some()),
                    "Unspecified combined nth/item selector"
                );
                let mut candidates = actual["messages"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|v| v["to"] == pattern["to"])
                    .collect::<Vec<_>>();
                if let Some(n) = pattern.get("nth") {
                    candidates = candidates
                        .get(n.as_u64().unwrap() as usize - 1)
                        .copied()
                        .into_iter()
                        .collect();
                } else if let Some(i) = pattern.get("item") {
                    candidates.retain(|v| &v["item"] == i);
                }
                let mut payload = pattern.clone();
                payload.as_object_mut().unwrap().remove("nth");
                candidates.len() == 1 && matches(&payload, candidates[0])
            }),
            _ => panic!("Unsupported expectation field: {field}"),
        };
        if !ok {
            errors.push(format!(
                "{field}: expected {value}, observed {}",
                actual[field]
            ));
        }
    }
    errors
}

#[test]
fn comparison_covers_all_seven_fields_and_partial_patterns() {
    let actual = json!({"run":"succeeded","starts":{"work":2},"messages":[{"to":"work","prompt":"first"},{"to":"work","resources":{"x":{"nested":[1,2],"extra":true}}}],"joins":[{"join":"join","outcome":"done","branches":{"a":{"value":1},"b":{}}}],"failures":[{"step":"a","code":"FAILED"},{"step":"b","code":"FAILED"}],"cancelled":[{"step":"c","item":0}],"answers":[{"work":"d","answer":"no"}]});
    let expected = json!({"run":"succeeded","starts":{"work":2},"messages":[{"to":"work","nth":2,"resources":{"x":{"nested":[1,2]}}}],"joins":[{"join":"join","outcome":"done","branches":{"a":{"value":1}}}],"failures":[{"code":"FAILED"},{"step":"a","code":"FAILED"}],"cancelled":[{"step":"c","item":0}],"answers":[{"work":"d","answer":"no"}]});
    assert!(compare(&expected, &actual).is_empty());
    for field in [
        "run",
        "starts",
        "messages",
        "joins",
        "failures",
        "cancelled",
        "answers",
    ] {
        let mut broken = actual.clone();
        broken[field] = match field {
            "run" => json!("failed"),
            "starts" => json!({"work":2,"unexpected":1}),
            _ => json!([]),
        };
        assert!(!compare(&expected, &broken).is_empty(), "{field}");
    }
    assert!(!matches(&json!([1]), &json!([1, 2])));
    assert!(!matches(
        &serde_json::from_str::<Value>("1.0").unwrap(),
        &json!(1)
    ));
}

#[test]
fn automatic_answers_keep_timeline_order() {
    let expected =
        json!({"answers":[{"work":"first","answer":"no"},{"work":"second","answer":"no"}]});
    assert!(compare(&expected, &expected).is_empty());
    let reversed =
        json!({"answers":[{"work":"second","answer":"no"},{"work":"first","answer":"no"}]});
    assert!(!compare(&expected, &reversed).is_empty());
}
