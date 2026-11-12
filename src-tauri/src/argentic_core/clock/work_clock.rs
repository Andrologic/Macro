use super::*;
pub(crate) struct WorkClock {
    pub(crate) timeout: Option<String>,
    last: BigInteger,
    elapsed: BigInteger,
    expired: bool,
    requests: Vec<Value>,
    closed: Vec<Value>,
}
impl WorkClock {
    pub(crate) fn new(timeout: &Value, now: &Value) -> Result<Self> {
        let timeout = integer(timeout)?;
        Ok(Self {
            timeout,
            last: monotone(now)?,
            elapsed: BigInteger::zero(),
            expired: false,
            requests: vec![],
            closed: vec![],
        })
    }
    pub(crate) fn advance(&mut self, now: &Value) -> Result<Value> {
        let now = monotone(now)?;
        if now < self.last {
            return correlation("", "Monotone work time moved backwards.");
        }
        if self.requests.is_empty() {
            self.elapsed = self.elapsed.add(&now.sub(&self.last));
        }
        self.last = now;
        if let Some(timeout) = &self.timeout {
            if integers::compare_integers030(&self.elapsed.to_js_string(), timeout)?
                != Ordering::Less
            {
                self.expired = true;
            }
        }
        Ok(self.snapshot())
    }
    pub(crate) fn open_human(&mut self, request: &Value, now: &Value) -> Result<()> {
        if trimmed(request, "requestId.trim", false)? || contains(&self.closed, request) {
            return correlation("", "A closed human wait cannot be reopened.");
        }
        self.advance(now)?;
        if !contains(&self.requests, request) {
            self.requests.push(request.clone());
        }
        Ok(())
    }
    pub(crate) fn close_human(&mut self, request: &Value, now: &Value) -> Result<()> {
        if !contains(&self.requests, request) {
            return correlation("", "No matching human wait is open.");
        }
        self.advance(now)?;
        self.requests.retain(|v| !strict_equal(v, request));
        if !contains(&self.closed, request) {
            self.closed.push(request.clone());
        }
        Ok(())
    }
    pub(crate) fn detach_human(&mut self, request: &Value, now: &Value) -> Result<()> {
        if !contains(&self.requests, request) {
            return correlation("", "No matching human wait is attached.");
        }
        self.advance(now)?;
        self.requests.retain(|v| !strict_equal(v, request));
        Ok(())
    }
    pub(crate) fn snapshot(&self) -> Value {
        o([
            ("elapsedMachineMs", s(self.elapsed.to_js_string())),
            ("openHumanRequests", a(self.requests.clone())),
            ("expired", Value::Bool(self.expired)),
        ])
    }
    pub(crate) fn next_wake(&self, slice: &Value) -> Result<Option<u32>> {
        if !self.requests.is_empty() {
            Ok(None)
        } else {
            timer(self.timeout.as_deref(), &self.elapsed, slice)
        }
    }
}
