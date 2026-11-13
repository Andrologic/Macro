//! Translation of a JSON Schema `pattern`, as `schemacheck.mjs` compiles it
//! (`new RegExp(source, 'u')`, final `$` read as the absolute end), to the
//! `regex` crate. Only constructs whose JS `u` meaning and Rust meaning agree
//! are emitted; every other construct is refused with a message, never
//! approximated. The schemas that reach this code are the pinned AgSDL schemas
//! and roots defined in Macro's code: authored documents never supply a
//! pattern, because `valueSchema` has no `pattern` keyword.
//!
//! Emitted forms: every literal as `\x{..}` (no Rust-only metacharacter can
//! leak), `^` as `\A`, `$` as `\z`, `.` as the JS line-terminator exclusion,
//! classes rebuilt atom by atom, `(?:`, capturing groups, `|` and the
//! greedy or lazy quantifiers `* + ? {n} {n,} {n,m}`. A boolean `test` only
//! asks whether some match exists, so backtracking (JS) and automata (Rust)
//! agree on this backreference-free, lookaround-free subset.
use regex::{Regex, RegexBuilder};

/// Compiled program bound for one pattern, stated explicitly rather than
/// inherited. The pinned URI pattern (5 427 characters of counted IPv6
/// repetitions) is the largest; the test
/// `pinned_patterns_compile_within_the_explicit_limit` measures its need and
/// checks that it fits.
pub(crate) const PATTERN_SIZE_LIMIT: usize = 10 * (1 << 20);

const SYNTAX: &str = "^$\\.*+?()[]{}|";

fn literal(c: char, out: &mut String) {
    out.push_str(&format!("\\x{{{:X}}}", c as u32));
}

/// Identity escapes allowed by the JS `u` grammar: syntax characters and `/`,
/// plus `-` inside a class.
fn identity_escape(c: char, in_class: bool) -> bool {
    SYNTAX.contains(c) || c == '/' || (in_class && c == '-')
}

fn class_atom(chars: &[char], at: &mut usize) -> Result<char, String> {
    let c = *chars.get(*at).ok_or("unterminated character class")?;
    *at += 1;
    if c != '\\' {
        return Ok(c);
    }
    let escaped = *chars.get(*at).ok_or("unterminated escape")?;
    *at += 1;
    if identity_escape(escaped, true) {
        Ok(escaped)
    } else {
        Err(format!("unsupported class escape \\{escaped}"))
    }
}

fn class(chars: &[char], at: &mut usize, out: &mut String) -> Result<(), String> {
    out.push('[');
    if chars.get(*at) == Some(&'^') {
        *at += 1;
        out.push('^');
    }
    if chars.get(*at) == Some(&']') {
        return Err("empty character class".to_owned());
    }
    loop {
        match chars.get(*at) {
            None => return Err("unterminated character class".to_owned()),
            Some(']') => {
                *at += 1;
                out.push(']');
                return Ok(());
            }
            Some(_) => {}
        }
        let start = class_atom(chars, at)?;
        literal(start, out);
        if chars.get(*at) == Some(&'-') && chars.get(*at + 1).is_some_and(|&c| c != ']') {
            *at += 1;
            let end = class_atom(chars, at)?;
            if end < start {
                return Err("character class range out of order".to_owned());
            }
            out.push('-');
            literal(end, out);
        }
    }
}

fn quantifier(chars: &[char], at: &mut usize, out: &mut String) -> Result<(), String> {
    // `{` already consumed. JS `u` accepts only `{n}`, `{n,}` and `{n,m}`.
    let digits = |at: &mut usize| {
        let start = *at;
        while chars.get(*at).is_some_and(char::is_ascii_digit) {
            *at += 1;
        }
        chars[start..*at].iter().collect::<String>()
    };
    let low = digits(at);
    if low.is_empty() {
        return Err("lone '{'".to_owned());
    }
    let mut text = format!("{{{low}");
    if chars.get(*at) == Some(&',') {
        *at += 1;
        text.push(',');
        text.push_str(&digits(at));
    }
    if chars.get(*at) != Some(&'}') {
        return Err("malformed quantifier".to_owned());
    }
    *at += 1;
    text.push('}');
    out.push_str(&text);
    Ok(())
}

/// Rust source for the JS `u` pattern `source`, or the refused construct.
pub(crate) fn translate(source: &str) -> Result<String, String> {
    let chars: Vec<char> = source.chars().collect();
    let mut out = String::new();
    let mut at = 0;
    while at < chars.len() {
        let c = chars[at];
        at += 1;
        match c {
            '\\' => {
                let escaped = *chars.get(at).ok_or("trailing backslash")?;
                at += 1;
                if !identity_escape(escaped, false) {
                    return Err(format!("unsupported escape \\{escaped}"));
                }
                literal(escaped, &mut out);
            }
            '[' => class(&chars, &mut at, &mut out)?,
            '(' => {
                if chars.get(at) == Some(&'?') {
                    if chars.get(at + 1) != Some(&':') {
                        return Err("unsupported group".to_owned());
                    }
                    at += 2;
                    out.push_str("(?:");
                } else {
                    out.push('(');
                }
            }
            ')' | '|' | '*' | '+' | '?' => out.push(c),
            '{' => quantifier(&chars, &mut at, &mut out)?,
            '}' | ']' => return Err(format!("lone '{c}'")),
            '^' => out.push_str("\\A"),
            '$' => out.push_str("\\z"),
            '.' => out.push_str("[^\\x{A}\\x{D}\\x{2028}\\x{2029}]"),
            c => literal(c, &mut out),
        }
    }
    Ok(out)
}

/// `new RegExp(source, 'u')` with the final-`$` rule, as a Rust regex.
pub(crate) fn compile(source: &str) -> Result<Regex, String> {
    let translated = translate(source)?;
    RegexBuilder::new(&translated)
        .size_limit(PATTERN_SIZE_LIMIT)
        .build()
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anchors_are_absolute_like_js_without_the_multiline_flag() {
        let name = compile("^[A-Za-z][A-Za-z0-9_-]{0,63}$").unwrap();
        assert!(name.is_match("writer"));
        assert!(!name.is_match("writer\n"));
        assert!(!name.is_match("\nwriter"));
        assert!(!name.is_match("é"));
        let dot = compile("^a.c$").unwrap();
        assert!(dot.is_match("a😀c"));
        assert!(!dot.is_match("a\u{2028}c"));
        assert!(!dot.is_match("a\rc"));
    }

    #[test]
    fn rust_only_metacharacters_stay_literal_and_unknown_escapes_are_refused() {
        let set = compile("^[a&&b~~-]+$").unwrap();
        assert!(set.is_match("&~-ab"));
        assert!(compile("^#x$").unwrap().is_match("#x"));
        for refused in [
            "\\d", "\\w", "\\s", "\\b", "(?=a)", "(?<n>a)", "\\1", "\\p{L}", "a{", "[]", "\\u0041",
        ] {
            assert!(translate(refused).is_err(), "{refused}");
        }
        assert!(compile("[b-a]").is_err());
    }
}
