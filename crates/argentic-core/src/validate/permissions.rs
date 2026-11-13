// SPDX-License-Identifier: Apache-2.0
//! Static permission helpers of the validator. Rust translation of
//! `src/vendor/agsdl/v0.3/permissions.mjs` (port of AgSDL v0.3.0
//! tooling/agsdl/permissions.py, upstream commit
//! bd9f8a5b16923476fd20ac2650bd1729ee151917). Provenance and license:
//! `src/vendor/agsdl/NOTICE.md`, `src/vendor/agsdl/v0.3/LICENSE`.
//!
//! These functions read an authored, shape-valid `permissions` value. They do
//! not enforce anything; runtime enforcement stays in Macro's permission
//! module. Globs are matched over Unicode scalars by a dynamic program, without
//! a regex engine, so an authored pattern of any length keeps its JS answer.
use super::Internal;
use crate::argentic_core::exact::{Object, Value};

pub(crate) const ACTIONS: [&str; 6] = ["read", "write", "shell", "network", "mcp", "delegate"];

fn internal<T>(message: impl Into<String>) -> Result<T, Internal> {
    Err(Internal {
        message: message.into(),
    })
}

fn order(effect: &str) -> Result<u8, Internal> {
    match effect {
        "allow" => Ok(0),
        "ask" => Ok(1),
        "deny" => Ok(2),
        other => internal(format!("unknown permission effect {other}")),
    }
}

/// `PRESETS[preset][action]`.
pub(crate) fn preset_effect(preset: &str, action: &str) -> Result<&'static str, Internal> {
    let effect = match (preset, action) {
        ("read-only", "read") => "allow",
        ("read-only", _) => "deny",
        ("workspace", "network") => "deny",
        ("workspace", _) => "allow",
        ("full", _) => "allow",
        _ => return internal(format!("unknown preset {preset}")),
    };
    if !ACTIONS.contains(&action) {
        return internal(format!("unknown action {action}"));
    }
    Ok(effect)
}

fn default_effect(preset: Option<&str>, action: &str) -> Result<&'static str, Internal> {
    match preset {
        None => Ok("deny"),
        Some(preset) => preset_effect(preset, action),
    }
}

/// One authored rule: `{ action, effect, match? }`.
pub(crate) struct Rule<'a> {
    pub(crate) action: &'a str,
    pub(crate) effect: &'a str,
    pub(crate) matcher: Option<&'a str>,
}

fn text<'a>(object: &'a Object, key: &str) -> Result<Option<&'a str>, Internal> {
    match object.get(key) {
        None => Ok(None),
        Some(Value::String(text)) => Ok(Some(text)),
        Some(_) => internal(format!("permission rule {key} is not a string")),
    }
}

/// `normalize(permissions)`: `[preset, rules]`.
pub(crate) fn normalize(
    permissions: Option<&Value>,
) -> Result<(Option<&str>, Vec<Rule<'_>>), Internal> {
    let object = match permissions {
        None | Some(Value::Null) => return Ok((None, Vec::new())),
        Some(Value::String(preset)) => return Ok((Some(preset), Vec::new())),
        Some(Value::Object(object)) => object,
        Some(_) => return internal("permissions are neither a preset nor an object"),
    };
    let preset = match object.get("preset") {
        None | Some(Value::Null) => None,
        Some(Value::String(preset)) => Some(preset.as_str()),
        Some(_) => return internal("preset is not a string"),
    };
    let rules = match object.get("rules") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(rules)) => {
            let mut out = Vec::with_capacity(rules.len());
            for rule in rules {
                let Value::Object(rule) = rule else {
                    return internal("permission rule is not an object");
                };
                let (Some(action), Some(effect)) = (text(rule, "action")?, text(rule, "effect")?)
                else {
                    return internal("permission rule lacks action or effect");
                };
                out.push(Rule {
                    action,
                    effect,
                    matcher: text(rule, "match")?,
                });
            }
            out
        }
        Some(_) => return internal("rules is not an array"),
    };
    Ok((preset, rules))
}

/// `outside(permissions)`.
pub(crate) fn outside(permissions: Option<&Value>) -> Result<&str, Internal> {
    let (preset, _) = normalize(permissions)?;
    if let Some(Value::Object(object)) = permissions {
        if let Some(value) = object.get("outside") {
            return match value {
                Value::String(text) => Ok(text),
                _ => internal("outside is not a string"),
            };
        }
    }
    Ok(if preset == Some("full") {
        "read"
    } else {
        "deny"
    })
}

/// `covers_all(rule)`.
pub(crate) fn covers_all(rule: &Rule<'_>) -> bool {
    let Some(matcher) = rule.matcher else {
        return true;
    };
    if rule.action == "read" || rule.action == "write" {
        return matcher == "/**";
    }
    !matcher.is_empty() && matcher.chars().all(|c| c == '*')
}

/// `shell_denied(permissions)`.
pub(crate) fn shell_denied(permissions: Option<&Value>) -> Result<bool, Internal> {
    let (preset, rules) = normalize(permissions)?;
    let shell: Vec<&Rule<'_>> = rules.iter().filter(|rule| rule.action == "shell").collect();
    if shell
        .iter()
        .any(|rule| rule.effect == "deny" && covers_all(rule))
    {
        return Ok(true);
    }
    if shell.iter().any(|rule| rule.effect != "deny") {
        return Ok(false);
    }
    Ok(default_effect(preset, "shell")? == "deny")
}

enum Token {
    /// `[\s\S]*`
    Any,
    /// `[^/]*`
    Segment,
    Literal(char),
}

/// `glob_matches(pattern, text, paths, command)`: the JS builds
/// `^(?:…)(?![\s\S])` with `u`; this is the same full match over scalars.
pub(crate) fn glob_matches(pattern: &str, text: &str, paths: bool, command: bool) -> bool {
    if command && pattern.strip_suffix(" *") == Some(text) {
        return true;
    }
    let chars: Vec<char> = pattern.chars().collect();
    let mut tokens = Vec::with_capacity(chars.len());
    let mut i = 0;
    while i < chars.len() {
        if paths && chars[i] == '*' && chars.get(i + 1) == Some(&'*') {
            tokens.push(Token::Any);
            i += 2;
        } else if chars[i] == '*' {
            tokens.push(if paths { Token::Segment } else { Token::Any });
            i += 1;
        } else {
            tokens.push(Token::Literal(chars[i]));
            i += 1;
        }
    }
    let subject: Vec<char> = text.chars().collect();
    // current[j]: the tokens so far match subject[..j].
    let mut current = vec![false; subject.len() + 1];
    current[0] = true;
    for token in &tokens {
        let mut next = vec![false; subject.len() + 1];
        match token {
            Token::Literal(c) => {
                for j in 0..subject.len() {
                    next[j + 1] = current[j] && subject[j] == *c;
                }
            }
            Token::Any => {
                next[0] = current[0];
                for j in 1..=subject.len() {
                    next[j] = current[j] || next[j - 1];
                }
            }
            Token::Segment => {
                next[0] = current[0];
                for j in 1..=subject.len() {
                    next[j] = current[j] || (next[j - 1] && subject[j - 1] != '/');
                }
            }
        }
        current = next;
    }
    current[subject.len()]
}

/// `effect_for(permissions, action, subject)`.
pub(crate) fn effect_for<'p>(
    permissions: Option<&'p Value>,
    action: &str,
    subject: &str,
) -> Result<&'p str, Internal> {
    let (preset, rules) = normalize(permissions)?;
    let mut effect: Option<&'p str> = None;
    for rule in rules.iter().filter(|rule| rule.action == action) {
        let matched = match rule.matcher {
            None => true,
            Some(pattern) => glob_matches(
                pattern,
                subject,
                action == "read" || action == "write",
                action == "shell",
            ),
        };
        if matched {
            let current = effect.unwrap_or("allow");
            effect = Some(if order(rule.effect)? > order(current)? {
                rule.effect
            } else {
                current
            });
        }
    }
    match effect {
        Some(effect) => Ok(effect),
        None => default_effect(preset, action),
    }
}

fn python_whitespace(c: char) -> bool {
    matches!(c,
        '\u{0009}'..='\u{000d}' | '\u{001c}'..='\u{0020}' | '\u{0085}' | '\u{00a0}' | '\u{1680}'
        | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}')
}

/// `command_prefix(pattern)`.
pub(crate) fn command_prefix(pattern: &str) -> bool {
    let words = pattern.strip_suffix(" *").unwrap_or(pattern);
    !words.is_empty()
        && !words.contains('*')
        && !words.chars().next().is_some_and(python_whitespace)
        && !words.chars().next_back().is_some_and(python_whitespace)
}

/// `effects_in_use(permissions)`: effects per action, in `ACTIONS` order and
/// first-insertion order.
pub(crate) fn effects_in_use(
    permissions: Option<&Value>,
) -> Result<Vec<(&'static str, Vec<String>)>, Internal> {
    let (preset, rules) = normalize(permissions)?;
    let mut out = Vec::with_capacity(ACTIONS.len());
    for action in ACTIONS {
        let mut effects: Vec<String> = Vec::new();
        let mut add = |effect: &str| {
            if !effects.iter().any(|known| known == effect) {
                effects.push(effect.to_owned());
            }
        };
        for rule in rules.iter().filter(|rule| rule.action == action) {
            add(rule.effect);
        }
        if !rules
            .iter()
            .any(|rule| rule.action == action && covers_all(rule))
        {
            add(default_effect(preset, action)?);
            if preset == Some("workspace") && action == "write" {
                add("deny");
            }
        }
        out.push((action, effects));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glob_vectors_of_the_ts_tests() {
        for (pattern, subject, paths, command, matches) in [
            ("*.ts", "a/b.ts", true, false, false),
            ("**.ts", "a/b.ts", true, false, true),
            ("a/**/b", "a/b", true, false, false),
            ("git push *", "git push", false, true, true),
            ("git push *", "git push origin", false, true, true),
            ("git push *", "git pushx", false, true, false),
            ("a.b[0](x)+?^$|\\", "a.b[0](x)+?^$|\\", false, false, true),
            ("literal", "literal\n", false, false, false),
            ("*", "x\ny😀", false, false, true),
            ("a*", "a\nb", true, false, true),
            ("**", "x/y", false, false, true),
            ("***", "x/y", true, false, true),
        ] {
            assert_eq!(
                glob_matches(pattern, subject, paths, command),
                matches,
                "{pattern} {subject}"
            );
        }
        for p in ["git push", "git push *", "a\tb", "\u{feff}cmd"] {
            assert!(command_prefix(p), "{p}");
        }
        for p in [
            "",
            "*",
            "git*",
            "git * status",
            " git",
            "git ",
            "\u{0085}git",
            "git\u{001f}",
        ] {
            assert!(!command_prefix(p), "{p}");
        }
    }
}
