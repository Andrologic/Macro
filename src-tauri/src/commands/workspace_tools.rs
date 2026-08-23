use super::{
    apply_patch_hunks_to_content, build_post_write_response, command_error,
    commit_pending_file_changes_atomically, compute_line_change_stats, exact_edit_match_error,
    format_with_line_numbers, fs, join_text_lines, json_arg_bool, json_arg_string,
    json_arg_string_map, json_arg_u32, normalize_tool_map_path, parse_apply_patch,
    resolve_validated_tool_path, CommandError, CommandResult, ParsedPatchOperation,
    PendingFileChange,
};
use crate::core::tool_policy::validate_tool_execution;
use glob::Pattern;
use regex::RegexBuilder;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceProjectMount {
    #[serde(alias = "project_id")]
    pub project_id: String,
    #[serde(alias = "mount_name")]
    pub mount_name: String,
    #[serde(alias = "workspace_path")]
    pub workspace_path: Option<String>,
    #[serde(default, alias = "display_name")]
    pub display_name: Option<String>,
    #[serde(default, alias = "is_read_only")]
    pub is_read_only: bool,
}

#[derive(Clone, Copy)]
pub(crate) struct VirtualWorkspaceContext<'a> {
    pub mounts: &'a [WorkspaceProjectMount],
    pub focused_project_id: Option<&'a str>,
}

#[derive(Debug)]
pub(crate) struct ResolvedMountTarget<'a> {
    pub mount: &'a WorkspaceProjectMount,
    pub relative_path: String,
}

pub(crate) type PendingVirtualChange = PendingFileChange;
pub(crate) type VirtualToolResponse = Option<String>;

pub(crate) fn normalize_tool_path(value: &str) -> String {
    let mut normalized = value.trim().replace('\\', "/");
    while normalized.starts_with("./") {
        normalized = normalized[2..].to_string();
    }
    normalized.trim_matches('/').to_string()
}

pub(crate) fn virtual_path_for_mount(mount: &WorkspaceProjectMount, relative_path: &str) -> String {
    let relative = normalize_tool_path(relative_path);
    if relative.is_empty() || relative == "." {
        mount.mount_name.clone()
    } else {
        format!("{}/{}", mount.mount_name, relative)
    }
}

pub(crate) fn mount_workspace_path(mount: &WorkspaceProjectMount) -> CommandResult<PathBuf> {
    let raw = mount
        .workspace_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            command_error(format!(
                "Project {} has no workspace path.",
                mount.mount_name
            ))
        })?;
    Ok(PathBuf::from(raw))
}

fn canonicalize_headless_allowed_roots(
    allowed_roots: &[PathBuf],
) -> Result<Vec<PathBuf>, CommandError> {
    if allowed_roots.is_empty() {
        return Err(command_error(
            "Headless execution has no allowed filesystem roots.",
        ));
    }

    let mut canonical_roots = Vec::with_capacity(allowed_roots.len());
    for root in allowed_roots {
        let canonical_root = root.canonicalize().map_err(|error| {
            command_error(format!(
                "Headless allowed root is not accessible: {} ({})",
                root.display(),
                error
            ))
        })?;
        if !canonical_root.is_dir() {
            return Err(command_error(format!(
                "Headless allowed root is not a directory: {}",
                root.display()
            )));
        }
        if !canonical_roots.contains(&canonical_root) {
            canonical_roots.push(canonical_root);
        }
    }
    Ok(canonical_roots)
}

fn canonicalize_headless_path(
    path: &Path,
    allowed_roots: &[PathBuf],
    description: &str,
) -> Result<PathBuf, CommandError> {
    let canonical_roots = canonicalize_headless_allowed_roots(allowed_roots)?;
    let canonical_path = path.canonicalize().map_err(|error| {
        command_error(format!(
            "{} is not accessible: {} ({})",
            description,
            path.display(),
            error
        ))
    })?;
    if !canonical_path.is_dir() {
        return Err(command_error(format!(
            "{} must be a directory: {}",
            description,
            path.display()
        )));
    }
    if !canonical_roots
        .iter()
        .any(|root| canonical_path == *root || canonical_path.starts_with(root))
    {
        return Err(command_error(format!(
            "{} is outside the explicitly allowed headless roots: {}",
            description,
            path.display()
        )));
    }
    Ok(canonical_path)
}

fn validate_mount_identifier(value: &str, field: &str) -> Result<String, CommandError> {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed == "."
        || trimmed == ".."
        || trimmed.contains('/')
        || trimmed.contains('\\')
    {
        return Err(command_error(format!(
            "Headless mount {} must be a single non-empty path component.",
            field
        )));
    }
    Ok(trimmed.to_string())
}

/// Validate and canonicalize project mounts received by the headless API.
///
/// The desktop path is already operating on user-selected state. Headless
/// requests, however, can supply mounts over the network, so every mount must
/// resolve to an existing directory below an explicitly configured root.
pub fn validate_headless_project_mounts(
    mounts: &[WorkspaceProjectMount],
    allowed_roots: &[PathBuf],
) -> Result<Vec<WorkspaceProjectMount>, CommandError> {
    let _ = canonicalize_headless_allowed_roots(allowed_roots)?;
    let mut project_ids = HashSet::new();
    let mut mount_names = HashSet::new();
    let mut validated = Vec::with_capacity(mounts.len());

    for mount in mounts {
        let project_id = validate_mount_identifier(&mount.project_id, "project_id")?;
        let mount_name = validate_mount_identifier(&mount.mount_name, "mount_name")?;
        if !project_ids.insert(project_id.to_lowercase()) {
            return Err(command_error(format!(
                "Duplicate headless mount project_id: {}",
                project_id
            )));
        }
        if !mount_names.insert(mount_name.to_lowercase()) {
            return Err(command_error(format!(
                "Duplicate headless mount_name: {}",
                mount_name
            )));
        }

        let workspace_path = mount_workspace_path(mount)?;
        let canonical_workspace =
            canonicalize_headless_path(&workspace_path, allowed_roots, "Headless project mount")?;
        let mut sanitized = mount.clone();
        sanitized.project_id = project_id;
        sanitized.mount_name = mount_name;
        sanitized.workspace_path = Some(canonical_workspace.to_string_lossy().to_string());
        validated.push(sanitized);
    }

    Ok(validated)
}

/// Validate the optional workspace override used by a headless tool request.
/// Relative paths retain the same workspace-root semantics as the normal
/// workspace tool dispatcher.
pub fn validate_headless_workspace_path(
    raw_path: Option<&str>,
    workspace_root: &Path,
    allowed_roots: &[PathBuf],
) -> Result<Option<String>, CommandError> {
    let Some(raw_path) = raw_path.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let requested_path = PathBuf::from(raw_path);
    let candidate = if requested_path.is_absolute() {
        requested_path
    } else {
        workspace_root.join(requested_path)
    };
    let canonical =
        canonicalize_headless_path(&candidate, allowed_roots, "Headless workspace path")?;
    Ok(Some(canonical.to_string_lossy().to_string()))
}

fn project_mount_aliases(mount: &WorkspaceProjectMount) -> Vec<String> {
    let mut aliases = Vec::new();
    for value in [
        mount.mount_name.as_str(),
        mount.project_id.as_str(),
        mount.display_name.as_deref().unwrap_or_default(),
    ] {
        let normalized = normalize_tool_path(value).to_lowercase();
        if !normalized.is_empty() && !aliases.contains(&normalized) {
            aliases.push(normalized);
        }
    }
    if let Some(workspace_path) = mount.workspace_path.as_ref() {
        if let Some(tail) = Path::new(workspace_path)
            .file_name()
            .and_then(|value| value.to_str())
        {
            let normalized = normalize_tool_path(tail).to_lowercase();
            if !normalized.is_empty() && !aliases.contains(&normalized) {
                aliases.push(normalized);
            }
        }
    }
    aliases
}

fn mount_has_workspace(mount: &WorkspaceProjectMount) -> bool {
    mount
        .workspace_path
        .as_ref()
        .is_some_and(|value| !value.trim().is_empty())
}

fn single_mount_or_ambiguous<'a>(
    matches: Vec<&'a WorkspaceProjectMount>,
    description: &str,
) -> CommandResult<&'a WorkspaceProjectMount> {
    match matches.as_slice() {
        [] => Err(command_error(format!(
            "Unknown project_id: {}",
            description
        ))),
        [mount] => Ok(*mount),
        _ => Err(command_error(format!(
            "Ambiguous virtual-root project selector '{}'. Provide a unique project_id.",
            description
        ))),
    }
}

pub(crate) fn resolve_virtual_mount_target<'a>(
    context: VirtualWorkspaceContext<'a>,
    raw_path: &str,
    explicit_project_id: Option<&str>,
) -> CommandResult<ResolvedMountTarget<'a>> {
    if let Some(project_id) = explicit_project_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let project_id_lower = project_id.to_lowercase();
        let matches = context
            .mounts
            .iter()
            .filter(|mount| {
                mount.project_id == project_id
                    || project_mount_aliases(mount)
                        .iter()
                        .any(|alias| alias == &project_id_lower)
            })
            .collect::<Vec<_>>();
        let mount = single_mount_or_ambiguous(matches, project_id)?;
        return Ok(ResolvedMountTarget {
            mount,
            relative_path: normalize_tool_path(raw_path).if_empty(".").to_string(),
        });
    }

    let normalized_path = normalize_tool_path(raw_path);
    let normalized_path_lower = normalized_path.to_lowercase();
    if !normalized_path.is_empty() && normalized_path != "." {
        let mut matches = Vec::new();
        for mount in context.mounts {
            for alias in project_mount_aliases(mount) {
                if normalized_path_lower == alias {
                    matches.push((mount, ".".to_string()));
                    continue;
                }
                let alias_prefix = format!("{}/", alias);
                if normalized_path_lower.starts_with(&alias_prefix) {
                    let rest = normalized_path
                        .get(alias_prefix.len()..)
                        .unwrap_or_default()
                        .if_empty(".")
                        .to_string();
                    matches.push((mount, rest));
                }
            }
        }
        match matches.as_slice() {
            [] => {}
            [(mount, relative_path)] => {
                return Ok(ResolvedMountTarget {
                    mount,
                    relative_path: relative_path.clone(),
                })
            }
            _ => {
                return Err(command_error(format!(
                    "Ambiguous virtual-root path '{}'. Provide project_id or use a unique mount prefix.",
                    raw_path
                )))
            }
        }
    }

    if let Some(project_id) = context
        .focused_project_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if let Some(mount) = context
            .mounts
            .iter()
            .find(|mount| mount.project_id == project_id)
        {
            return Ok(ResolvedMountTarget {
                mount,
                relative_path: normalized_path.if_empty(".").to_string(),
            });
        }
    }

    let available_mounts = context
        .mounts
        .iter()
        .filter(|mount| mount_has_workspace(mount))
        .collect::<Vec<_>>();
    match available_mounts.as_slice() {
        [] => Err(command_error("No virtual-root project is available.")),
        [mount] => Ok(ResolvedMountTarget {
            mount,
            relative_path: normalized_path.if_empty(".").to_string(),
        }),
        _ => Err(command_error(format!(
            "Ambiguous virtual-root path '{}'. Provide project_id or a mount prefix.",
            raw_path
        ))),
    }
}

trait EmptyStringExt {
    fn if_empty<'a>(&'a self, fallback: &'a str) -> &'a str;
}

impl EmptyStringExt for str {
    fn if_empty<'a>(&'a self, fallback: &'a str) -> &'a str {
        if self.is_empty() {
            fallback
        } else {
            self
        }
    }
}

async fn execute_virtual_workspace_search_tool(
    tool_id: &str,
    args: &Value,
    mounts: &[WorkspaceProjectMount],
) -> CommandResult<String> {
    let include_hidden = json_arg_bool(args, "include_hidden").unwrap_or(false);
    let mut all_files = Vec::new();
    for mount in mounts {
        let Ok(workspace) = mount_workspace_path(mount) else {
            continue;
        };
        let entries = fs::list_dir_internal(
            &workspace,
            ".".to_string(),
            Some(true),
            Some(include_hidden),
            None,
            Some(true),
        )
        .await
        .map_err(|error| command_error(error.to_string()))?;
        for entry in entries.into_iter().filter(|entry| entry.kind == "file") {
            all_files.push((
                mount.clone(),
                workspace.clone(),
                entry.relative_path.replace('\\', "/"),
                entry.size,
            ));
        }
    }
    all_files.sort_by(|left, right| {
        virtual_path_for_mount(&left.0, &left.2).cmp(&virtual_path_for_mount(&right.0, &right.2))
    });
    let mount_scope = serde_json::json!(mounts
        .iter()
        .map(|mount| [
            mount.project_id.as_str(),
            mount.mount_name.as_str(),
            mount.workspace_path.as_deref().unwrap_or("")
        ])
        .collect::<Vec<_>>())
    .to_string();

    if tool_id == "glob" {
        let pattern = json_arg_string(args, "pattern").unwrap_or_else(|| "**/*".to_string());
        let compiled = Pattern::new(&pattern)
            .map_err(|error| command_error(format!("Invalid glob pattern: {}", error)))?;
        let mut paths = all_files
            .into_iter()
            .filter_map(|(mount, _, relative, _)| {
                let virtual_path = virtual_path_for_mount(&mount, &relative);
                (compiled.matches(&relative) || compiled.matches(&virtual_path))
                    .then_some(virtual_path)
            })
            .collect::<Vec<_>>();
        paths.sort();
        paths.dedup();
        let cursor_scope = format!("glob\0{mount_scope}\0{pattern}\0{include_hidden}");
        let total_count = paths.len();
        let page = super::tool_output::paginate_items(
            &paths,
            args,
            &cursor_scope,
            super::tool_output::GLOB_DEFAULT_LIMIT,
            super::tool_output::GLOB_MAX_LIMIT,
        )?;
        return serde_json::to_string_pretty(&serde_json::json!({
            "pattern": pattern,
            "virtual_root": true,
            "count": page.items.len(),
            "total_count": total_count,
            "paths": page.items,
            "limit": page.limit,
            "offset": page.offset,
            "truncated": page.truncated,
            "next_cursor": page.next_cursor
        }))
        .map_err(|error| command_error(error.to_string()));
    }

    let query = json_arg_string(args, "query")
        .filter(|query| !query.is_empty())
        .ok_or_else(|| command_error("Missing query argument for grep tool."))?;
    let is_regexp = json_arg_bool(args, "is_regexp").unwrap_or(false);
    let include_pattern = json_arg_string(args, "include_pattern");
    let include_glob = include_pattern
        .as_ref()
        .map(|glob| Pattern::new(glob))
        .transpose()
        .map_err(|error| command_error(format!("Invalid include_pattern glob: {}", error)))?;
    let regex = if is_regexp {
        Some(
            RegexBuilder::new(&query)
                .case_insensitive(true)
                .build()
                .map_err(|error| {
                    command_error(format!("Invalid regex pattern for grep: {}", error))
                })?,
        )
    } else {
        None
    };
    let query_lower = query.to_lowercase();
    let cursor_scope = format!(
        "grep\0{mount_scope}\0{query}\0{is_regexp}\0{}\0{include_hidden}",
        include_pattern.as_deref().unwrap_or("")
    );
    let page = super::tool_output::resolve_tool_page(
        args,
        &cursor_scope,
        super::tool_output::GREP_DEFAULT_LIMIT,
        super::tool_output::GREP_MAX_LIMIT,
    )?;
    let mut results = Vec::new();
    let mut seen_matches = 0usize;
    let mut files_scanned = 0usize;
    let mut skipped_binary = 0usize;
    let mut skipped_too_large = 0usize;
    let mut column_truncated_matches = 0usize;
    for (mount, workspace, relative, size) in all_files {
        let virtual_path = virtual_path_for_mount(&mount, &relative);
        if let Some(pattern) = include_glob.as_ref() {
            if !pattern.matches(&relative) && !pattern.matches(&virtual_path) {
                continue;
            }
        }
        if size.unwrap_or(0) > super::tool_output::GREP_MAX_FILE_BYTES {
            skipped_too_large += 1;
            continue;
        }
        let content = fs::read_file_internal(&workspace, relative, Some(true))
            .await
            .map_err(|error| command_error(error.to_string()))?;
        if content.size > super::tool_output::GREP_MAX_FILE_BYTES {
            skipped_too_large += 1;
            continue;
        }
        if content.is_binary {
            skipped_binary += 1;
            continue;
        }
        files_scanned += 1;
        for (index, line) in content.content.lines().enumerate() {
            let is_match = if let Some(compiled) = regex.as_ref() {
                compiled.is_match(line)
            } else {
                line.to_lowercase().contains(&query_lower)
            };
            if is_match {
                if seen_matches < page.offset {
                    seen_matches += 1;
                    continue;
                }
                seen_matches += 1;
                let (text, was_truncated) = super::tool_output::truncate_grep_line(line.trim());
                results.push(serde_json::json!({
                    "path": virtual_path,
                    "line": index + 1,
                    "text": text,
                    "text_truncated": was_truncated,
                    "project_id": mount.project_id,
                    "mount_name": mount.mount_name,
                }));
                if was_truncated && results.len() <= page.limit {
                    column_truncated_matches += 1;
                }
                if results.len() > page.limit {
                    break;
                }
            }
        }
        if results.len() > page.limit {
            break;
        }
    }
    let truncated = results.len() > page.limit;
    if truncated {
        results.truncate(page.limit);
    }
    let next_cursor = truncated.then(|| {
        super::tool_output::create_tool_cursor(&cursor_scope, page.offset + results.len())
    });
    serde_json::to_string_pretty(&serde_json::json!({
        "query": query,
        "total": results.len(),
        "count": results.len(),
        "total_count": (!truncated).then_some(page.offset + results.len()),
        "total_is_exact": !truncated,
        "results": results,
        "limit": page.limit,
        "offset": page.offset,
        "truncated": truncated,
        "next_cursor": next_cursor,
        "files_scanned": files_scanned,
        "scan_complete": !truncated,
        "skipped_files": {
            "binary": skipped_binary,
            "too_large": skipped_too_large,
            "max_file_bytes": super::tool_output::GREP_MAX_FILE_BYTES,
            "is_exact": !truncated
        },
        "column_truncated_matches": column_truncated_matches,
        "max_columns": super::tool_output::GREP_MAX_COLUMNS
    }))
    .map_err(|error| command_error(error.to_string()))
}

async fn execute_virtual_ast_search(
    args: &Value,
    context: VirtualWorkspaceContext<'_>,
) -> CommandResult<String> {
    let raw_path = json_arg_string(args, "path").unwrap_or_else(|| ".".to_string());
    let explicit_project_id = json_arg_string(args, "project_id");
    let normalized_path = normalize_tool_path(&raw_path);
    let include_hidden = json_arg_bool(args, "include_hidden").unwrap_or(false);
    let mut targets = Vec::<(&WorkspaceProjectMount, String)>::new();

    if explicit_project_id.is_none() && (normalized_path.is_empty() || normalized_path == ".") {
        targets.extend(
            context
                .mounts
                .iter()
                .filter(|mount| mount_has_workspace(mount))
                .map(|mount| (mount, ".".to_string())),
        );
    } else {
        let resolved =
            resolve_virtual_mount_target(context, &raw_path, explicit_project_id.as_deref())?;
        targets.push((resolved.mount, resolved.relative_path));
    }

    let mut candidates = Vec::new();
    for (mount, base_path) in targets {
        let workspace = mount_workspace_path(mount)?;
        let stats = fs::stat_internal(&workspace, base_path.clone())
            .await
            .map_err(|error| command_error(error.to_string()))?;
        if stats.kind == "file" {
            candidates.push(super::ast_search::AstSearchCandidate {
                workspace,
                read_path: base_path.clone(),
                display_path: virtual_path_for_mount(mount, &base_path),
                size: Some(stats.size),
                project_id: Some(mount.project_id.clone()),
                mount_name: Some(mount.mount_name.clone()),
            });
            continue;
        }
        if stats.kind != "directory" {
            return Err(command_error(format!(
                "ast_grep path must be a file or directory: {}",
                raw_path
            )));
        }
        let entries = fs::list_dir_internal(
            &workspace,
            base_path.clone(),
            Some(true),
            Some(include_hidden),
            None,
            Some(true),
        )
        .await
        .map_err(|error| command_error(error.to_string()))?;
        for entry in entries.into_iter().filter(|entry| entry.kind == "file") {
            let relative = entry.relative_path.replace('\\', "/");
            let read_path = if base_path.is_empty() || base_path == "." {
                relative
            } else {
                format!(
                    "{}/{}",
                    base_path.trim_end_matches(['/', '\\']),
                    relative.trim_start_matches(['/', '\\'])
                )
            };
            candidates.push(super::ast_search::AstSearchCandidate {
                workspace: workspace.clone(),
                display_path: virtual_path_for_mount(mount, &read_path),
                read_path,
                size: entry.size,
                project_id: Some(mount.project_id.clone()),
                mount_name: Some(mount.mount_name.clone()),
            });
        }
    }

    let mount_scope = serde_json::json!(context
        .mounts
        .iter()
        .map(|mount| [
            mount.project_id.as_str(),
            mount.mount_name.as_str(),
            mount.workspace_path.as_deref().unwrap_or("")
        ])
        .collect::<Vec<_>>())
    .to_string();
    let cursor_scope = format!(
        "ast_grep\0{}\0{}\0{}\0{}\0{}\0{}\0{}\0{}",
        mount_scope,
        raw_path,
        explicit_project_id.as_deref().unwrap_or(""),
        json_arg_string(args, "pattern").unwrap_or_default(),
        json_arg_string(args, "language").unwrap_or_default(),
        json_arg_string(args, "strictness").unwrap_or_else(|| "smart".to_string()),
        json_arg_string(args, "include_pattern").unwrap_or_default(),
        include_hidden
    );
    super::ast_search::execute_ast_search(args, candidates, &cursor_scope, true).await
}

pub(crate) async fn execute_virtual_workspace_tool(
    mode: &str,
    tool_id: &str,
    args: &Value,
    mounts: &[WorkspaceProjectMount],
    focused_project_id: Option<&str>,
) -> CommandResult<VirtualToolResponse> {
    if mounts.is_empty() {
        return Ok(None);
    }
    let virtual_context = VirtualWorkspaceContext {
        mounts,
        focused_project_id,
    };

    match tool_id {
        "list" => {
            let raw_path = json_arg_string(args, "path").unwrap_or_else(|| ".".to_string());
            let explicit_project_id = json_arg_string(args, "project_id");
            let normalized_path = normalize_tool_path(&raw_path);
            if explicit_project_id.is_none()
                && (normalized_path.is_empty() || normalized_path == ".")
            {
                let mut entries = mounts
                    .iter()
                    .map(|mount| {
                        serde_json::json!({
                            "path": mount.mount_name,
                            "relative_path": mount.mount_name,
                            "name": mount.mount_name,
                            "kind": "directory",
                            "is_hidden": false,
                            "is_readonly": mount.is_read_only,
                        })
                    })
                    .collect::<Vec<_>>();
                entries.sort_by(|left, right| {
                    left.get("relative_path")
                        .and_then(Value::as_str)
                        .cmp(&right.get("relative_path").and_then(Value::as_str))
                });
                let mount_scope = serde_json::json!(mounts
                    .iter()
                    .map(|mount| [mount.project_id.as_str(), mount.mount_name.as_str()])
                    .collect::<Vec<_>>())
                .to_string();
                let cursor_scope = format!("list\0virtual-root\0{mount_scope}");
                let total_count = entries.len();
                let page = super::tool_output::paginate_items(
                    &entries,
                    args,
                    &cursor_scope,
                    super::tool_output::LIST_DEFAULT_LIMIT,
                    super::tool_output::LIST_MAX_LIMIT,
                )?;
                return serde_json::to_string_pretty(&serde_json::json!({
                    "path": ".",
                    "virtual_root": true,
                    "count": page.items.len(),
                    "total_count": total_count,
                    "entries": page.items,
                    "limit": page.limit,
                    "offset": page.offset,
                    "truncated": page.truncated,
                    "next_cursor": page.next_cursor
                }))
                .map(Some)
                .map_err(|error| command_error(error.to_string()));
            }

            let resolved = resolve_virtual_mount_target(
                virtual_context,
                &raw_path,
                explicit_project_id.as_deref(),
            )?;
            let mount = resolved.mount;
            let relative_path = resolved.relative_path;
            let workspace = mount_workspace_path(mount)?;
            let recursive = json_arg_bool(args, "recursive");
            let include_hidden = json_arg_bool(args, "include_hidden");
            let max_depth = json_arg_u32(args, "max_depth");
            let mut entries = fs::list_dir_internal(
                &workspace,
                relative_path.clone(),
                recursive,
                include_hidden,
                max_depth,
                Some(true),
            )
            .await
            .map_err(|error| command_error(error.to_string()))?
            .into_iter()
            .map(|mut entry| {
                entry.path = virtual_path_for_mount(mount, &entry.relative_path);
                entry.relative_path = entry.path.clone();
                entry
            })
            .collect::<Vec<_>>();

            entries.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
            let cursor_scope = format!(
                "list\0{}\0{}\0{}\0{}\0{}",
                workspace.to_string_lossy(),
                relative_path,
                recursive.unwrap_or(false),
                include_hidden.unwrap_or(false),
                max_depth.map_or_else(String::new, |value| value.to_string())
            );
            let total_count = entries.len();
            let page = super::tool_output::paginate_items(
                &entries,
                args,
                &cursor_scope,
                super::tool_output::LIST_DEFAULT_LIMIT,
                super::tool_output::LIST_MAX_LIMIT,
            )?;

            serde_json::to_string_pretty(&serde_json::json!({
                "path": virtual_path_for_mount(mount, &relative_path),
                "project_id": mount.project_id,
                "mount_name": mount.mount_name,
                "count": page.items.len(),
                "total_count": total_count,
                "entries": page.items,
                "limit": page.limit,
                "offset": page.offset,
                "truncated": page.truncated,
                "next_cursor": page.next_cursor
            }))
            .map(Some)
            .map_err(|error| command_error(error.to_string()))
        }
        "read" => {
            let raw_path = json_arg_string(args, "path")
                .ok_or_else(|| command_error("Missing path argument for read tool."))?;
            let explicit_project_id = json_arg_string(args, "project_id");
            let resolved = resolve_virtual_mount_target(
                virtual_context,
                &raw_path,
                explicit_project_id.as_deref(),
            )?;
            let mount = resolved.mount;
            let relative_path = resolved.relative_path;
            let workspace = mount_workspace_path(mount)?;
            let result = fs::read_file_internal(&workspace, relative_path.clone(), Some(true))
                .await
                .map_err(|error| command_error(error.to_string()))?;
            let virtual_path = virtual_path_for_mount(mount, &relative_path);
            if result.is_binary {
                return Ok(Some(format!(
                    "FILE: {}\nSOURCE: WORKSPACE_FILE\nPROJECT_ID: {}\nMOUNT: {}\nBINARY: true\nSIZE: {}\nENCODING: {}\nREVISION: {}\nCONTENT_OMITTED: binary",
                    virtual_path,
                    mount.project_id,
                    mount.mount_name,
                    result.size,
                    result.encoding,
                    result.revision
                )));
            }

            let end_line_scope =
                json_arg_u32(args, "end_line").map_or_else(String::new, |value| value.to_string());
            let cursor_scope = format!(
                "read\0{}\0{}\0{}\0{}",
                workspace.to_string_lossy(),
                relative_path,
                result.revision,
                end_line_scope
            );
            let page =
                super::tool_output::paginate_read_content(&result.content, args, &cursor_scope)?;
            let selected = page.lines.iter().map(String::as_str).collect::<Vec<_>>();
            let numbered = format_with_line_numbers(&selected, page.start_line);
            Ok(Some(format!(
                "FILE: {}\nSOURCE: WORKSPACE_FILE\nPROJECT_ID: {}\nMOUNT: {}\nLANGUAGE: {}\nSIZE: {}\nREVISION: {}\nLINES: {}-{}\nTOTAL_LINES: {}\nRETURNED_LINES: {}\nTRUNCATED: {}\nNEXT_CURSOR: {}\nLIMITS: max_lines={}, max_bytes={}, max_columns={}\nCOLUMN_TRUNCATED_LINES: {}\n\n---BEGIN FILE CONTENT---\n{}\n---END FILE CONTENT---",
                virtual_path,
                mount.project_id,
                mount.mount_name,
                result.language,
                result.size,
                result.revision,
                page.start_line,
                page.end_line,
                page.total_lines,
                page.returned_lines,
                page.truncated,
                page.next_cursor.as_deref().unwrap_or("none"),
                page.max_lines,
                page.max_bytes,
                super::tool_output::READ_MAX_COLUMNS,
                page.column_truncated_lines,
                numbered
            )))
        }
        "glob" | "grep" => execute_virtual_workspace_search_tool(tool_id, args, mounts)
            .await
            .map(Some),
        "ast_grep" => execute_virtual_ast_search(args, virtual_context)
            .await
            .map(Some),
        "write" => {
            let raw_path = json_arg_string(args, "path")
                .ok_or_else(|| command_error("Missing path argument for write tool."))?;
            let explicit_project_id = json_arg_string(args, "project_id");
            let resolved = resolve_virtual_mount_target(
                virtual_context,
                &raw_path,
                explicit_project_id.as_deref(),
            )?;
            let mount = resolved.mount;
            let relative_path = resolved.relative_path;
            if mount.is_read_only {
                return Ok(Some(format!(
                    "Cannot write to read-only project mount {}.",
                    mount.mount_name
                )));
            }
            let content = json_arg_string(args, "content")
                .ok_or_else(|| command_error("Missing content argument for write tool."))?;
            let create_dirs = json_arg_bool(args, "create_dirs");
            let expected_revision = json_arg_string(args, "expected_revision");
            let workspace = mount_workspace_path(mount)?;
            let absolute_path =
                resolve_validated_tool_path(&workspace, relative_path.as_str(), true)?;
            let write_result = fs::write_file_internal_with_revision(
                &workspace,
                relative_path.clone(),
                content.clone(),
                create_dirs,
                Some(true),
                expected_revision.as_deref(),
            )
            .await
            .map_err(|error| command_error(error.to_string()))?;
            let display_path = virtual_path_for_mount(mount, &relative_path);
            let change: PendingVirtualChange = PendingFileChange {
                display_path: display_path.clone(),
                effective_workspace: workspace,
                effective_path: relative_path,
                absolute_path,
                status: if write_result.created {
                    "created".to_string()
                } else {
                    "updated".to_string()
                },
                new_content: Some(content.clone()),
                created: write_result.created,
                bytes_written: write_result.bytes_written,
                additions: content.lines().count(),
                deletions: 0,
                expected_revision,
            };
            build_post_write_response(
                &[change],
                serde_json::Map::from_iter([
                    ("path".to_string(), Value::String(display_path)),
                    (
                        "bytes_written".to_string(),
                        Value::Number(serde_json::Number::from(write_result.bytes_written)),
                    ),
                    ("created".to_string(), Value::Bool(write_result.created)),
                    (
                        "project_id".to_string(),
                        Value::String(mount.project_id.clone()),
                    ),
                ]),
            )
            .await
            .map(Some)
        }
        "edit" => {
            let raw_path = json_arg_string(args, "path")
                .ok_or_else(|| command_error("Missing path argument for edit tool."))?;
            let explicit_project_id = json_arg_string(args, "project_id");
            let resolved = resolve_virtual_mount_target(
                virtual_context,
                &raw_path,
                explicit_project_id.as_deref(),
            )?;
            let mount = resolved.mount;
            let relative_path = resolved.relative_path;
            if mount.is_read_only {
                return Ok(Some(format!(
                    "Cannot edit read-only project mount {}.",
                    mount.mount_name
                )));
            }
            let old_text = json_arg_string(args, "old_text")
                .ok_or_else(|| command_error("Missing old_text argument for edit tool."))?;
            let new_text = json_arg_string(args, "new_text")
                .ok_or_else(|| command_error("Missing new_text argument for edit tool."))?;
            let replace_all = json_arg_bool(args, "replace_all").unwrap_or(false);
            let expected_revision = json_arg_string(args, "expected_revision");
            let workspace = mount_workspace_path(mount)?;
            let current = fs::read_file_internal(&workspace, relative_path.clone(), Some(true))
                .await
                .map_err(|error| command_error(error.to_string()))?;
            let display_path = virtual_path_for_mount(mount, &relative_path);
            if current.is_binary {
                return Ok(Some(format!("Cannot edit binary file: {}", display_path)));
            }
            fs::validate_expected_revision(
                &display_path,
                expected_revision.as_deref(),
                Some(&current.revision),
            )
            .map_err(|error| command_error(error.to_string()))?;
            let occurrences = current.content.matches(&old_text).count();
            if let Some(error) = exact_edit_match_error(&display_path, occurrences, replace_all) {
                return Ok(Some(error));
            }
            let updated = if replace_all {
                current.content.replace(&old_text, &new_text)
            } else {
                current.content.replacen(&old_text, &new_text, 1)
            };
            let absolute_path =
                resolve_validated_tool_path(&workspace, relative_path.as_str(), true)?;
            let write_result = fs::write_file_internal_with_revision(
                &workspace,
                relative_path.clone(),
                updated.clone(),
                Some(true),
                Some(true),
                expected_revision.as_deref(),
            )
            .await
            .map_err(|error| command_error(error.to_string()))?;
            let (additions, deletions) = compute_line_change_stats(&current.content, &updated);
            let change: PendingVirtualChange = PendingFileChange {
                display_path: display_path.clone(),
                effective_workspace: workspace,
                effective_path: relative_path,
                absolute_path,
                status: if write_result.created {
                    "created".to_string()
                } else {
                    "updated".to_string()
                },
                new_content: Some(updated),
                created: write_result.created,
                bytes_written: write_result.bytes_written,
                additions,
                deletions,
                expected_revision,
            };
            build_post_write_response(
                &[change],
                serde_json::Map::from_iter([
                    (
                        "replacements".to_string(),
                        Value::Number(serde_json::Number::from(if replace_all {
                            occurrences as u64
                        } else {
                            1
                        })),
                    ),
                    ("path".to_string(), Value::String(display_path)),
                    (
                        "bytes_written".to_string(),
                        Value::Number(serde_json::Number::from(write_result.bytes_written)),
                    ),
                    ("created".to_string(), Value::Bool(write_result.created)),
                    (
                        "project_id".to_string(),
                        Value::String(mount.project_id.clone()),
                    ),
                ]),
            )
            .await
            .map(Some)
        }
        "delete" => {
            let raw_path = json_arg_string(args, "path")
                .ok_or_else(|| command_error("Missing path argument for delete tool."))?;
            let explicit_project_id = json_arg_string(args, "project_id");
            let resolved = resolve_virtual_mount_target(
                virtual_context,
                &raw_path,
                explicit_project_id.as_deref(),
            )?;
            let mount = resolved.mount;
            let relative_path = resolved.relative_path;
            let expected_revision = json_arg_string(args, "expected_revision");
            if mount.is_read_only {
                return Ok(Some(format!(
                    "Cannot delete from read-only project mount {}.",
                    mount.mount_name
                )));
            }
            let workspace = mount_workspace_path(mount)?;
            let absolute_path =
                resolve_validated_tool_path(&workspace, relative_path.as_str(), false)?;
            let display_path = virtual_path_for_mount(mount, &relative_path);
            let metadata = fs::stat_internal(&workspace, relative_path.clone())
                .await
                .map_err(|error| {
                    command_error(format!(
                        "Failed to inspect {} before delete: {}",
                        display_path, error
                    ))
                })?;
            if metadata.kind == "directory" {
                return Ok(Some(format!(
                    "Cannot delete directory with delete tool: {}. Only files are supported.",
                    display_path
                )));
            }
            let current = fs::read_file_internal(&workspace, relative_path.clone(), Some(true))
                .await
                .map_err(|error| command_error(error.to_string()))?;
            let deletions = if current.is_binary {
                0
            } else {
                current.content.lines().count()
            };
            fs::validate_expected_revision(
                &display_path,
                expected_revision.as_deref(),
                Some(&current.revision),
            )
            .map_err(|error| command_error(error.to_string()))?;
            fs::delete_path_internal_with_revision(
                &workspace,
                relative_path.clone(),
                Some(false),
                expected_revision.as_deref(),
            )
            .await
            .map_err(|error| {
                command_error(format!("Failed to delete {}: {}", display_path, error))
            })?;
            let change: PendingVirtualChange = PendingFileChange {
                display_path: display_path.clone(),
                effective_workspace: workspace,
                effective_path: relative_path,
                absolute_path,
                status: "deleted".to_string(),
                new_content: None,
                created: false,
                bytes_written: 0,
                additions: 0,
                deletions,
                expected_revision,
            };
            build_post_write_response(
                &[change],
                serde_json::Map::from_iter([
                    ("path".to_string(), Value::String(display_path)),
                    (
                        "project_id".to_string(),
                        Value::String(mount.project_id.clone()),
                    ),
                ]),
            )
            .await
            .map(Some)
        }
        "apply_patch" => {
            let patch_text = json_arg_string(args, "patch_text").ok_or_else(|| {
                command_error("Missing patch_text argument for apply_patch tool.")
            })?;
            let explicit_project_id = json_arg_string(args, "project_id");
            let expected_revisions = json_arg_string_map(args, "expected_revisions");
            let operations = parse_apply_patch(&patch_text)?;
            let mut pending_changes: Vec<PendingVirtualChange> = Vec::new();

            for operation in operations.iter() {
                let operation_path = match operation {
                    ParsedPatchOperation::Add { path, .. }
                    | ParsedPatchOperation::Update { path, .. }
                    | ParsedPatchOperation::Delete { path } => path,
                };
                let validation =
                    validate_tool_execution(mode, tool_id, Some(operation_path.as_str()));
                if !validation.allowed {
                    return Ok(Some(validation.reason.unwrap_or_else(|| {
                        format!(
                            "Tool {} is not allowed for path {}",
                            tool_id, operation_path
                        )
                    })));
                }
            }

            for operation in operations {
                match operation {
                    ParsedPatchOperation::Add { path, lines } => {
                        let expected_revision = expected_revisions
                            .get(&normalize_tool_map_path(&path))
                            .cloned()
                            .or_else(|| Some(fs::EXPECTED_REVISION_ABSENT.to_string()));
                        let resolved = resolve_virtual_mount_target(
                            virtual_context,
                            &path,
                            explicit_project_id.as_deref(),
                        )?;
                        let mount = resolved.mount;
                        let relative_path = resolved.relative_path;
                        if mount.is_read_only {
                            return Ok(Some(format!(
                                "Cannot apply patch to read-only project mount {}.",
                                mount.mount_name
                            )));
                        }
                        let workspace = mount_workspace_path(mount)?;
                        let absolute_path =
                            resolve_validated_tool_path(&workspace, relative_path.as_str(), true)?;
                        let display_path = virtual_path_for_mount(mount, &relative_path);
                        if fs::exists_internal(&workspace, relative_path.clone())
                            .await
                            .map_err(|error| {
                                command_error(format!(
                                    "Failed to inspect {} before apply_patch: {}",
                                    display_path, error
                                ))
                            })?
                        {
                            return Ok(Some(format!(
                                "Cannot add file {} because it already exists.",
                                display_path
                            )));
                        }
                        let new_content = join_text_lines(&lines, true);
                        pending_changes.push(PendingFileChange {
                            display_path,
                            effective_workspace: workspace,
                            effective_path: relative_path,
                            absolute_path,
                            status: "created".to_string(),
                            new_content: Some(new_content.clone()),
                            created: true,
                            bytes_written: new_content.len() as u64,
                            additions: new_content.lines().count(),
                            deletions: 0,
                            expected_revision,
                        });
                    }
                    ParsedPatchOperation::Update { path, hunks } => {
                        let expected_revision = expected_revisions
                            .get(&normalize_tool_map_path(&path))
                            .cloned();
                        let resolved = resolve_virtual_mount_target(
                            virtual_context,
                            &path,
                            explicit_project_id.as_deref(),
                        )?;
                        let mount = resolved.mount;
                        let relative_path = resolved.relative_path;
                        if mount.is_read_only {
                            return Ok(Some(format!(
                                "Cannot apply patch to read-only project mount {}.",
                                mount.mount_name
                            )));
                        }
                        let workspace = mount_workspace_path(mount)?;
                        let display_path = virtual_path_for_mount(mount, &relative_path);
                        let current =
                            fs::read_file_internal(&workspace, relative_path.clone(), Some(true))
                                .await
                                .map_err(|error| command_error(error.to_string()))?;
                        if current.is_binary {
                            return Ok(Some(format!(
                                "Cannot apply patch to binary file: {}",
                                display_path
                            )));
                        }
                        let absolute_path =
                            resolve_validated_tool_path(&workspace, relative_path.as_str(), true)?;
                        let new_content = apply_patch_hunks_to_content(
                            display_path.as_str(),
                            &current.content,
                            &hunks,
                        )?;
                        let (additions, deletions) =
                            compute_line_change_stats(&current.content, &new_content);
                        pending_changes.push(PendingFileChange {
                            display_path,
                            effective_workspace: workspace,
                            effective_path: relative_path,
                            absolute_path,
                            status: "updated".to_string(),
                            new_content: Some(new_content.clone()),
                            created: false,
                            bytes_written: new_content.len() as u64,
                            additions,
                            deletions,
                            expected_revision,
                        });
                    }
                    ParsedPatchOperation::Delete { path } => {
                        let expected_revision = expected_revisions
                            .get(&normalize_tool_map_path(&path))
                            .cloned();
                        let resolved = resolve_virtual_mount_target(
                            virtual_context,
                            &path,
                            explicit_project_id.as_deref(),
                        )?;
                        let mount = resolved.mount;
                        let relative_path = resolved.relative_path;
                        if mount.is_read_only {
                            return Ok(Some(format!(
                                "Cannot apply patch to read-only project mount {}.",
                                mount.mount_name
                            )));
                        }
                        let workspace = mount_workspace_path(mount)?;
                        let absolute_path =
                            resolve_validated_tool_path(&workspace, relative_path.as_str(), false)?;
                        let display_path = virtual_path_for_mount(mount, &relative_path);
                        let current =
                            fs::read_file_internal(&workspace, relative_path.clone(), Some(true))
                                .await
                                .map_err(|error| command_error(error.to_string()))?;
                        let deletion_count = if current.is_binary {
                            0
                        } else {
                            current.content.lines().count()
                        };
                        pending_changes.push(PendingFileChange {
                            display_path,
                            effective_workspace: workspace,
                            effective_path: relative_path,
                            absolute_path,
                            status: "deleted".to_string(),
                            new_content: None,
                            created: false,
                            bytes_written: 0,
                            additions: 0,
                            deletions: deletion_count,
                            expected_revision,
                        });
                    }
                }
            }

            commit_pending_file_changes_atomically(&pending_changes).await?;

            build_post_write_response(
                &pending_changes,
                serde_json::Map::from_iter([(
                    "applied_operations".to_string(),
                    Value::Number(serde_json::Number::from(pending_changes.len() as u64)),
                )]),
            )
            .await
            .map(Some)
        }
        _ => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        execute_virtual_workspace_tool, resolve_virtual_mount_target,
        validate_headless_project_mounts, validate_headless_workspace_path, ResolvedMountTarget,
        VirtualWorkspaceContext, WorkspaceProjectMount,
    };
    use serde_json::json;
    use std::fs;
    use tempfile::TempDir;

    fn mount(
        project_id: &str,
        mount_name: &str,
        display_name: Option<&str>,
    ) -> WorkspaceProjectMount {
        WorkspaceProjectMount {
            project_id: project_id.to_string(),
            mount_name: mount_name.to_string(),
            workspace_path: Some(format!("/tmp/{}", project_id)),
            display_name: display_name.map(str::to_string),
            is_read_only: false,
        }
    }

    fn resolve<'a>(
        mounts: &'a [WorkspaceProjectMount],
        raw_path: &str,
        project_id: Option<&str>,
        focused_project_id: Option<&'a str>,
    ) -> Result<ResolvedMountTarget<'a>, String> {
        resolve_virtual_mount_target(
            VirtualWorkspaceContext {
                mounts,
                focused_project_id,
            },
            raw_path,
            project_id,
        )
        .map_err(|error| error.message)
    }

    #[test]
    fn resolve_virtual_mount_requires_selector_when_path_is_ambiguous() {
        let mounts = vec![mount("web", "web", None), mount("api", "api", None)];

        let error = resolve(&mounts, "src/main.rs", None, None).expect_err("ambiguous path");

        assert!(error.contains("Ambiguous virtual-root path"));
        assert!(error.contains("project_id"));
    }

    #[test]
    fn resolve_virtual_mount_detects_ambiguous_aliases() {
        let mounts = vec![
            mount("frontend", "web", Some("app")),
            mount("backend", "api", Some("app")),
        ];

        let error = resolve(&mounts, "app/src/index.ts", None, None).expect_err("ambiguous alias");

        assert!(error.contains("Ambiguous virtual-root path"));
    }

    #[test]
    fn resolve_virtual_mount_uses_focused_project_when_available() {
        let mounts = vec![mount("web", "web", None), mount("api", "api", None)];

        let resolved = resolve(&mounts, "src/main.rs", None, Some("api")).expect("focused project");

        assert_eq!(resolved.mount.project_id, "api");
        assert_eq!(resolved.relative_path, "src/main.rs");
    }

    #[test]
    fn validate_headless_mounts_canonicalizes_paths_below_allowed_root() {
        let allowed = TempDir::new().expect("allowed root");
        let project = allowed.path().join("project");
        fs::create_dir(&project).expect("project directory");
        let mounts = vec![WorkspaceProjectMount {
            project_id: "project-1".to_string(),
            mount_name: "project".to_string(),
            workspace_path: Some(project.to_string_lossy().to_string()),
            display_name: Some("Project".to_string()),
            is_read_only: false,
        }];

        let validated = validate_headless_project_mounts(&mounts, &[allowed.path().to_path_buf()])
            .expect("mount below allowed root");

        assert_eq!(
            validated[0].workspace_path.as_deref(),
            Some(
                project
                    .canonicalize()
                    .expect("canonical project path")
                    .to_string_lossy()
                    .as_ref()
            )
        );
    }

    #[cfg(unix)]
    #[test]
    fn validate_headless_mounts_rejects_symlink_outside_allowed_root() {
        use std::os::unix::fs::symlink;

        let allowed = TempDir::new().expect("allowed root");
        let outside = TempDir::new().expect("outside root");
        let link = allowed.path().join("linked-project");
        symlink(outside.path(), &link).expect("project symlink");
        let mounts = vec![WorkspaceProjectMount {
            project_id: "project-1".to_string(),
            mount_name: "project".to_string(),
            workspace_path: Some(link.to_string_lossy().to_string()),
            display_name: None,
            is_read_only: false,
        }];

        let error = validate_headless_project_mounts(&mounts, &[allowed.path().to_path_buf()])
            .expect_err("external mount must be rejected");

        assert!(error.message.contains("outside the explicitly allowed"));
    }

    #[test]
    fn validate_headless_workspace_path_keeps_relative_paths_inside_root() {
        let allowed = TempDir::new().expect("allowed root");
        let project = allowed.path().join("project");
        fs::create_dir(&project).expect("project directory");

        let validated = validate_headless_workspace_path(
            Some("project"),
            allowed.path(),
            &[allowed.path().to_path_buf()],
        )
        .expect("workspace path")
        .expect("workspace path present");

        assert_eq!(
            validated,
            project
                .canonicalize()
                .expect("canonical project path")
                .to_string_lossy()
        );
    }

    #[tokio::test]
    async fn virtual_glob_respects_max_results() {
        let temp = TempDir::new().expect("temp dir");
        fs::write(temp.path().join("a.rs"), "").expect("write a");
        fs::write(temp.path().join("b.rs"), "").expect("write b");
        fs::write(temp.path().join("c.rs"), "").expect("write c");
        let mounts = vec![WorkspaceProjectMount {
            project_id: "api".to_string(),
            mount_name: "api".to_string(),
            workspace_path: Some(temp.path().to_string_lossy().to_string()),
            display_name: None,
            is_read_only: false,
        }];

        let result = execute_virtual_workspace_tool(
            "Implement",
            "glob",
            &json!({ "pattern": "**/*.rs", "max_results": 2 }),
            &mounts,
            None,
        )
        .await
        .expect("glob")
        .expect("handled by virtual root");
        let parsed: serde_json::Value = serde_json::from_str(&result).expect("json response");

        assert_eq!(
            parsed.get("count").and_then(serde_json::Value::as_u64),
            Some(2)
        );
        assert_eq!(
            parsed
                .get("paths")
                .and_then(serde_json::Value::as_array)
                .map(Vec::len),
            Some(2)
        );
    }

    #[tokio::test]
    async fn virtual_ast_grep_searches_all_project_mounts() {
        let api = TempDir::new().expect("api workspace");
        let web = TempDir::new().expect("web workspace");
        fs::write(api.path().join("app.ts"), "console.log(apiValue);\n")
            .expect("write api fixture");
        fs::write(web.path().join("app.ts"), "console.log(webValue);\n")
            .expect("write web fixture");
        let mounts = vec![
            WorkspaceProjectMount {
                project_id: "web-project".to_string(),
                mount_name: "web".to_string(),
                workspace_path: Some(web.path().to_string_lossy().to_string()),
                display_name: None,
                is_read_only: false,
            },
            WorkspaceProjectMount {
                project_id: "api-project".to_string(),
                mount_name: "api".to_string(),
                workspace_path: Some(api.path().to_string_lossy().to_string()),
                display_name: None,
                is_read_only: false,
            },
        ];

        let result = execute_virtual_workspace_tool(
            "Implement",
            "ast_grep",
            &json!({
                "pattern": "console.log($ARG)",
                "include_meta": true,
                "limit": 10
            }),
            &mounts,
            None,
        )
        .await
        .expect("ast grep")
        .expect("handled by virtual root");
        let parsed: serde_json::Value = serde_json::from_str(&result).expect("json response");

        assert_eq!(parsed["virtual_root"], true);
        assert_eq!(parsed["count"], 2);
        assert_eq!(parsed["total_count"], 2);
        assert_eq!(parsed["matches"][0]["path"], "api/app.ts");
        assert_eq!(parsed["matches"][0]["project_id"], "api-project");
        assert_eq!(parsed["matches"][0]["meta_variables"]["ARG"], "apiValue");
        assert_eq!(parsed["matches"][1]["path"], "web/app.ts");
        assert_eq!(parsed["matches"][1]["project_id"], "web-project");
    }

    #[tokio::test]
    async fn virtual_exact_edit_rejects_ambiguous_old_text() {
        let temp = TempDir::new().expect("temp dir");
        fs::write(
            temp.path().join("app.ts"),
            "const value = 1;\nconst value = 1;\n",
        )
        .expect("write fixture");
        let mounts = vec![WorkspaceProjectMount {
            project_id: "web".to_string(),
            mount_name: "web".to_string(),
            workspace_path: Some(temp.path().to_string_lossy().to_string()),
            display_name: None,
            is_read_only: false,
        }];

        let result = execute_virtual_workspace_tool(
            "Implement",
            "edit",
            &json!({
                "path": "app.ts",
                "old_text": "const value = 1;",
                "new_text": "const value = 2;"
            }),
            &mounts,
            None,
        )
        .await
        .expect("edit")
        .expect("handled by virtual root");

        assert!(result.contains("old_text matched 2 locations"));
        assert_eq!(
            fs::read_to_string(temp.path().join("app.ts")).expect("read fixture"),
            "const value = 1;\nconst value = 1;\n"
        );
    }
}
