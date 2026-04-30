use super::{command_error, CommandResult};
use serde::{Deserialize, Serialize};
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
                "Subproject {} has no workspace path.",
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
        [] => Err(command_error("No virtual-root subproject is available.")),
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

#[cfg(test)]
mod tests {
    use super::{
        resolve_virtual_mount_target, ResolvedMountTarget, VirtualWorkspaceContext,
        WorkspaceProjectMount,
    };

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
}
