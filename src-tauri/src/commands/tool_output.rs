use super::{command_error, CommandResult};
use serde_json::Value;

pub(crate) const READ_DEFAULT_MAX_LINES: usize = 500;
pub(crate) const READ_HARD_MAX_LINES: usize = 3_000;
pub(crate) const READ_MAX_BYTES: usize = 256 * 1024;
pub(crate) const READ_MAX_COLUMNS: usize = 2_000;
pub(crate) const LIST_DEFAULT_LIMIT: usize = 200;
pub(crate) const LIST_MAX_LIMIT: usize = 1_000;
pub(crate) const GLOB_DEFAULT_LIMIT: usize = 200;
pub(crate) const GLOB_MAX_LIMIT: usize = 1_000;
pub(crate) const GREP_DEFAULT_LIMIT: usize = 50;
pub(crate) const GREP_MAX_LIMIT: usize = 200;
pub(crate) const GREP_MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;
pub(crate) const GREP_MAX_COLUMNS: usize = 512;

const CURSOR_VERSION: &str = "v1";
const FNV_OFFSET_BASIS: u64 = 0xcbf29ce484222325;
const FNV_PRIME: u64 = 0x100000001b3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ToolPage {
    pub limit: usize,
    pub offset: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PaginatedItems<T> {
    pub items: Vec<T>,
    pub limit: usize,
    pub offset: usize,
    pub truncated: bool,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ReadContentPage {
    pub lines: Vec<String>,
    pub start_line: usize,
    pub end_line: usize,
    pub total_lines: usize,
    pub returned_lines: usize,
    pub truncated: bool,
    pub next_cursor: Option<String>,
    pub max_lines: usize,
    pub max_bytes: usize,
    pub column_truncated_lines: usize,
}

fn fingerprint_scope(scope: &str) -> String {
    let mut hash = FNV_OFFSET_BASIS;
    for byte in scope.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    format!("{hash:016x}")
}

pub(crate) fn create_tool_cursor(scope: &str, offset: usize) -> String {
    format!("{CURSOR_VERSION}:{}:{offset}", fingerprint_scope(scope))
}

pub(crate) fn parse_tool_cursor(cursor: Option<&Value>, scope: &str) -> CommandResult<usize> {
    let Some(cursor) = cursor else {
        return Ok(0);
    };
    if cursor.is_null() || cursor.as_str() == Some("") {
        return Ok(0);
    }
    let raw = cursor.as_str().ok_or_else(|| {
        command_error("cursor must be a string returned by the previous tool page.")
    })?;
    let parts = raw.trim().split(':').collect::<Vec<_>>();
    if parts.len() != 3
        || parts[0] != CURSOR_VERSION
        || parts[1].len() != 16
        || !parts[1].bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(command_error(
            "cursor is malformed or uses an unsupported version.",
        ));
    }
    if parts[1] != fingerprint_scope(scope) {
        return Err(command_error(
            "cursor does not belong to this tool request. Restart without cursor.",
        ));
    }
    parts[2]
        .parse::<usize>()
        .map_err(|_| command_error("cursor offset exceeds the supported range."))
}

fn resolve_limit(
    value: Option<&Value>,
    default_value: usize,
    max_value: usize,
) -> CommandResult<usize> {
    let Some(value) = value else {
        return Ok(default_value);
    };
    let number = value
        .as_f64()
        .filter(|number| number.is_finite() && *number > 0.0)
        .ok_or_else(|| command_error("limit must be a positive finite number."))?;
    Ok((number.floor() as usize).clamp(1, max_value))
}

pub(crate) fn resolve_tool_page(
    args: &Value,
    scope: &str,
    default_limit: usize,
    max_limit: usize,
) -> CommandResult<ToolPage> {
    let limit_value = args
        .get("limit")
        .filter(|value| !value.is_null())
        .or_else(|| args.get("max_results"));
    Ok(ToolPage {
        limit: resolve_limit(limit_value, default_limit, max_limit)?,
        offset: parse_tool_cursor(args.get("cursor"), scope)?,
    })
}

pub(crate) fn paginate_items<T: Clone>(
    items: &[T],
    args: &Value,
    scope: &str,
    default_limit: usize,
    max_limit: usize,
) -> CommandResult<PaginatedItems<T>> {
    let page = resolve_tool_page(args, scope, default_limit, max_limit)?;
    let start = page.offset.min(items.len());
    let available_end = start.saturating_add(page.limit).min(items.len());
    let page_items = items[start..available_end].to_vec();
    let truncated = available_end < items.len();
    Ok(PaginatedItems {
        items: page_items,
        limit: page.limit,
        offset: page.offset,
        truncated,
        next_cursor: truncated.then(|| create_tool_cursor(scope, available_end)),
    })
}

fn truncate_columns(value: &str, max_columns: usize) -> (String, bool) {
    let mut chars = value.chars();
    let prefix = chars.by_ref().take(max_columns).collect::<String>();
    if chars.next().is_none() {
        return (prefix, false);
    }
    let mut capped = prefix
        .chars()
        .take(max_columns.saturating_sub(1).max(1))
        .collect::<String>();
    capped.push('…');
    (capped, true)
}

pub(crate) fn paginate_read_content(
    content: &str,
    args: &Value,
    scope: &str,
) -> CommandResult<ReadContentPage> {
    let normalized = content.replace("\r\n", "\n").replace('\r', "\n");
    let all_lines = normalized.split('\n').collect::<Vec<_>>();
    let total_lines = all_lines.len();
    let has_cursor = args
        .get("cursor")
        .is_some_and(|cursor| !cursor.is_null() && cursor.as_str() != Some(""));
    if has_cursor && args.get("start_line").is_some() {
        return Err(command_error("cursor cannot be combined with start_line."));
    }

    let requested_start = args
        .get("start_line")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .map(|value| value.floor().max(1.0) as usize)
        .unwrap_or(1);
    let offset = if has_cursor {
        parse_tool_cursor(args.get("cursor"), scope)?
    } else {
        requested_start.saturating_sub(1)
    };
    if offset >= total_lines {
        return Err(command_error(format!(
            "read offset {} exceeds the file length of {} lines.",
            offset + 1,
            total_lines
        )));
    }

    let requested_end = args
        .get("end_line")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .map(|value| (value.floor() as usize).clamp(offset + 1, total_lines))
        .unwrap_or(total_lines);
    let max_lines = resolve_limit(
        args.get("max_lines"),
        READ_DEFAULT_MAX_LINES,
        READ_HARD_MAX_LINES,
    )?;
    let maximum_end = requested_end.min(offset.saturating_add(max_lines));
    let mut lines = Vec::new();
    let mut output_bytes = 0usize;
    let mut column_truncated_lines = 0usize;
    let mut next_offset = offset;

    while next_offset < maximum_end {
        let (line, column_truncated) = truncate_columns(all_lines[next_offset], READ_MAX_COLUMNS);
        let line_bytes = line.len() + usize::from(!lines.is_empty());
        if !lines.is_empty() && output_bytes.saturating_add(line_bytes) > READ_MAX_BYTES {
            break;
        }
        lines.push(line);
        output_bytes = output_bytes.saturating_add(line_bytes);
        column_truncated_lines += usize::from(column_truncated);
        next_offset += 1;
    }

    let truncated = next_offset < requested_end;
    let returned_lines = lines.len();
    Ok(ReadContentPage {
        lines,
        start_line: offset + 1,
        end_line: offset + returned_lines,
        total_lines,
        returned_lines,
        truncated,
        next_cursor: truncated.then(|| create_tool_cursor(scope, next_offset)),
        max_lines,
        max_bytes: READ_MAX_BYTES,
        column_truncated_lines,
    })
}

pub(crate) fn truncate_grep_line(line: &str) -> (String, bool) {
    truncate_columns(line, GREP_MAX_COLUMNS)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn cursor_is_deterministic_and_scope_bound() {
        let cursor = create_tool_cursor("glob\0src/**/*.ts", 200);
        assert_eq!(
            parse_tool_cursor(Some(&Value::String(cursor.clone())), "glob\0src/**/*.ts")
                .expect("valid cursor"),
            200
        );
        assert!(parse_tool_cursor(Some(&Value::String(cursor)), "glob\0tests/**/*.ts").is_err());
    }

    #[test]
    fn item_pages_are_hard_capped_and_resumable() {
        let page = paginate_items(
            &["a", "b", "c"],
            &json!({ "limit": 10_000 }),
            "list\0.",
            1,
            2,
        )
        .expect("page");
        assert_eq!(page.items, vec!["a", "b"]);
        assert_eq!(page.limit, 2);
        assert!(page.truncated);
        assert!(page.next_cursor.is_some());
    }

    #[test]
    fn read_pages_resume_and_report_wide_lines() {
        let content = format!("{}\nsecond\nthird", "x".repeat(READ_MAX_COLUMNS + 5));
        let first = paginate_read_content(&content, &json!({ "max_lines": 2 }), "read\0notes.txt")
            .expect("first page");
        assert_eq!(first.returned_lines, 2);
        assert_eq!(first.column_truncated_lines, 1);
        assert!(first.truncated);

        let second = paginate_read_content(
            &content,
            &json!({ "cursor": first.next_cursor, "max_lines": 2 }),
            "read\0notes.txt",
        )
        .expect("second page");
        assert_eq!(second.lines, vec!["third"]);
        assert_eq!(second.start_line, 3);
        assert!(!second.truncated);
    }

    #[test]
    fn read_rejects_a_non_string_cursor() {
        let error = paginate_read_content("one\ntwo", &json!({ "cursor": 12 }), "read\0notes.txt")
            .expect_err("numeric cursor must fail");
        assert!(error.message.contains("cursor must be a string"));
    }
}
