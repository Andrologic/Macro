//! Git fallback for the existing-only Architect catalog's file and directory reads.
use super::{
    dto::{DirEntryDto, FileContentDto},
    operations::{content_revision, DIRECTORY_LIST_LIMIT, MAX_FILE_SIZE_BYTES},
};
use crate::{
    core::error::{BackendError, Result},
    git::metadata_read::{
        local_macro_tree, open_unchecked_out_macro_repo, read_macro_plan_file, tree_entry,
    },
};
use git2::{Repository, Tree};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

fn component(value: &str) -> bool {
    !matches!(value, "" | "." | "..") && !value.contains(['\\', ':', '\0'])
}

fn plan_file(path: &str) -> bool {
    let Some(path) = path.strip_prefix("branches/") else {
        return false;
    };
    let branch = if let Some(branch) = path.strip_suffix("/plans/index.json") {
        Some(branch)
    } else {
        path.rsplit_once('/').and_then(|(path, file)| {
            if !matches!(file, "plan.json" | "runtime.json" | "manifest.json") {
                return None;
            }
            let (path, id) = path.rsplit_once('/')?;
            component(id).then(|| path.strip_suffix("/plans")).flatten()
        })
    };
    branch.is_some_and(|branch| branch.split('/').all(component))
}

async fn with_catalog<T: Send + 'static>(
    registry_root: &Path,
    workspace: PathBuf,
    read: impl FnOnce(&Repository, &Tree<'_>) -> Result<Option<T>> + Send + 'static,
) -> Result<Option<T>> {
    let Ok(workspace) =
        crate::workspace::resolve_project_path(registry_root, &workspace.to_string_lossy())
            .canonicalize()
    else {
        return Ok(None);
    };
    if registry_root.canonicalize().ok().as_ref() != Some(&workspace) {
        let state = crate::workspace::read_existing_workspace_state(registry_root).await?;
        let registered = state
            .standalone_projects
            .iter()
            .chain(
                state
                    .project_groups
                    .iter()
                    .flat_map(|group| &group.projects),
            )
            .any(|project| {
                !project.path.trim().is_empty()
                    && crate::workspace::resolve_project_path(registry_root, &project.path)
                        .canonicalize()
                        .ok()
                        .as_ref()
                        == Some(&workspace)
            });
        if !registered {
            return Ok(None);
        }
    }
    tokio::task::spawn_blocking(move || {
        let Some(repo) =
            open_unchecked_out_macro_repo(&workspace).map_err(BackendError::Validation)?
        else {
            return Ok(None);
        };
        let Some((_, tree)) = local_macro_tree(&repo).map_err(BackendError::Validation)? else {
            return Ok(None);
        };
        read(&repo, &tree)
    })
    .await
    .map_err(|error| BackendError::Internal {
        message: error.to_string(),
    })?
}

pub(crate) async fn read_file(
    registry_root: &Path,
    workspace: PathBuf,
    path: String,
) -> Result<Option<FileContentDto>> {
    if !plan_file(&path) {
        return Ok(None);
    }
    with_catalog(registry_root, workspace, move |repo, tree| {
        let Some(content) =
            read_macro_plan_file(repo, tree, Path::new(&path)).map_err(BackendError::Validation)?
        else {
            return Ok(None);
        };
        let size = content.len() as u64;
        if size > MAX_FILE_SIZE_BYTES {
            return Err(BackendError::FilesystemFileTooLarge {
                message: format!("Plan metadata file is too large: {path}"),
            });
        }
        Ok(Some(FileContentDto {
            revision: content_revision(content.as_bytes()),
            content,
            language: "JSON".into(),
            is_binary: false,
            size,
            encoding: "utf-8".into(),
            workspace_identity: None,
            unix_mode: None,
        }))
    })
    .await
}

pub(crate) async fn list_dir(
    registry_root: &Path,
    workspace: PathBuf,
    path: String,
    recursive: bool,
    max_depth: Option<u32>,
) -> Result<Option<Vec<DirEntryDto>>> {
    if !(recursive && path == "branches"
        || !recursive
            && path
                .strip_prefix("branches/")
                .and_then(|path| path.strip_suffix("/plans"))
                .is_some_and(|branch| branch.split('/').all(component)))
    {
        return Ok(None);
    }
    with_catalog(registry_root, workspace, move |repo, tree| {
        let mut entries = BTreeMap::new();
        let mut scanned = 0;
        for root in [PathBuf::from(&path), Path::new(".macro").join(&path)] {
            let Some(entry) = tree_entry(tree, &root).map_err(BackendError::Validation)? else {
                continue;
            };
            let subtree = repo
                .find_tree(entry.id())
                .map_err(|error| BackendError::Validation(error.to_string()))?;
            let mut pending = vec![(String::new(), subtree, 0)];
            let depth_limit = if recursive {
                max_depth.unwrap_or(u32::MAX)
            } else {
                1
            };
            while let Some((prefix, subtree, depth)) = pending.pop() {
                if depth >= depth_limit {
                    continue;
                }
                for entry in subtree.iter() {
                    scanned += 1;
                    if scanned > DIRECTORY_LIST_LIMIT {
                        return Err(BackendError::Filesystem {
                            message: "Plan catalog exceeds the directory listing limit.".into(),
                        });
                    }
                    let Ok(name) = entry.name() else { continue };
                    if !component(name) {
                        continue;
                    }
                    let relative = format!("{prefix}{name}");
                    let kind = match entry.filemode() {
                        0o040000 if !recursive => {
                            let child = repo
                                .find_tree(entry.id())
                                .map_err(|error| BackendError::Validation(error.to_string()))?;
                            if !child
                                .get_name("plan.json")
                                .is_some_and(|file| matches!(file.filemode(), 0o100644 | 0o100755))
                            {
                                continue;
                            }
                            "directory"
                        }
                        0o040000 => {
                            let child = repo
                                .find_tree(entry.id())
                                .map_err(|error| BackendError::Validation(error.to_string()))?;
                            pending.push((format!("{relative}/"), child, depth + 1));
                            continue;
                        }
                        0o100644 | 0o100755
                            if recursive
                                && plan_file(&format!("{path}/{relative}"))
                                && (relative.ends_with("/plan.json")
                                    || relative.ends_with("/plans/index.json")) =>
                        {
                            "file"
                        }
                        _ => continue,
                    };
                    let logical_path = format!("{path}/{relative}");
                    entries
                        .entry(relative.clone())
                        .or_insert_with(|| DirEntryDto {
                            path: logical_path,
                            relative_path: relative,
                            name: name.into(),
                            kind: kind.into(),
                            size: None,
                            modified: None,
                            created: None,
                            language: None,
                            is_hidden: name.starts_with('.'),
                            is_readonly: true,
                        });
                }
            }
        }
        Ok(Some(entries.into_values().collect()))
    })
    .await
}
