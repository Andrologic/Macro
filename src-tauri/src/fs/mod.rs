// File System Module
// ⚠️ CRITICAL: This module requires manual implementation
// See docs/fs-todo.md for detailed tasks

use std::path::{Path, PathBuf};

use tokio::fs::canonicalize;

use crate::core::error::{BackendError, Result};

pub mod watcher;
pub mod dto;


// Core Path Validation and Normalization Functions

/// Resolve path to absolute path, checks if path is within workspace using `canonicalize`
/// Prevents path traversal attacks (`../`,symlinks outside workspace)
/// Return normalized absolute path if valid, else error
/// # Arguments
/// * `path` - The input path to resolve
/// * `workspace` - The workspace directory to resolve relative paths against
/// # Returns
/// * `Result<PathBuf>` - The resolved absolute path or an error
pub fn validate_path(path: &Path, workspace: &Path) -> Result<PathBuf>{
    // The workspace must exist -> cononicalize it first
    let canonical_workspace = workspace.canonicalize().map_err(|e| {
        BackendError::Config {
            message: format!("Workspace path invalid: {}",e) 
        }
    })?;

    // Resolve absolute path
    let abs_path = if path.is_absolute() {
        path.to_path_buf()
    } else {   
        canonical_workspace.join(path)
    };

    // Try to canonicalize the absolute path
    match abs_path.canonicalize() {
        // File exists, check if within workspace
        Ok(canonical_path) => {
            if canonical_path.starts_with(&canonical_workspace) {
                Ok(canonical_path)
            } else {
                Err(BackendError::FilesystemPathOutsideWorkspace {
                    message: format!("Path {:?} is outside workspace {:?}", canonical_path, canonical_workspace),
                })
            }
        },
        // File doesn't exist, verify parent directory
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let parent = abs_path.parent().ok_or_else(|| BackendError::Filesystem {
                message: format!("Path {:?} has no parent directory", abs_path),
            })?;
            // Parent must exist 
            let canonical_parent = parent.canonicalize().map_err(|_| {
                BackendError::FilesystemNotFound {
                    message: format!("Parent directory {:?} does not exist", parent),
                }
            })?;
            // Check if parent is within workspace
            if !canonical_parent.starts_with(&canonical_workspace) {
                return Err(BackendError::FilesystemPathOutsideWorkspace {
                    message: format!("Parent of path {:?} is outside workspace {:?}", abs_path, canonical_workspace),
                });
            }

            // Build final normalized path (canonical parent + file name)
            let file_name = abs_path.file_name().ok_or_else(|| {
                BackendError::Filesystem {
                    message: "Invalid file path".to_string(),
                }
            })?;

            Ok(canonical_parent.join(file_name))
        },
        // Other IO errors
        Err(e) => Err(BackendError::Io {
            message: format!("Failed to canonicalize path {:?}: {}", abs_path, e),
            source: e,
        }),
    }
}

/// Convert path to OS-specific format
/// Resolve `.` and `..` segments
/// Handle UNC paths on Windows
/// # Arguments
/// * `path` - The input path to convert
/// # Returns
/// * `PathBuf` - The OS-specific path
pub fn normalize_path(path: &Path) -> PathBuf {
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {} // Ignore "."
            std::path::Component::ParentDir => { result.pop(); } // Résout ".."
            _ => result.push(component),
        }
    }
    result
}

///Extract file extension
/// Map extensions to languages  (e.g., `.rs` -> `Rust`, `.ts` -> `TypeScript`)
/// Support for common programming languages
/// # Arguments
/// * `path` - The input file path
/// # Returns
/// * `Option<String>` - The detected language or None
pub fn get_file_language(path: &Path) -> Result<String> {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext_str| match ext_str {
            "rs" => "Rust",
            "ts" | "tsx" => "TypeScript",
            "js" | "jsx" => "JavaScript",
            "py" => "Python",
            "java" => "Java",
            "cpp" | "cc" | "cxx" | "c" => "C/C++",
            "go" => "Go",
            "cs" => "C#",
            "html" | "htm" => "HTML",
            "css" => "CSS",
            "json" => "JSON",
            "xml" => "XML",
            "yaml" | "yml" => "YAML",
            "md" => "Markdown",
            "sh" => "Shell",
            "kt" | "kts" => "Kotlin",
            "dart" => "Dart",
            "rb" => "Ruby",
            "toml" => "TOML",
            "typ" => "Typst",
            "tex" => "LaTeX",
            "r" => "R",
            "scala" => "Scala",
            "hs" => "Haskell",
            "php" => "PHP",
            "pl" => "Perl",
            "lua" => "Lua",
            "swift" => "Swift",
            "sql" => "SQL",
            "vue" => "Vue.js",
            "svelte" => "Svelte",
            "asm" | "s" => "Assembly",
            "f" | "f90" | "f95" => "Fortran",
            "cob" | "cbl" => "COBOL",
            "clj" => "Clojure",
            "erl" => "Erlang",
            "ex" | "exs" => "Elixir",
            "jl" => "Julia",
            "m" => "MATLAB",
            "mm" => "Objective-C",
            "ps1" => "PowerShell",
            "bat" | "cmd" => "Batch",
            "cr" => "Crystal",
            "nim" => "Nim",
            "zig" => "Zig",
            _ => "Unknown",
        }.to_string())
        .ok_or_else(|| BackendError::Filesystem {
            message: format!("File {:?} has no extension", path),
        })
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

    #[test]
    fn test_normalize_path() {
        let path = Path::new("a/./b/../c/");
        let normalized = normalize_path(path);
        assert_eq!(normalized, PathBuf::from("a/c"));
    }
    #[test]
    fn test_get_file_language() {
        let path = Path::new("example.rs");
        let language = get_file_language(path).unwrap();
        assert_eq!(language, "Rust");
        let path = Path::new("example.unknownext");
        let language = get_file_language(path).unwrap();
        assert_eq!(language, "Unknown");
        let path = Path::new("example");
        let result = get_file_language(path);
        assert!(result.is_err());
    }   
}