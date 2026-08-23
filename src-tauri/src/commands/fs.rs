// File System Commands
// This module contains the desktop FS command surface.

use crate::core::error::{io_error_to_backend_error, BackendError};
use crate::core::tool_policy::is_macro_scoped_path;
use crate::fs::dto::{
    DirEntryDto, FileContentDto, FileStatsDto, WorkspaceFileSearchResultDto,
    WorkspaceFileSearchRootDto, WriteResultDto,
};
use crate::fs::{
    get_file_language, is_binary_file, normalize_path, validate_path, validate_path_for_write,
};
use crate::git::GitState;
use crate::project_path::{
    join_wsl_path, normalize_linux_path, parse_wsl_unc_path, run_wsl_shell,
    run_wsl_shell_with_stdin, wsl_unc_path, WslProjectPath,
};
use crate::WorkspaceRoot;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::Duration;

#[cfg(windows)]
use std::os::windows::fs::MetadataExt;

// Constants
const MAX_FILE_SIZE_BYTES: u64 = 10 * 1024 * 1024; // 10 MB
const MAX_WRITE_SIZE_BYTES: u64 = 50 * 1024 * 1024; // 50 MB
const MAX_FILE_SEARCH_RESULTS: usize = 100;
const MAX_FILE_SEARCH_CANDIDATES: usize = 600;
const WSL_FS_TIMEOUT: Duration = Duration::from_secs(5);
const WSL_FS_WRITE_TIMEOUT: Duration = Duration::from_secs(10);
const WSL_LIST_LIMIT: usize = 1_000;

// Default ignored directories/patterns
static DEFAULT_IGNORED: [&str; 12] = [
    ".git",
    "node_modules",
    "target",
    ".next",
    ".nuxt",
    "dist",
    "build",
    "__pycache__",
    ".cache",
    ".DS_Store",
    "Thumbs.db",
    ".idea",
];

fn to_join_error(err: tokio::task::JoinError) -> BackendError {
    BackendError::Internal {
        message: format!("File system task join error: {}", err),
    }
}

async fn resolve_workspace_for_path(
    workspace: PathBuf,
    git_state: GitState,
    workspace_path: Option<PathBuf>,
    path: &str,
    allow_outside_workspace: Option<bool>,
    workspace_scope: Option<&str>,
) -> Result<PathBuf, BackendError> {
    let base_workspace = workspace_path.unwrap_or(workspace);
    let metadata_scope = matches!(workspace_scope.map(str::trim), Some("metadata"));
    if allow_outside_workspace.unwrap_or(false) || (!metadata_scope && !is_macro_scoped_path(path))
    {
        return Ok(base_workspace);
    }

    if parse_wsl_unc_path(&base_workspace.to_string_lossy()).is_some() {
        return Err(BackendError::Git {
            message: "Macro metadata is not yet available for WSL projects.".to_string(),
        });
    }

    let base_workspace_for_fallback = base_workspace.clone();
    let resolved =
        tokio::task::spawn_blocking(move || git_state.resolve_macro_metadata_root(&base_workspace))
            .await
            .map_err(to_join_error);
    match resolved {
        Ok(Ok(metadata_root)) => Ok(metadata_root),
        Ok(Err(error)) => {
            let error_message = error.to_string();
            if let Some(metadata_worktree) =
                crate::git::find_existing_macro_metadata_worktree_root(&base_workspace_for_fallback)
            {
                tracing::warn!(
                    action = "workspace_fs_metadata_root_existing_worktree_fallback",
                    workspace_path = %base_workspace_for_fallback.display(),
                    fallback_path = %metadata_worktree.display(),
                    reason = %error_message
                );
                return Ok(metadata_worktree);
            }
            let BackendError::GitRepositoryNotFound { message } = error else {
                return Err(error);
            };
            let fallback = base_workspace_for_fallback.join(".macro");
            tracing::warn!(
                action = "workspace_fs_metadata_root_fallback",
                workspace_path = %base_workspace_for_fallback.display(),
                fallback_path = %fallback.display(),
                reason = %message
            );
            Ok(fallback)
        }
        Err(error) => Err(error),
    }
}

pub fn map_macro_virtual_path(path: &str) -> String {
    let mut normalized = path.trim().replace('\\', "/");
    while normalized.starts_with("./") {
        normalized = normalized[2..].to_string();
    }

    if normalized == ".macro" || normalized == ".macro/" {
        return ".".to_string();
    }

    if let Some(stripped) = normalized.strip_prefix(".macro/") {
        if stripped.is_empty() {
            return ".".to_string();
        }
        return stripped.to_string();
    }

    path.to_string()
}

fn linux_path_is_same_or_child(root: &str, candidate: &str) -> bool {
    let root = root.trim_end_matches('/');
    candidate == root
        || candidate
            .strip_prefix(root)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

fn wsl_path_outside_workspace(path: &str) -> BackendError {
    BackendError::FilesystemPathOutsideWorkspace {
        message: format!("Path escapes WSL workspace: {}", path),
    }
}

fn resolve_wsl_path(
    workspace: &WslProjectPath,
    path: &str,
    allow_outside_workspace: Option<bool>,
) -> Result<WslProjectPath, BackendError> {
    let allow_outside = allow_outside_workspace.unwrap_or(false);
    if let Some(absolute_wsl_path) = parse_wsl_unc_path(path) {
        if !allow_outside
            && (absolute_wsl_path.distro != workspace.distro
                || !linux_path_is_same_or_child(
                    &workspace.linux_path,
                    &absolute_wsl_path.linux_path,
                ))
        {
            return Err(wsl_path_outside_workspace(path));
        }
        return Ok(absolute_wsl_path);
    }

    let normalized_input = path.trim().replace('\\', "/");
    let resolved = if normalized_input.starts_with('/') {
        let linux_path = normalize_linux_path(&normalized_input)?;
        WslProjectPath {
            distro: workspace.distro.clone(),
            unc_path: wsl_unc_path(&workspace.distro, &linux_path),
            linux_path,
            original_path: path.to_string(),
        }
    } else {
        join_wsl_path(workspace, path)?
    };

    if !allow_outside && !linux_path_is_same_or_child(&workspace.linux_path, &resolved.linux_path) {
        return Err(wsl_path_outside_workspace(path));
    }

    Ok(resolved)
}

fn epoch_to_rfc3339(value: &str) -> Option<String> {
    let seconds = value.trim().split('.').next()?.parse::<i64>().ok()?;
    chrono::DateTime::<chrono::Utc>::from_timestamp(seconds, 0).map(|time| time.to_rfc3339())
}

fn bytes_look_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8192).any(|byte| *byte == 0)
}

pub(crate) fn content_revision(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub(crate) const EXPECTED_REVISION_ABSENT: &str = "absent";

pub(crate) fn validate_expected_revision(
    path: &str,
    expected_revision: Option<&str>,
    actual_revision: Option<&str>,
) -> Result<(), BackendError> {
    let Some(expected) = expected_revision
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(());
    };
    if expected.eq_ignore_ascii_case(EXPECTED_REVISION_ABSENT) {
        return if actual_revision.is_none() {
            Ok(())
        } else {
            Err(BackendError::RevisionConflict {
                message: format!(
                    "Stale content for '{}': expected the file to be absent but found revision {}. Re-read the path and retry.",
                    path,
                    actual_revision.unwrap_or("unknown")
                ),
            })
        };
    }
    let Some(actual) = actual_revision else {
        return Err(BackendError::RevisionConflict {
            message: format!(
            "Cannot safely mutate '{}': expected revision {} but the current revision is unavailable. Re-read the file and retry.",
            path, expected
        ),
        });
    };
    if actual != expected {
        return Err(BackendError::RevisionConflict {
            message: format!(
                "Stale content for '{}': expected revision {} but found {}. Re-read the file and retry.",
                path, expected, actual
            ),
        });
    }
    Ok(())
}

fn wsl_name_from_linux_path(path: &str) -> String {
    path.trim_end_matches('/')
        .rsplit('/')
        .next()
        .filter(|value| !value.is_empty())
        .unwrap_or("/")
        .to_string()
}

async fn wsl_stat_raw(
    path: &WslProjectPath,
) -> Result<(String, u64, Option<String>, String, Option<String>), BackendError> {
    let script = r#"
p=$1
if [ ! -e "$p" ] && [ ! -L "$p" ]; then
  printf 'Path not found: %s\n' "$p" >&2
  exit 4
fi
kind=file
if [ -L "$p" ]; then kind=symlink; elif [ -d "$p" ]; then kind=directory; fi
size=$(stat -c '%s' -- "$p" 2>/dev/null || printf '0')
mtime=$(stat -c '%Y' -- "$p" 2>/dev/null || printf '0')
perm=$(stat -c '%a' -- "$p" 2>/dev/null || printf '')
target=''
if [ -L "$p" ]; then target=$(readlink -- "$p" 2>/dev/null || true); fi
printf '%s\t%s\t%s\t%s\t%s\n' "$kind" "$size" "$mtime" "$perm" "$target"
"#;
    let output = run_wsl_shell(path, script, &[path.linux_path.clone()], WSL_FS_TIMEOUT).await?;
    let stdout = output.stdout_text();
    let parts = stdout.splitn(5, '\t').collect::<Vec<_>>();
    if parts.len() < 4 {
        return Err(BackendError::Filesystem {
            message: format!("Invalid WSL stat output for {}", path.unc_path),
        });
    }
    Ok((
        parts[0].to_string(),
        parts[1].trim().parse::<u64>().unwrap_or(0),
        epoch_to_rfc3339(parts[2]).or_else(|| Some(chrono::Utc::now().to_rfc3339())),
        parts[3].to_string(),
        parts
            .get(4)
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
    ))
}

async fn read_wsl_file_internal(
    workspace: &WslProjectPath,
    path: String,
    allow_outside_workspace: Option<bool>,
) -> Result<FileContentDto, BackendError> {
    let resolved = resolve_wsl_path(workspace, &path, allow_outside_workspace)?;
    let (kind, size, _, _, _) = wsl_stat_raw(&resolved).await?;
    if kind != "file" && kind != "symlink" {
        return Err(BackendError::FilesystemIsDirectory {
            message: format!("The path '{}' is a directory, not a file.", path),
        });
    }
    if size > MAX_FILE_SIZE_BYTES {
        return Err(BackendError::FilesystemFileTooLarge {
            message: format!(
                "The file '{}' exceeds the maximum allowed size of {} bytes.",
                path, MAX_FILE_SIZE_BYTES
            ),
        });
    }

    let output = run_wsl_shell(
        &resolved,
        r#"head -c "$2" -- "$1""#,
        &[
            resolved.linux_path.clone(),
            MAX_FILE_SIZE_BYTES.saturating_add(1).to_string(),
        ],
        WSL_FS_TIMEOUT,
    )
    .await?;
    if output.stdout.len() as u64 > MAX_FILE_SIZE_BYTES {
        return Err(BackendError::FilesystemFileTooLarge {
            message: format!(
                "The file '{}' exceeds the maximum allowed size of {} bytes.",
                path, MAX_FILE_SIZE_BYTES
            ),
        });
    }
    let size = output.stdout.len() as u64;
    let revision = content_revision(&output.stdout);
    if bytes_look_binary(&output.stdout) {
        return Ok(FileContentDto {
            is_binary: true,
            content: String::new(),
            encoding: "none".to_string(),
            language: "binary".to_string(),
            size,
            revision,
        });
    }
    let content = String::from_utf8(output.stdout).map_err(|error| BackendError::Filesystem {
        message: format!("Invalid UTF-8 returned from WSL: {}", error),
    })?;
    Ok(FileContentDto {
        content,
        language: get_file_language(Path::new(&resolved.unc_path))
            .unwrap_or_else(|| "Unknown".to_string()),
        is_binary: false,
        size,
        encoding: "utf-8".to_string(),
        revision,
    })
}

async fn write_wsl_file_internal_with_revision(
    workspace: &WslProjectPath,
    path: String,
    content: String,
    create_dirs: Option<bool>,
    allow_outside_workspace: Option<bool>,
    expected_revision: Option<&str>,
    acquire_lock: bool,
) -> Result<WriteResultDto, BackendError> {
    let content_bytes = content.into_bytes();
    if content_bytes.len() as u64 > MAX_WRITE_SIZE_BYTES {
        return Err(BackendError::FilesystemFileTooLarge {
            message: format!(
                "Content exceeds maximum write size of {} bytes",
                MAX_WRITE_SIZE_BYTES
            ),
        });
    }

    let resolved = resolve_wsl_path(workspace, &path, allow_outside_workspace)?;
    let _mutation_guard = if acquire_lock {
        Some(
            super::content_mutation_lock(&super::wsl_content_mutation_key(&resolved))
                .lock_owned()
                .await,
        )
    } else {
        None
    };
    let create_dirs_flag = if create_dirs.unwrap_or(true) {
        "1"
    } else {
        "0"
    }
    .to_string();
    let script = r#"
p=$1
create_dirs=$2
expected_revision=$3
dir=$(dirname -- "$p")
if [ "$create_dirs" = "1" ]; then
  mkdir -p -- "$dir"
elif [ ! -d "$dir" ]; then
  printf 'Parent directory not found: %s\n' "$dir" >&2
  exit 4
fi
if [ -d "$p" ]; then
  printf 'Path is a directory: %s\n' "$p" >&2
  exit 5
fi
created=0
if [ ! -e "$p" ]; then created=1; fi
tmp=$(mktemp "$dir/.macro-write.XXXXXX") || exit 6
cat > "$tmp"
if [ -n "$expected_revision" ]; then
  actual_revision=unavailable
  if [ ! -e "$p" ] && [ ! -L "$p" ]; then
    actual_revision=absent
  elif [ -f "$p" ]; then
    actual_line=$(sha256sum -- "$p") || { rm -f -- "$tmp"; exit 7; }
    actual_revision=${actual_line%% *}
  fi
  if [ "$expected_revision" = "absent" ]; then
    revision_matches=$([ "$actual_revision" = "absent" ] && printf '1' || printf '0')
  else
    revision_matches=$([ "$actual_revision" = "$expected_revision" ] && printf '1' || printf '0')
  fi
  if [ "$revision_matches" != "1" ]; then
    rm -f -- "$tmp"
    printf 'revision_conflict actual=%s\n' "$actual_revision"
    exit 0
  fi
fi
if [ "$created" = "0" ] && cmp -s "$tmp" "$p"; then
  rm -f -- "$tmp"
  printf 'created=0 skipped=1\n'
  exit 0
fi
mv -f -- "$tmp" "$p"
printf 'created=%s skipped=0\n' "$created"
"#;
    let output = run_wsl_shell_with_stdin(
        &resolved,
        script,
        &[
            resolved.linux_path.clone(),
            create_dirs_flag,
            expected_revision
                .map(str::trim)
                .map(|value| {
                    if value.eq_ignore_ascii_case(EXPECTED_REVISION_ABSENT) {
                        EXPECTED_REVISION_ABSENT
                    } else {
                        value
                    }
                })
                .unwrap_or_default()
                .to_string(),
        ],
        content_bytes.clone(),
        WSL_FS_WRITE_TIMEOUT,
    )
    .await?;
    let stdout = output.stdout_text();
    if let Some(actual) = stdout
        .lines()
        .find_map(|line| line.strip_prefix("revision_conflict actual="))
    {
        let actual_revision = if actual == EXPECTED_REVISION_ABSENT || actual == "unavailable" {
            None
        } else {
            Some(actual)
        };
        validate_expected_revision(&path, expected_revision, actual_revision)?;
        return Err(BackendError::RevisionConflict {
            message: format!("Revision conflict while writing '{}'.", path),
        });
    }
    let skipped = stdout.contains("skipped=1");
    let created = stdout.contains("created=1");
    Ok(WriteResultDto {
        path: resolved.unc_path,
        bytes_written: if skipped {
            0
        } else {
            content_bytes.len() as u64
        },
        created,
        skipped,
        revision: content_revision(&content_bytes),
    })
}

async fn list_wsl_dir_internal(
    workspace: &WslProjectPath,
    path: String,
    recursive: Option<bool>,
    include_hidden: Option<bool>,
    max_depth: Option<u32>,
    allow_outside_workspace: Option<bool>,
) -> Result<Vec<DirEntryDto>, BackendError> {
    let resolved = resolve_wsl_path(workspace, &path, allow_outside_workspace)?;
    let (kind, _, _, _, _) = wsl_stat_raw(&resolved).await?;
    if kind != "directory" {
        return Err(BackendError::FilesystemIsFile {
            message: format!("Path '{}' is a file, not a directory", path),
        });
    }

    let depth = if recursive.unwrap_or(false) {
        max_depth
            .map(|value| value.max(1).to_string())
            .unwrap_or_else(|| "all".to_string())
    } else {
        "1".to_string()
    };
    let include_hidden_flag = if include_hidden.unwrap_or(false) {
        "1"
    } else {
        "0"
    }
    .to_string();
    let ignored = DEFAULT_IGNORED.join("|");
    let script = r#"
root=$1
depth=$2
include_hidden=$3
limit=$4
ignored=$5
if [ "$depth" = "all" ]; then
  find "$root" -mindepth 1 -printf '%p\t%P\t%f\t%y\t%s\t%T@\t%m\n' 2>/dev/null
else
  find "$root" -mindepth 1 -maxdepth "$depth" -printf '%p\t%P\t%f\t%y\t%s\t%T@\t%m\n' 2>/dev/null
fi |
while IFS="$(printf '\t')" read -r full rel name type size mtime perm; do
  case "|$ignored|" in *"|$name|"*) continue;; esac
  if [ "$include_hidden" != "1" ]; then
    case "$name" in .*) continue;; esac
  fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$full" "$rel" "$name" "$type" "$size" "$mtime" "$perm"
done | head -n "$limit"
"#;
    let output = run_wsl_shell(
        &resolved,
        script,
        &[
            resolved.linux_path.clone(),
            depth,
            include_hidden_flag,
            WSL_LIST_LIMIT.saturating_add(1).to_string(),
            ignored,
        ],
        WSL_FS_TIMEOUT,
    )
    .await?;

    let mut entries = Vec::new();
    for line in output.stdout_text().lines() {
        let parts = line.splitn(7, '\t').collect::<Vec<_>>();
        if parts.len() < 7 {
            continue;
        }
        let full_linux_path = parts[0].to_string();
        let relative_path = parts[1].replace('\\', "/");
        let name = parts[2].to_string();
        let kind = match parts[3] {
            "d" => "directory",
            "l" => "symlink",
            _ => "file",
        }
        .to_string();
        let size = if kind == "file" || kind == "symlink" {
            Some(parts[4].trim().parse::<u64>().unwrap_or(0))
        } else {
            None
        };
        let modified = epoch_to_rfc3339(parts[5]);
        let permissions = parts[6].trim();
        entries.push(DirEntryDto {
            path: wsl_unc_path(&resolved.distro, &full_linux_path),
            relative_path,
            name: name.clone(),
            kind,
            size,
            modified,
            created: None,
            language: get_file_language(Path::new(&name)),
            is_hidden: name.starts_with('.'),
            is_readonly: !permissions.ends_with('2')
                && !permissions.ends_with('3')
                && !permissions.ends_with('6')
                && !permissions.ends_with('7'),
        });
    }

    if entries.len() > WSL_LIST_LIMIT {
        return Err(BackendError::Filesystem {
            message: format!(
                "Directory listing exceeds the WSL safety limit of {} entries. Narrow the path, glob pattern, or recursion depth before retrying.",
                WSL_LIST_LIMIT
            ),
        });
    }

    entries.sort_by(|a, b| {
        let a_is_dir = a.kind == "directory";
        let b_is_dir = b.kind == "directory";
        match (a_is_dir, b_is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        }
    });
    Ok(entries)
}

async fn stat_wsl_internal(
    workspace: &WslProjectPath,
    path: String,
) -> Result<FileStatsDto, BackendError> {
    let resolved = resolve_wsl_path(workspace, &path, None)?;
    let (kind, size, modified, permissions, symlink_target) = wsl_stat_raw(&resolved).await?;
    let name = wsl_name_from_linux_path(&resolved.linux_path);
    let symlink_target = symlink_target.map(|target| {
        if target.starts_with('/') {
            wsl_unc_path(&resolved.distro, &target)
        } else {
            target
        }
    });
    Ok(FileStatsDto {
        path: resolved.unc_path,
        name: name.clone(),
        kind: kind.clone(),
        size,
        created: None,
        modified: modified.unwrap_or_else(|| chrono::Utc::now().to_rfc3339()),
        accessed: None,
        permissions: permissions.clone(),
        language: if kind == "file" || kind == "symlink" {
            get_file_language(Path::new(&name))
        } else {
            None
        },
        is_readonly: !permissions.ends_with('2')
            && !permissions.ends_with('3')
            && !permissions.ends_with('6')
            && !permissions.ends_with('7'),
        is_hidden: name.starts_with('.'),
        is_symlink: kind == "symlink",
        symlink_target,
    })
}

async fn wsl_exists_internal(
    workspace: &WslProjectPath,
    path: String,
) -> Result<bool, BackendError> {
    let resolved = resolve_wsl_path(workspace, &path, None)?;
    let output = run_wsl_shell(
        &resolved,
        r#"if [ -e "$1" ] || [ -L "$1" ]; then printf '1'; else printf '0'; fi"#,
        &[resolved.linux_path.clone()],
        WSL_FS_TIMEOUT,
    )
    .await?;
    Ok(output.stdout_text() == "1")
}

async fn delete_wsl_path_internal(
    workspace: &WslProjectPath,
    path: String,
    recursive: Option<bool>,
) -> Result<(), BackendError> {
    delete_wsl_path_internal_with_revision(workspace, path, recursive, None, false).await
}

async fn delete_wsl_path_internal_with_revision(
    workspace: &WslProjectPath,
    path: String,
    recursive: Option<bool>,
    expected_revision: Option<&str>,
    acquire_lock: bool,
) -> Result<(), BackendError> {
    let resolved = resolve_wsl_path(workspace, &path, None)?;
    let _mutation_guard = if acquire_lock {
        Some(
            super::content_mutation_lock(&super::wsl_content_mutation_key(&resolved))
                .lock_owned()
                .await,
        )
    } else {
        None
    };
    let recursive_flag = if recursive.unwrap_or(false) { "1" } else { "0" }.to_string();
    let script = r#"
p=$1
recursive=$2
expected_revision=$3
if [ ! -e "$p" ] && [ ! -L "$p" ]; then
  if [ -n "$expected_revision" ]; then
    printf 'revision_conflict actual=absent\n'
    exit 0
  fi
  printf 'Path not found: %s\n' "$p" >&2
  exit 4
fi
if [ -n "$expected_revision" ]; then
  actual_revision=unavailable
  if [ -f "$p" ]; then
    actual_line=$(sha256sum -- "$p") || exit 7
    actual_revision=${actual_line%% *}
  fi
  if [ "$expected_revision" = "absent" ] || [ "$actual_revision" != "$expected_revision" ]; then
    printf 'revision_conflict actual=%s\n' "$actual_revision"
    exit 0
  fi
fi
if [ -d "$p" ] && [ ! -L "$p" ]; then
  if [ "$recursive" = "1" ]; then rm -rf -- "$p"; else rmdir -- "$p"; fi
else
  rm -f -- "$p"
fi
"#;
    let output = run_wsl_shell(
        &resolved,
        script,
        &[
            resolved.linux_path.clone(),
            recursive_flag,
            expected_revision
                .map(str::trim)
                .map(|value| {
                    if value.eq_ignore_ascii_case(EXPECTED_REVISION_ABSENT) {
                        EXPECTED_REVISION_ABSENT
                    } else {
                        value
                    }
                })
                .unwrap_or_default()
                .to_string(),
        ],
        WSL_FS_WRITE_TIMEOUT,
    )
    .await?;
    if let Some(actual) = output
        .stdout_text()
        .lines()
        .find_map(|line| line.strip_prefix("revision_conflict actual="))
    {
        let actual_revision = if actual == EXPECTED_REVISION_ABSENT || actual == "unavailable" {
            None
        } else {
            Some(actual)
        };
        validate_expected_revision(&path, expected_revision, actual_revision)?;
        return Err(BackendError::RevisionConflict {
            message: format!("Revision conflict while deleting '{}'.", path),
        });
    }
    Ok(())
}

async fn create_wsl_dir_internal(
    workspace: &WslProjectPath,
    path: String,
    recursive: Option<bool>,
) -> Result<(), BackendError> {
    let resolved = resolve_wsl_path(workspace, &path, None)?;
    let recursive_flag = if recursive.unwrap_or(true) { "1" } else { "0" }.to_string();
    let script = r#"
p=$1
recursive=$2
if [ "$recursive" = "1" ]; then
  mkdir -p -- "$p"
else
  mkdir -- "$p"
fi
"#;
    run_wsl_shell(
        &resolved,
        script,
        &[resolved.linux_path.clone(), recursive_flag],
        WSL_FS_WRITE_TIMEOUT,
    )
    .await?;
    Ok(())
}

async fn copy_wsl_path_internal(
    workspace: &WslProjectPath,
    src: String,
    dest: String,
) -> Result<u64, BackendError> {
    let src_resolved = resolve_wsl_path(workspace, &src, None)?;
    let dest_resolved = resolve_wsl_path(workspace, &dest, None)?;
    let script = r#"
src=$1
dest=$2
parent=$(dirname -- "$dest")
mkdir -p -- "$parent"
cp -f -- "$src" "$dest"
stat -c '%s' -- "$dest" 2>/dev/null || printf '0'
"#;
    let output = run_wsl_shell(
        &src_resolved,
        script,
        &[
            src_resolved.linux_path.clone(),
            dest_resolved.linux_path.clone(),
        ],
        WSL_FS_WRITE_TIMEOUT,
    )
    .await?;
    Ok(output.stdout_text().parse::<u64>().unwrap_or(0))
}

async fn move_wsl_path_internal(
    workspace: &WslProjectPath,
    src: String,
    dest: String,
) -> Result<(), BackendError> {
    let src_resolved = resolve_wsl_path(workspace, &src, None)?;
    let dest_resolved = resolve_wsl_path(workspace, &dest, None)?;
    let script = r#"
src=$1
dest=$2
parent=$(dirname -- "$dest")
mkdir -p -- "$parent"
mv -f -- "$src" "$dest"
"#;
    run_wsl_shell(
        &src_resolved,
        script,
        &[
            src_resolved.linux_path.clone(),
            dest_resolved.linux_path.clone(),
        ],
        WSL_FS_WRITE_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// Internal function that reads file content. This is separated for testability.
pub async fn read_file_internal(
    workspace: &Path,
    path: String,
    allow_outside_workspace: Option<bool>,
) -> Result<FileContentDto, BackendError> {
    let workspace_string = workspace.to_string_lossy();
    if let Some(wsl_workspace) = parse_wsl_unc_path(&workspace_string) {
        return read_wsl_file_internal(&wsl_workspace, path, allow_outside_workspace).await;
    }

    let path_buf = PathBuf::from(&path); // Parse path string to PathBuf
    let allow_outside = allow_outside_workspace.unwrap_or(false);
    let validated_path = if allow_outside {
        if path_buf.is_absolute() {
            normalize_path(&path_buf)
        } else {
            normalize_path(&workspace.join(&path_buf))
        }
    } else {
        validate_path(&path_buf, workspace)?
    };
    let file_metadata = tokio::fs::metadata(&validated_path)
        .await
        .map_err(|e| io_error_to_backend_error(e, &validated_path))?; // Get file metadata

    // Check if it's a file
    if !file_metadata.is_file() {
        return Err(BackendError::FilesystemIsDirectory {
            message: format!("The path '{}' is a directory, not a file.", path),
        });
    }
    // Check file size
    if file_metadata.len() > MAX_FILE_SIZE_BYTES {
        return Err(BackendError::FilesystemFileTooLarge {
            message: format!(
                "The file '{}' exceeds the maximum allowed size of {} bytes.",
                path, MAX_FILE_SIZE_BYTES
            ),
        });
    }
    // Verify if file is accessible
    let _file = tokio::fs::File::open(&validated_path)
        .await
        .map_err(|e| io_error_to_backend_error(e, &validated_path))?;

    // Verify if binary or text file
    let is_binary = is_binary_file(&validated_path)?;
    let bytes = tokio::fs::read(&validated_path)
        .await
        .map_err(|e| io_error_to_backend_error(e, &validated_path))?;
    if bytes.len() as u64 > MAX_FILE_SIZE_BYTES {
        return Err(BackendError::FilesystemFileTooLarge {
            message: format!(
                "The file '{}' exceeds the maximum allowed size of {} bytes.",
                path, MAX_FILE_SIZE_BYTES
            ),
        });
    }
    let actual_size = bytes.len() as u64;
    let revision = content_revision(&bytes);
    if is_binary {
        // Return binary file response
        Ok(FileContentDto {
            is_binary: true,
            content: "".to_string(),
            encoding: "none".to_string(),
            language: "binary".to_string(),
            size: actual_size,
            revision,
        })
    } else {
        // Read text file content
        let content = String::from_utf8(bytes).map_err(|e| BackendError::Filesystem {
            message: format!(
                "Invalid UTF-8 returned for {}: {}",
                validated_path.display(),
                e
            ),
        })?;
        // Detect language
        let language = get_file_language(&validated_path).unwrap_or_else(|| "Unknown".to_string());
        // Return text file response
        Ok(FileContentDto {
            content,
            language,
            is_binary: false,
            size: actual_size,
            encoding: "utf-8".to_string(),
            revision,
        })
    }
}

#[tauri::command]
pub async fn fs_read_file(
    workspace_root: tauri::State<'_, WorkspaceRoot>,
    git_state: tauri::State<'_, GitState>,
    path: String,
    allow_outside_workspace: Option<bool>,
    workspace_scope: Option<String>,
    workspace_path: Option<String>,
) -> Result<FileContentDto, BackendError> {
    let effective_path = if is_macro_scoped_path(&path) {
        map_macro_virtual_path(&path)
    } else {
        path.clone()
    };
    let workspace = workspace_root.inner().read().await.clone();
    let workspace = resolve_workspace_for_path(
        workspace,
        git_state.inner().clone(),
        workspace_path.map(PathBuf::from),
        &path,
        allow_outside_workspace,
        workspace_scope.as_deref(),
    )
    .await?;
    read_file_internal(&workspace, effective_path, allow_outside_workspace).await
}

/// Internal function for writing files with atomic write support
pub async fn write_file_internal(
    workspace: &Path,
    path: String,
    content: String,
    create_dirs: Option<bool>,
    allow_outside_workspace: Option<bool>,
) -> Result<WriteResultDto, BackendError> {
    write_file_internal_with_revision(
        workspace,
        path,
        content,
        create_dirs,
        allow_outside_workspace,
        None,
    )
    .await
}

pub async fn write_file_internal_with_revision(
    workspace: &Path,
    path: String,
    content: String,
    create_dirs: Option<bool>,
    allow_outside_workspace: Option<bool>,
    expected_revision: Option<&str>,
) -> Result<WriteResultDto, BackendError> {
    write_file_internal_with_revision_impl(
        workspace,
        path,
        content,
        create_dirs,
        allow_outside_workspace,
        expected_revision,
        true,
    )
    .await
}

pub(crate) async fn write_file_internal_with_revision_unlocked(
    workspace: &Path,
    path: String,
    content: String,
    create_dirs: Option<bool>,
    allow_outside_workspace: Option<bool>,
    expected_revision: Option<&str>,
) -> Result<WriteResultDto, BackendError> {
    write_file_internal_with_revision_impl(
        workspace,
        path,
        content,
        create_dirs,
        allow_outside_workspace,
        expected_revision,
        false,
    )
    .await
}

async fn write_file_internal_with_revision_impl(
    workspace: &Path,
    path: String,
    content: String,
    create_dirs: Option<bool>,
    allow_outside_workspace: Option<bool>,
    expected_revision: Option<&str>,
    acquire_lock: bool,
) -> Result<WriteResultDto, BackendError> {
    let workspace_string = workspace.to_string_lossy();
    if let Some(wsl_workspace) = parse_wsl_unc_path(&workspace_string) {
        return write_wsl_file_internal_with_revision(
            &wsl_workspace,
            path,
            content,
            create_dirs,
            allow_outside_workspace,
            expected_revision,
            acquire_lock,
        )
        .await;
    }

    let path_buf = PathBuf::from(&path);

    // Check write size limit
    let content_bytes = content.as_bytes();
    if content_bytes.len() as u64 > MAX_WRITE_SIZE_BYTES {
        return Err(BackendError::FilesystemFileTooLarge {
            message: format!(
                "Content exceeds maximum write size of {} bytes",
                MAX_WRITE_SIZE_BYTES
            ),
        });
    }

    // Validate path for write (handles non-existent files)
    let allow_outside = allow_outside_workspace.unwrap_or(false);
    let validated_path = if allow_outside {
        if path_buf.is_absolute() {
            normalize_path(&path_buf)
        } else {
            normalize_path(&workspace.join(&path_buf))
        }
    } else {
        validate_path_for_write(&path_buf, workspace)?
    };
    let _mutation_guard = if acquire_lock {
        Some(
            super::content_mutation_lock(
                &super::native_content_mutation_key(&validated_path).await,
            )
            .lock_owned()
            .await,
        )
    } else {
        None
    };

    let existing_bytes = match tokio::fs::read(&validated_path).await {
        Ok(bytes) => Some(bytes),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(io_error_to_backend_error(error, &validated_path)),
    };
    let actual_revision = existing_bytes.as_deref().map(content_revision);
    validate_expected_revision(&path, expected_revision, actual_revision.as_deref())?;

    // Check if file already exists
    let created = existing_bytes.is_none();
    if let Some(existing_bytes) = existing_bytes.as_deref() {
        if existing_bytes == content_bytes {
            return Ok(WriteResultDto {
                path: validated_path.to_string_lossy().to_string(),
                bytes_written: 0,
                created: false,
                skipped: true,
                revision: content_revision(content_bytes),
            });
        }
    }

    // Get parent directory
    let parent = validated_path
        .parent()
        .ok_or_else(|| BackendError::FilesystemInvalidPath {
            message: format!("Path '{}' has no parent directory", path),
        })?;

    // Create parent directories if requested (default: true)
    let should_create_dirs = create_dirs.unwrap_or(true);
    if should_create_dirs && !parent.exists() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| io_error_to_backend_error(e, parent))?;
    }

    // Atomic write implementation using temp file + rename
    let temp_suffix = format!(".tmp.{}", uuid::Uuid::new_v4());
    let temp_path = validated_path.with_extension(temp_suffix);

    // Write to temp file
    tokio::fs::write(&temp_path, content_bytes)
        .await
        .map_err(|e| io_error_to_backend_error(e, &temp_path))?;

    if expected_revision.is_some() {
        let latest_revision = match tokio::fs::read(&validated_path).await {
            Ok(bytes) => Some(content_revision(&bytes)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => {
                let _ = tokio::fs::remove_file(&temp_path).await;
                return Err(io_error_to_backend_error(error, &validated_path));
            }
        };
        if let Err(error) =
            validate_expected_revision(&path, expected_revision, latest_revision.as_deref())
        {
            let _ = tokio::fs::remove_file(&temp_path).await;
            return Err(error);
        }
    }

    // Rename temp file to final path (atomic operation)
    match tokio::fs::rename(&temp_path, &validated_path).await {
        Ok(_) => {}
        Err(e) => {
            // Clean up temp file on rename failure
            let _ = tokio::fs::remove_file(&temp_path).await;
            return Err(io_error_to_backend_error(e, &validated_path));
        }
    }

    // Audit logging
    tracing::info!(
        operation = "fs_write_file",
        path = %validated_path.display(),
        bytes_written = content_bytes.len(),
        created = created,
        "File written successfully"
    );

    Ok(WriteResultDto {
        path: validated_path.to_string_lossy().to_string(),
        bytes_written: content_bytes.len() as u64,
        created,
        skipped: false,
        revision: content_revision(content_bytes),
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn fs_write_file(
    workspace_root: tauri::State<'_, WorkspaceRoot>,
    git_state: tauri::State<'_, GitState>,
    path: String,
    content: String,
    create_dirs: Option<bool>,
    allow_outside_workspace: Option<bool>,
    workspace_scope: Option<String>,
    workspace_path: Option<String>,
    expected_revision: Option<String>,
) -> Result<WriteResultDto, BackendError> {
    let effective_path = if is_macro_scoped_path(&path) {
        map_macro_virtual_path(&path)
    } else {
        path.clone()
    };
    let workspace = workspace_root.inner().read().await.clone();
    let workspace = resolve_workspace_for_path(
        workspace,
        git_state.inner().clone(),
        workspace_path.map(PathBuf::from),
        &path,
        allow_outside_workspace,
        workspace_scope.as_deref(),
    )
    .await?;
    write_file_internal_with_revision(
        &workspace,
        effective_path,
        content,
        create_dirs,
        allow_outside_workspace,
        expected_revision.as_deref(),
    )
    .await
}

/// Internal function for listing directory contents
pub async fn list_dir_internal(
    workspace: &Path,
    path: String,
    recursive: Option<bool>,
    include_hidden: Option<bool>,
    max_depth: Option<u32>,
    allow_outside_workspace: Option<bool>,
) -> Result<Vec<DirEntryDto>, BackendError> {
    let workspace_string = workspace.to_string_lossy();
    if let Some(wsl_workspace) = parse_wsl_unc_path(&workspace_string) {
        return list_wsl_dir_internal(
            &wsl_workspace,
            path,
            recursive,
            include_hidden,
            max_depth,
            allow_outside_workspace,
        )
        .await;
    }

    let path_buf = PathBuf::from(&path);
    let allow_outside = allow_outside_workspace.unwrap_or(false);
    let validated_path = if allow_outside {
        if path_buf.is_absolute() {
            normalize_path(&path_buf)
        } else {
            normalize_path(&workspace.join(&path_buf))
        }
    } else {
        validate_path(&path_buf, workspace)?
    };

    // Verify path is a directory
    let metadata = tokio::fs::metadata(&validated_path)
        .await
        .map_err(|e| io_error_to_backend_error(e, &validated_path))?;
    if !metadata.is_dir() {
        return Err(BackendError::FilesystemIsFile {
            message: format!("Path '{}' is a file, not a directory", path),
        });
    }

    let should_include_hidden = include_hidden.unwrap_or(false);
    let should_recurse = recursive.unwrap_or(false);
    let depth_limit = max_depth.unwrap_or(u32::MAX);

    let mut entries = Vec::new();

    if should_recurse {
        // Use walkdir for recursive listing
        let mut walkdir = walkdir::WalkDir::new(&validated_path)
            .max_depth(depth_limit as usize)
            .into_iter();

        while let Some(entry_result) = walkdir.next() {
            let entry = entry_result.map_err(|e| BackendError::Filesystem {
                message: format!("Failed to read directory entry: {}", e),
            })?;

            let entry_path = entry.path();

            // Skip the root directory itself
            if entry_path == validated_path {
                continue;
            }

            // Check if path should be ignored
            if should_ignore_path(entry_path, should_include_hidden) {
                if entry.file_type().is_dir() {
                    walkdir.skip_current_dir();
                }
                continue;
            }

            let dto = create_dir_entry_dto(entry_path, workspace, &validated_path).await?;
            entries.push(dto);
        }
    } else {
        // Non-recursive listing using read_dir
        let mut dir = tokio::fs::read_dir(&validated_path)
            .await
            .map_err(|e| io_error_to_backend_error(e, &validated_path))?;

        while let Some(entry) = dir.next_entry().await? {
            let entry_path = entry.path();

            if should_ignore_path(&entry_path, should_include_hidden) {
                continue;
            }

            let dto = create_dir_entry_dto(&entry_path, workspace, &validated_path).await?;
            entries.push(dto);
        }
    }

    // Sort entries: directories first, then files, alphabetically
    entries.sort_by(|a, b| {
        let a_is_dir = a.kind == "directory";
        let b_is_dir = b.kind == "directory";
        match (a_is_dir, b_is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        }
    });

    Ok(entries)
}

/// Check if a path should be ignored based on default patterns
fn should_ignore_path(path: &Path, include_hidden: bool) -> bool {
    let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");

    // Check hidden files
    if !include_hidden && file_name.starts_with('.') {
        return true;
    }

    // Check default ignored patterns
    DEFAULT_IGNORED.contains(&file_name)
}

fn normalize_search_text(value: &str) -> String {
    value.trim().replace('\\', "/").to_lowercase()
}

fn workspace_file_match_score(query: &str, relative_path: &str, name: &str) -> i32 {
    if query.is_empty() {
        return 0;
    }

    let normalized_path = normalize_search_text(relative_path);
    let normalized_name = normalize_search_text(name);
    if normalized_path == query || normalized_name == query {
        return 100;
    }
    if normalized_name.starts_with(query) {
        return 75;
    }
    if normalized_path.starts_with(query) {
        return 65;
    }
    if normalized_path
        .split('/')
        .any(|segment| segment.starts_with(query))
    {
        return 50;
    }
    if normalized_path.contains(query) || normalized_name.contains(query) {
        return 30;
    }
    0
}

fn to_slash_path(value: &Path) -> String {
    value.to_string_lossy().replace('\\', "/")
}

fn search_workspace_files_blocking(
    roots: Vec<WorkspaceFileSearchRootDto>,
    query: String,
    limit: Option<u32>,
    include_hidden: Option<bool>,
    virtual_root_enabled: Option<bool>,
) -> Result<Vec<WorkspaceFileSearchResultDto>, BackendError> {
    let normalized_query = normalize_search_text(&query);
    if normalized_query.is_empty() {
        return Ok(Vec::new());
    }

    let result_limit = limit
        .map(|value| value as usize)
        .unwrap_or(30)
        .clamp(1, MAX_FILE_SEARCH_RESULTS);
    let should_include_hidden = include_hidden.unwrap_or(false);
    let use_virtual_root = virtual_root_enabled.unwrap_or(false);
    let mut candidates: Vec<(i32, WorkspaceFileSearchResultDto)> = Vec::new();

    for root in roots {
        let workspace = PathBuf::from(root.workspace_path.trim());
        if workspace.as_os_str().is_empty() || !workspace.is_dir() {
            continue;
        }

        let mut walkdir = walkdir::WalkDir::new(&workspace).into_iter();
        while let Some(entry_result) = walkdir.next() {
            let entry = entry_result.map_err(|error| BackendError::Filesystem {
                message: format!("Failed to read directory entry: {}", error),
            })?;
            let entry_path = entry.path();
            let relative_path_buf = match entry_path.strip_prefix(&workspace) {
                Ok(path) => path,
                Err(_) => continue,
            };

            if !relative_path_buf.as_os_str().is_empty()
                && should_ignore_path(relative_path_buf, should_include_hidden)
            {
                if entry.file_type().is_dir() {
                    walkdir.skip_current_dir();
                }
                continue;
            }

            if !entry.file_type().is_file() {
                continue;
            }

            let relative_path = to_slash_path(relative_path_buf);
            let name = entry_path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("")
                .to_string();
            let score = workspace_file_match_score(&normalized_query, &relative_path, &name);
            if score <= 0 {
                continue;
            }

            let metadata = entry.metadata().map_err(|error| BackendError::Filesystem {
                message: format!("Failed to read file metadata: {}", error),
            })?;
            let modified = metadata
                .modified()
                .ok()
                .map(|time| chrono::DateTime::<chrono::Utc>::from(time).to_rfc3339());
            let virtual_path = if use_virtual_root {
                root.mount_name
                    .as_deref()
                    .filter(|value| !value.trim().is_empty())
                    .map(|mount| format!("{}/{}", mount.trim().trim_matches('/'), relative_path))
                    .unwrap_or_else(|| relative_path.clone())
            } else {
                relative_path.clone()
            };
            let id_project = root
                .project_id
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or("workspace");

            candidates.push((
                score,
                WorkspaceFileSearchResultDto {
                    id: format!("file:{}:{}", id_project, virtual_path),
                    path: virtual_path,
                    relative_path,
                    project_id: root.project_id.clone(),
                    project_name: root.project_name.clone(),
                    language: get_file_language(entry_path),
                    size_bytes: Some(metadata.len()),
                    modified,
                    is_focused: root.is_focused,
                },
            ));

            if candidates.len() >= MAX_FILE_SEARCH_CANDIDATES {
                break;
            }
        }

        if candidates.len() >= MAX_FILE_SEARCH_CANDIDATES {
            break;
        }
    }

    candidates.sort_by(|(left_score, left), (right_score, right)| {
        right_score
            .cmp(left_score)
            .then_with(|| left.path.to_lowercase().cmp(&right.path.to_lowercase()))
    });
    candidates.truncate(result_limit);
    Ok(candidates.into_iter().map(|(_, result)| result).collect())
}

async fn search_wsl_workspace_files(
    root: WorkspaceFileSearchRootDto,
    query: &str,
    limit: usize,
    include_hidden: Option<bool>,
    virtual_root_enabled: Option<bool>,
) -> Result<Vec<WorkspaceFileSearchResultDto>, BackendError> {
    let Some(wsl_root) = parse_wsl_unc_path(root.workspace_path.trim()) else {
        return Ok(Vec::new());
    };
    let should_include_hidden = include_hidden.unwrap_or(false);
    let include_hidden_flag = if should_include_hidden { "1" } else { "0" }.to_string();
    let script = r#"
root=$1
include_hidden=$2
limit=$3
if [ "$include_hidden" = "1" ]; then
  find "$root" -mindepth 1 -maxdepth 8 \( -type d \( -name .git -o -name node_modules -o -name target -o -name .next -o -name .nuxt -o -name dist -o -name build -o -name __pycache__ -o -name .cache -o -name .idea \) -prune \) -o -type f -printf '%P\t%f\t%s\t%T@\n' 2>/dev/null | head -n "$limit"
else
  find "$root" -mindepth 1 -maxdepth 8 \( -type d \( -name .git -o -name node_modules -o -name target -o -name .next -o -name .nuxt -o -name dist -o -name build -o -name __pycache__ -o -name .cache -o -name .idea -o -name '.*' \) -prune \) -o -type f ! -name '.*' -printf '%P\t%f\t%s\t%T@\n' 2>/dev/null | head -n "$limit"
fi
"#;
    let output = run_wsl_shell(
        &wsl_root,
        script,
        &[
            wsl_root.linux_path.clone(),
            include_hidden_flag,
            MAX_FILE_SEARCH_CANDIDATES.to_string(),
        ],
        WSL_FS_TIMEOUT,
    )
    .await?;
    let normalized_query = normalize_search_text(query);
    let use_virtual_root = virtual_root_enabled.unwrap_or(false);
    let mut candidates = Vec::new();
    for line in output.stdout_text().lines() {
        let parts = line.splitn(4, '\t').collect::<Vec<_>>();
        if parts.len() < 4 {
            continue;
        }
        let relative_path = parts[0].replace('\\', "/");
        let name = parts[1].to_string();
        let score = workspace_file_match_score(&normalized_query, &relative_path, &name);
        if score <= 0 {
            continue;
        }
        let virtual_path = if use_virtual_root {
            root.mount_name
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .map(|mount| format!("{}/{}", mount.trim().trim_matches('/'), relative_path))
                .unwrap_or_else(|| relative_path.clone())
        } else {
            relative_path.clone()
        };
        let id_project = root
            .project_id
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("workspace");
        candidates.push((
            score,
            WorkspaceFileSearchResultDto {
                id: format!("file:{}:{}", id_project, virtual_path),
                path: virtual_path,
                relative_path,
                project_id: root.project_id.clone(),
                project_name: root.project_name.clone(),
                language: get_file_language(Path::new(&name)),
                size_bytes: parts[2].trim().parse::<u64>().ok(),
                modified: epoch_to_rfc3339(parts[3]),
                is_focused: root.is_focused,
            },
        ));
    }
    candidates.sort_by(|(left_score, left), (right_score, right)| {
        right_score
            .cmp(left_score)
            .then_with(|| left.path.to_lowercase().cmp(&right.path.to_lowercase()))
    });
    candidates.truncate(limit);
    Ok(candidates.into_iter().map(|(_, result)| result).collect())
}

#[tauri::command]
pub async fn fs_search_files(
    roots: Vec<WorkspaceFileSearchRootDto>,
    query: String,
    limit: Option<u32>,
    include_hidden: Option<bool>,
    virtual_root_enabled: Option<bool>,
) -> Result<Vec<WorkspaceFileSearchResultDto>, BackendError> {
    let result_limit = limit
        .map(|value| value as usize)
        .unwrap_or(30)
        .clamp(1, MAX_FILE_SEARCH_RESULTS);
    let (wsl_roots, windows_roots): (Vec<_>, Vec<_>) = roots
        .into_iter()
        .partition(|root| parse_wsl_unc_path(root.workspace_path.trim()).is_some());

    let mut results = if windows_roots.is_empty() {
        Vec::new()
    } else {
        let query_for_windows = query.clone();
        tokio::task::spawn_blocking(move || {
            search_workspace_files_blocking(
                windows_roots,
                query_for_windows,
                limit,
                include_hidden,
                virtual_root_enabled,
            )
        })
        .await
        .map_err(to_join_error)??
    };

    for root in wsl_roots {
        results.extend(
            search_wsl_workspace_files(
                root,
                &query,
                result_limit,
                include_hidden,
                virtual_root_enabled,
            )
            .await?,
        );
    }

    let normalized_query = normalize_search_text(&query);
    results.sort_by(|left, right| {
        let left_name = left.path.rsplit('/').next().unwrap_or(&left.path);
        let right_name = right.path.rsplit('/').next().unwrap_or(&right.path);
        let left_score =
            workspace_file_match_score(&normalized_query, &left.relative_path, left_name);
        let right_score =
            workspace_file_match_score(&normalized_query, &right.relative_path, right_name);
        right_score
            .cmp(&left_score)
            .then_with(|| left.path.to_lowercase().cmp(&right.path.to_lowercase()))
    });
    results.truncate(result_limit);
    Ok(results)
}

/// Create a DirEntryDto from a file system entry
async fn create_dir_entry_dto(
    entry_path: &Path,
    workspace: &Path,
    base_path: &Path,
) -> Result<DirEntryDto, BackendError> {
    let metadata = tokio::fs::metadata(entry_path)
        .await
        .map_err(|e| io_error_to_backend_error(e, entry_path))?;
    let symlink_metadata = tokio::fs::symlink_metadata(entry_path)
        .await
        .map_err(|e| io_error_to_backend_error(e, entry_path))?;

    let name = entry_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();

    let relative_path = entry_path
        .strip_prefix(base_path)
        .or_else(|_| entry_path.strip_prefix(workspace))
        .unwrap_or(entry_path)
        .to_string_lossy()
        .to_string();

    let kind = if symlink_metadata.is_symlink() {
        "symlink".to_string()
    } else if metadata.is_dir() {
        "directory".to_string()
    } else {
        "file".to_string()
    };

    let size = if metadata.is_file() {
        Some(metadata.len())
    } else {
        None
    };

    let modified = metadata
        .modified()
        .ok()
        .map(|t| chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339());

    let created = metadata
        .created()
        .ok()
        .map(|t| chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339());

    let language = if metadata.is_file() {
        get_file_language(entry_path)
    } else {
        None
    };

    let is_hidden = name.starts_with('.');
    let is_readonly = metadata.permissions().readonly();

    Ok(DirEntryDto {
        path: entry_path.to_string_lossy().to_string(),
        relative_path,
        name,
        kind,
        size,
        modified,
        created,
        language,
        is_hidden,
        is_readonly,
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn fs_list_dir(
    workspace_root: tauri::State<'_, WorkspaceRoot>,
    git_state: tauri::State<'_, GitState>,
    path: String,
    recursive: Option<bool>,
    include_hidden: Option<bool>,
    max_depth: Option<u32>,
    allow_outside_workspace: Option<bool>,
    workspace_scope: Option<String>,
    workspace_path: Option<String>,
) -> Result<Vec<DirEntryDto>, BackendError> {
    let effective_path = if is_macro_scoped_path(&path) {
        map_macro_virtual_path(&path)
    } else {
        path.clone()
    };
    let workspace = workspace_root.inner().read().await.clone();
    let workspace = resolve_workspace_for_path(
        workspace,
        git_state.inner().clone(),
        workspace_path.map(PathBuf::from),
        &path,
        allow_outside_workspace,
        workspace_scope.as_deref(),
    )
    .await?;
    list_dir_internal(
        &workspace,
        effective_path,
        recursive,
        include_hidden,
        max_depth,
        allow_outside_workspace,
    )
    .await
}

/// Internal function for getting file stats
pub async fn stat_internal(workspace: &Path, path: String) -> Result<FileStatsDto, BackendError> {
    let workspace_string = workspace.to_string_lossy();
    if let Some(wsl_workspace) = parse_wsl_unc_path(&workspace_string) {
        return stat_wsl_internal(&wsl_workspace, path).await;
    }

    let path_buf = PathBuf::from(&path);
    let validated_path = validate_path_for_write(&path_buf, workspace)?;

    if !validated_path.exists() {
        return Err(BackendError::FilesystemNotFound {
            message: format!("Path not found: {}", validated_path.display()),
        });
    }

    let metadata = tokio::fs::metadata(&validated_path)
        .await
        .map_err(|e| io_error_to_backend_error(e, &validated_path))?;
    let symlink_metadata = tokio::fs::symlink_metadata(&validated_path)
        .await
        .map_err(|e| io_error_to_backend_error(e, &validated_path))?;

    let name = validated_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();

    let kind = if symlink_metadata.is_symlink() {
        "symlink"
    } else if metadata.is_dir() {
        "directory"
    } else {
        "file"
    }
    .to_string();

    let modified = chrono::DateTime::<chrono::Utc>::from(metadata.modified()?).to_rfc3339();

    let created = metadata
        .created()
        .ok()
        .map(|t| chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339());

    let accessed = metadata
        .accessed()
        .ok()
        .map(|t| chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339());

    let permissions = format_permissions(&metadata);

    let language = if metadata.is_file() {
        get_file_language(&validated_path)
    } else {
        None
    };

    let is_hidden = name.starts_with('.');
    let is_readonly = metadata.permissions().readonly();
    let is_symlink = symlink_metadata.is_symlink();

    let symlink_target = if is_symlink {
        tokio::fs::read_link(&validated_path)
            .await
            .ok()
            .map(|p| p.to_string_lossy().to_string())
    } else {
        None
    };

    Ok(FileStatsDto {
        path: validated_path.to_string_lossy().to_string(),
        name,
        kind,
        size: metadata.len(),
        created,
        modified,
        accessed,
        permissions,
        language,
        is_readonly,
        is_hidden,
        is_symlink,
        symlink_target,
    })
}

pub async fn exists_internal(workspace: &Path, path: String) -> Result<bool, BackendError> {
    let workspace_string = workspace.to_string_lossy();
    if let Some(wsl_workspace) = parse_wsl_unc_path(&workspace_string) {
        return wsl_exists_internal(&wsl_workspace, path).await;
    }

    let path_buf = PathBuf::from(&path);
    match validate_path(&path_buf, workspace) {
        Ok(validated_path) => tokio::fs::try_exists(&validated_path)
            .await
            .map_err(BackendError::from),
        Err(BackendError::FilesystemNotFound { .. }) => Ok(false),
        Err(error) => Err(error),
    }
}

pub(crate) async fn delete_path_internal_unlocked(
    workspace: &Path,
    path: String,
    recursive: Option<bool>,
) -> Result<(), BackendError> {
    let workspace_string = workspace.to_string_lossy();
    if let Some(wsl_workspace) = parse_wsl_unc_path(&workspace_string) {
        return delete_wsl_path_internal(&wsl_workspace, path, recursive).await;
    }

    let path_buf = PathBuf::from(&path);
    let validated_path = validate_path(&path_buf, workspace)?;

    let metadata = tokio::fs::metadata(&validated_path)
        .await
        .map_err(|e| io_error_to_backend_error(e, &validated_path))?;

    if metadata.is_file() {
        tokio::fs::remove_file(&validated_path)
            .await
            .map_err(|e| io_error_to_backend_error(e, &validated_path))?;
    } else if metadata.is_dir() {
        let should_recurse = recursive.unwrap_or(false);
        if should_recurse {
            tokio::fs::remove_dir_all(&validated_path)
                .await
                .map_err(|e| io_error_to_backend_error(e, &validated_path))?;
        } else {
            tokio::fs::remove_dir(&validated_path)
                .await
                .map_err(|e| io_error_to_backend_error(e, &validated_path))?;
        }
    }

    tracing::info!(
        operation = "fs_delete",
        path = %validated_path.display(),
        is_directory = metadata.is_dir(),
        recursive = recursive.unwrap_or(false),
        "File or directory deleted"
    );

    Ok(())
}

pub async fn delete_path_internal_with_revision(
    workspace: &Path,
    path: String,
    recursive: Option<bool>,
    expected_revision: Option<&str>,
) -> Result<(), BackendError> {
    delete_path_internal_with_revision_impl(workspace, path, recursive, expected_revision, true)
        .await
}

pub(crate) async fn delete_path_internal_with_revision_unlocked(
    workspace: &Path,
    path: String,
    recursive: Option<bool>,
    expected_revision: Option<&str>,
) -> Result<(), BackendError> {
    delete_path_internal_with_revision_impl(workspace, path, recursive, expected_revision, false)
        .await
}

async fn delete_path_internal_with_revision_impl(
    workspace: &Path,
    path: String,
    recursive: Option<bool>,
    expected_revision: Option<&str>,
    acquire_lock: bool,
) -> Result<(), BackendError> {
    let workspace_string = workspace.to_string_lossy();
    if let Some(wsl_workspace) = parse_wsl_unc_path(&workspace_string) {
        return delete_wsl_path_internal_with_revision(
            &wsl_workspace,
            path,
            recursive,
            expected_revision,
            acquire_lock,
        )
        .await;
    }
    let validated_path = validate_path(&PathBuf::from(&path), workspace)?;
    let _mutation_guard = if acquire_lock {
        Some(
            super::content_mutation_lock(
                &super::native_content_mutation_key(&validated_path).await,
            )
            .lock_owned()
            .await,
        )
    } else {
        None
    };
    if expected_revision.is_some() {
        let actual_revision = match read_file_internal(workspace, path.clone(), Some(false)).await {
            Ok(current) => Some(current.revision),
            Err(BackendError::FilesystemNotFound { .. }) => None,
            Err(error) => return Err(error),
        };
        validate_expected_revision(&path, expected_revision, actual_revision.as_deref())?;
    }
    delete_path_internal_unlocked(workspace, path, recursive).await
}

/// Format file permissions based on platform
#[cfg(unix)]
fn format_permissions(metadata: &std::fs::Metadata) -> String {
    use std::os::unix::fs::PermissionsExt;
    format!("{:04o}", metadata.permissions().mode() & 0o7777)
}

#[cfg(windows)]
fn format_permissions(metadata: &std::fs::Metadata) -> String {
    let attrs = metadata.file_attributes();
    let mut parts = Vec::new();
    if attrs & 0x1 != 0 {
        parts.push("readonly");
    }
    if attrs & 0x2 != 0 {
        parts.push("hidden");
    }
    if attrs & 0x4 != 0 {
        parts.push("system");
    }
    if parts.is_empty() {
        "normal".to_string()
    } else {
        parts.join(",")
    }
}

#[tauri::command]
pub async fn fs_stat(
    workspace_root: tauri::State<'_, WorkspaceRoot>,
    git_state: tauri::State<'_, GitState>,
    path: String,
    workspace_scope: Option<String>,
    workspace_path: Option<String>,
) -> Result<FileStatsDto, BackendError> {
    let effective_path = if is_macro_scoped_path(&path) {
        map_macro_virtual_path(&path)
    } else {
        path.clone()
    };
    let workspace = workspace_root.inner().read().await.clone();
    let workspace = resolve_workspace_for_path(
        workspace,
        git_state.inner().clone(),
        workspace_path.map(PathBuf::from),
        &path,
        None,
        workspace_scope.as_deref(),
    )
    .await?;
    stat_internal(&workspace, effective_path).await
}

#[tauri::command]
pub async fn fs_exists(
    workspace_root: tauri::State<'_, WorkspaceRoot>,
    git_state: tauri::State<'_, GitState>,
    path: String,
    workspace_scope: Option<String>,
    workspace_path: Option<String>,
) -> Result<bool, BackendError> {
    let effective_path = if is_macro_scoped_path(&path) {
        map_macro_virtual_path(&path)
    } else {
        path.clone()
    };
    let workspace = workspace_root.inner().read().await.clone();
    let workspace = resolve_workspace_for_path(
        workspace,
        git_state.inner().clone(),
        workspace_path.map(PathBuf::from),
        &path,
        None,
        workspace_scope.as_deref(),
    )
    .await?;
    exists_internal(&workspace, effective_path).await
}

#[tauri::command]
pub async fn fs_delete(
    workspace_root: tauri::State<'_, WorkspaceRoot>,
    git_state: tauri::State<'_, GitState>,
    path: String,
    recursive: Option<bool>,
    workspace_scope: Option<String>,
    workspace_path: Option<String>,
    expected_revision: Option<String>,
) -> Result<(), BackendError> {
    let effective_path = if is_macro_scoped_path(&path) {
        map_macro_virtual_path(&path)
    } else {
        path.clone()
    };
    let workspace = workspace_root.inner().read().await.clone();
    let workspace = resolve_workspace_for_path(
        workspace,
        git_state.inner().clone(),
        workspace_path.map(PathBuf::from),
        &path,
        None,
        workspace_scope.as_deref(),
    )
    .await?;
    delete_path_internal_with_revision(
        &workspace,
        effective_path,
        recursive,
        expected_revision.as_deref(),
    )
    .await
}

#[tauri::command]
pub async fn fs_create_dir(
    workspace_root: tauri::State<'_, WorkspaceRoot>,
    git_state: tauri::State<'_, GitState>,
    path: String,
    recursive: Option<bool>,
    workspace_scope: Option<String>,
    workspace_path: Option<String>,
) -> Result<(), BackendError> {
    let effective_path = if is_macro_scoped_path(&path) {
        map_macro_virtual_path(&path)
    } else {
        path.clone()
    };
    let workspace = workspace_root.inner().read().await.clone();
    let workspace = resolve_workspace_for_path(
        workspace,
        git_state.inner().clone(),
        workspace_path.map(PathBuf::from),
        &path,
        None,
        workspace_scope.as_deref(),
    )
    .await?;
    let workspace_string = workspace.to_string_lossy();
    if let Some(wsl_workspace) = parse_wsl_unc_path(&workspace_string) {
        return create_wsl_dir_internal(&wsl_workspace, effective_path, recursive).await;
    }
    let path_buf = PathBuf::from(&effective_path);
    let validated_path = validate_path_for_write(&path_buf, &workspace)?;

    let should_recurse = recursive.unwrap_or(true);
    if should_recurse {
        tokio::fs::create_dir_all(&validated_path)
            .await
            .map_err(|e| io_error_to_backend_error(e, &validated_path))?;
    } else {
        tokio::fs::create_dir(&validated_path)
            .await
            .map_err(|e| io_error_to_backend_error(e, &validated_path))?;
    }

    Ok(())
}

#[tauri::command]
pub async fn fs_copy(
    workspace_root: tauri::State<'_, WorkspaceRoot>,
    git_state: tauri::State<'_, GitState>,
    src: String,
    dest: String,
) -> Result<u64, BackendError> {
    let workspace = workspace_root.inner().read().await.clone();
    let src_macro = is_macro_scoped_path(&src);
    let dest_macro = is_macro_scoped_path(&dest);
    if src_macro != dest_macro {
        return Err(BackendError::Validation(
            "Copy across workspace and metadata roots is not supported".to_string(),
        ));
    }
    let workspace = if src_macro {
        resolve_workspace_for_path(workspace, git_state.inner().clone(), None, &src, None, None)
            .await?
    } else {
        workspace
    };
    let src_effective = if src_macro {
        map_macro_virtual_path(&src)
    } else {
        src.clone()
    };
    let dest_effective = if dest_macro {
        map_macro_virtual_path(&dest)
    } else {
        dest.clone()
    };
    let workspace_string = workspace.to_string_lossy();
    if let Some(wsl_workspace) = parse_wsl_unc_path(&workspace_string) {
        return copy_wsl_path_internal(&wsl_workspace, src_effective, dest_effective).await;
    }
    let src_path = PathBuf::from(&src_effective);
    let dest_path = PathBuf::from(&dest_effective);

    let validated_src = validate_path(&src_path, &workspace)?;
    let validated_dest = validate_path_for_write(&dest_path, &workspace)?;

    // Ensure parent of destination exists
    if let Some(parent) = validated_dest.parent() {
        if !parent.exists() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| io_error_to_backend_error(e, parent))?;
        }
    }

    let bytes_copied = tokio::fs::copy(&validated_src, &validated_dest)
        .await
        .map_err(|e| io_error_to_backend_error(e, &validated_src))?;

    // Audit logging
    tracing::info!(
        operation = "fs_copy",
        src = %validated_src.display(),
        dest = %validated_dest.display(),
        bytes_copied = bytes_copied,
        "File copied successfully"
    );

    Ok(bytes_copied)
}

#[tauri::command]
pub async fn fs_move(
    workspace_root: tauri::State<'_, WorkspaceRoot>,
    git_state: tauri::State<'_, GitState>,
    src: String,
    dest: String,
) -> Result<(), BackendError> {
    let workspace = workspace_root.inner().read().await.clone();
    let src_macro = is_macro_scoped_path(&src);
    let dest_macro = is_macro_scoped_path(&dest);
    if src_macro != dest_macro {
        return Err(BackendError::Validation(
            "Move across workspace and metadata roots is not supported".to_string(),
        ));
    }
    let workspace = if src_macro {
        resolve_workspace_for_path(workspace, git_state.inner().clone(), None, &src, None, None)
            .await?
    } else {
        workspace
    };
    let src_effective = if src_macro {
        map_macro_virtual_path(&src)
    } else {
        src.clone()
    };
    let dest_effective = if dest_macro {
        map_macro_virtual_path(&dest)
    } else {
        dest.clone()
    };
    let workspace_string = workspace.to_string_lossy();
    if let Some(wsl_workspace) = parse_wsl_unc_path(&workspace_string) {
        return move_wsl_path_internal(&wsl_workspace, src_effective, dest_effective).await;
    }
    let src_path = PathBuf::from(&src_effective);
    let dest_path = PathBuf::from(&dest_effective);

    let validated_src = validate_path(&src_path, &workspace)?;
    let validated_dest = validate_path_for_write(&dest_path, &workspace)?;

    // Try atomic rename first
    match tokio::fs::rename(&validated_src, &validated_dest).await {
        Ok(_) => {
            tracing::info!(
                operation = "fs_move",
                src = %validated_src.display(),
                dest = %validated_dest.display(),
                method = "rename",
                "File moved successfully (atomic rename)"
            );
            Ok(())
        }
        Err(rename_err) => {
            // Rename failed (likely cross-filesystem), fallback to copy + delete
            tracing::debug!("Rename failed, falling back to copy+delete: {}", rename_err);

            // Ensure parent of destination exists
            if let Some(parent) = validated_dest.parent() {
                if !parent.exists() {
                    tokio::fs::create_dir_all(parent)
                        .await
                        .map_err(|e| io_error_to_backend_error(e, parent))?;
                }
            }

            // Copy file
            tokio::fs::copy(&validated_src, &validated_dest)
                .await
                .map_err(|e| io_error_to_backend_error(e, &validated_src))?;

            // Delete source
            let src_metadata = tokio::fs::metadata(&validated_src)
                .await
                .map_err(|e| io_error_to_backend_error(e, &validated_src))?;
            if src_metadata.is_dir() {
                tokio::fs::remove_dir_all(&validated_src)
                    .await
                    .map_err(|e| io_error_to_backend_error(e, &validated_src))?;
            } else {
                tokio::fs::remove_file(&validated_src)
                    .await
                    .map_err(|e| io_error_to_backend_error(e, &validated_src))?;
            }

            tracing::info!(
                operation = "fs_move",
                src = %validated_src.display(),
                dest = %validated_dest.display(),
                method = "copy_delete",
                "File moved successfully (copy+delete fallback)"
            );

            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::Repository;
    use std::collections::HashSet;
    use std::fs;
    use std::io::Write;
    use tempfile::TempDir;

    // Helper function to create a test workspace with sample files
    fn setup_test_workspace() -> TempDir {
        let temp_dir = TempDir::new().expect("Failed to create temp directory");
        let workspace_path = temp_dir.path();

        // Create a sample text file
        let text_file_path = workspace_path.join("sample.txt");
        let mut text_file = fs::File::create(&text_file_path).expect("Failed to create text file");
        writeln!(text_file, "Hello, World!").expect("Failed to write to text file");

        // Create a Rust source file
        let rust_file_path = workspace_path.join("main.rs");
        let mut rust_file = fs::File::create(&rust_file_path).expect("Failed to create Rust file");
        writeln!(
            rust_file,
            "fn main() {{\n    println!(\"Hello, Rust!\");\n}}"
        )
        .expect("Failed to write to Rust file");

        // Create a JavaScript file
        let js_file_path = workspace_path.join("script.js");
        let mut js_file = fs::File::create(&js_file_path).expect("Failed to create JS file");
        writeln!(js_file, "console.log('Hello, JS!');").expect("Failed to write to JS file");

        // Create a subdirectory with a file
        let subdir = workspace_path.join("subdir");
        fs::create_dir(&subdir).expect("Failed to create subdirectory");
        let subfile_path = subdir.join("nested.txt");
        let mut subfile = fs::File::create(&subfile_path).expect("Failed to create nested file");
        writeln!(subfile, "Nested content").expect("Failed to write to nested file");

        // Create a binary file (with null bytes)
        let binary_file_path = workspace_path.join("binary.bin");
        fs::write(&binary_file_path, [0u8, 255u8, 128u8, 0u8])
            .expect("Failed to create binary file");

        // Create an empty file
        fs::File::create(workspace_path.join("empty.txt")).expect("Failed to create empty file");

        temp_dir
    }

    fn setup_empty_workspace() -> TempDir {
        TempDir::new().expect("Failed to create temp directory")
    }

    #[test]
    fn test_search_workspace_files_respects_ignores_limit_and_virtual_paths() {
        let workspace = setup_empty_workspace();
        let workspace_path = workspace.path();
        fs::create_dir_all(workspace_path.join("src/components")).expect("create source dirs");
        fs::create_dir_all(workspace_path.join("node_modules/pkg")).expect("create ignored dir");
        fs::write(
            workspace_path.join("src/App.tsx"),
            "export const App = () => null;",
        )
        .expect("write app");
        fs::write(
            workspace_path.join("src/components/Button.tsx"),
            "export const Button = () => null;",
        )
        .expect("write button");
        fs::write(workspace_path.join("node_modules/pkg/index.ts"), "ignored")
            .expect("write ignored");
        fs::write(workspace_path.join(".env"), "SECRET=value").expect("write hidden");

        let root = WorkspaceFileSearchRootDto {
            project_id: Some("project-1".to_string()),
            project_name: Some("Web".to_string()),
            workspace_path: workspace_path.to_string_lossy().to_string(),
            mount_name: Some("web".to_string()),
            is_focused: true,
        };

        let results = search_workspace_files_blocking(
            vec![root.clone()],
            "src".to_string(),
            Some(10),
            Some(false),
            Some(true),
        )
        .expect("search results");
        let paths: Vec<String> = results.iter().map(|result| result.path.clone()).collect();
        assert!(paths.contains(&"web/src/App.tsx".to_string()));
        assert!(paths.contains(&"web/src/components/Button.tsx".to_string()));
        assert!(!paths.iter().any(|path| path.contains("node_modules")));
        assert!(results.iter().all(|result| result.is_focused));

        let hidden_results = search_workspace_files_blocking(
            vec![root.clone()],
            "env".to_string(),
            Some(10),
            Some(false),
            Some(true),
        )
        .expect("hidden search results");
        assert!(hidden_results.is_empty());

        let limited_results = search_workspace_files_blocking(
            vec![root],
            "tsx".to_string(),
            Some(1),
            Some(false),
            Some(true),
        )
        .expect("limited search results");
        assert_eq!(limited_results.len(), 1);
    }

    fn init_git_repo(path: &Path) -> Repository {
        let repo = Repository::init(path).expect("init repo");
        let file_path = path.join("README.md");
        fs::write(&file_path, "hello").expect("write file");

        let mut index = repo.index().expect("index");
        index.add_path(Path::new("README.md")).expect("add");
        let tree_id = index.write_tree().expect("write tree");
        {
            let tree = repo.find_tree(tree_id).expect("tree");
            let sig = git2::Signature::now("Tester", "tester@example.com").expect("sig");
            repo.commit(Some("HEAD"), &sig, &sig, "initial", &tree, &[])
                .expect("commit");
        }

        repo
    }

    #[test]
    fn test_metadata_path_mapping_preserves_addressing_boundary() {
        for (path, expected) in [
            (".macro", "."),
            ("./.macro/workspace.json", "workspace.json"),
            (
                ".macro/branches/main/plans/index.json",
                "branches/main/plans/index.json",
            ),
        ] {
            assert!(is_macro_scoped_path(path), "virtual metadata path: {path}");
            assert_eq!(map_macro_virtual_path(path), expected, "path: {path}");
        }

        for path in [
            "workspace.json",
            "branches/main/plans/index.json",
            ".macro/../workspace.json",
            ".macro/../../outside.json",
            ".macro-neighbor/workspace.json",
        ] {
            assert!(
                !is_macro_scoped_path(path),
                "non-virtual or escaping path: {path}"
            );
        }
    }

    #[tokio::test]
    async fn test_metadata_path_resolution_aligns_explicit_and_virtual_scopes() {
        let default_workspace = setup_empty_workspace();
        let explicit_repo = setup_empty_workspace();
        let _repo = init_git_repo(explicit_repo.path());
        let git_state = GitState::new();

        let resolved = resolve_workspace_for_path(
            default_workspace.path().to_path_buf(),
            git_state.clone(),
            Some(explicit_repo.path().to_path_buf()),
            "branches/develop/plans/index.json",
            None,
            Some("metadata"),
        )
        .await
        .expect("resolve metadata workspace");

        let resolved = resolved.canonicalize().expect("canonical resolved path");
        let explicit_repo_canonical = explicit_repo
            .path()
            .canonicalize()
            .expect("canonical explicit repo");

        assert!(resolved.starts_with(&explicit_repo_canonical));
        assert!(resolved.ends_with(Path::new("macro-metadata-worktree")));

        let virtual_resolved = resolve_workspace_for_path(
            default_workspace.path().to_path_buf(),
            git_state,
            Some(explicit_repo.path().to_path_buf()),
            ".macro/workspace.json",
            None,
            None,
        )
        .await
        .expect("resolve virtual metadata workspace")
        .canonicalize()
        .expect("canonical virtual metadata workspace");

        assert_eq!(virtual_resolved, resolved);
    }

    #[tokio::test]
    async fn test_resolve_workspace_for_path_uses_existing_metadata_worktree_when_repo_open_fails()
    {
        let default_workspace = setup_empty_workspace();
        let explicit_repo = setup_empty_workspace();
        let repo = init_git_repo(explicit_repo.path());
        let git_dir = repo.path().to_path_buf();
        let metadata_worktree = git_dir.join("macro-metadata-worktree");
        fs::create_dir_all(&metadata_worktree).expect("create metadata worktree");
        fs::write(
            metadata_worktree.join(".git"),
            "gitdir: ../worktrees/macro-metadata\n",
        )
        .expect("write metadata gitfile");
        {
            let mut config = fs::OpenOptions::new()
                .append(true)
                .open(git_dir.join("config"))
                .expect("open git config");
            writeln!(
                config,
                "\n[extensions]\n\trelativeWorktrees = true\n\tworktreeConfig = true"
            )
            .expect("write relative worktree extension");
        }
        drop(repo);

        let resolved = resolve_workspace_for_path(
            default_workspace.path().to_path_buf(),
            GitState::new(),
            Some(explicit_repo.path().to_path_buf()),
            "branches/develop/plans/index.json",
            None,
            Some("metadata"),
        )
        .await
        .expect("resolve metadata workspace");

        let resolved = resolved.canonicalize().expect("canonical resolved path");
        let expected = metadata_worktree
            .canonicalize()
            .expect("canonical metadata worktree");
        assert_eq!(resolved, expected);
    }

    #[tokio::test]
    async fn test_read_text_file_success() {
        let workspace = setup_test_workspace();
        let workspace_path = workspace.path().to_path_buf();

        let result = read_file_internal(&workspace_path, "sample.txt".to_string(), None).await;

        assert!(result.is_ok());
        let dto = result.unwrap();
        assert!(!dto.is_binary);
        assert_eq!(dto.content, "Hello, World!\n");
        assert_eq!(
            dto.revision,
            "c98c24b677eff44860afea6f493bbaec5bb1c4cbb209c6fc2bbb47f66ff2ad31"
        );
        // Language detection may vary for .txt files, so we just check it's not empty
        assert!(!dto.language.is_empty());
        assert!(!dto.encoding.is_empty());
    }

    #[tokio::test]
    async fn test_read_rust_file() {
        let workspace = setup_test_workspace();
        let workspace_path = workspace.path().to_path_buf();

        let result = read_file_internal(&workspace_path, "main.rs".to_string(), None).await;

        assert!(result.is_ok());
        let dto = result.unwrap();
        assert!(!dto.is_binary);
        assert!(dto.content.contains("fn main"));
        assert_eq!(dto.language, "Rust");
    }

    #[tokio::test]
    async fn test_read_javascript_file() {
        let workspace = setup_test_workspace();
        let workspace_path = workspace.path().to_path_buf();

        let result = read_file_internal(&workspace_path, "script.js".to_string(), None).await;

        assert!(result.is_ok());
        let dto = result.unwrap();
        assert!(!dto.is_binary);
        assert!(dto.content.contains("console.log"));
        assert_eq!(dto.language, "JavaScript");
    }

    #[tokio::test]
    async fn test_read_nested_file() {
        let workspace = setup_test_workspace();
        let workspace_path = workspace.path().to_path_buf();

        let result =
            read_file_internal(&workspace_path, "subdir/nested.txt".to_string(), None).await;

        assert!(result.is_ok());
        let dto = result.unwrap();
        assert!(!dto.is_binary);
        assert_eq!(dto.content, "Nested content\n");
    }

    #[tokio::test]
    async fn test_read_nonexistent_file() {
        let workspace = setup_empty_workspace();
        let workspace_path = workspace.path().to_path_buf();

        let result = read_file_internal(&workspace_path, "missing.txt".to_string(), None).await;

        assert!(matches!(
            result,
            Err(BackendError::FilesystemNotFound { .. })
        ));
    }

    #[tokio::test]
    async fn test_read_file_outside_workspace() {
        let workspace = setup_empty_workspace();
        let workspace_path = workspace.path().to_path_buf();

        let outside_file = workspace.path().parent().unwrap().join("outside.txt");
        fs::write(&outside_file, "outside").unwrap();

        let result = read_file_internal(
            &workspace_path,
            outside_file.to_string_lossy().to_string(),
            None,
        )
        .await;

        assert!(matches!(
            result,
            Err(BackendError::FilesystemPathOutsideWorkspace { .. })
        ));
    }

    #[tokio::test]
    async fn test_read_directory_returns_error() {
        let workspace = setup_test_workspace();
        let workspace_path = workspace.path().to_path_buf();

        let result = read_file_internal(&workspace_path, "subdir".to_string(), None).await;

        assert!(matches!(
            result,
            Err(BackendError::FilesystemIsDirectory { .. })
        ));
    }

    #[tokio::test]
    async fn test_read_binary_file_returns_binary() {
        let workspace = setup_test_workspace();
        let workspace_path = workspace.path().to_path_buf();

        let result = read_file_internal(&workspace_path, "binary.bin".to_string(), None).await;

        assert!(result.is_ok());
        let dto = result.unwrap();
        assert!(dto.is_binary);
        assert_eq!(dto.content, "");
        assert_eq!(dto.encoding, "none");
    }

    #[tokio::test]
    async fn test_read_file_too_large() {
        let workspace = setup_empty_workspace();
        let workspace_path = workspace.path().to_path_buf();

        let large_file = workspace.path().join("large.txt");
        let file = fs::File::create(&large_file).unwrap();
        file.set_len(MAX_FILE_SIZE_BYTES + 1).unwrap();

        let result = read_file_internal(&workspace_path, "large.txt".to_string(), None).await;

        assert!(matches!(
            result,
            Err(BackendError::FilesystemFileTooLarge { .. })
        ));
    }

    #[tokio::test]
    async fn test_write_new_file() {
        let workspace = setup_empty_workspace();
        let workspace_path = workspace.path().to_path_buf();

        let result = write_file_internal(
            &workspace_path,
            "new.txt".to_string(),
            "hello".to_string(),
            Some(true),
            None,
        )
        .await;

        assert!(result.is_ok());
        let dto = result.unwrap();
        assert!(dto.created);
        assert!(!dto.skipped);
        assert_eq!(
            dto.revision,
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
        let written = fs::read_to_string(workspace.path().join("new.txt")).unwrap();
        assert_eq!(written, "hello");
    }

    #[tokio::test]
    async fn test_write_overwrite_file() {
        let workspace = setup_empty_workspace();
        let workspace_path = workspace.path().to_path_buf();

        write_file_internal(
            &workspace_path,
            "file.txt".to_string(),
            "first".to_string(),
            Some(true),
            None,
        )
        .await
        .unwrap();

        let result = write_file_internal(
            &workspace_path,
            "file.txt".to_string(),
            "second".to_string(),
            Some(true),
            None,
        )
        .await;

        assert!(result.is_ok());
        let dto = result.unwrap();
        assert!(!dto.created);
        assert!(!dto.skipped);
        let written = fs::read_to_string(workspace.path().join("file.txt")).unwrap();
        assert_eq!(written, "second");
    }

    #[tokio::test]
    async fn test_write_with_revision_rejects_stale_content() {
        let workspace = setup_empty_workspace();
        let path = workspace.path().join("guarded.txt");
        fs::write(&path, "current").expect("seed guarded file");

        let error = write_file_internal_with_revision(
            workspace.path(),
            "guarded.txt".to_string(),
            "updated".to_string(),
            Some(true),
            None,
            Some("stale-revision"),
        )
        .await
        .expect_err("stale write must fail");

        assert!(error.to_string().contains("Stale content"));
        assert_eq!(
            fs::read_to_string(&path).expect("read guarded file"),
            "current"
        );
    }

    #[tokio::test]
    async fn test_write_with_revision_accepts_matching_content() {
        let workspace = setup_empty_workspace();
        let path = workspace.path().join("guarded.txt");
        fs::write(&path, "current").expect("seed guarded file");
        let revision = content_revision(b"current");

        write_file_internal_with_revision(
            workspace.path(),
            "guarded.txt".to_string(),
            "updated".to_string(),
            Some(true),
            None,
            Some(&revision),
        )
        .await
        .expect("matching revision should write");

        assert_eq!(
            fs::read_to_string(&path).expect("read guarded file"),
            "updated"
        );
    }

    #[tokio::test]
    async fn concurrent_guarded_writes_allow_exactly_one_winner() {
        let workspace = setup_empty_workspace();
        let workspace_path = workspace.path().to_path_buf();
        let path = workspace_path.join("guarded.txt");
        fs::write(&path, "current").expect("seed guarded file");
        let revision = content_revision(b"current");

        let first = write_file_internal_with_revision(
            &workspace_path,
            "guarded.txt".to_string(),
            "first".to_string(),
            Some(true),
            None,
            Some(&revision),
        );
        let second = write_file_internal_with_revision(
            &workspace_path,
            "guarded.txt".to_string(),
            "second".to_string(),
            Some(true),
            None,
            Some(&revision),
        );

        let (first_result, second_result) = tokio::join!(first, second);
        assert_eq!(
            usize::from(first_result.is_ok()) + usize::from(second_result.is_ok()),
            1
        );
        let failure = first_result.err().or_else(|| second_result.err()).unwrap();
        assert!(matches!(failure, BackendError::RevisionConflict { .. }));
        let content = fs::read_to_string(path).expect("read winning content");
        assert!(content == "first" || content == "second");
    }

    #[tokio::test]
    async fn test_write_with_absent_revision_only_creates_a_missing_file() {
        let workspace = setup_empty_workspace();
        let path = workspace.path().join("new.txt");

        write_file_internal_with_revision(
            workspace.path(),
            "new.txt".to_string(),
            "created".to_string(),
            Some(true),
            None,
            Some(EXPECTED_REVISION_ABSENT),
        )
        .await
        .expect("absent guard should allow creation");

        let error = write_file_internal_with_revision(
            workspace.path(),
            "new.txt".to_string(),
            "overwritten".to_string(),
            Some(true),
            None,
            Some(EXPECTED_REVISION_ABSENT),
        )
        .await
        .expect_err("absent guard must reject an existing file");

        assert!(matches!(error, BackendError::RevisionConflict { .. }));
        assert_eq!(fs::read_to_string(path).expect("read new file"), "created");
    }

    #[tokio::test]
    async fn test_write_identical_file_skips_write() {
        let workspace = setup_empty_workspace();
        let workspace_path = workspace.path().to_path_buf();

        write_file_internal(
            &workspace_path,
            "same.txt".to_string(),
            "content".to_string(),
            Some(true),
            None,
        )
        .await
        .unwrap();

        let result = write_file_internal(
            &workspace_path,
            "same.txt".to_string(),
            "content".to_string(),
            Some(true),
            None,
        )
        .await;

        assert!(result.is_ok());
        let dto = result.unwrap();
        assert!(!dto.created);
        assert!(dto.skipped);
        assert_eq!(dto.bytes_written, 0);
        let written = fs::read_to_string(workspace.path().join("same.txt")).unwrap();
        assert_eq!(written, "content");
    }

    #[tokio::test]
    async fn test_write_nested_directories() {
        let workspace = setup_empty_workspace();
        let workspace_path = workspace.path().to_path_buf();

        let result = write_file_internal(
            &workspace_path,
            "a/b/c.txt".to_string(),
            "content".to_string(),
            Some(true),
            None,
        )
        .await;

        assert!(result.is_ok());
        assert!(!result.unwrap().skipped);
        let written = fs::read_to_string(workspace.path().join("a/b/c.txt")).unwrap();
        assert_eq!(written, "content");
    }

    #[tokio::test]
    async fn test_write_outside_workspace() {
        let workspace = setup_empty_workspace();
        let workspace_path = workspace.path().to_path_buf();

        let outside_path = workspace.path().parent().unwrap().join("outside.txt");

        let result = write_file_internal(
            &workspace_path,
            outside_path.to_string_lossy().to_string(),
            "content".to_string(),
            Some(true),
            None,
        )
        .await;

        assert!(matches!(
            result,
            Err(BackendError::FilesystemPathOutsideWorkspace { .. })
        ));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_write_nested_missing_path_through_external_symlink_is_rejected() {
        use std::os::unix::fs::symlink;

        let workspace = setup_empty_workspace();
        let outside = setup_empty_workspace();
        symlink(outside.path(), workspace.path().join("linked")).expect("create external symlink");

        let result = write_file_internal(
            workspace.path(),
            "linked/new/nested.txt".to_string(),
            "must not escape".to_string(),
            Some(true),
            None,
        )
        .await;

        assert!(matches!(
            result,
            Err(BackendError::FilesystemPathOutsideWorkspace { .. })
        ));
        assert!(!outside.path().join("new/nested.txt").exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_write_readonly_directory() {
        use std::os::unix::fs::PermissionsExt;

        let workspace = setup_empty_workspace();
        let workspace_path = workspace.path().to_path_buf();

        let readonly_dir = workspace.path().join("readonly");
        fs::create_dir_all(&readonly_dir).unwrap();
        fs::set_permissions(&readonly_dir, fs::Permissions::from_mode(0o555)).unwrap();

        let result = write_file_internal(
            &workspace_path,
            "readonly/file.txt".to_string(),
            "content".to_string(),
            Some(true),
            None,
        )
        .await;

        assert!(matches!(
            result,
            Err(BackendError::FilesystemPermissionDenied { .. }) | Err(BackendError::Io { .. })
        ));

        fs::set_permissions(&readonly_dir, fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[tokio::test]
    async fn test_list_dir_empty() {
        let workspace = setup_empty_workspace();
        let workspace_path = workspace.path().to_path_buf();

        let result =
            list_dir_internal(&workspace_path, ".".to_string(), None, None, None, None).await;

        assert!(result.is_ok());
        assert!(result.unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_list_dir_with_files() {
        let workspace = setup_test_workspace();
        let workspace_path = workspace.path().to_path_buf();

        let result =
            list_dir_internal(&workspace_path, ".".to_string(), None, None, None, None).await;

        assert!(result.is_ok());
        let entries = result.unwrap();
        let names: HashSet<String> = entries.into_iter().map(|e| e.name).collect();

        for expected in [
            "sample.txt",
            "main.rs",
            "script.js",
            "subdir",
            "binary.bin",
            "empty.txt",
        ] {
            assert!(names.contains(expected));
        }
    }

    #[tokio::test]
    async fn test_list_dir_outside_workspace() {
        let workspace = setup_empty_workspace();
        let workspace_path = workspace.path().to_path_buf();

        let outside_dir = workspace.path().parent().unwrap().join("outside_dir");
        fs::create_dir_all(&outside_dir).unwrap();

        let result = list_dir_internal(
            &workspace_path,
            outside_dir.to_string_lossy().to_string(),
            None,
            None,
            None,
            None,
        )
        .await;

        assert!(matches!(
            result,
            Err(BackendError::FilesystemPathOutsideWorkspace { .. })
        ));

        let _ = fs::remove_dir_all(&outside_dir);
    }

    #[tokio::test]
    async fn test_list_dir_recursive_and_hidden() {
        let workspace = setup_empty_workspace();
        let workspace_path = workspace.path().to_path_buf();

        fs::create_dir_all(workspace.path().join("a/b")).unwrap();
        fs::write(workspace.path().join("a/b/file.txt"), "content").unwrap();
        fs::write(workspace.path().join(".hidden"), "hidden").unwrap();

        let result = list_dir_internal(
            &workspace_path,
            ".".to_string(),
            Some(true),
            Some(false),
            None,
            None,
        )
        .await
        .unwrap();

        assert!(result.iter().any(|e| e.name == "file.txt"));
        assert!(!result.iter().any(|e| e.name == ".hidden"));

        let result_include_hidden = list_dir_internal(
            &workspace_path,
            ".".to_string(),
            Some(true),
            Some(true),
            None,
            None,
        )
        .await
        .unwrap();

        assert!(result_include_hidden.iter().any(|e| e.name == ".hidden"));
    }

    #[tokio::test]
    async fn test_list_dir_ignores_default_dirs() {
        let workspace = setup_empty_workspace();
        let workspace_path = workspace.path().to_path_buf();

        fs::create_dir_all(workspace.path().join("node_modules")).unwrap();
        fs::write(workspace.path().join("node_modules/ignored.txt"), "x").unwrap();

        let result = list_dir_internal(
            &workspace_path,
            ".".to_string(),
            Some(true),
            None,
            None,
            None,
        )
        .await
        .unwrap();

        assert!(!result
            .iter()
            .any(|e| e.relative_path.contains("node_modules")));
    }

    #[tokio::test]
    async fn test_list_dir_on_file_returns_error() {
        let workspace = setup_test_workspace();
        let workspace_path = workspace.path().to_path_buf();

        let result = list_dir_internal(
            &workspace_path,
            "sample.txt".to_string(),
            None,
            None,
            None,
            None,
        )
        .await;

        assert!(matches!(result, Err(BackendError::FilesystemIsFile { .. })));
    }

    #[tokio::test]
    async fn test_stat_file_and_directory() {
        let workspace = setup_test_workspace();
        let workspace_path = workspace.path().to_path_buf();

        let file_stat = stat_internal(&workspace_path, "sample.txt".to_string())
            .await
            .unwrap();
        assert_eq!(file_stat.kind, "file");

        let dir_stat = stat_internal(&workspace_path, "subdir".to_string())
            .await
            .unwrap();
        assert_eq!(dir_stat.kind, "directory");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_stat_symlink() {
        use std::os::unix::fs::symlink;

        let workspace = setup_empty_workspace();
        let workspace_path = workspace.path().to_path_buf();

        let target = workspace.path().join("target.txt");
        fs::write(&target, "content").unwrap();
        let link = workspace.path().join("link.txt");
        symlink(&target, &link).unwrap();

        let stat = stat_internal(&workspace_path, "link.txt".to_string())
            .await
            .unwrap();
        assert!(stat.is_symlink);
        assert_eq!(stat.kind, "symlink");
    }

    #[tokio::test]
    async fn test_stat_nonexistent() {
        let workspace = setup_empty_workspace();
        let workspace_path = workspace.path().to_path_buf();

        let result = stat_internal(&workspace_path, "missing.txt".to_string()).await;

        assert!(matches!(
            result,
            Err(BackendError::FilesystemNotFound { .. })
        ));
    }
}
