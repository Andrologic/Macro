// File System Module
// ⚠️ CRITICAL: This module requires manual implementation
// See docs/fs-todo.md for detailed tasks

use std::path::{Path, PathBuf};
use std::io::Result;

pub mod watcher;

/// Resolve path to absolute path, checks if path is within workspace using `canonicalize`
/// Prevents path traversal attacks (`../`,symlinks outside workspace)
/// Return normalized absolute path if valid, else error
/// # Arguments
/// * `path` - The input path to resolve
/// * `workspace` - The workspace directory to resolve relative paths against
/// # Returns
/// * `Result<PathBuf>` - The resolved absolute path or an error
fn validate_path(path: &Path, workspace: &Path) -> Result<PathBuf>{
    let abs_path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        workspace.join(path)
    };

    let canonical_workspace = workspace.canonicalize()?;
    let canonical_path = abs_path.canonicalize()?;

    if canonical_path.starts_with(&canonical_workspace) {
        Ok(canonical_path)
    } else {
        Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "Path traversal outside workspace is not allowed",
        ))
    }
}

// Test for validate_path function
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::env;
    use std::io::Write;
    #[test]
    fn test_validate_path() {
        let workspace = env::temp_dir().join("workspace_test");
        fs::create_dir_all(&workspace).unwrap();
        let valid_file = workspace.join("file.txt");
        let mut file = fs::File::create(&valid_file).unwrap();
        writeln!(file, "Test content").unwrap();
        // Test valid relative path
        let result = validate_path(Path::new("file.txt"), &workspace).unwrap();
        assert_eq!(result, valid_file.canonicalize().unwrap());
        // Test valid absolute path
        let result = validate_path(&valid_file, &workspace).unwrap();
        assert_eq!(result, valid_file.canonicalize().unwrap());
        // Test path traversal attempt
        let result = validate_path(Path::new("../outside.txt"), &workspace);
        assert!(result.is_err());
        fs::remove_file(&valid_file).unwrap();
        fs::remove_dir(&workspace).unwrap();
    }
}   