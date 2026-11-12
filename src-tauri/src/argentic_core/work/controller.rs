use super::*;
use crate::argentic_core::{contract, exact::BigInteger, integers, native::a};
use std::collections::HashMap;
struct Entry {
    signature: String,
    receipt: Value,
}
/// In-process controller only. Receipts do not authorize or execute effects.
pub(crate) struct Controller {
    owner: Value,
    contract: Value,
    options: Value,
    state: &'static str,
    plan_lock: &'static str,
    submission_corrections: BigInteger,
    check_failures: BigInteger,
    revision: BigInteger,
    visible: Vec<Vec<Text>>,
    accepted: Value,
    pending_check: Value,
    pending_plan: Value,
    stop_code: Value,
    terminal: Value,
    entries: Vec<Entry>,
    events: HashMap<Text, usize>,
    operations: HashMap<Text, usize>,
}
fn decision(kind: &str) -> Value {
    o([("kind", s(kind))])
}
fn waiting(target: &str) -> Value {
    o([("kind", s("waiting")), ("for", s(target))])
}
fn stopping(code: &Value) -> Value {
    o([("kind", s("stopping")), ("code", code.clone())])
}
fn event_key(event: &Value) -> Result<Option<Text>> {
    for (kind, field, prefix) in [
        ("visibleText", "messageId", "message:"),
        ("submit", "callId", "submit:"),
        ("turnEnded", "turnId", "turn:"),
        ("planPresented", "planId", "plan:"),
        ("planResolved", "planId", "planDecision:"),
        ("checkEnded", "checkId", "check:"),
    ] {
        if event.get("kind").eq_str(kind) {
            identity(event.get(field))?;
            let mut key = Text::from(prefix);
            key.push(text(event.get(field))?);
            return Ok(Some(key));
        }
    }
    Ok(None)
}
pub(crate) fn assemble_visible_text(messages: &[Vec<Text>]) -> Text {
    let mut out = Text::default();
    let mut any = false;
    for parts in messages {
        let mut message = Text::default();
        for part in parts {
            message.push(part);
        }
        if !message.units().is_empty() {
            if any {
                out.push(&Text::from("\n"));
            }
            out.push(&message);
            any = true;
        }
    }
    out
}
impl Controller {
    pub(crate) fn new(owner: &Value, input_contract: &Value, options: &Value) -> Result<Self> {
        if let Some(fields) = owner.object() {
            for (_, v) in fields {
                identity(v)?;
            }
        }
        let captured = contract::copy(input_contract)?;
        integer_string(options.get("checkTimeoutMs"), true)?;
        let bound = options.get("maxCheckOutputBytes");
        let negative = matches!(bound,Value::Number(native::Number::Finite(raw)) if raw.starts_with('-') && raw != "-0");
        if !safe_integer(bound) || negative {
            return correlation("", "Invalid check output bound.");
        }
        if input_contract.get("planFirst").eq_str("ask")
            && !is_true(options.get("enforcedPlanLock"))
        {
            return Err(native::Error::new(
                "HARNESS_REFUSED",
                "/planFirst",
                "planFirst=ask requires an enforced native lock.",
            )
            .into());
        }
        Ok(Self {
            owner: owner.clone(),
            contract: captured,
            options: options.clone(),
            state: "working",
            plan_lock: if matches!(input_contract.get("planFirst"), Value::Null) {
                "unlocked"
            } else {
                "awaitingPlan"
            },
            submission_corrections: BigInteger::zero(),
            check_failures: BigInteger::zero(),
            revision: BigInteger::zero(),
            visible: vec![],
            accepted: Value::Null,
            pending_check: Value::Null,
            pending_plan: Value::Null,
            stop_code: Value::Null,
            terminal: Value::Null,
            entries: vec![],
            events: HashMap::new(),
            operations: HashMap::new(),
        })
    }
    pub(crate) fn snapshot(&self) -> Value {
        o([
            ("state", s(self.state)),
            (
                "submissionCorrections",
                s(self.submission_corrections.to_js_string()),
            ),
            ("checkFailures", s(self.check_failures.to_js_string())),
            ("planLock", s(self.plan_lock)),
            ("accepted", self.accepted.clone()),
        ])
    }
    pub(crate) fn allows_effect(&self, effect: &str) -> bool {
        self.state == "working" && (self.plan_lock == "unlocked" || effect == "read")
    }
    pub(crate) fn dispatch(&mut self, input: &Value) -> Result<Value> {
        access(input, "input.eventId")?;
        identity(input.get("eventId"))?;
        access(input.get("owner"), "input.owner[key]")?;
        if self.owner.object().is_some_and(|a| {
            a.iter()
                .any(|(k, v)| !same(v, input.get("owner").get_text(k)))
        }) {
            return correlation("", "Foreign or revoked work owner.");
        }
        let event = input.get("event").clone();
        access(&event, "event.kind")?;
        let key = event_key(&event)?;
        let signature = event.stringify();
        let id = text(input.get("eventId"))?.clone();
        let prior = self
            .events
            .get(&id)
            .copied()
            .or_else(|| key.as_ref().and_then(|k| self.operations.get(k).copied()));
        if prior.is_some_and(|p| self.entries[p].signature != signature) {
            return correlation(
                "",
                "Event or provider operation identity has conflicting bytes.",
            );
        }
        if !matches!(self.stop_code, Value::Null)
            && !event.get("kind").eq_str("physicalEnded")
            && !event.get("kind").eq_str("stop")
        {
            if let Some(p) = prior {
                if !self.entries[p]
                    .receipt
                    .get("decision")
                    .get("kind")
                    .eq_str("stopping")
                {
                    let next = self.receipt(stopping(&self.stop_code));
                    self.entries[p].receipt = next;
                }
                self.events.insert(id, p);
                return Ok(self.entries[p].receipt.clone());
            }
            let receipt = self.receipt(stopping(&self.stop_code));
            self.remember(id, key, signature, &receipt);
            return Ok(receipt);
        }
        if let Some(p) = prior {
            self.events.insert(id, p);
            return Ok(self.entries[p].receipt.clone());
        }
        let result = self.apply(&event)?;
        let receipt = self.receipt(result);
        self.remember(id, key, signature, &receipt);
        Ok(receipt)
    }
    fn remember(&mut self, id: Text, key: Option<Text>, signature: String, receipt: &Value) {
        let i = self.entries.len();
        self.entries.push(Entry {
            signature,
            receipt: receipt.clone(),
        });
        self.events.insert(id, i);
        if let Some(k) = key {
            self.operations.insert(k, i);
        }
    }
    fn receipt(&mut self, decision: Value) -> Value {
        let revision = counter_next(&mut self.revision);
        let mut id = native_string(self.owner.get("activationId"));
        id.push(&Text::from(format!(":{revision}")));
        o([
            ("receiptId", s(id)),
            ("owner", self.owner.clone()),
            ("revision", s(revision)),
            ("decision", decision),
        ])
    }
    fn stop(&mut self, code: Value) -> Value {
        self.state = "stopping";
        self.stop_code = code;
        stopping(&self.stop_code)
    }
    fn correction(&mut self, diagnostics: Value) -> Result<Value> {
        if integers::compare_integers030(
            &self.submission_corrections.to_js_string(),
            text(self.contract.get("maxCorrections"))?
                .utf8()
                .as_deref()
                .unwrap(),
        )? != std::cmp::Ordering::Less
        {
            return Ok(self.stop(s("OUTPUT_INVALID")));
        }
        counter_next(&mut self.submission_corrections);
        Ok(o([
            ("kind", s("correction")),
            ("category", s("submission")),
            ("diagnostics", diagnostics),
        ]))
    }
    fn accept(&mut self, candidate: &Value) -> Value {
        self.accepted = o([
            ("text", s(assemble_visible_text(&self.visible))),
            ("resultsJson", candidate.get("resultsJson").clone()),
            ("choice", candidate.get("choice").clone()),
            ("instructions", candidate.get("instructions").clone()),
        ]);
        self.state = "accepted";
        o([("kind", s("accepted")), ("output", self.accepted.clone())])
    }
    fn apply(&mut self, event: &Value) -> Result<Value> {
        if !matches!(self.terminal, Value::Null) {
            return Ok(self.terminal.clone());
        }
        let kind = event.get("kind");
        if kind.eq_str("stop") {
            return Ok(if matches!(self.stop_code, Value::Null) {
                self.stop(event.get("reason").clone())
            } else {
                stopping(&self.stop_code)
            });
        }
        if kind.eq_str("physicalEnded") {
            if !event.get("providerEnded").truthy() || !event.get("effectsEnded").truthy() {
                return Ok(waiting("physicalEnd"));
            }
            if !matches!(self.stop_code, Value::Null) {
                self.terminal = o([
                    ("kind", s("finished")),
                    (
                        "outcome",
                        s(if self.stop_code.eq_str("JOIN_CANCELLED") {
                            "cancelled"
                        } else {
                            "failure"
                        }),
                    ),
                    ("code", self.stop_code.clone()),
                ]);
            } else if !matches!(self.accepted, Value::Null) && self.state == "accepted" {
                self.terminal = o([
                    ("kind", s("finished")),
                    ("outcome", s("success")),
                    ("output", self.accepted.clone()),
                ]);
            } else {
                return Ok(waiting(if matches!(self.pending_check, Value::Null) {
                    "physicalEnd"
                } else {
                    "check"
                }));
            }
            self.state = "finished";
            return Ok(self.terminal.clone());
        }
        if kind.eq_str("visibleText") {
            let Some(parts) = event
                .get("textParts")
                .array()
                .filter(|a| a.iter().all(|v| v.text().is_some()))
            else {
                return correlation("", "Visible text must contain attributed string parts.");
            };
            self.visible
                .push(parts.iter().map(|v| v.text().unwrap().clone()).collect());
            if !matches!(self.accepted, Value::Null) {
                self.accepted
                    .set("text", s(assemble_visible_text(&self.visible)));
            }
            return Ok(waiting(if matches!(self.pending_check, Value::Null) {
                "physicalEnd"
            } else {
                "check"
            }));
        }
        if self.state == "uncertain" {
            return Ok(o([
                ("kind", s("uncertain")),
                ("checkId", self.pending_check.get("checkId").clone()),
            ]));
        }
        if kind.eq_str("checkEnded") {
            if self.state != "checking"
                || !same(self.pending_check.get("checkId"), event.get("checkId"))
            {
                return correlation("", "No matching active check reservation.");
            }
            if event.get("physicalState").eq_str("uncertain") {
                self.state = "uncertain";
                return Ok(o([
                    ("kind", s("uncertain")),
                    ("checkId", event.get("checkId").clone()),
                ]));
            }
            if !matches!(event.get("exitCode"), Value::Null) && !safe_integer(event.get("exitCode"))
            {
                return correlation("", "Invalid check exit status.");
            }
            let candidate = self.pending_check.get("candidate").clone();
            self.pending_check = Value::Null;
            let zero = matches!(event.get("exitCode"),Value::Number(native::Number::Finite(raw)) if raw=="0" || raw=="-0");
            if zero {
                return Ok(self.accept(&candidate));
            }
            self.state = "working";
            if integers::compare_integers030(
                &self.check_failures.to_js_string(),
                text(self.contract.get("completionCheck").get("maxFailures"))?
                    .utf8()
                    .as_deref()
                    .unwrap(),
            )? != std::cmp::Ordering::Less
            {
                return Ok(self.stop(s("CHECK_FAILED")));
            }
            counter_next(&mut self.check_failures);
            let bound = if let Value::Number(native::Number::Finite(raw)) =
                self.options.get("maxCheckOutputBytes")
            {
                integers::bounded_integer030(
                    raw.trim_start_matches('-'),
                    &BigInteger::from_canonical_unsigned("9007199254740991").unwrap(),
                )?
                .to_usize()
                .unwrap() as u64
            } else {
                unreachable!()
            };
            let (stdout, stderr, truncated) =
                bounded_output(event.get("stdout"), event.get("stderr"), bound)?;
            return Ok(o([
                ("kind", s("correction")),
                ("category", s("check")),
                ("exitCode", event.get("exitCode").clone()),
                ("stdout", s(stdout)),
                ("stderr", s(stderr)),
                (
                    "truncated",
                    Value::Bool(is_true(event.get("truncated")) || truncated),
                ),
            ]));
        }
        if self.state == "checking" {
            if kind.eq_str("submit") {
                let validation = validate_submission(&self.contract, event.get("argumentsJson"))?;
                if validation.get("kind").eq_str("invalid") {
                    return self.correction(validation.get("diagnostics").clone());
                }
                return Ok(o([
                    ("kind", s("submissionNotAdmitted")),
                    ("reason", s("CHECK_IN_PROGRESS")),
                    ("checkId", self.pending_check.get("checkId").clone()),
                ]));
            }
            return Ok(waiting("check"));
        }
        if self.state == "accepted" {
            return Ok(waiting("physicalEnd"));
        }
        if kind.eq_str("planPresented") {
            if trimmed(event.get("text"), "event.text.trim", false)? {
                return correlation("/plan", "A presented plan must contain text.");
            }
            if self.plan_lock == "awaitingApproval" {
                return correlation("/plan", "A plan already awaits a decision.");
            }
            if !self.contract.get("planFirst").eq_str("ask") || self.plan_lock == "unlocked" {
                self.plan_lock = "unlocked";
                return Ok(o([
                    ("kind", s("planAccepted")),
                    ("planId", event.get("planId").clone()),
                ]));
            }
            self.pending_plan = event.get("planId").clone();
            self.plan_lock = "awaitingApproval";
            return Ok(o([
                ("kind", s("planWaiting")),
                ("planId", event.get("planId").clone()),
                ("text", event.get("text").clone()),
            ]));
        }
        if kind.eq_str("planResolved") {
            if self.plan_lock != "awaitingApproval"
                || !same(&self.pending_plan, event.get("planId"))
            {
                return correlation("/plan", "No matching plan awaits approval.");
            }
            self.pending_plan = Value::Null;
            if event.get("decision").eq_str("accept") {
                self.plan_lock = "unlocked";
                return Ok(o([
                    ("kind", s("planAccepted")),
                    ("planId", event.get("planId").clone()),
                ]));
            }
            if event.get("comment").is_nullish()
                || trimmed(event.get("comment"), "event.comment?.trim", true)?
            {
                return Ok(self.stop(s("PLAN_REJECTED")));
            }
            self.plan_lock = "awaitingPlan";
            return Ok(o([
                ("kind", s("planRevision")),
                ("planId", event.get("planId").clone()),
                ("comment", event.get("comment").clone()),
            ]));
        }
        if self.plan_lock != "unlocked" {
            return Ok(decision("planRequired"));
        }
        if kind.eq_str("turnEnded") {
            if requires_submission(&self.contract)? {
                return self.correction(a([diagnostic(
                    "",
                    "SUBMISSION_REQUIRED",
                    "Submit the required result before completing this work.",
                )]));
            }
            return Ok(self.accept(&o([
                ("resultsJson", s("{}")),
                ("choice", Value::Null),
                ("instructions", Value::Null),
            ])));
        }
        let validation = validate_submission(&self.contract, event.get("argumentsJson"))?;
        if validation.get("kind").eq_str("invalid") {
            return self.correction(validation.get("diagnostics").clone());
        }
        let candidate = validation.get("candidate");
        if !candidate.get("checkRequired").truthy() {
            return Ok(self.accept(candidate));
        }
        if self.plan_lock != "unlocked" {
            return Ok(decision("planRequired"));
        }
        let mut id = native_string(self.owner.get("activationId"));
        id.push(&Text::from(format!(
            ":check:{}",
            self.revision.add(&BigInteger::from_usize(1)).to_js_string()
        )));
        self.pending_check = o([
            ("checkId", s(id)),
            ("owner", self.owner.clone()),
            ("candidate", candidate.clone()),
            (
                "command",
                self.contract.get("completionCheck").get("command").clone(),
            ),
            ("timeoutMs", self.options.get("checkTimeoutMs").clone()),
            (
                "maxOutputBytes",
                self.options.get("maxCheckOutputBytes").clone(),
            ),
        ]);
        self.state = "checking";
        Ok(o([
            ("kind", s("checkRequested")),
            ("check", self.pending_check.clone()),
        ]))
    }
}
fn bounded_output(stdout: &Value, stderr: &Value, limit: u64) -> Result<(Text, Text, bool)> {
    fn byte_len(text: &Text) -> u64 {
        char::decode_utf16(text.units().iter().copied())
            .map(|c| c.unwrap_or(char::REPLACEMENT_CHARACTER).len_utf8() as u64)
            .sum()
    }
    fn take(source: &Value, remaining: &mut u64, truncated: &mut bool) -> Result<Text> {
        access(source, "source")?;
        let mut out = Text::default();
        if let Some(source) = source.text() {
            let units = source.units();
            let mut i = 0;
            while i < units.len() {
                let u = units[i];
                let pair = (0xd800..=0xdbff).contains(&u)
                    && units
                        .get(i + 1)
                        .is_some_and(|u| (0xdc00..=0xdfff).contains(u));
                let bytes = if pair {
                    4
                } else if u < 0x80 {
                    1
                } else if u < 0x800 {
                    2
                } else {
                    3
                };
                if bytes > *remaining {
                    *truncated = true;
                    break;
                }
                *remaining -= bytes;
                let end = i + if pair { 2 } else { 1 };
                out.push(&Text::from_units(units[i..end].to_vec()));
                i = end;
            }
        } else if let Some(parts) = source.array() {
            // A malformed native event can contain an array. JS still iterates
            // it, encodes each element and then joins the retained elements.
            for part in parts {
                let encoded = if matches!(part, Value::Undefined) {
                    Text::default()
                } else {
                    native_string(part)
                };
                let bytes = byte_len(&encoded);
                if bytes > *remaining {
                    *truncated = true;
                    break;
                }
                *remaining -= bytes;
                if !part.is_nullish() {
                    out.push(&native_string(part));
                }
            }
        } else {
            return exception(
                "TypeError",
                match source {
                    Value::Number(_) => "number is not iterable",
                    Value::Bool(true) => "true is not iterable",
                    Value::Bool(false) => "false is not iterable",
                    _ => "{} is not iterable",
                },
            );
        }
        Ok(out)
    }
    let mut remaining = limit;
    let mut truncated = false;
    let stdout = take(stdout, &mut remaining, &mut truncated)?;
    let stderr = take(stderr, &mut remaining, &mut truncated)?;
    Ok((stdout, stderr, truncated))
}
