use super::{projection::Projection, *};
fn event(raw: &Value, expected_owner: &Value, decoder: &impl JsonDecoder) -> Result<Value> {
    let envelope = parse_exact(raw, decoder)?;
    object(&envelope)?;
    keys(&envelope, &["owner", "eventId", "nowMs", "event"])?;
    let event_owner = owner(envelope.get("owner"))?;
    if !native::equal(&event_owner, expected_owner) {
        return plain("foreign or revoked owner.");
    }
    let event_id = id(envelope.get("eventId"))?;
    let now = id(envelope.get("nowMs"))?;
    monotone(&now)?;
    let b = envelope.get("event");
    object(b)?;
    let kind = b.get("kind");
    let mut body = if kind.eq_str("admit") {
        keys(
            b,
            &[
                "kind",
                "workId",
                "timeoutMs",
                "answerTimeoutMs",
                "startedAtMs",
            ],
        )?;
        o([
            ("kind", kind.clone()),
            ("workId", id(b.get("workId"))?),
            ("timeoutMs", nullable_string(b.get("timeoutMs"))?),
            (
                "answerTimeoutMs",
                nullable_string(b.get("answerTimeoutMs"))?,
            ),
        ])
    } else if kind.eq_str("retire") {
        keys(b, &["kind", "workId"])?;
        o([("kind", kind.clone()), ("workId", id(b.get("workId"))?)])
    } else if kind.eq_str("open") {
        keys(
            b,
            &["kind", "requestId", "requestKind", "reviewer", "workIds"],
        )?;
        let request_kind = coerced_string(b.get("requestKind"))?;
        let allowed_kind = ["ask", "plan", "question"]
            .iter()
            .any(|v| request_kind.eq_str(v));
        let reviewer = if allowed_kind {
            coerced_string(b.get("reviewer"))?
        } else {
            Text::default()
        };
        if !["ask", "plan", "question"]
            .iter()
            .any(|v| request_kind.eq_str(v))
            || !["person", "model"].iter().any(|v| reviewer.eq_str(v))
        {
            return plain("invalid request type.");
        }
        o([
            ("kind", kind.clone()),
            ("requestId", id(b.get("requestId"))?),
            ("requestKind", b.get("requestKind").clone()),
            ("reviewer", b.get("reviewer").clone()),
            ("workIds", ids(b.get("workIds"))?),
        ])
    } else if kind.eq_str("associate") {
        keys(b, &["kind", "requestId", "workIds"])?;
        o([
            ("kind", kind.clone()),
            ("requestId", id(b.get("requestId"))?),
            ("workIds", ids(b.get("workIds"))?),
        ])
    } else if kind.eq_str("answer") {
        keys(b, &["kind", "requestId", "nativeReceiptId", "answer"])?;
        let raw = b.get("answer");
        let answer = if matches!(raw, Value::Null) {
            Value::Null
        } else {
            object(raw)?;
            keys(raw, &["decision", "comment"])?;
            if !(raw.get("decision").eq_str("yes") || raw.get("decision").eq_str("no"))
                || raw.has("comment") && raw.get("comment").text().is_none()
            {
                return plain("invalid answer projection.");
            }
            let mut answer = o([("decision", raw.get("decision").clone())]);
            if raw.has("comment") {
                answer.set("comment", raw.get("comment").clone());
            }
            answer
        };
        o([
            ("kind", kind.clone()),
            ("requestId", id(b.get("requestId"))?),
            ("nativeReceiptId", id(b.get("nativeReceiptId"))?),
            ("answer", answer),
        ])
    } else if kind.eq_str("approval") {
        keys(
            b,
            &[
                "kind",
                "requestId",
                "workId",
                "choices",
                "timeoutMs",
                "startedAtMs",
            ],
        )?;
        let choices = ids(b.get("choices"))?;
        let values = choices.array().unwrap();
        if values.is_empty()
            || values
                .iter()
                .enumerate()
                .any(|(i, v)| contains(&values[..i], v))
        {
            return plain("invalid approval choices.");
        }
        let timeout = nullable_string(b.get("timeoutMs"))?;
        if !matches!(timeout, Value::Null) {
            integer_string(&timeout, true)?;
        }
        o([
            ("kind", kind.clone()),
            ("requestId", id(b.get("requestId"))?),
            ("workId", id(b.get("workId"))?),
            ("choices", choices),
            ("timeoutMs", timeout),
        ])
    } else if kind.eq_str("approvalAnswer") {
        keys(
            b,
            &["kind", "requestId", "nativeReceiptId", "choice", "comment"],
        )?;
        if b.get("comment").text().is_none() {
            return plain("invalid approval comment.");
        }
        o([
            ("kind", kind.clone()),
            ("requestId", id(b.get("requestId"))?),
            ("nativeReceiptId", id(b.get("nativeReceiptId"))?),
            ("choice", id(b.get("choice"))?),
            ("comment", b.get("comment").clone()),
        ])
    } else if kind.eq_str("tick") {
        keys(b, &["kind"])?;
        o([("kind", kind.clone())])
    } else if kind.eq_str("ack") {
        keys(b, &["kind", "requestId"])?;
        o([
            ("kind", kind.clone()),
            ("requestId", id(b.get("requestId"))?),
        ])
    } else {
        return plain("unknown clock event.");
    };
    if (kind.eq_str("admit") || kind.eq_str("approval")) && b.has("startedAtMs") {
        body.set("startedAtMs", id(b.get("startedAtMs"))?);
    }
    Ok(o([
        ("owner", event_owner),
        ("eventId", event_id),
        ("nowMs", now),
        ("event", body),
    ]))
}
struct Replay {
    projection: Projection,
    operations: Vec<(String, String)>,
    latest: String,
}
impl Replay {
    fn apply(&mut self, input: &Value) -> Result<String> {
        let event = input.get("event");
        let kind = event.get("kind");
        let key_field = if kind.eq_str("admit") || kind.eq_str("retire") {
            Some("workId")
        } else if kind.eq_str("open") || kind.eq_str("approval") {
            Some("requestId")
        } else if kind.eq_str("answer") || kind.eq_str("approvalAnswer") {
            Some("nativeReceiptId")
        } else {
            None
        };
        let key = key_field.map(|field| a([kind.clone(), event.get(field).clone()]).stringify());
        let signature = o([
            ("nowMs", input.get("nowMs").clone()),
            ("event", event.clone()),
        ])
        .stringify();
        if let Some((_, previous)) = key
            .as_ref()
            .and_then(|k| self.operations.iter().find(|(old, _)| old == k))
        {
            if *previous != signature {
                return plain("operation identity has conflicting content.");
            }
            return Ok(self.latest.clone());
        }
        let receipt = self.projection.dispatch(input)?.stringify();
        if let Some(key) = key {
            self.operations.push((key, signature));
        }
        self.latest = receipt.clone();
        Ok(receipt)
    }
}
/// Mirrors the direct TS export. Native fields are validated in source order.
pub(crate) fn evaluate_host(
    context: &Value,
    event_id: &Value,
    revision: &Value,
    state: &Value,
    raw_event: &Value,
    options: &Value,
    decoder: &impl JsonDecoder,
) -> Result<Value> {
    let owner = owner(context)?;
    id(event_id)?;
    let revision_text = coerced_string(revision)?.utf8().unwrap_or_default();
    let Some(revision) = BigInteger::from_canonical_unsigned(&revision_text) else {
        return plain("invalid journal revision.");
    };
    object(options)?;
    keys(options, &["maxSliceMs"])?;
    let slice = options.get("maxSliceMs");
    if !safe_integer(slice) || timer(None, &BigInteger::zero(), slice).is_err() {
        return plain("invalid timer slice.");
    }
    let current = if state.eq_str("") {
        o([
            ("format", s("macro-agsdl-human-clock-journal/1")),
            ("owner", owner.clone()),
            ("options", o([("maxSliceMs", slice.clone())])),
            ("entries", a([])),
        ])
    } else {
        parse_exact(state, decoder)?
    };
    object(&current)?;
    keys(&current, &["format", "owner", "options", "entries"])?;
    object(current.get("options"))?;
    keys(current.get("options"), &["maxSliceMs"])?;
    // Short-circuiting matters: a wrong format precedes owner validation.
    if !current
        .get("format")
        .eq_str("macro-agsdl-human-clock-journal/1")
        || !native::equal(&super::owner(current.get("owner"))?, &owner)
        || !strict_equal(current.get("options").get("maxSliceMs"), slice)
        || current.get("entries").array().is_none()
        || revision != BigInteger::from_usize(current.get("entries").array().unwrap().len())
    {
        return plain("journal capture or native revision differs.");
    }
    let mut replay = Replay {
        projection: Projection::new(slice.clone()),
        operations: vec![],
        latest: String::new(),
    };
    let mut entries = vec![];
    let mut seen: Vec<(Text, Value)> = vec![];
    for entry in current.get("entries").array().unwrap() {
        object(entry)?;
        keys(entry, &["eventJson", "receiptJson"])?;
        if entry.get("eventJson").text().is_none() || entry.get("receiptJson").text().is_none() {
            return plain("invalid journal entry.");
        }
        let input = event(entry.get("eventJson"), &owner, decoder)?;
        if find(&seen, input.get("eventId")).is_some() {
            return plain("repeated stored event.");
        }
        let actual = replay.apply(&input)?;
        if !entry.get("receiptJson").eq_str(&actual) {
            return plain("journal receipt cannot be reproduced.");
        }
        let captured = o([
            ("eventJson", entry.get("eventJson").clone()),
            ("receiptJson", entry.get("receiptJson").clone()),
        ]);
        put(&mut seen, input.get("eventId"), captured.clone());
        entries.push(captured);
    }
    let input = event(raw_event, &owner, decoder)?;
    if !strict_equal(input.get("eventId"), event_id) {
        return plain("event identity differs from native job.");
    }
    if let Some(i) = find(&seen, event_id) {
        if !strict_equal(seen[i].1.get("eventJson"), raw_event) {
            return plain("event identity has conflicting content.");
        }
        return Ok(o([
            ("stateJson", state.clone()),
            ("receiptJson", seen[i].1.get("receiptJson").clone()),
        ]));
    }
    let receipt = replay.apply(&input)?;
    entries.push(o([
        ("eventJson", raw_event.clone()),
        ("receiptJson", s(receipt.clone())),
    ]));
    let next = o([
        ("format", s("macro-agsdl-human-clock-journal/1")),
        ("owner", owner),
        ("options", o([("maxSliceMs", slice.clone())])),
        ("entries", a(entries)),
    ]);
    Ok(o([
        ("stateJson", s(next.stringify())),
        ("receiptJson", s(receipt)),
    ]))
}
