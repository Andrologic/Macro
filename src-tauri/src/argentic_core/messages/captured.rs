//! Selection of host-supplied captures only. No content IO, hashing, or grants.
use crate::argentic_core::{
    calls_data::{self as c, Error, Result},
    error::Failure,
    exact,
    messages::CapturedSource,
    native::{self, Value},
};
#[derive(Clone)]
pub(crate) struct CapturedReceipts {
    identity: Value,
    receipts: Value,
    exception: Option<Error>,
}
impl CapturedReceipts {
    pub(crate) fn new(identity: &Value, receipts: &Value) -> Self {
        Self {
            identity: identity.clone(),
            receipts: receipts.clone(),
            exception: None,
        }
    }
    pub(crate) fn resolve(
        &self,
        source_json: &Value,
        usage: &Value,
        pointer: &Value,
    ) -> Result<Value> {
        let source = c::decode(source_json)?;
        let object = exact::record(Some(&source), "")?;
        if object.contains_key("value") {
            return Ok(c::encoded(&source));
        }
        let p = pointer.text().and_then(|t| t.utf8()).unwrap_or_default();
        let Some(uri) = object.get("uri").and_then(exact::Value::as_str) else {
            return c::fail(
                "CONTENT_UNAVAILABLE",
                &p,
                "Expected an inline value or captured URI.",
            );
        };
        let mut matches = vec![];
        let Some(receipts) = self.receipts.array() else {
            return c::exception("TypeError", "receipts.filter is not a function");
        };
        for receipt in receipts {
            if receipt.is_nullish() {
                return c::exception("TypeError", "Invalid native receipt.");
            }
            let candidate = c::decode(receipt.get("sourceJson"))?;
            if !exact::equal(&candidate, &source) {
                continue;
            }
            let provenance = receipt.get("provenance");
            if provenance.is_nullish() {
                return c::exception("TypeError", "Invalid native provenance.");
            }
            if !native::equal(provenance.get("pointer"), pointer)
                || !native::equal(provenance.get("usage"), usage)
            {
                continue;
            }
            if !["captureId", "sourceDigest", "agent", "policyDigest"]
                .iter()
                .all(|k| native::equal(provenance.get(k), self.identity.get(k)))
            {
                continue;
            }
            if !provenance.get("requestedUri").eq_str(uri) {
                continue;
            }
            if !provenance
                .get("sha256")
                .text()
                .and_then(|t| t.utf8())
                .is_some_and(|s| {
                    s.as_str().len() == 64
                        && s.as_str()
                            .bytes()
                            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                })
            {
                continue;
            }
            matches.push(receipt);
        }
        if matches.len() != 1 {
            return c::fail(
                "CONTENT_UNAVAILABLE",
                &p,
                "No uniquely correlated native content receipt.",
            );
        }
        let receipt = matches[0];
        let payload = receipt.get("payload");
        if payload.is_nullish() {
            return c::exception("TypeError", "Invalid native payload.");
        }
        let value = if payload.get("kind").eq_str("json") {
            exact::encode(&c::decode(payload.get("json"))?)
        } else {
            interpolated_json(if payload.get("kind").eq_str("text") {
                payload.get("text")
            } else {
                payload.get("base64")
            })
        };
        Ok(native::s(format!(
            "{{\"value\":{value},\"mediaType\":{}}}",
            interpolated_json(receipt.get("provenance").get("mediaType"))
        )))
    }
}
fn interpolated_json(v: &Value) -> String {
    if matches!(v, Value::Undefined) {
        "undefined".into()
    } else {
        v.stringify()
    }
}
impl CapturedReceipts {
    pub(crate) fn take_exception(&mut self) -> Option<Error> {
        self.exception.take()
    }
}
impl CapturedSource for CapturedReceipts {
    fn resolve_source(
        &mut self,
        raw: &str,
        usage: &str,
        pointer: &str,
    ) -> std::result::Result<String, Failure> {
        match self.resolve(&native::s(raw), &native::s(usage), &native::s(pointer)) {
            Ok(v) => Ok(v.text().unwrap().utf8().unwrap()),
            Err(Error::Failure(e)) => Err(Failure {
                code: e.code,
                pointer: e.pointer.utf8().unwrap_or_default(),
                message: e.message.utf8().unwrap_or_default(),
            }),
            Err(e) => {
                self.exception = Some(e);
                Err(Failure::new(
                    "CONTENT_UNAVAILABLE",
                    pointer,
                    "Invalid captured receipt.",
                ))
            }
        }
    }
}
#[derive(Default)]
pub(crate) struct CapturedOccurrences {
    entries: Vec<(String, Value, CapturedReceipts)>,
}
impl CapturedOccurrences {
    pub(crate) fn new(cache: &Value) -> Result<Self> {
        let mut result = Self::default();
        if cache.has("format") {
            if !cache.get("format").eq_str("macro-agsdl-route-content/1")
                || cache.get("occurrences").array().is_none()
            {
                return c::exception("Error", "Invalid content cache.");
            }
            let mut contexts = vec![];
            for occurrence in cache.get("occurrences").array().unwrap() {
                let ordinal = occurrence.get("targetOrdinal");
                let safe = if let Value::Number(native::Number::Finite(raw)) = ordinal {
                    exact::decode(raw).is_ok_and(|v| exact::values::uint(&v, false))
                } else {
                    false
                };
                let valid_index = occurrence
                    .get("itemIndex")
                    .text()
                    .and_then(|t| t.utf8())
                    .is_some_and(|raw| {
                        let raw = raw.as_str();
                        raw == "0"
                            || !raw.is_empty()
                                && matches!(raw.as_bytes()[0], b'1'..=b'9')
                                && raw.bytes().all(|b| b.is_ascii_digit())
                    });
                let context = occurrence.get("contextId");
                let identity = occurrence.get("identity");
                if !safe
                    || !valid_index
                    || !context.text().is_some_and(|t| !t.units().is_empty())
                    || !["captureId", "sourceDigest", "agent", "policyDigest"]
                        .iter()
                        .all(|k| {
                            identity
                                .get(k)
                                .text()
                                .is_some_and(|t| !t.units().is_empty())
                        })
                    || occurrence.get("receipts").array().is_none()
                {
                    return c::exception("Error", "Invalid content occurrence.");
                }
                let key = format!(
                    "{}:{}",
                    ordinal.stringify(),
                    occurrence.get("itemIndex").text().unwrap().lossy()
                );
                if result.entries.iter().any(|(k, _, _)| k == &key)
                    || contexts.iter().any(|c| native::equal(c, context))
                {
                    return c::exception("Error", "Duplicate content occurrence.");
                }
                contexts.push(context.clone());
                result.entries.push((
                    key,
                    occurrence.clone(),
                    CapturedReceipts::new(identity, occurrence.get("receipts")),
                ));
            }
        } else if !cache.get("identity").truthy()
            || !matches!(cache.get("identity"), Value::Object(_) | Value::Array(_))
            || cache.get("receipts").array().is_none_or(|v| !v.is_empty())
        {
            return c::exception(
                "Error",
                "Legacy content receipts cannot authorize an occurrence.",
            );
        }
        Ok(result)
    }
    pub(crate) fn select(&mut self, ordinal: usize, index: &str) -> Option<&mut CapturedReceipts> {
        self.entries
            .iter_mut()
            .find(|(k, _, _)| k == &format!("{ordinal}:{index}"))
            .map(|(_, _, v)| v)
    }
    pub(crate) fn resolve(
        &mut self,
        ordinal: &Value,
        index: &Value,
        source: &Value,
        usage: &Value,
        pointer: &Value,
    ) -> Result<Value> {
        let key = format!(
            "{}:{}",
            ordinal.stringify(),
            index
                .text()
                .map_or_else(|| index.stringify(), |t| t.lossy())
        );
        match self.entries.iter_mut().find(|(k, _, _)| k == &key) {
            Some((_, _, v)) => v.resolve(source, usage, pointer),
            None => Ok(native::o([])),
        }
    }
}
