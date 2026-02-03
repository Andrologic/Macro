// File System Commands
// ⚠️ CRITICAL: This module requires manual implementation
// See docs/fs-todo.md for detailed tasks

use crate::core::error::{io_error_to_backend_error, BackendError};
use crate::fs::dto::{DirEntryDto, FileContentDto, FileStatsDto, WriteResultDto};
use crate::fs::{get_file_language, is_binary_file, validate_path, validate_path_for_write};
use std::path::{Path, PathBuf};

// Constants
const MAX_FILE_SIZE_BYTES: u64 = 10 * 1024 * 1024; // 10 MB
const MAX_WRITE_SIZE_BYTES: u64 = 50 * 1024 * 1024; // 50 MB

// Default ignored directories/patterns
static DEFAULT_IGNORED: &[&str] = &[
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

/// Internal function that reads file content. This is separated for testability.
pub async fn read_file_internal(
    workspace: &PathBuf,
    path: String,
) -> Result<FileContentDto, BackendError> {
    let path_buf = PathBuf::from(&path); // Parse path string to PathBuf
    let validated_path = validate_path(&path_buf, workspace)?; // Validate path against workspace, also checks if path exists
    let file_metadata = tokio::fs::metadata(&validated_path).await?; // Get file metadata

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
    workspace: tauri::State<'_, PathBuf>,
    path: String,
) -> Result<FileContentDto, BackendError> {
    read_file_internal(&workspace, path).await
}

/// Internal function for writing files with atomic write support
pub async fn write_file_internal(
    workspace: &PathBuf,
    path: String,
    content: String,
    create_dirs: Option<bool>,
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
    let validated_path = validate_path_for_write(&path_buf, workspace)?;

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
    workspace: tauri::State<'_, PathBuf>,
    path: String,
    content: String,
    create_dirs: Option<bool>,
) -> Result<WriteResultDto, BackendError> {
    write_file_internal(&workspace, path, content, create_dirs).await
}

/// Internal function for listing directory contents
pub async fn list_dir_internal(
    workspace: &PathBuf,
    path: String,
    recursive: Option<bool>,
    include_hidden: Option<bool>,
    max_depth: Option<u32>,
) -> Result<Vec<DirEntryDto>, BackendError> {
    let path_buf = PathBuf::from(&path);
    let validated_path = validate_path(&path_buf, workspace)?;

    // Verify path is a directory
    let metadata = tokio::fs::metadata(&validated_path).await?;
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
        let mut dir = tokio::fs::read_dir(&validated_path).await?;

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
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("");

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
    let metadata = tokio::fs::metadata(entry_path).await?;
    let symlink_metadata = tokio::fs::symlink_metadata(entry_path).await?;

    let name = entry_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();

    let relative_path = entry_path
        .strip_prefix(workspace)
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
    workspace: tauri::State<'_, PathBuf>,
    path: String,
    recursive: Option<bool>,
    include_hidden: Option<bool>,
    max_depth: Option<u32>,
) -> Result<Vec<DirEntryDto>, BackendError> {
    list_dir_internal(&workspace, path, recursive, include_hidden, max_depth).await
}

/// Internal function for getting file stats
pub async fn stat_internal(
    workspace: &PathBuf,
    path: String,
) -> Result<FileStatsDto, BackendError> {
    let path_buf = PathBuf::from(&path);
    let validated_path = validate_path(&path_buf, workspace)?;

    let metadata = tokio::fs::metadata(&validated_path).await?;
    let symlink_metadata = tokio::fs::symlink_metadata(&validated_path).await?;

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
    workspace: tauri::State<'_, PathBuf>,
    path: String,
) -> Result<FileStatsDto, BackendError> {
    stat_internal(&workspace, path).await
}

#[tauri::command]
pub async fn fs_exists(
    workspace: tauri::State<'_, PathBuf>,
    path: String,
) -> Result<bool, BackendError> {
    let path_buf = PathBuf::from(&path);
    
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
    workspace: tauri::State<'_, PathBuf>,
    path: String,
    recursive: Option<bool>,
) -> Result<(), BackendError> {
    let path_buf = PathBuf::from(&path);
    let validated_path = validate_path(&path_buf, &workspace)?;

    let metadata = tokio::fs::metadata(&validated_path).await?;

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
    workspace: tauri::State<'_, PathBuf>,
    path: String,
    recursive: Option<bool>,
) -> Result<(), BackendError> {
    let path_buf = PathBuf::from(&path);
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
    workspace: tauri::State<'_, PathBuf>,
    src: String,
    dest: String,
) -> Result<u64, BackendError> {
    let src_path = PathBuf::from(&src);
    let dest_path = PathBuf::from(&dest);

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
    workspace: tauri::State<'_, PathBuf>,
    src: String,
    dest: String,
) -> Result<(), BackendError> {
    let src_path = PathBuf::from(&src);
    let dest_path = PathBuf::from(&dest);

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
            tracing::debug!(
                "Rename failed, falling back to copy+delete: {}",
                rename_err
            );

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
            let src_metadata = tokio::fs::metadata(&validated_src).await?;
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

    #[tokio::test]
    async fn test_read_text_file_success() {
        let workspace = setup_test_workspace();
        let workspace_path = workspace.path().to_path_buf();

        let result = read_file_internal(&workspace_path, "sample.txt".to_string()).await;

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

        let result = read_file_internal(&workspace_path, "main.rs".to_string()).await;

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

        let result = read_file_internal(&workspace_path, "script.js".to_string()).await;

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

        let result = read_file_internal(&workspace_path, "subdir/nested.txt".to_string()).await;

        assert!(result.is_ok());
        let dto = result.unwrap();
        assert!(!dto.is_binary);
        assert_eq!(dto.content, "Nested content\n");
    }
}
