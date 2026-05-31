use super::{
    apply_patch_hunks_to_content, build_post_write_response, command_error,
    commit_pending_file_changes_atomically, compute_line_change_stats, format_with_line_numbers,
    fs, join_text_lines, json_arg_bool, json_arg_string, json_arg_u32, parse_apply_patch,
    resolve_validated_tool_path, CommandResult, ParsedPatchOperation, PendingFileChange,
};
use crate::core::tool_policy::validate_tool_execution;
use glob::Pattern;
use regex::RegexBuilder;
use serde::{Deserialize, Serialize};
use serde_json::Value;
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
            ));
        }
    }

    if tool_id == "glob" {
        let pattern = json_arg_string(args, "pattern").unwrap_or_else(|| "**/*".to_string());
        let max_results = json_arg_u32(args, "max_results").map(|value| value.max(1) as usize);
        let compiled = Pattern::new(&pattern)
            .map_err(|error| command_error(format!("Invalid glob pattern: {}", error)))?;
        let paths = all_files
            .into_iter()
            .filter_map(|(mount, _, relative)| {
                let virtual_path = virtual_path_for_mount(&mount, &relative);
                (compiled.matches(&relative) || compiled.matches(&virtual_path))
                    .then_some(virtual_path)
            })
            .take(max_results.unwrap_or(usize::MAX))
            .collect::<Vec<_>>();
        return serde_json::to_string_pretty(&serde_json::json!({
            "pattern": pattern,
            "virtual_root": true,
            "count": paths.len(),
            "paths": paths
        }))
        .map_err(|error| command_error(error.to_string()));
    }

    let query = json_arg_string(args, "query")
        .ok_or_else(|| command_error("Missing query argument for grep tool."))?;
    let is_regexp = json_arg_bool(args, "is_regexp").unwrap_or(false);
    let include_pattern = json_arg_string(args, "include_pattern");
    let max_results = json_arg_u32(args, "max_results").unwrap_or(50).max(1) as usize;
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
    let mut results = Vec::new();
    for (mount, workspace, relative) in all_files {
        let virtual_path = virtual_path_for_mount(&mount, &relative);
        if let Some(pattern) = include_glob.as_ref() {
            if !pattern.matches(&relative) && !pattern.matches(&virtual_path) {
                continue;
            }
        }
        let content = fs::read_file_internal(&workspace, relative, Some(true))
            .await
            .map_err(|error| command_error(error.to_string()))?;
        if content.is_binary {
            continue;
        }
        for (index, line) in content.content.lines().enumerate() {
            let is_match = if let Some(compiled) = regex.as_ref() {
                compiled.is_match(line)
            } else {
                line.to_lowercase().contains(&query_lower)
            };
            if is_match {
                results.push(serde_json::json!({
                    "path": virtual_path,
                    "line": index + 1,
                    "text": line.trim(),
                    "project_id": mount.project_id,
                    "mount_name": mount.mount_name,
                }));
                if results.len() >= max_results {
                    break;
                }
            }
        }
        if results.len() >= max_results {
            break;
        }
    }
    serde_json::to_string_pretty(&serde_json::json!({
        "query": query,
        "total": results.len(),
        "results": results
    }))
    .map_err(|error| command_error(error.to_string()))
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
                let entries = mounts
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
                return serde_json::to_string_pretty(&serde_json::json!({
                    "path": ".",
                    "virtual_root": true,
                    "count": entries.len(),
                    "entries": entries
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
            let entries = fs::list_dir_internal(
                &workspace,
                relative_path.clone(),
                json_arg_bool(args, "recursive"),
                json_arg_bool(args, "include_hidden"),
                json_arg_u32(args, "max_depth"),
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

            serde_json::to_string_pretty(&serde_json::json!({
                "path": virtual_path_for_mount(mount, &relative_path),
                "project_id": mount.project_id,
                "mount_name": mount.mount_name,
                "count": entries.len(),
                "entries": entries
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
                    "File {} is binary ({} bytes, encoding={}).",
                    virtual_path, result.size, result.encoding
                )));
            }

            let start_line = json_arg_u32(args, "start_line").unwrap_or(1).max(1) as usize;
            let end_line = json_arg_u32(args, "end_line").map(|value| value as usize);
            let lines = result.content.lines().collect::<Vec<_>>();
            let effective_start = start_line.min(lines.len().max(1));
            let effective_end = end_line
                .map(|value| value.max(effective_start))
                .unwrap_or(lines.len().max(effective_start));
            let selected = if lines.is_empty() {
                vec![""]
            } else {
                lines
                    .iter()
                    .skip(effective_start.saturating_sub(1))
                    .take(effective_end.saturating_sub(effective_start) + 1)
                    .copied()
                    .collect::<Vec<_>>()
            };
            let numbered = format_with_line_numbers(&selected, effective_start);
            Ok(Some(format!(
                "FILE: {}\nSOURCE: WORKSPACE_FILE\nPROJECT_ID: {}\nMOUNT: {}\nLANGUAGE: {}\nSIZE: {}\nLINES: {}-{}\n\n---BEGIN FILE CONTENT---\n{}\n---END FILE CONTENT---",
                virtual_path,
                mount.project_id,
                mount.mount_name,
                result.language,
                result.size,
                effective_start,
                effective_start + selected.len().saturating_sub(1),
                numbered
            )))
        }
        "glob" | "grep" => execute_virtual_workspace_search_tool(tool_id, args, mounts)
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
            let workspace = mount_workspace_path(mount)?;
            let absolute_path =
                resolve_validated_tool_path(&workspace, relative_path.as_str(), true)?;
            let write_result = fs::write_file_internal(
                &workspace,
                relative_path.clone(),
                content.clone(),
                create_dirs,
                Some(true),
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
            let workspace = mount_workspace_path(mount)?;
            let current = fs::read_file_internal(&workspace, relative_path.clone(), Some(true))
                .await
                .map_err(|error| command_error(error.to_string()))?;
            let display_path = virtual_path_for_mount(mount, &relative_path);
            if current.is_binary {
                return Ok(Some(format!("Cannot edit binary file: {}", display_path)));
            }
            let occurrences = current.content.matches(&old_text).count();
            if occurrences == 0 {
                return Ok(Some(format!(
                    "No match found for old_text in {}.",
                    display_path
                )));
            }
            let updated = if replace_all {
                current.content.replace(&old_text, &new_text)
            } else {
                current.content.replacen(&old_text, &new_text, 1)
            };
            let absolute_path =
                resolve_validated_tool_path(&workspace, relative_path.as_str(), true)?;
            let write_result = fs::write_file_internal(
                &workspace,
                relative_path.clone(),
                updated.clone(),
                Some(true),
                Some(true),
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
            let metadata = tokio::fs::metadata(&absolute_path).await.map_err(|error| {
                command_error(format!(
                    "Failed to inspect {} before delete: {}",
                    display_path, error
                ))
            })?;
            if metadata.is_dir() {
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
            tokio::fs::remove_file(&absolute_path)
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
                        if tokio::fs::try_exists(&absolute_path)
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
                        });
                    }
                    ParsedPatchOperation::Update { path, hunks } => {
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
                        });
                    }
                    ParsedPatchOperation::Delete { path } => {
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
        execute_virtual_workspace_tool, resolve_virtual_mount_target, ResolvedMountTarget,
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
}
