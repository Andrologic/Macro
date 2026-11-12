//! Runtime guards for transport metadata. Shape never authenticates a caller.
use crate::argentic_core::{
    exact,
    native::{fail, o, s, Error, Text, Value},
};
type Result<T> = std::result::Result<T, Error>;
pub(crate) fn object<'a>(v: &'a Value, p: &str, code: &'static str) -> Result<&'a [(Text, Value)]> {
    v.object()
        .ok_or_else(|| Error::new(code, p, "Expected a plain metadata object."))
}
pub(crate) fn text(v: &Value, p: &str, code: &'static str) -> Result<Text> {
    v.text()
        .cloned()
        .ok_or_else(|| Error::new(code, p, "Expected primitive text metadata."))
}
pub(crate) fn identity(v: &Value, p: &str, code: &'static str) -> Result<Text> {
    let value = text(v, p, code)?;
    if value.trimmed_empty() {
        return fail(code, p, "Metadata identity must be nonempty.");
    }
    Ok(value)
}
pub(crate) fn array<'a>(v: &'a Value, p: &str) -> Result<&'a [Value]> {
    v.array()
        .ok_or_else(|| Error::new("UNSUPPORTED", p, "Expected a metadata array."))
}
pub(crate) fn json(v: &Value, p: &str) -> Result<String> {
    let raw = text(v, p, "UNSUPPORTED")?;
    let Some(raw) = raw.utf8() else {
        return fail("UNSUPPORTED", p, "Expected validated exact JSON metadata.");
    };
    if exact::decode(&raw).is_err() {
        return fail("UNSUPPORTED", p, "Expected validated exact JSON metadata.");
    }
    Ok(raw)
}
pub(crate) fn at(p: &Text, key: &Text) -> Text {
    let mut units = p.units().to_vec();
    units.push(47);
    for u in key.units() {
        match u {
            126 => units.extend([126, 48]),
            47 => units.extend([126, 49]),
            u => units.push(*u),
        }
    }
    Text::from_units(units)
}
pub(crate) fn capture_native_json(v: &Value, p: &str) -> Result<Value> {
    let mut pending = vec![(v, Text::from(p))];
    while let Some((v, p)) = pending.pop() {
        match v {
            Value::Null | Value::String(_) | Value::Bool(_) => {}
            Value::Number(n) if n.is_finite() => {}
            Value::Array(items) => {
                for (i, v) in items.iter().enumerate().rev() {
                    pending.push((v, at(&p, &Text::from(i.to_string()))));
                }
            }
            Value::Object(fields) => {
                for (k, v) in fields.iter().rev() {
                    pending.push((v, at(&p, k)));
                }
            }
            _ => return fail("UNSUPPORTED", p, "Expected a plain metadata object."),
        }
    }
    Ok(v.clone())
}
pub(crate) fn capture_source(v: &Value) -> Result<Value> {
    object(v, "/source", "CORRELATION")?;
    let owner = v.get("owner");
    object(owner, "/source/owner", "CORRELATION")?;
    let owner = o([
        (
            "projectId",
            s(identity(
                owner.get("projectId"),
                "/source/owner/projectId",
                "CORRELATION",
            )?),
        ),
        (
            "planId",
            s(identity(
                owner.get("planId"),
                "/source/owner/planId",
                "CORRELATION",
            )?),
        ),
        (
            "branch",
            s(identity(
                owner.get("branch"),
                "/source/owner/branch",
                "CORRELATION",
            )?),
        ),
    ]);
    let revision = text(v.get("revision"), "/source/revision", "CORRELATION")?;
    if !revision.utf8().is_some_and(|s| {
        s == "0"
            || s.as_bytes()
                .first()
                .is_some_and(|b| (b'1'..=b'9').contains(b))
                && s.bytes().all(|b| b.is_ascii_digit())
    }) {
        return fail(
            "CORRELATION",
            "/source/revision",
            "Source revision must be a canonical decimal string.",
        );
    }
    let sha = text(v.get("sourceSha256"), "/source/sourceSha256", "CORRELATION")?;
    if !sha.utf8().is_some_and(|s| {
        s.len() == 64
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    }) {
        return fail(
            "CORRELATION",
            "/source/sourceSha256",
            "Source SHA must be a canonical lowercase hexadecimal string.",
        );
    }
    Ok(o([
        ("owner", owner),
        ("revision", s(revision)),
        ("sourceSha256", s(sha)),
    ]))
}
