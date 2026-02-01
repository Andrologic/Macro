// File System Commands
// ⚠️ CRITICAL: This module requires manual implementation
// See docs/fs-todo.md for detailed tasks

use crate::core::error::BackendError;
use crate::fs::dto::FileContentDto;
use crate::fs::{get_file_language, is_binary_file, validate_path};
use std::path::PathBuf;

// Constants
const MAX_FILE_SIZE_BYTES: u64 = 10 * 1024 * 1024; // 10 MB

/// Internal function that reads file content. This is separated for testability.
pub async fn read_file_internal(
    workspace: &PathBuf,
    path: String,
) -> Result<FileContentDto, BackendError> {
    let path_buf = PathBuf::from(&path); // Parse path string to PathBuf
    let validated_path = validate_path(&path_buf, workspace)?; // Validate path against workspace
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
    // Verify if binary (placeholder function)
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
        let content = tokio::fs::read_to_string(&validated_path).await.map_err(|_e| {
            BackendError::Filesystem {
                message: format!("Failed to read file: {}", path),
            }
        })?;
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

#[tauri::command]
pub async fn fs_write_file(
    _workspace: tauri::State<'_, PathBuf>,
    _path: String,
    _content: String,
) -> Result<(), BackendError> {
    unimplemented!("fs_write_file command is not yet implemented");
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

    #[tokio::test]
    async fn test_read_empty_file() {
        let workspace = setup_test_workspace();
        let workspace_path = workspace.path().to_path_buf();

        let result = read_file_internal(&workspace_path, "empty.txt".to_string()).await;

        assert!(result.is_ok());
        let dto = result.unwrap();
        assert!(!dto.is_binary);
        assert_eq!(dto.content, "");
        assert_eq!(dto.size, 0);
    }

    #[tokio::test]
    async fn test_read_binary_file() {
        let workspace = setup_test_workspace();
        let workspace_path = workspace.path().to_path_buf();

        let result = read_file_internal(&workspace_path, "binary.bin".to_string()).await;

        assert!(result.is_ok());
        let dto = result.unwrap();
        assert!(dto.is_binary);
        assert_eq!(dto.content, "");
        assert_eq!(dto.language, "binary");
    }

    #[tokio::test]
    async fn test_read_nonexistent_file() {
        let workspace = setup_test_workspace();
        let workspace_path = workspace.path().to_path_buf();

        let result = read_file_internal(&workspace_path, "nonexistent.txt".to_string()).await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_read_directory_error() {
        let workspace = setup_test_workspace();
        let workspace_path = workspace.path().to_path_buf();

        let result = read_file_internal(&workspace_path, "subdir".to_string()).await;

        assert!(result.is_err());
        if let Err(BackendError::FilesystemIsDirectory { message }) = result {
            assert!(message.contains("directory"));
        } else {
            panic!("Expected FilesystemIsDirectory error");
        }
    }

    #[tokio::test]
    async fn test_read_file_with_relative_path() {
        let workspace = setup_test_workspace();
        let workspace_path = workspace.path().to_path_buf();

        // Test relative path with ./
        let result = read_file_internal(&workspace_path, "./sample.txt".to_string()).await;

        assert!(result.is_ok());
        let dto = result.unwrap();
        assert_eq!(dto.content, "Hello, World!\n");
    }

    #[tokio::test]
    async fn test_read_file_size() {
        let workspace = setup_test_workspace();
        let workspace_path = workspace.path().to_path_buf();

        let result = read_file_internal(&workspace_path, "sample.txt".to_string()).await;

        assert!(result.is_ok());
        let dto = result.unwrap();
        assert!(dto.size > 0);
        assert_eq!(dto.size as usize, dto.content.len());
    }

    #[tokio::test]
    async fn test_read_file_encoding_utf8() {
        let workspace = setup_test_workspace();
        let workspace_path = workspace.path().to_path_buf();

        let result = read_file_internal(&workspace_path, "sample.txt".to_string()).await;

        assert!(result.is_ok());
        let dto = result.unwrap();
        assert_eq!(dto.encoding, "utf-8");
    }

    #[tokio::test]
    async fn test_read_large_text_file() {
        let workspace = setup_test_workspace();
        let workspace_path = workspace.path().to_path_buf();
        
        // Create a large text file (under 10 MB limit)
        let large_file_path = workspace_path.join("large.txt");
        let mut large_file = fs::File::create(&large_file_path)
            .expect("Failed to create large file");
        
        // Write 1 MB of data
        let large_content = "x".repeat(1024 * 1024);
        writeln!(large_file, "{}", large_content).expect("Failed to write to large file");
        
        let result = read_file_internal(&workspace_path, "large.txt".to_string()).await;

        assert!(result.is_ok());
        let dto = result.unwrap();
        assert!(dto.content.len() > 1024 * 1024);
        assert!(!dto.is_binary);
    }

    #[tokio::test]
    async fn test_read_file_outside_workspace_prevented() {
        let workspace = setup_test_workspace();
        let workspace_path = workspace.path().to_path_buf();

        // Try to read a file outside the workspace using path traversal
        let result = read_file_internal(&workspace_path, "../../../etc/passwd".to_string()).await;

        // Should fail due to path validation
        assert!(result.is_err());
    }
}
