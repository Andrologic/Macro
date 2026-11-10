//! Native proof checks for the resident's temporal projection. Only SQL-backed
//! answers, native event timestamps and authored limits can create authority.
use super::*;
use std::cmp::Ordering;
#[path = "flow_number.rs"]
mod counter;

pub(crate) fn ms(raw: &str) -> Result<u64> {
    require(counter::canonical(raw), "Noncanonical native milliseconds")?;
    raw.parse()
        .map_err(|_| failure("CORRELATION", "clock", "Native milliseconds overflow"))
}
fn text<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    v[key]
        .as_str()
        .ok_or_else(|| failure("CORRELATION", "clock", "Missing native projection field"))
}
fn ids(v: &Value) -> Result<Vec<String>> {
    let values: Vec<String> = serde_json::from_value(v.clone())?;
    require(
        values
            .iter()
            .collect::<std::collections::BTreeSet<_>>()
            .len()
            == values.len(),
        "Duplicate native projection identity",
    )?;
    Ok(values)
}
fn subtract(a: &str, b: &str) -> String {
    let mut rhs = b.bytes().rev();
    let mut borrow = 0i16;
    let mut result = Vec::new();
    for c in a.bytes().rev() {
        let n = (c - b'0') as i16 - rhs.next().map_or(0, |c| (c - b'0') as i16) - borrow;
        borrow = i16::from(n < 0);
        result.push(b'0' + n.rem_euclid(10) as u8);
    }
    while result.len() > 1 && result.last() == Some(&b'0') {
        result.pop();
    }
    result.reverse();
    String::from_utf8(result).expect("decimal digits")
}
/// Compare positive exact JSON integers without expanding arbitrary exponents.
fn magnitude(raw: &str) -> Result<(String, String)> {
    require(
        counter::Limit::parse(raw).is_some(),
        "Invalid authored human limit",
    )?;
    let (m, e) = raw
        .trim()
        .split_once(['e', 'E'])
        .unwrap_or((raw.trim(), "0"));
    let (whole, fraction) = m.split_once('.').unwrap_or((m, ""));
    let all = format!("{whole}{fraction}");
    let all = all.trim_start_matches('0');
    let digits = all.trim_end_matches('0');
    let exponent = e.trim_start_matches(['+', '-']).trim_start_matches('0');
    let exponent = if exponent.is_empty() { "0" } else { exponent };
    let positive = counter::add(
        if e.starts_with('-') { "0" } else { exponent },
        &(all.len() - digits.len()).to_string(),
    );
    let negative = counter::add(
        if e.starts_with('-') { exponent } else { "0" },
        &fraction.len().to_string(),
    );
    require(
        counter::cmp(&positive, &negative) != Ordering::Less,
        "Nonintegral limit",
    )?;
    Ok((digits.to_owned(), subtract(&positive, &negative)))
}
fn compare_limits(a: &str, b: &str) -> Result<Ordering> {
    let (a, az) = magnitude(a)?;
    let (b, bz) = magnitude(b)?;
    let order = counter::cmp(
        &counter::add(&a.len().to_string(), &az),
        &counter::add(&b.len().to_string(), &bz),
    );
    if order != Ordering::Equal {
        return Ok(order);
    }
    Ok((0..a.len().max(b.len()))
        .map(|i| {
            a.as_bytes()
                .get(i)
                .copied()
                .unwrap_or(b'0')
                .cmp(&b.as_bytes().get(i).copied().unwrap_or(b'0'))
        })
        .find(|o| *o != Ordering::Equal)
        .unwrap_or(Ordering::Equal))
}
pub(super) fn bounded(raw: &str, bound: u128) -> Result<Option<u128>> {
    let limit = counter::Limit::parse(raw)
        .ok_or_else(|| failure("CORRELATION", "clock", "Invalid authored limit"))?;
    if limit.compare_counter(&bound.to_string()) == Ordering::Less {
        return Ok(None);
    }
    let (mut lo, mut hi) = (1, bound);
    while lo < hi {
        let mid = lo + (hi - lo) / 2;
        if limit.compare_counter(&mid.to_string()) == Ordering::Less {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    Ok(Some(lo))
}
fn wake(limit: Option<&str>, elapsed: u64, slice: u64) -> Result<Option<u64>> {
    limit
        .map(|limit| {
            Ok(match bounded(limit, elapsed as u128 + slice as u128)? {
                None => slice,
                Some(value) => value.saturating_sub(elapsed as u128) as u64,
            })
        })
        .transpose()
}
#[derive(Clone)]
pub(super) struct Work {
    pub(super) id: String,
    pub(super) kind: String,
    pub(super) start: u64,
    pub(super) timeout: Option<String>,
    pub(super) answer_timeout: Option<String>,
    pub(super) snapshot: Value,
    pub(super) retired: bool,
}
#[derive(Clone)]
pub(super) struct Request {
    pub(super) id: String,
    pub(super) kind: String,
    pub(super) works: Vec<String>,
    pub(super) opened: u64,
    pub(super) duration: Option<String>,
    pub(super) resolution: Option<Value>,
    pub(super) acknowledged: bool,
    pub(super) proven: bool,
}
#[derive(Clone)]
pub(super) struct Submission {
    pub(super) id: String,
    pub(super) request: String,
    pub(super) received: u64,
    pub(super) answer: HumanAnswer030,
    pub(super) accepted: Option<bool>,
}
pub(super) fn duration(request: &Request, works: &[Work]) -> Result<Option<String>> {
    if request.kind == "approval" {
        let work = works
            .iter()
            .find(|w| request.works == [w.id.clone()])
            .ok_or_else(|| failure("CORRELATION", "clock", "Approval work differs"))?;
        return Ok(work.timeout.clone());
    }
    let mut shortest: Option<String> = None;
    for id in &request.works {
        let work = works
            .iter()
            .find(|w| &w.id == id && w.kind != "approval")
            .ok_or_else(|| failure("CORRELATION", "clock", "Unknown attributed native work"))?;
        if let Some(limit) = &work.answer_timeout {
            if shortest
                .as_ref()
                .map(|prior| compare_limits(limit, prior))
                .transpose()?
                .is_none_or(|o| o == Ordering::Less)
            {
                shortest = Some(limit.clone());
            }
        }
    }
    Ok(shortest)
}
pub(super) fn due(request: &Request, now: u64, previous: u64) -> Result<Option<u64>> {
    let Some(duration) = &request.duration else {
        return Ok(None);
    };
    let Some(elapsed) = now.checked_sub(request.opened) else {
        return Ok(None);
    };
    Ok(bounded(duration, elapsed as u128)?.map(|d| {
        let at = request.opened + d as u64;
        if request.kind == "approval" {
            at
        } else {
            at.max(previous)
        }
    }))
}
pub(super) fn resolution(
    request: &Request,
    at: u64,
    submission: Option<&Submission>,
) -> Result<Value> {
    let expired = submission.is_none();
    let answer = match submission.map(|s| &s.answer) {
        None if request.kind == "approval" || request.kind == "question" => {
            json!({"kind":"expired"})
        }
        None => json!({"kind":"decision","decision":"no"}),
        Some(HumanAnswer030::Decision { decision, comment })
            if ["ask", "plan"].contains(&request.kind.as_str()) =>
        {
            json!({"kind":"decision","decision":decision,"comment":comment})
        }
        Some(HumanAnswer030::Approval { choice, comment }) if request.kind == "approval" => {
            json!({"kind":"approval","choice":choice,"comment":comment})
        }
        Some(HumanAnswer030::Question { .. }) if request.kind == "question" => {
            json!({"kind":"native","nativeReceiptId":submission.unwrap().id})
        }
        _ => {
            return Err(failure(
                "CORRELATION",
                "human",
                "Submission kind differs from native request",
            ))
        }
    };
    let has_comment = !human_comment_is_empty030(answer["comment"].as_str().unwrap_or(""));
    let action = if request.kind == "plan" && answer["decision"] == "no" && !has_comment {
        "PLAN_REJECTED"
    } else {
        "continue"
    };
    let actions = if request.kind == "approval" {
        Vec::new()
    } else {
        request
            .works
            .iter()
            .map(|id| json!({"workId":id,"action":action}))
            .collect()
    };
    let mut value = json!({"requestId":request.id,"expired":expired,"resolvedAtMs":at.to_string(),"workActions":actions,"answer":answer});
    if expired && request.kind == "approval" {
        value["failure"] = json!("APPROVAL_TIMEOUT");
    }
    Ok(value)
}
fn keyed(values: &Value, key: &str) -> Result<BTreeMap<String, Value>> {
    let mut result = BTreeMap::new();
    for value in values
        .as_array()
        .ok_or_else(|| failure("CORRELATION", "clock", "Projection array absent"))?
    {
        require(
            result
                .insert(text(value, key)?.into(), value.clone())
                .is_none(),
            "Duplicate projection identity",
        )?;
    }
    Ok(result)
}
pub(super) fn strip_reason(mut value: Value) -> Value {
    if let Some(object) = value.as_object_mut() {
        object.remove("reason");
    }
    value
}

pub(super) fn validate_projection(
    works: Vec<Work>,
    mut requests: Vec<Request>,
    submissions: Vec<Submission>,
    previous: u64,
    envelope: &Value,
    receipt: &Value,
) -> Result<()> {
    let now = ms(text(envelope, "nowMs")?)?;
    let event = &envelope["event"];
    // Recheck existing decisions too: even a previously stored plan acceptance
    // cannot mint a capability without the authenticated native submission.
    for request in &requests {
        verify_existing(request, &submissions)?;
    }
    let before = requests.clone();
    for request in &mut requests {
        if request.resolution.is_none() {
            if let Some(at) = due(request, now, previous)? {
                request.resolution = Some(resolution(request, at, None)?);
            }
        }
    }
    if event["kind"] == "associate" {
        let request = requests
            .iter_mut()
            .find(|r| Some(r.id.as_str()) == event["requestId"].as_str())
            .ok_or_else(|| failure("CORRELATION", "clock", "Unknown native association"))?;
        if request.resolution.is_none() {
            request.works = ids(&event["workIds"])?;
            request.duration = duration(request, &works)?;
            if let Some(at) = due(request, now, now)? {
                request.resolution = Some(resolution(request, at, None)?);
            }
        }
    }
    if event["kind"] == "retire" {
        for request in &mut requests {
            if request.resolution.is_none() && request.kind != "approval" {
                request
                    .works
                    .retain(|id| Some(id.as_str()) != event["workId"].as_str());
                request.duration = duration(request, &works)?;
            }
        }
    }
    let mut accepted_current = false;
    if event["kind"] == "answer" || event["kind"] == "approvalAnswer" {
        let submission = submissions
            .iter()
            .find(|s| Some(s.id.as_str()) == event["nativeReceiptId"].as_str())
            .ok_or_else(|| {
                failure(
                    "CORRELATION",
                    "human",
                    "Resident answer has no native submission",
                )
            })?;
        require(
            submission.received == now
                && Some(submission.request.as_str()) == event["requestId"].as_str(),
            "Native submission time or request differs",
        )?;
        let request = requests
            .iter_mut()
            .find(|r| r.id == submission.request)
            .ok_or_else(|| failure("CORRELATION", "human", "Native request absent"))?;
        if request.resolution.is_none() {
            request.resolution = Some(resolution(request, now, Some(submission))?);
            accepted_current = true;
        }
    }
    let expected_pending: BTreeMap<_, _> = requests
        .iter()
        .filter(|r| !r.acknowledged)
        .filter_map(|r| r.resolution.as_ref().map(|v| (r.id.clone(), v.clone())))
        .collect();
    require(
        keyed(&receipt["pendingResolutions"], "requestId")? == expected_pending,
        "Resident human resolutions lack native proof",
    )?;
    let expected_answers: BTreeMap<_, _> = submissions
        .iter()
        .map(|s| {
            let accepted = if Some(s.id.as_str()) == event["nativeReceiptId"].as_str() {
                accepted_current
            } else {
                s.accepted.unwrap_or(false)
            };
            (
                s.id.clone(),
                json!({"requestId":s.request,"nativeReceiptId":s.id,"accepted":accepted}),
            )
        })
        .collect();
    require(
        keyed(&receipt["nativeAnswers"], "nativeReceiptId")? == expected_answers,
        "Resident native answer references differ",
    )?;
    let mut snapshots = keyed(&receipt["requests"], "requestId")?;
    for request in &requests {
        let snapshot = snapshots
            .remove(&request.id)
            .ok_or_else(|| failure("CORRELATION", "clock", "Native request omitted"))?;
        require(
            snapshot["kind"] == request.kind
                && snapshot["workIds"] == json!(request.works)
                && snapshot["openedAtMs"] == request.opened.to_string()
                && snapshot["answerTimeoutMs"] == json!(request.duration),
            "Resident changed a native deadline or attribution",
        )?;
    }
    require(snapshots.is_empty(), "Resident invented a request")?;
    validate_clocks(&works, &before, &requests, previous, now, event, receipt)?;
    Ok(())
}
pub(super) fn verify_existing(request: &Request, submissions: &[Submission]) -> Result<()> {
    let Some(stored) = &request.resolution else {
        return Ok(());
    };
    require(
        request.proven,
        "Stored decision lacks a committed native validation proof",
    )?;
    let at = ms(text(stored, "resolvedAtMs")?)?;
    let submission = if stored["expired"] == true {
        require(
            due(request, at, 0)?.is_some(),
            "Automatic resolution precedes native deadline",
        )?;
        None
    } else {
        let matching = submissions
            .iter()
            .filter(|s| s.request == request.id && s.accepted == Some(true) && s.received == at)
            .collect::<Vec<_>>();
        require(
            matching.len() == 1 && due(request, at, 0)?.is_none(),
            "Stored decision lacks timely authenticated submission",
        )?;
        Some(matching[0])
    };
    require(
        *stored == resolution(request, at, submission)?,
        "Stored human decision differs from native answer",
    )
}
fn validate_clocks(
    works: &[Work],
    before: &[Request],
    requests: &[Request],
    previous: u64,
    now: u64,
    event: &Value,
    receipt: &Value,
) -> Result<()> {
    let mut active = keyed(&receipt["clocks"], "workId")?;
    let mut retired = keyed(&receipt["retiredClocks"], "workId")?;
    let mut expired = Vec::new();
    let mut wakes = Vec::new();
    for work in works {
        if work.kind == "approval" {
            continue;
        }
        let new_retirement =
            event["kind"] == "retire" && Some(work.id.as_str()) == event["workId"].as_str();
        let snapshot = if work.retired {
            work.snapshot.clone()
        } else {
            let start = if work.snapshot.get("elapsedMachineMs").is_some() {
                previous.max(work.start)
            } else {
                work.start
            };
            require(start <= now, "Work time moved backwards")?;
            let mut intervals = Vec::new();
            for old in before
                .iter()
                .filter(|r| r.kind != "approval" && r.works.contains(&work.id))
            {
                let request = requests.iter().find(|r| r.id == old.id).unwrap();
                let from = start.max(old.opened);
                let until = request
                    .resolution
                    .as_ref()
                    .map(|r| ms(text(r, "resolvedAtMs")?))
                    .transpose()?
                    .unwrap_or(now)
                    .min(now);
                if from < until {
                    intervals.push((from, until));
                }
            }
            intervals.sort_unstable();
            let (mut paused, mut end) = (0, start);
            for (from, until) in intervals {
                if until > end {
                    paused += until - end.max(from);
                    end = until;
                }
            }
            let consumed = work.snapshot["elapsedMachineMs"]
                .as_str()
                .map(ms)
                .transpose()?
                .unwrap_or(0);
            let elapsed = consumed
                .checked_add(now - start - paused)
                .ok_or_else(|| failure("CORRELATION", "clock", "Machine budget overflow"))?;
            let open = requests
                .iter()
                .filter(|r| {
                    r.resolution.is_none() && r.kind != "approval" && r.works.contains(&work.id)
                })
                .map(|r| r.id.clone())
                .collect::<Vec<_>>();
            let is_expired = work.snapshot["expired"] == true
                || wake(work.timeout.as_deref(), elapsed, 2147483647)? == Some(0);
            if !new_retirement {
                if let Some(delay) = if open.is_empty() {
                    wake(work.timeout.as_deref(), elapsed, 2147483647)?
                } else {
                    None
                } {
                    wakes.push(delay);
                }
            }
            json!({"elapsedMachineMs":elapsed.to_string(),"openHumanRequests":open,"expired":is_expired})
        };
        let actual = if work.retired || new_retirement {
            retired.remove(&work.id)
        } else {
            active.remove(&work.id)
        }
        .ok_or_else(|| failure("CORRELATION", "clock", "Native work clock omitted"))?;
        require(
            actual["snapshot"]["elapsedMachineMs"] == snapshot["elapsedMachineMs"]
                && actual["snapshot"]["expired"] == snapshot["expired"]
                && ids(&actual["snapshot"]["openHumanRequests"])?
                    .into_iter()
                    .collect::<std::collections::BTreeSet<_>>()
                    == ids(&snapshot["openHumanRequests"])?.into_iter().collect(),
            "Resident changed native machine budget or pauses",
        )?;
        if !work.retired && !new_retirement && snapshot["expired"] == true {
            expired.push(work.id.clone());
        }
    }
    require(
        active.is_empty() && retired.is_empty() && ids(&receipt["expiredWorkIds"])? == expired,
        "Resident invented a machine timeout",
    )?;
    for request in requests.iter().filter(|r| r.resolution.is_none()) {
        if let Some(delay) = wake(
            request.duration.as_deref(),
            now.saturating_sub(request.opened),
            2147483647,
        )? {
            wakes.push(delay);
        }
    }
    require(
        receipt["nextWakeMs"] == json!(wakes.into_iter().min()),
        "Resident wake differs from native deadline",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserves_exact_authored_limits_without_expanding_exponents() {
        assert_eq!(compare_limits("1e3", "1000").unwrap(), Ordering::Equal);
        assert_eq!(
            compare_limits("9007199254740993", "9007199254740992").unwrap(),
            Ordering::Greater
        );
        assert_eq!(
            compare_limits(
                "1e10000000000000000000000000",
                "9e9999999999999999999999999"
            )
            .unwrap(),
            Ordering::Greater
        );
        assert_eq!(bounded("60000", 60001).unwrap(), Some(60000));
        assert_eq!(
            bounded("1e9999999999999999999999", u128::MAX).unwrap(),
            None
        );
        assert_eq!(
            wake(Some("1e9999999999999999999999"), 1, 1000).unwrap(),
            Some(1000)
        );
        assert_eq!(wake(Some("1e3"), 999, 1000).unwrap(), Some(1));
        assert!(compare_limits("0", "1").is_err());
    }
}
