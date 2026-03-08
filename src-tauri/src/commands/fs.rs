// File System Commands
// ⚠️ CRITICAL: This module requires manual implementation
// See docs/fs-todo.md for detailed tasks

use crate::core::error::{io_error_to_backend_error, BackendError};
use crate::core::tool_policy::is_macro_scoped_path;
use crate::fs::dto::{DirEntryDto, FileContentDto, FileStatsDto, WriteResultDto};
use crate::fs::{
    get_file_language, is_binary_file, normalize_path, validate_path, validate_path_for_write,
};
use crate::git::GitState;
use crate::WorkspaceRoot;
use std::path::{Path, PathBuf};

#[cfg(windows)]
use std::os::windows::fs::MetadataExt;

// Constants
const MAX_FILE_SIZE_BYTES: u64 = 10 * 1024 * 1024; // 10 MB
const MAX_WRITE_SIZE_BYTES: u64 = 50 * 1024 * 1024; // 50 MB

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

    tokio::task::spawn_blocking(move || git_state.resolve_macro_metadata_root(&base_workspace))
        .await
        .map_err(to_join_error)?
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

/// Internal function that reads file content. This is separated for testability.
pub async fn read_file_internal(
    workspace: &PathBuf,
    path: String,
    allow_outside_workspace: Option<bool>,
) -> Result<FileContentDto, BackendError> {
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
    if is_binary {
        // Return binary file response
        return Ok(FileContentDto {
            is_binary: true,
            content: "".to_string(),
            encoding: "none".to_string(),
            language: "binary".to_string(),
            size: file_metadata.len(),
        });
    } else {
        // Read text file content
        let content = tokio::fs::read_to_string(&validated_path)
            .await
            .map_err(|e| io_error_to_backend_error(e, &validated_path))?;
        // Detect language
        let language = get_file_language(&validated_path).unwrap_or_else(|| "Unknown".to_string());
        // Return text file response
        return Ok(FileContentDto {
            content,
            language,
            is_binary: false,
            size: file_metadata.len(),
            encoding: "utf-8".to_string(),
        });
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
    workspace: &PathBuf,
    path: String,
    content: String,
    create_dirs: Option<bool>,
    allow_outside_workspace: Option<bool>,
) -> Result<WriteResultDto, BackendError> {
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

    // Check if file already exists
    let created = !validated_path.exists();

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
    })
}

#[tauri::command]
pub async fn fs_write_file(
    workspace_root: tauri::State<'_, WorkspaceRoot>,
    git_state: tauri::State<'_, GitState>,
    path: String,
    content: String,
    create_dirs: Option<bool>,
    allow_outside_workspace: Option<bool>,
    workspace_scope: Option<String>,
    workspace_path: Option<String>,
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
    write_file_internal(
        &workspace,
        effective_path,
        content,
        create_dirs,
        allow_outside_workspace,
    )
    .await
}

/// Internal function for listing directory contents
pub async fn list_dir_internal(
    workspace: &PathBuf,
    path: String,
    recursive: Option<bool>,
    include_hidden: Option<bool>,
    max_depth: Option<u32>,
    allow_outside_workspace: Option<bool>,
) -> Result<Vec<DirEntryDto>, BackendError> {
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
    DEFAULT_IGNORED.iter().any(|&pattern| file_name == pattern)
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
pub async fn stat_internal(
    workspace: &PathBuf,
    path: String,
) -> Result<FileStatsDto, BackendError> {
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
    let path_buf = PathBuf::from(&effective_path);

    // For exists, we validate the path format but allow non-existent files
    // as long as they would be within workspace if they existed
    match validate_path(&path_buf, &workspace) {
        Ok(validated_path) => {
            let exists = tokio::fs::try_exists(&validated_path).await?;
            Ok(exists)
        }
        Err(BackendError::FilesystemNotFound { .. }) => {
            // Path is within workspace but doesn't exist - this is valid for exists check
            Ok(false)
        }
        Err(e) => Err(e),
    }
}

#[tauri::command]
pub async fn fs_delete(
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
    let path_buf = PathBuf::from(&effective_path);
    let validated_path = validate_path(&path_buf, &workspace)?;

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

    // Audit logging
    tracing::info!(
        operation = "fs_delete",
        path = %validated_path.display(),
        is_directory = metadata.is_dir(),
        recursive = recursive.unwrap_or(false),
        "File or directory deleted"
    );

    Ok(())
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
        resolve_workspace_for_path(workspace, git_state.inner().clone(), None, &src, None, None).await?
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
        resolve_workspace_for_path(workspace, git_state.inner().clone(), None, &src, None, None).await?
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
        fs::write(&binary_file_path, &[0u8, 255u8, 128u8, 0u8])
            .expect("Failed to create binary file");

        // Create an empty file
        fs::File::create(workspace_path.join("empty.txt")).expect("Failed to create empty file");

        temp_dir
    }

    fn setup_empty_workspace() -> TempDir {
        TempDir::new().expect("Failed to create temp directory")
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

    #[tokio::test]
    async fn test_resolve_workspace_for_path_uses_explicit_repo_for_metadata_scope() {
        let default_workspace = setup_empty_workspace();
        let explicit_repo = setup_empty_workspace();
        let _repo = init_git_repo(explicit_repo.path());
        let git_state = GitState::new();

        let resolved = resolve_workspace_for_path(
            default_workspace.path().to_path_buf(),
            git_state,
            Some(explicit_repo.path().to_path_buf()),
            "branches/develop/plans/index.json",
            None,
            Some("metadata"),
        )
        .await
        .expect("resolve metadata workspace");

        assert!(resolved.starts_with(explicit_repo.path()));
        assert!(resolved.ends_with(Path::new("macro-metadata-worktree")));
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
        let written = fs::read_to_string(workspace.path().join("file.txt")).unwrap();
        assert_eq!(written, "second");
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
