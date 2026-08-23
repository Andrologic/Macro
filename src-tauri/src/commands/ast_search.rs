use super::{command_error, fs, tool_output, CommandResult};
use ast_grep_core::{
    matcher::{Pattern as AstPattern, PatternError},
    meta_var::MetaVariable,
    MatchStrictness,
};
use ast_grep_language::{Language, LanguageExt, SupportLang};
use glob::Pattern as GlobPattern;
use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;

const AST_PARSE_ERROR_LIMIT: usize = 20;

#[derive(Clone, Debug)]
pub(crate) struct AstSearchCandidate {
    pub workspace: PathBuf,
    pub read_path: String,
    pub display_path: String,
    pub size: Option<u64>,
    pub project_id: Option<String>,
    pub mount_name: Option<String>,
}

#[derive(Debug, Serialize)]
struct AstSearchMatch {
    path: String,
    language: String,
    start_line: usize,
    start_column: usize,
    end_line: usize,
    end_column: usize,
    byte_start: usize,
    byte_end: usize,
    text: String,
    text_truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    meta_variables: Option<BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    meta_variables_truncated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    mount_name: Option<String>,
}

struct SourceMatch {
    start_line: usize,
    start_column: usize,
    end_line: usize,
    end_column: usize,
    byte_start: usize,
    byte_end: usize,
    text: String,
    text_truncated: bool,
    meta_variables: Option<BTreeMap<String, String>>,
    meta_variables_truncated: Option<bool>,
}

struct SourceAnalysis {
    matches_seen: usize,
    matches: Vec<SourceMatch>,
    parse_error: bool,
    stopped_early: bool,
}

fn supported_languages() -> String {
    SupportLang::all_langs()
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join(", ")
}

fn resolve_language(raw: Option<&str>, path: &str) -> CommandResult<Option<SupportLang>> {
    if let Some(raw) = raw.map(str::trim).filter(|value| !value.is_empty()) {
        return raw.parse::<SupportLang>().map(Some).map_err(|_| {
            command_error(format!(
                "Unsupported ast_grep language '{}'. Supported languages: {}.",
                raw,
                supported_languages()
            ))
        });
    }
    Ok(SupportLang::from_path(path))
}

fn resolve_strictness(raw: Option<&str>) -> CommandResult<MatchStrictness> {
    match raw.map(str::trim).filter(|value| !value.is_empty()) {
        None | Some("smart") => Ok(MatchStrictness::Smart),
        Some("cst") => Ok(MatchStrictness::Cst),
        Some("ast") => Ok(MatchStrictness::Ast),
        Some("relaxed") => Ok(MatchStrictness::Relaxed),
        Some("signature") => Ok(MatchStrictness::Signature),
        Some("template") => Ok(MatchStrictness::Template),
        Some(value) => Err(command_error(format!(
            "Unsupported ast_grep strictness '{}'. Use smart, cst, ast, relaxed, signature, or template.",
            value
        ))),
    }
}

fn truncate_utf8(value: &str, max_bytes: usize) -> (String, bool) {
    if value.len() <= max_bytes {
        return (value.to_string(), false);
    }
    if max_bytes < 3 {
        return (String::new(), true);
    }
    let mut end = max_bytes.saturating_sub(3).min(value.len());
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    (format!("{}...", &value[..end]), true)
}

fn quote_json_bare_meta_variables(pattern: &str) -> String {
    let bytes = pattern.as_bytes();
    let mut output = String::with_capacity(pattern.len().saturating_add(4));
    let mut in_string = false;
    let mut index = 0usize;

    while index < bytes.len() {
        let byte = bytes[index];
        if byte == b'"' {
            let mut escape_start = index;
            while escape_start > 0 && bytes[escape_start - 1] == b'\\' {
                escape_start -= 1;
            }
            let escaped = (index - escape_start) % 2 == 1;
            if !escaped {
                in_string = !in_string;
            }
            output.push('"');
            index += 1;
            continue;
        }
        if byte == b'$' && !in_string {
            let start = index;
            index += 1;
            if bytes[index..].starts_with(b"$$") {
                index += 2;
            }
            let name_start = index;
            while index < bytes.len()
                && (bytes[index].is_ascii_alphanumeric() || bytes[index] == b'_')
            {
                index += 1;
            }
            if index > name_start {
                output.push('"');
                output.push_str(&pattern[start..index]);
                output.push('"');
            } else {
                output.push_str(&pattern[start..index]);
            }
            continue;
        }

        let mut end = index + 1;
        while end < bytes.len() && !pattern.is_char_boundary(end) {
            end += 1;
        }
        output.push_str(&pattern[index..end]);
        index = end;
    }

    output
}

fn compile_pattern(
    pattern: &str,
    language: SupportLang,
    strictness: &MatchStrictness,
) -> Result<AstPattern, String> {
    let compiled = match AstPattern::try_new(pattern, language) {
        Ok(compiled) => compiled,
        Err(original @ PatternError::MultipleNode(_)) if language == SupportLang::Json => {
            let context = format!("{{ {} }}", quote_json_bare_meta_variables(pattern));
            AstPattern::contextual(&context, "pair", language).map_err(|_| original.to_string())?
        }
        Err(error) => return Err(error.to_string()),
    };
    Ok(compiled.with_strictness(strictness.clone()))
}

fn analyze_source(
    source: String,
    language: SupportLang,
    pattern: AstPattern,
    skip: usize,
    take: usize,
    include_meta: bool,
) -> SourceAnalysis {
    let ast = language.ast_grep(source);
    let parse_error = ast.root().dfs().any(|node| node.is_error());
    let mut matches_seen = 0usize;
    let mut matches = Vec::with_capacity(take);
    let mut stopped_early = false;

    for matched in ast.root().find_all(pattern) {
        matches_seen = matches_seen.saturating_add(1);
        if matches_seen <= skip {
            continue;
        }
        if matches.len() >= take {
            stopped_early = true;
            break;
        }

        let start = matched.start_pos();
        let end = matched.end_pos();
        let range = matched.range();
        let node = matched.get_node();
        let (text, text_truncated) =
            truncate_utf8(matched.text().as_ref(), tool_output::AST_MATCH_MAX_BYTES);
        let (meta_variables, meta_variables_truncated) = if include_meta {
            let environment = matched.get_env();
            let mut captured = environment
                .get_matched_variables()
                .filter_map(|variable| {
                    let name = match &variable {
                        MetaVariable::Capture(name, _) | MetaVariable::MultiCapture(name) => {
                            name.clone()
                        }
                        MetaVariable::Dropped(_) | MetaVariable::Multiple => return None,
                    };
                    Some((name, variable))
                })
                .collect::<Vec<_>>();
            captured.sort_by(|left, right| left.0.cmp(&right.0));

            let mut capture_was_truncated = false;
            let mut capture_bytes = 0usize;
            let mut variables = BTreeMap::new();
            for (index, (name, variable)) in captured.iter().enumerate() {
                if index >= tool_output::AST_CAPTURE_MAX_COUNT
                    || capture_bytes.saturating_add(name.len())
                        >= tool_output::AST_CAPTURE_TOTAL_MAX_BYTES
                {
                    capture_was_truncated = true;
                    break;
                }
                let Some(bytes) = environment.get_var_bytes(variable) else {
                    continue;
                };
                let value = String::from_utf8_lossy(bytes);
                let remaining = tool_output::AST_CAPTURE_TOTAL_MAX_BYTES
                    .saturating_sub(capture_bytes)
                    .saturating_sub(name.len());
                let (value, truncated) =
                    truncate_utf8(&value, tool_output::AST_CAPTURE_MAX_BYTES.min(remaining));
                capture_was_truncated |= truncated;
                capture_bytes = capture_bytes
                    .saturating_add(name.len())
                    .saturating_add(value.len());
                variables.insert(name.clone(), value);
            }
            capture_was_truncated |= captured.len() > variables.len();
            (Some(variables), Some(capture_was_truncated))
        } else {
            (None, None)
        };
        matches.push(SourceMatch {
            start_line: start.line() + 1,
            start_column: start.column(node) + 1,
            end_line: end.line() + 1,
            end_column: end.column(node) + 1,
            byte_start: range.start,
            byte_end: range.end,
            text,
            text_truncated,
            meta_variables,
            meta_variables_truncated,
        });
    }

    SourceAnalysis {
        matches_seen,
        matches,
        parse_error,
        stopped_early,
    }
}

pub(crate) async fn execute_ast_search(
    args: &Value,
    mut candidates: Vec<AstSearchCandidate>,
    cursor_scope: &str,
    virtual_root: bool,
) -> CommandResult<String> {
    let pattern = args
        .get("pattern")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| command_error("Missing pattern argument for ast_grep tool."))?
        .to_string();
    if pattern.len() > tool_output::AST_PATTERN_MAX_BYTES {
        return Err(command_error(format!(
            "ast_grep pattern exceeds the {} byte safety limit.",
            tool_output::AST_PATTERN_MAX_BYTES
        )));
    }
    let explicit_language = args
        .get("language")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let strictness_name = args
        .get("strictness")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("smart")
        .to_string();
    let strictness = resolve_strictness(Some(&strictness_name))?;
    let include_meta = args
        .get("include_meta")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let include_pattern = args
        .get("include_pattern")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let include_glob = include_pattern
        .as_ref()
        .map(|value| GlobPattern::new(value))
        .transpose()
        .map_err(|error| command_error(format!("Invalid include_pattern glob: {}", error)))?;
    let page = tool_output::resolve_tool_page(
        args,
        cursor_scope,
        tool_output::AST_DEFAULT_LIMIT,
        tool_output::AST_MAX_LIMIT,
    )?;

    candidates.sort_by(|left, right| left.display_path.cmp(&right.display_path));
    let mut compiled_patterns = HashMap::<SupportLang, Result<AstPattern, String>>::new();
    let mut reported_compile_errors = HashSet::<SupportLang>::new();
    let mut results = Vec::<AstSearchMatch>::new();
    let mut matches_seen = 0usize;
    let mut files_scanned = 0usize;
    let mut files_with_matches = 0usize;
    let mut skipped_binary = 0usize;
    let mut skipped_too_large = 0usize;
    let mut skipped_unsupported = 0usize;
    let mut parse_errors = Vec::<String>::new();
    let mut parse_errors_total = 0usize;
    let mut scan_complete = true;

    for candidate in candidates {
        if let Some(glob) = include_glob.as_ref() {
            if !glob.matches(&candidate.read_path) && !glob.matches(&candidate.display_path) {
                continue;
            }
        }
        if candidate.size.unwrap_or(0) > tool_output::AST_MAX_FILE_BYTES {
            skipped_too_large = skipped_too_large.saturating_add(1);
            continue;
        }
        let Some(language) =
            resolve_language(explicit_language.as_deref(), candidate.read_path.as_str())?
        else {
            skipped_unsupported = skipped_unsupported.saturating_add(1);
            continue;
        };
        let compiled = compiled_patterns
            .entry(language)
            .or_insert_with(|| compile_pattern(&pattern, language, &strictness))
            .clone();
        let compiled = match compiled {
            Ok(compiled) => compiled,
            Err(error) => {
                if reported_compile_errors.insert(language) {
                    parse_errors_total = parse_errors_total.saturating_add(1);
                    if parse_errors.len() < AST_PARSE_ERROR_LIMIT {
                        parse_errors.push(format!("{}: {}", language, error));
                    }
                }
                continue;
            }
        };

        let content = fs::read_file_internal(
            &candidate.workspace,
            candidate.read_path.clone(),
            Some(false),
        )
        .await
        .map_err(|error| command_error(error.to_string()))?;
        if content.size > tool_output::AST_MAX_FILE_BYTES {
            skipped_too_large = skipped_too_large.saturating_add(1);
            continue;
        }
        if content.is_binary {
            skipped_binary = skipped_binary.saturating_add(1);
            continue;
        }
        files_scanned = files_scanned.saturating_add(1);

        let remaining_skip = page.offset.saturating_sub(matches_seen);
        let remaining_take = page.limit.saturating_add(1).saturating_sub(results.len());
        let analysis = tokio::task::spawn_blocking(move || {
            analyze_source(
                content.content,
                language,
                compiled,
                remaining_skip,
                remaining_take,
                include_meta,
            )
        })
        .await
        .map_err(|error| command_error(format!("ast_grep worker failed: {}", error)))?;

        if analysis.parse_error {
            parse_errors_total = parse_errors_total.saturating_add(1);
            if parse_errors.len() < AST_PARSE_ERROR_LIMIT {
                parse_errors.push(format!(
                    "{}: syntax tree contains parse error nodes",
                    candidate.display_path
                ));
            }
        }
        if analysis.matches_seen > 0 {
            files_with_matches = files_with_matches.saturating_add(1);
        }
        matches_seen = matches_seen.saturating_add(analysis.matches_seen);
        results.extend(analysis.matches.into_iter().map(|matched| AstSearchMatch {
            path: candidate.display_path.clone(),
            language: language.to_string(),
            start_line: matched.start_line,
            start_column: matched.start_column,
            end_line: matched.end_line,
            end_column: matched.end_column,
            byte_start: matched.byte_start,
            byte_end: matched.byte_end,
            text: matched.text,
            text_truncated: matched.text_truncated,
            meta_variables: matched.meta_variables,
            meta_variables_truncated: matched.meta_variables_truncated,
            project_id: candidate.project_id.clone(),
            mount_name: candidate.mount_name.clone(),
        }));

        if analysis.stopped_early || results.len() > page.limit {
            scan_complete = false;
            break;
        }
    }

    let truncated = results.len() > page.limit;
    if truncated {
        results.truncate(page.limit);
    }
    let next_cursor = truncated.then(|| {
        tool_output::create_tool_cursor(cursor_scope, page.offset.saturating_add(results.len()))
    });
    let total_count = scan_complete.then_some(matches_seen);

    serde_json::to_string_pretty(&serde_json::json!({
        "pattern": pattern,
        "language": explicit_language,
        "strictness": strictness_name,
        "virtual_root": virtual_root,
        "count": results.len(),
        "total_count": total_count,
        "total_is_exact": scan_complete,
        "matches": results,
        "limit": page.limit,
        "offset": page.offset,
        "truncated": truncated,
        "next_cursor": next_cursor,
        "files_scanned": files_scanned,
        "files_with_matches": files_with_matches,
        "scan_complete": scan_complete,
        "skipped_files": {
            "binary": skipped_binary,
            "too_large": skipped_too_large,
            "unsupported_language": skipped_unsupported,
            "max_file_bytes": tool_output::AST_MAX_FILE_BYTES,
            "is_exact": scan_complete
        },
        "parse_errors": parse_errors,
        "parse_errors_total": parse_errors_total,
        "parse_errors_truncated": parse_errors_total > AST_PARSE_ERROR_LIMIT,
        "max_match_bytes": tool_output::AST_MATCH_MAX_BYTES,
        "max_meta_variable_bytes": tool_output::AST_CAPTURE_MAX_BYTES,
        "max_meta_variables": tool_output::AST_CAPTURE_MAX_COUNT,
        "max_meta_variables_total_bytes": tool_output::AST_CAPTURE_TOTAL_MAX_BYTES,
        "max_pattern_bytes": tool_output::AST_PATTERN_MAX_BYTES
    }))
    .map_err(|error| command_error(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn structural_search_captures_meta_variables() {
        let pattern =
            AstPattern::try_new("console.log($ARG)", SupportLang::TypeScript).expect("pattern");
        let analysis = analyze_source(
            "console.log(first);".to_string(),
            SupportLang::TypeScript,
            pattern,
            0,
            10,
            true,
        );

        assert_eq!(analysis.matches.len(), 1);
        assert_eq!(analysis.matches[0].start_line, 1);
        assert_eq!(
            analysis.matches[0]
                .meta_variables
                .as_ref()
                .and_then(|variables| variables.get("ARG"))
                .map(String::as_str),
            Some("first")
        );
    }

    #[test]
    fn structural_search_bounds_match_text() {
        let source = format!("console.log('{}');", "x".repeat(4_000));
        let pattern =
            AstPattern::try_new("console.log($ARG)", SupportLang::TypeScript).expect("pattern");
        let analysis = analyze_source(source, SupportLang::TypeScript, pattern, 0, 10, false);

        assert_eq!(analysis.matches.len(), 1);
        assert!(analysis.matches[0].text_truncated);
        assert!(analysis.matches[0].text.len() <= tool_output::AST_MATCH_MAX_BYTES);
    }

    #[test]
    fn structural_search_matches_rust_call_expressions() {
        let pattern = AstPattern::try_new("process($$$ARGS)", SupportLang::Rust).expect("pattern");
        let analysis = analyze_source(
            "fn main() { process(first, second); }".to_string(),
            SupportLang::Rust,
            pattern,
            0,
            10,
            true,
        );

        assert_eq!(analysis.matches.len(), 1);
    }

    #[test]
    fn structural_search_wraps_json_pair_fragments() {
        let pattern = compile_pattern(
            r#""key": $VALUE"#,
            SupportLang::Json,
            &MatchStrictness::Smart,
        )
        .expect("contextual JSON pair pattern");
        let analysis = analyze_source(
            r#"{"key": "hello", "other": true}"#.to_string(),
            SupportLang::Json,
            pattern,
            0,
            10,
            true,
        );

        assert_eq!(analysis.matches.len(), 1);
        assert_eq!(analysis.matches[0].text, r#""key": "hello""#);
        assert!(analysis.matches[0]
            .meta_variables
            .as_ref()
            .is_some_and(|variables| variables.contains_key("VALUE")));
    }

    #[test]
    fn structural_search_reports_truncated_meta_variables() {
        let pattern =
            AstPattern::try_new("console.log($ARG)", SupportLang::TypeScript).expect("pattern");
        let analysis = analyze_source(
            format!("console.log('{}');", "x".repeat(1_000)),
            SupportLang::TypeScript,
            pattern,
            0,
            10,
            true,
        );

        assert_eq!(analysis.matches.len(), 1);
        assert_eq!(analysis.matches[0].meta_variables_truncated, Some(true));
        assert!(analysis.matches[0]
            .meta_variables
            .as_ref()
            .and_then(|variables| variables.get("ARG"))
            .is_some_and(|value| value.len() <= tool_output::AST_CAPTURE_MAX_BYTES));
    }

    #[tokio::test]
    async fn structural_search_rejects_oversized_patterns() {
        let args = serde_json::json!({
            "pattern": "x".repeat(tool_output::AST_PATTERN_MAX_BYTES + 1)
        });
        let error = execute_ast_search(&args, Vec::new(), "oversized-pattern", false)
            .await
            .expect_err("oversized pattern must fail before parsing");

        assert!(error.message.contains("pattern exceeds"));
    }
}
