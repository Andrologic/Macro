use super::*;
struct Approval {
    work: Value,
    opened: Value,
    timeout: Option<String>,
    choices: Value,
    resolution: Option<Value>,
    ack: bool,
}
pub(super) struct Projection {
    registry: HumanWaitRegistry,
    clocks: Vec<(Text, SharedClock)>,
    retired: Vec<(Text, Value)>,
    requests: Vec<(Text, Value)>,
    answers: Vec<(Text, Value)>,
    signatures: Vec<(Text, String)>,
    accepted: Vec<Value>,
    approvals: Vec<(Text, Approval)>,
    last: Option<BigInteger>,
    slice: Value,
}
impl Projection {
    pub(super) fn new(slice: Value) -> Self {
        Self {
            registry: Default::default(),
            clocks: vec![],
            retired: vec![],
            requests: vec![],
            answers: vec![],
            signatures: vec![],
            accepted: vec![],
            approvals: vec![],
            last: None,
            slice,
        }
    }
    pub(super) fn dispatch(&mut self, input: &Value) -> Result<Value> {
        let now_raw = input.get("nowMs");
        let now = monotone(now_raw)?;
        let event = input.get("event");
        let kind = event.get("kind");
        if self.last.as_ref().is_some_and(|last| now < *last) {
            return plain("approval clock moved backwards.");
        }
        self.last = Some(now.clone());
        self.expire_approvals(now_raw)?;
        self.registry.tick(now_raw)?;
        if kind.eq_str("admit") {
            let started = if event.has("startedAtMs") {
                event.get("startedAtMs")
            } else {
                now_raw
            };
            if monotone(started)? > now {
                return plain("handoff time exceeds admission.");
            }
            let clock = Rc::new(RefCell::new(WorkClock::new(
                event.get("timeoutMs"),
                started,
            )?));
            self.registry.register_work(
                event.get("workId"),
                clock.clone(),
                event.get("answerTimeoutMs"),
            )?;
            put(&mut self.clocks, event.get("workId"), clock);
        } else if kind.eq_str("retire") {
            let snapshot = self
                .registry
                .unregister_work(event.get("workId"), now_raw)?;
            put(&mut self.retired, event.get("workId"), snapshot);
            if let Some(i) = find(&self.clocks, event.get("workId")) {
                self.clocks.remove(i);
            }
        } else if kind.eq_str("open") {
            if find(&self.approvals, event.get("requestId")).is_some() {
                return plain("request identity already belongs to an approval.");
            }
            self.registry.open(&o([
                ("requestId", event.get("requestId").clone()),
                ("kind", event.get("requestKind").clone()),
                ("reviewer", event.get("reviewer").clone()),
                ("workIds", event.get("workIds").clone()),
                ("openedAtMs", now_raw.clone()),
            ]))?;
            put(
                &mut self.requests,
                event.get("requestId"),
                event.get("requestKind").clone(),
            );
        } else if kind.eq_str("associate") {
            self.registry.set_request_works(
                event.get("requestId"),
                event.get("workIds"),
                now_raw,
            )?;
        } else if kind.eq_str("answer") {
            let Some(i) = find(&self.requests, event.get("requestId")) else {
                return plain("unknown request.");
            };
            let question = self.requests[i].1.eq_str("question");
            if question != matches!(event.get("answer"), Value::Null) {
                return plain("answer projection does not match request kind.");
            }
            let signature = o([
                ("requestId", event.get("requestId").clone()),
                ("answer", event.get("answer").clone()),
            ])
            .stringify();
            let native_id = event.get("nativeReceiptId");
            if let Some(i) = find(&self.signatures, native_id) {
                if self.signatures[i].1 != signature {
                    return plain("conflicting native answer receipt.");
                }
            } else {
                let already = !matches!(
                    self.registry
                        .request(event.get("requestId"))?
                        .get("resolution"),
                    Value::Null
                );
                let marker = o([("decision", s("yes"))]);
                let resolution = self.registry.resolve(
                    event.get("requestId"),
                    if question {
                        &marker
                    } else {
                        event.get("answer")
                    },
                    now_raw,
                )?;
                let accepted = !already
                    && !resolution.get("expired").truthy()
                    && !contains(&self.accepted, event.get("requestId"));
                if accepted {
                    self.accepted.push(event.get("requestId").clone());
                }
                put(&mut self.signatures, native_id, signature);
                put(
                    &mut self.answers,
                    native_id,
                    o([
                        ("requestId", event.get("requestId").clone()),
                        ("nativeReceiptId", native_id.clone()),
                        ("accepted", Value::Bool(accepted)),
                    ]),
                );
            }
        } else if kind.eq_str("approval") {
            let id = event.get("requestId");
            if find(&self.approvals, id).is_some() || find(&self.requests, id).is_some() {
                return plain("duplicate approval.");
            }
            let started = if event.has("startedAtMs") {
                event.get("startedAtMs")
            } else {
                now_raw
            };
            if monotone(started)? > now {
                return plain("handoff time exceeds admission.");
            }
            // Validation checked the limit, but the request snapshot retains its authored text.
            let timeout = event.get("timeoutMs").text().map(|t| t.utf8().unwrap());
            put(
                &mut self.approvals,
                id,
                Approval {
                    work: event.get("workId").clone(),
                    opened: started.clone(),
                    timeout,
                    choices: event.get("choices").clone(),
                    resolution: None,
                    ack: false,
                },
            );
            self.expire_approvals(now_raw)?;
        } else if kind.eq_str("approvalAnswer") {
            let id = event.get("requestId");
            let Some(i) = find(&self.approvals, id) else {
                return plain("unknown approval or choice.");
            };
            if !contains(
                self.approvals[i].1.choices.array().unwrap(),
                event.get("choice"),
            ) {
                return plain("unknown approval or choice.");
            }
            let signature = event.stringify();
            let native_id = event.get("nativeReceiptId");
            if let Some(i) = find(&self.signatures, native_id) {
                if self.signatures[i].1 != signature {
                    return plain("conflicting native answer receipt.");
                }
            } else {
                let accepted = self.approvals[i].1.resolution.is_none();
                if accepted {
                    self.approvals[i].1.resolution = Some(resolution(
                        id,
                        false,
                        now_raw.clone(),
                        a([]),
                        o([
                            ("kind", s("approval")),
                            ("choice", event.get("choice").clone()),
                            ("comment", event.get("comment").clone()),
                        ]),
                    ));
                }
                put(&mut self.signatures, native_id, signature);
                put(
                    &mut self.answers,
                    native_id,
                    o([
                        ("requestId", id.clone()),
                        ("nativeReceiptId", native_id.clone()),
                        ("accepted", Value::Bool(accepted)),
                    ]),
                );
            }
        } else if kind.eq_str("ack") {
            if let Some(i) = find(&self.approvals, event.get("requestId")) {
                if self.approvals[i].1.resolution.is_none() {
                    return plain("unresolved approval.");
                }
                self.approvals[i].1.ack = true;
            } else {
                self.registry
                    .acknowledge_resolution(event.get("requestId"))?;
            }
        }
        let mut next = self.registry.next_wake(now_raw, &self.slice)?;
        for (_, approval) in &self.approvals {
            if approval.resolution.is_some() {
                continue;
            }
            if let Some(wake) = timer(
                approval.timeout.as_deref(),
                &now.sub(&monotone(&approval.opened)?),
                &self.slice,
            )? {
                next = Some(next.map_or(wake, |n| n.min(wake)));
            }
        }
        let clocks: Vec<_> = self
            .clocks
            .iter()
            .map(|(id, clock)| {
                o([
                    ("workId", s(id.clone())),
                    ("snapshot", clock.borrow().snapshot()),
                ])
            })
            .collect();
        let mut requests = self
            .requests
            .iter()
            .map(|(id, _)| self.registry.request(&s(id.clone())))
            .collect::<Result<Vec<_>>>()?;
        requests.extend(self.approvals.iter().map(|(id, approval)| {
            o([
                ("requestId", s(id.clone())),
                ("kind", s("approval")),
                ("workIds", a([approval.work.clone()])),
                ("openedAtMs", approval.opened.clone()),
                ("answerTimeoutMs", optional_integer(&approval.timeout)),
            ])
        }));
        let pending = self.registry.pending_resolutions();
        let mut pending = pending
            .array()
            .unwrap()
            .iter()
            .map(|r| self.project(r))
            .collect::<Result<Vec<_>>>()?;
        pending.extend(
            self.approvals
                .iter()
                .filter(|(_, a)| !a.ack)
                .filter_map(|(_, a)| a.resolution.clone()),
        );
        pending.sort_by(|a, b| {
            monotone(a.get("resolvedAtMs"))
                .unwrap()
                .cmp(&monotone(b.get("resolvedAtMs")).unwrap())
        });
        Ok(o([
            ("requests", a(requests)),
            (
                "retiredClocks",
                a(self.retired.iter().map(|(id, snapshot)| {
                    o([("workId", s(id.clone())), ("snapshot", snapshot.clone())])
                })),
            ),
            ("clocks", a(clocks.clone())),
            (
                "expiredWorkIds",
                a(clocks
                    .iter()
                    .filter(|c| c.get("snapshot").get("expired").truthy())
                    .map(|c| c.get("workId").clone())),
            ),
            ("pendingResolutions", a(pending)),
            (
                "nativeAnswers",
                a(self.answers.iter().map(|(_, v)| v.clone())),
            ),
            ("nextWakeMs", delay(next)),
        ]))
    }
    fn expire_approvals(&mut self, now_raw: &Value) -> Result<()> {
        let now = monotone(now_raw)?;
        for (id, approval) in &mut self.approvals {
            let opened = monotone(&approval.opened)?;
            let elapsed = now.sub(&opened);
            if let Some(timeout) = &approval.timeout {
                if approval.resolution.is_none()
                    && integers::compare_integers030(&elapsed.to_js_string(), timeout)?
                        != Ordering::Less
                {
                    let at = opened.add(&integers::bounded_integer030(timeout, &elapsed)?);
                    let mut r = resolution(
                        &s(id.clone()),
                        true,
                        s(at.to_js_string()),
                        a([]),
                        o([("kind", s("expired"))]),
                    );
                    r.set("failure", s("APPROVAL_TIMEOUT"));
                    approval.resolution = Some(r);
                }
            }
        }
        Ok(())
    }
    fn project(&self, raw: &Value) -> Result<Value> {
        let id = raw.get("requestId");
        let question =
            find(&self.requests, id).is_some_and(|i| self.requests[i].1.eq_str("question"));
        let answer = if question {
            if raw.get("expired").truthy() {
                o([("kind", s("expired"))])
            } else {
                let Some((_, reference)) = self.answers.iter().find(|(_, r)| {
                    strict_equal(r.get("requestId"), id) && r.get("accepted").truthy()
                }) else {
                    return plain("question resolution lacks a native receipt.");
                };
                o([
                    ("kind", s("native")),
                    ("nativeReceiptId", reference.get("nativeReceiptId").clone()),
                ])
            }
        } else {
            let mut answer = o([("kind", s("decision"))]);
            for (k, v) in raw.get("answer").object().unwrap() {
                answer.set(k.clone(), v.clone());
            }
            answer
        };
        Ok(resolution(
            id,
            raw.get("expired").truthy(),
            raw.get("resolvedAtMs").clone(),
            raw.get("workActions").clone(),
            answer,
        ))
    }
}
fn resolution(id: &Value, expired: bool, at: Value, actions: Value, answer: Value) -> Value {
    o([
        ("requestId", id.clone()),
        ("expired", Value::Bool(expired)),
        ("resolvedAtMs", at),
        ("workActions", actions),
        ("answer", answer),
    ])
}
