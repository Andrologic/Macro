use super::*;
struct RegisteredWork {
    clock: SharedClock,
    timeout: Option<String>,
}
struct Request {
    input: Value,
    signature: String,
    attached: Vec<Value>,
    timeout: Option<String>,
    resolution: Option<Value>,
}
#[derive(Default)]
pub(crate) struct HumanWaitRegistry {
    works: Vec<(Text, RegisteredWork)>,
    requests: Vec<(Text, Request)>,
    last: Option<BigInteger>,
    registered: Vec<Value>,
    pending: Vec<(Text, Value)>,
}
impl HumanWaitRegistry {
    pub(crate) fn register_work(
        &mut self,
        id: &Value,
        clock: SharedClock,
        timeout: &Value,
    ) -> Result<()> {
        if trimmed(id, "workId.trim", false)? || contains(&self.registered, id) {
            return correlation("", "Work must be registered exactly once.");
        }
        self.registered.push(id.clone());
        let timeout = integer(timeout)?;
        put(&mut self.works, id, RegisteredWork { clock, timeout });
        Ok(())
    }
    pub(crate) fn pending_resolutions(&self) -> Value {
        a(self.pending.iter().map(|(_, v)| v.clone()))
    }
    pub(crate) fn acknowledge_resolution(&mut self, id: &Value) -> Result<()> {
        let i = self.get(id)?;
        if self.requests[i].1.resolution.is_none() {
            return correlation("", "Cannot acknowledge an unresolved request.");
        }
        if let Some(i) = find(&self.pending, id) {
            self.pending.remove(i);
        }
        Ok(())
    }
    pub(crate) fn unregister_work(&mut self, id: &Value, now: &Value) -> Result<Value> {
        let Some(i) = find(&self.works, id) else {
            return correlation("", "Unknown or retired work.");
        };
        let clock = self.works[i].1.clock.clone();
        self.tick(now)?;
        for i in 0..self.requests.len() {
            let request = &mut self.requests[i].1;
            if request.resolution.is_some() || !contains(&request.attached, id) {
                continue;
            }
            if request.input.get("reviewer").eq_str("person") {
                clock
                    .borrow_mut()
                    .detach_human(request.input.get("requestId"), now)?;
            }
            request.attached.retain(|v| !strict_equal(v, id));
            let timeout = self.limit(
                self.requests[i].1.input.get("reviewer"),
                &self.requests[i].1.attached,
            )?;
            self.requests[i].1.timeout = timeout;
        }
        self.works.remove(find(&self.works, id).unwrap());
        let snapshot = clock.borrow().snapshot();
        Ok(snapshot)
    }
    pub(crate) fn open(&mut self, input: &Value) -> Result<Value> {
        access(input, "input.requestId")?;
        let id = input.get("requestId");
        if trimmed(id, "input.requestId.trim", false)? {
            return correlation("", "A human request needs an identity.");
        }
        let signature = input.stringify();
        if let Some(i) = find(&self.requests, id) {
            if self.requests[i].1.signature != signature {
                return correlation("", "Human request identity has conflicting content.");
            }
            return Ok(self.snapshot(i));
        }
        let works = self.work_ids(input.get("workIds"))?;
        self.tick(input.get("openedAtMs"))?;
        let timeout = self.limit(input.get("reviewer"), &works)?;
        put(
            &mut self.requests,
            id,
            Request {
                input: input.clone(),
                signature,
                attached: works.clone(),
                timeout,
                resolution: None,
            },
        );
        if input.get("reviewer").eq_str("person") {
            for work in &works {
                self.works[find(&self.works, work).unwrap()]
                    .1
                    .clock
                    .borrow_mut()
                    .open_human(id, input.get("openedAtMs"))?;
            }
        }
        Ok(self.snapshot(self.get(id)?))
    }
    pub(crate) fn set_request_works(
        &mut self,
        id: &Value,
        works: &Value,
        now: &Value,
    ) -> Result<Value> {
        let works = self.work_ids(works)?;
        self.tick(now)?;
        let i = self.get(id)?;
        if self.requests[i].1.resolution.is_some() {
            return Ok(self.snapshot(i));
        }
        if self.requests[i].1.input.get("reviewer").eq_str("person") {
            for old in &self.requests[i].1.attached {
                if !contains(&works, old) {
                    self.works[find(&self.works, old).unwrap()]
                        .1
                        .clock
                        .borrow_mut()
                        .detach_human(id, now)?;
                }
            }
            for work in &works {
                if !contains(&self.requests[i].1.attached, work) {
                    self.works[find(&self.works, work).unwrap()]
                        .1
                        .clock
                        .borrow_mut()
                        .open_human(id, now)?;
                }
            }
        }
        self.requests[i].1.attached = works;
        self.requests[i].1.timeout = self.limit(
            self.requests[i].1.input.get("reviewer"),
            &self.requests[i].1.attached,
        )?;
        self.tick(now)?;
        Ok(self.snapshot(i))
    }
    pub(crate) fn resolve(&mut self, id: &Value, answer: &Value, now: &Value) -> Result<Value> {
        access(answer, "answer.decision")?;
        if !(answer.get("decision").eq_str("yes") || answer.get("decision").eq_str("no"))
            || answer.has("comment") && answer.get("comment").text().is_none()
        {
            return correlation("", "Invalid human answer.");
        }
        self.tick(now)?;
        let i = self.get(id)?;
        if let Some(r) = &self.requests[i].1.resolution {
            return Ok(r.clone());
        }
        self.close(i, answer.clone(), false, now)
    }
    pub(crate) fn tick(&mut self, now: &Value) -> Result<Value> {
        let at = monotone(now)?;
        if self.last.as_ref().is_some_and(|last| at < *last) {
            return correlation("", "Human registry time moved backwards.");
        }
        let mut due = vec![];
        for (i, (_, request)) in self.requests.iter().enumerate() {
            if request.resolution.is_some() {
                continue;
            }
            let Some(timeout) = &request.timeout else {
                continue;
            };
            let opened = monotone(request.input.get("openedAtMs"))?;
            let elapsed = at.sub(&opened);
            if !elapsed.is_negative()
                && integers::compare_integers030(&elapsed.to_js_string(), timeout)?
                    != Ordering::Less
            {
                let mut deadline = opened.add(&integers::bounded_integer030(timeout, &elapsed)?);
                if let Some(last) = &self.last {
                    if deadline < *last {
                        deadline = last.clone();
                    }
                }
                due.push((i, deadline));
            }
        }
        due.sort_by(|a, b| a.1.cmp(&b.1));
        let mut resolved = vec![];
        for (i, deadline) in due {
            resolved.push(self.close(
                i,
                o([("decision", s("no"))]),
                true,
                &s(deadline.to_js_string()),
            )?);
        }
        for (_, work) in &self.works {
            work.clock.borrow_mut().advance(now)?;
        }
        self.last = Some(at);
        Ok(a(resolved))
    }
    pub(crate) fn next_wake(&mut self, now: &Value, slice: &Value) -> Result<Option<u32>> {
        self.tick(now)?;
        let at = monotone(now)?;
        let mut delays = vec![];
        for (_, request) in &self.requests {
            if request.resolution.is_some() {
                continue;
            }
            if let Some(timeout) = &request.timeout {
                delays.push(
                    timer(
                        Some(timeout),
                        &at.sub(&monotone(request.input.get("openedAtMs"))?),
                        slice,
                    )?
                    .unwrap(),
                );
            }
        }
        for (_, work) in &self.works {
            if let Some(delay) = work.clock.borrow().next_wake(slice)? {
                delays.push(delay);
            }
        }
        Ok(delays.into_iter().min())
    }
    pub(crate) fn request(&self, id: &Value) -> Result<Value> {
        Ok(self.snapshot(self.get(id)?))
    }
    fn close(&mut self, i: usize, answer: Value, expired: bool, at: &Value) -> Result<Value> {
        let request = &mut self.requests[i].1;
        if request.input.get("reviewer").eq_str("person") {
            for work in &request.attached {
                self.works[find(&self.works, work).unwrap()]
                    .1
                    .clock
                    .borrow_mut()
                    .close_human(request.input.get("requestId"), at)?;
            }
        }
        let rejected = request.input.get("kind").eq_str("plan")
            && answer.get("decision").eq_str("no")
            && answer.get("comment").text().is_none_or(Text::trimmed_empty);
        let resolution = o([
            ("requestId", request.input.get("requestId").clone()),
            ("answer", answer),
            ("expired", Value::Bool(expired)),
            ("resolvedAtMs", at.clone()),
            (
                "workActions",
                a(request.attached.iter().map(|id| {
                    o([
                        ("workId", id.clone()),
                        (
                            "action",
                            s(if rejected {
                                "PLAN_REJECTED"
                            } else {
                                "continue"
                            }),
                        ),
                    ])
                })),
            ),
        ]);
        request.resolution = Some(resolution.clone());
        put(
            &mut self.pending,
            request.input.get("requestId"),
            resolution.clone(),
        );
        Ok(resolution)
    }
    fn snapshot(&self, i: usize) -> Value {
        let request = &self.requests[i].1;
        let mut snapshot = request.input.clone();
        snapshot.set("workIds", a(request.attached.clone()));
        snapshot.set("answerTimeoutMs", optional_integer(&request.timeout));
        snapshot.set(
            "resolution",
            request.resolution.clone().unwrap_or(Value::Null),
        );
        snapshot
    }
    fn get(&self, id: &Value) -> Result<usize> {
        find(&self.requests, id).ok_or_else(|| {
            Error::Failure(native::Error::new(
                "CORRELATION",
                "",
                "Unknown human request.",
            ))
        })
    }
    fn work_ids(&self, value: &Value) -> Result<Vec<Value>> {
        let Some(works) = value.array() else {
            // new Set accepts null/undefined, but reading length then fails.
            if value.is_nullish() {
                access(value, "workIds.length")?;
            }
            if let Some(text) = value.text() {
                // String iteration uses code points, while .length uses UTF-16.
                let unique = char::decode_utf16(text.units().iter().copied())
                    .map(|c| match c {
                        Ok(c) => {
                            let mut units = [0; 2];
                            c.encode_utf16(&mut units).to_vec()
                        }
                        Err(e) => vec![e.unpaired_surrogate()],
                    })
                    .collect::<std::collections::HashSet<_>>();
                if unique.len() != text.units().len() {
                    return correlation("", "Unknown or duplicate work in human request.");
                }
                return exception("TypeError", "workIds.some is not a function. (In 'workIds.some((id) => !this.works.has(id))', 'workIds.some' is undefined)");
            }
            return exception("TypeError", "Type error");
        };
        let mut unique = vec![];
        for work in works {
            if contains(&unique, work) || find(&self.works, work).is_none() {
                return correlation("", "Unknown or duplicate work in human request.");
            }
            unique.push(work.clone());
        }
        Ok(unique)
    }
    fn limit(&self, reviewer: &Value, works: &[Value]) -> Result<Option<String>> {
        if !reviewer.eq_str("person") {
            return Ok(None);
        }
        let mut limit: Option<String> = None;
        for work in works {
            if let Some(candidate) = &self.works[find(&self.works, work).unwrap()].1.timeout {
                if limit
                    .as_ref()
                    .map(|prior| integers::compare_integers030(candidate, prior))
                    .transpose()?
                    .is_none_or(|o| o == Ordering::Less)
                {
                    limit = Some(candidate.clone());
                }
            }
        }
        Ok(limit)
    }
}
