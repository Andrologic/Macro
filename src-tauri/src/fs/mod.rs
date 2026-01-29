// File System Module
// ⚠️ CRITICAL: This module requires manual implementation
// See docs/fs-todo.md for detailed tasks

use std::path::{Path, PathBuf};

use crate::core::error::{BackendError, Result};

pub mod dto;
pub mod watcher;

// Core Path Validation and Normalization Functions

// Basic helper to resolve absolute path
fn resolve_absolute(path: &Path, workspace: &Path) -> Result<(PathBuf, PathBuf)> {
    let canonical_workspace = workspace.canonicalize().map_err(|e| BackendError::Config {
        message: format!("Workspace path invalid: {}", e),
    })?;
    let abs_path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        canonical_workspace.join(path)
    };
    Ok((abs_path, canonical_workspace))
}

// Basic helper 2: Validate parent directory (core of write/create security)
fn validate_parent(abs_path: &Path, canonical_workspace: &Path) -> Result<PathBuf> {
    let parent = abs_path.parent().ok_or_else(|| BackendError::Filesystem {
        message: format!("Path {:?} has no parent directory", abs_path),
    })?;
    let canonical_parent = parent
        .canonicalize()
        .map_err(|_| BackendError::FilesystemNotFound {
            message: format!("Parent directory {:?} does not exist", parent),
        })?;
    if !canonical_parent.starts_with(canonical_workspace) {
        return Err(BackendError::FilesystemPathOutsideWorkspace {
            message: format!(
                "Parent of path {:?} is outside workspace {:?}",
                abs_path, canonical_workspace
            ),
        });
    }
    Ok(canonical_parent)
}

/// Resolve path to absolute path, checks if path is within workspace using `canonicalize`
/// Prevents path traversal attacks (`../`,symlinks outside workspace)
/// Return normalized absolute path if valid, else error
/// # Arguments
/// * `path` - The input path to resolve
/// * `workspace` - The workspace directory to resolve relative paths against
/// # Returns
/// * `Result<PathBuf>` - The resolved absolute path or an error
pub fn validate_path(path: &Path, workspace: &Path) -> Result<PathBuf> {
    let (abs_path, canonical_workspace) = resolve_absolute(path, workspace)?;
    match abs_path.canonicalize() {
        Ok(canonical_path) => {
            if canonical_path.starts_with(&canonical_workspace) {
                Ok(normalize_path(&canonical_path))
            } else {
                Err(BackendError::FilesystemPathOutsideWorkspace {
                    message: format!(
                        "Path {:?} is outside workspace {:?}",
                        canonical_path, canonical_workspace
                    ),
                })
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // Fichier n'existe pas : on valide le parent et on reconstruit le chemin
            let canonical_parent = validate_parent(&abs_path, &canonical_workspace)?;
            let file_name = abs_path
                .file_name()
                .ok_or_else(|| BackendError::Filesystem {
                    message: "Invalid file path".to_string(),
                })?;
            Ok(normalize_path(&canonical_parent.join(file_name)))
        }
        Err(e) => Err(BackendError::Io {
            message: format!("Failed to canonicalize path {:?}: {}", abs_path, e),
            source: e,
        }),
    }
}

/// Validate path for write operations
/// Similar to `validate_path` but handles non-existent files
/// Checks if parent directory exists and is within workspace
/// Returns the target path (not canonicalized, since file doesn't exist)
/// Prevents creating files in restricted locations
/// # Arguments
/// * `path` - The input path to validate
/// * `workspace` - The workspace directory to resolve relative paths against
/// # Returns
/// * `Result<PathBuf>` - The validated path or an error
pub fn validate_path_for_write(path: &Path, workspace: &Path) -> Result<PathBuf> {
    let (abs_path, canonical_workspace) = resolve_absolute(path, workspace)?;

    // To write, we just check that the parent is clean
    // We return abs_path as is (since the file may not exist yet)
    validate_parent(&abs_path, &canonical_workspace)?;

    Ok(normalize_path(&abs_path))
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

    // Handle empty path
    if path.components().next().is_none() {
        return result;
    }

    for component in path.components() {
        match component {
            std::path::Component::CurDir => {} // Ignore `.` components
            std::path::Component::ParentDir => {
                result.pop();
            } // Remove the last component for `..`
            _ => result.push(component),
        }
    }
    result
}

/// Extract file extension and map to programming language
/// Case-insensitive matching (e.g., `.RS`, `.rs`, `.Rs` all → "Rust")
/// # Arguments
/// * `path` - The input file path
/// # Returns
/// * `Option<String>` - The detected language, or None if no extension
pub fn get_file_language(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext_str| {
            match ext_str.to_ascii_lowercase().as_str() {
                // Data formats
                "csv" => "CSV",
                "json" => "JSON",
                "xml" => "XML",
                "yaml" | "yml" => "YAML",
                "toml" => "TOML",

                // Web
                "html" | "htm" => "HTML",
                "css" | "scss" | "sass" | "less" => "CSS",
                "js" | "mjs" | "cjs" => "JavaScript",
                "jsx" => "JavaScript (JSX)",
                "ts" | "mts" | "cts" => "TypeScript",
                "tsx" => "TypeScript (TSX)",
                "vue" => "Vue",
                "svelte" => "Svelte",
                "astro" => "Astro",

                // Systems
                "rs" => "Rust",
                "c" | "h" => "C",
                "cpp" | "cc" | "cxx" | "hpp" | "hxx" | "hh" => "C++",
                "go" => "Go",
                "zig" => "Zig",
                "nim" => "Nim",
                "cr" => "Crystal",
                "asm" | "s" => "Assembly",

                // JVM
                "java" => "Java",
                "kt" | "kts" => "Kotlin",
                "scala" | "sc" => "Scala",
                "clj" | "cljs" | "cljc" | "edn" => "Clojure",
                "groovy" | "gvy" | "gy" | "gsh" => "Groovy",

                // .NET
                "cs" => "C#",
                "fs" | "fsi" | "fsx" => "F#",
                "vb" => "Visual Basic",

                // Scripting
                "py" | "pyw" | "pyi" => "Python",
                "rb" | "rake" | "gemspec" => "Ruby",
                "php" => "PHP",
                "pl" | "pm" => "Perl",
                "lua" => "Lua",
                "tcl" => "Tcl",
                "r" | "rmd" => "R",

                // Functional
                "hs" | "lhs" => "Haskell",
                "ml" | "mli" => "OCaml",
                "erl" | "hrl" => "Erlang",
                "ex" | "exs" => "Elixir",
                "elm" => "Elm",
                "purs" => "PureScript",
                "jl" => "Julia",
                "lisp" | "lsp" | "cl" => "Lisp",
                "scm" | "ss" => "Scheme",
                "rkt" => "Racket",

                // Mobile
                "swift" => "Swift",
                "m" => "Objective-C",
                "mm" => "Objective-C++",
                "dart" => "Dart",

                // Shell & Scripts
                "sh" | "bash" | "zsh" | "fish" => "Shell",
                "ps1" | "psm1" | "psd1" => "PowerShell",
                "bat" | "cmd" => "Batch",

                // Config & DevOps
                "dockerfile" => "Dockerfile",
                "tf" | "tfvars" => "Terraform",
                "nix" => "Nix",
                "dhall" => "Dhall",

                // Query & Data
                "sql" => "SQL",
                "graphql" | "gql" => "GraphQL",
                "prisma" => "Prisma",

                // Documentation
                "md" | "markdown" => "Markdown",
                "rst" => "reStructuredText",
                "adoc" | "asciidoc" => "AsciiDoc",
                "tex" | "latex" => "LaTeX",
                "typ" => "Typst",
                "org" => "Org",

                // Legacy
                "f" | "for" | "f90" | "f95" | "f03" | "f08" => "Fortran",
                "cob" | "cbl" | "cpy" => "COBOL",
                "pas" | "pp" => "Pascal",
                "ada" | "adb" | "ads" => "Ada",

                // Other
                "v" | "sv" | "svh" => "Verilog/SystemVerilog",
                "vhd" | "vhdl" => "VHDL",
                "proto" => "Protocol Buffers",
                "thrift" => "Thrift",
                "wasm" | "wat" => "WebAssembly",
                "sol" => "Solidity",
                "vy" => "Vyper",
                "move" => "Move",

                _ => "Unknown",
            }
            .to_string()
        })
}

/// Checks whether a file is binary based on its extension
/// If the extension is known to be text-based, returns false
/// If unknown, defaults to true if null bytes are found in the content, else false
/// # Arguments
/// * `path` - The input file path
/// # Returns
/// * `Result<bool>` - True if binary, false if text
/// # Errors
/// * `BackendError` - If file cannot be read
pub fn is_binary_file(path: &Path) -> Result<bool> {
    if path.is_dir() {
        return Ok(false); // Directories are not binary files
    }
    if !path.exists() {
        return Err(BackendError::FilesystemNotFound {
            message: format!("File {:?} does not exist", path),
        });
    }
    let text_extensions = [
        "txt",
        "md",
        "rs",
        "py",
        "js",
        "ts",
        "java",
        "c",
        "cpp",
        "html",
        "css",
        "json",
        "xml",
        "yaml",
        "yml",
        "toml",
        "sh",
        "go",
        "rb",
        "php",
        "Makefile",
        "Dockerfile",
        "Vagrantfile",
        "Gemfile",
        "Rakefile",
        "CMakeLists",
        "LICENSE",
        "README",
        "CHANGELOG",
        "AUTHORS",
        ".gitignore",
        ".gitattributes",
        ".editorconfig",
        ".env",
    ];
    let binary_extensions = [
        // Images
        "png", "jpg", "jpeg", "gif", "bmp", "ico", "webp", "svg", "tiff", // Audio/Video
        "mp3", "mp4", "wav", "avi", "mkv", "mov", "flac", "ogg", // Archives
        "zip", "tar", "gz", "rar", "7z", "bz2", "xz", // Executables
        "exe", "dll", "so", "dylib", "bin", "wasm", // Documents
        "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", // Databases
        "db", "sqlite", "sqlite3", // Other
        "class", "pyc", "o", "a", "lib", "jar", "war", "ear",
    ];
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        let ext_lower = ext.to_ascii_lowercase();
        if text_extensions.contains(&ext_lower.as_str()) {
            return Ok(false);
        }
        if binary_extensions.contains(&ext_lower.as_str()) {
            return Ok(true);
        }
    }
    // If unknown extension, read file content to check for null bytes
    let content = std::fs::read(path)?;
    Ok(content.contains(&0))
}

// Tests
#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::fs::{self, File};
    use std::io::Write;

    // Helper to create a temporary workspace
    fn setup_workspace(name: &str) -> PathBuf {
        let workspace = env::temp_dir().join(format!("macro_test_{}", name));
        let _ = fs::remove_dir_all(&workspace); // Clean up if exists
        fs::create_dir_all(&workspace).unwrap();
        workspace
    }

    fn cleanup_workspace(workspace: &Path) {
        let _ = fs::remove_dir_all(workspace);
    }

    // ============ validate_path tests ============

    #[test]
    fn test_validate_path_valid_relative() {
        let workspace = setup_workspace("validate_rel");
        let file_path = workspace.join("test.txt");
        File::create(&file_path).unwrap();

        let result = validate_path(Path::new("test.txt"), &workspace).unwrap();
        assert_eq!(result, file_path.canonicalize().unwrap());

        cleanup_workspace(&workspace);
    }

    #[test]
    fn test_validate_path_valid_absolute() {
        let workspace = setup_workspace("validate_abs");
        let file_path = workspace.join("test.txt");
        File::create(&file_path).unwrap();

        let result = validate_path(&file_path, &workspace).unwrap();
        assert_eq!(result, file_path.canonicalize().unwrap());

        cleanup_workspace(&workspace);
    }

    #[test]
    fn test_validate_path_traversal_rejected() {
        let workspace = setup_workspace("validate_traversal");

        let result = validate_path(Path::new("../outside.txt"), &workspace);
        assert!(result.is_err());

        cleanup_workspace(&workspace);
    }

    #[test]
    fn test_validate_path_nonexistent_file_valid_parent() {
        let workspace = setup_workspace("validate_nonexist");

        // File doesn't exist but parent does
        let result = validate_path(Path::new("new_file.txt"), &workspace);
        assert!(result.is_ok());
        assert!(result.unwrap().ends_with("new_file.txt"));

        cleanup_workspace(&workspace);
    }

    #[test]
    fn test_validate_path_nested_directory() {
        let workspace = setup_workspace("validate_nested");
        let nested = workspace.join("a/b/c");
        fs::create_dir_all(&nested).unwrap();
        let file_path = nested.join("deep.txt");
        File::create(&file_path).unwrap();

        let result = validate_path(Path::new("a/b/c/deep.txt"), &workspace).unwrap();
        assert_eq!(result, file_path.canonicalize().unwrap());

        cleanup_workspace(&workspace);
    }

    #[test]
    fn test_validate_path_with_dots() {
        let workspace = setup_workspace("validate_dots");
        let file_path = workspace.join("test.txt");
        File::create(&file_path).unwrap();

        let result = validate_path(Path::new("./test.txt"), &workspace).unwrap();
        assert_eq!(result, file_path.canonicalize().unwrap());

        cleanup_workspace(&workspace);
    }

    // ============ validate_path_for_write tests ============

    #[test]
    fn test_validate_path_for_write_new_file() {
        let workspace = setup_workspace("write_new");

        let result = validate_path_for_write(Path::new("new_file.txt"), &workspace);
        assert!(result.is_ok());

        cleanup_workspace(&workspace);
    }

    #[test]
    fn test_validate_path_for_write_nested_parent_exists() {
        let workspace = setup_workspace("write_nested");
        let subdir = workspace.join("subdir");
        fs::create_dir_all(&subdir).unwrap();

        let result = validate_path_for_write(Path::new("subdir/new_file.txt"), &workspace);
        assert!(result.is_ok());

        cleanup_workspace(&workspace);
    }

    #[test]
    fn test_validate_path_for_write_parent_not_exists() {
        let workspace = setup_workspace("write_no_parent");

        let result = validate_path_for_write(Path::new("nonexistent_dir/file.txt"), &workspace);
        assert!(result.is_err());

        cleanup_workspace(&workspace);
    }

    #[test]
    fn test_validate_path_for_write_traversal_rejected() {
        let workspace = setup_workspace("write_traversal");

        let result = validate_path_for_write(Path::new("../outside.txt"), &workspace);
        assert!(result.is_err());

        cleanup_workspace(&workspace);
    }

    // ============ normalize_path tests ============

    #[test]
    fn test_normalize_path_dots() {
        assert_eq!(
            normalize_path(Path::new("a/./b/../c")),
            PathBuf::from("a/c")
        );
    }

    #[test]
    fn test_normalize_path_empty() {
        assert_eq!(normalize_path(Path::new("")), PathBuf::new());
    }

    #[test]
    fn test_normalize_path_trailing_slash() {
        assert_eq!(normalize_path(Path::new("a/b/c/")), PathBuf::from("a/b/c"));
    }

    #[test]
    fn test_normalize_path_multiple_parent() {
        assert_eq!(
            normalize_path(Path::new("a/b/c/../../d")),
            PathBuf::from("a/d")
        );
    }

    #[test]
    fn test_normalize_path_only_dots() {
        assert_eq!(normalize_path(Path::new("./././.")), PathBuf::new());
    }

    #[test]
    fn test_normalize_path_absolute() {
        let path = normalize_path(Path::new("/a/b/../c"));
        assert!(path.is_absolute());
        assert!(path.ends_with("a/c"));
    }

    // ============ get_file_language tests ============

    #[test]
    fn test_get_file_language_rust() {
        assert_eq!(
            get_file_language(Path::new("main.rs")),
            Some("Rust".to_string())
        );
    }

    #[test]
    fn test_get_file_language_case_insensitive() {
        assert_eq!(
            get_file_language(Path::new("Main.RS")),
            Some("Rust".to_string())
        );
        assert_eq!(
            get_file_language(Path::new("app.TS")),
            Some("TypeScript".to_string())
        );
        assert_eq!(
            get_file_language(Path::new("style.CSS")),
            Some("CSS".to_string())
        );
    }

    #[test]
    fn test_get_file_language_typescript_variants() {
        assert_eq!(
            get_file_language(Path::new("app.ts")),
            Some("TypeScript".to_string())
        );
        assert_eq!(
            get_file_language(Path::new("app.tsx")),
            Some("TypeScript (TSX)".to_string())
        );
        assert_eq!(
            get_file_language(Path::new("app.mts")),
            Some("TypeScript".to_string())
        );
    }

    #[test]
    fn test_get_file_language_javascript_variants() {
        assert_eq!(
            get_file_language(Path::new("app.js")),
            Some("JavaScript".to_string())
        );
        assert_eq!(
            get_file_language(Path::new("app.jsx")),
            Some("JavaScript (JSX)".to_string())
        );
        assert_eq!(
            get_file_language(Path::new("app.mjs")),
            Some("JavaScript".to_string())
        );
        assert_eq!(
            get_file_language(Path::new("app.cjs")),
            Some("JavaScript".to_string())
        );
    }

    #[test]
    fn test_get_file_language_unknown() {
        assert_eq!(
            get_file_language(Path::new("file.xyz")),
            Some("Unknown".to_string())
        );
    }

    #[test]
    fn test_get_file_language_no_extension() {
        assert_eq!(get_file_language(Path::new("Makefile")), None);
        assert_eq!(get_file_language(Path::new("README")), None);
    }

    #[test]
    fn test_get_file_language_hidden_file() {
        // .gitignore has no extension (the dot is part of the filename)
        assert_eq!(get_file_language(Path::new(".gitignore")), None);
        // Hidden file WITH extension
        assert_eq!(
            get_file_language(Path::new(".eslintrc.json")),
            Some("JSON".to_string())
        );
    }

    #[test]
    fn test_get_file_language_multiple_dots() {
        assert_eq!(
            get_file_language(Path::new("app.test.ts")),
            Some("TypeScript".to_string())
        );
        assert_eq!(
            get_file_language(Path::new("file.spec.js")),
            Some("JavaScript".to_string())
        );
    }

    #[test]
    fn test_get_file_language_various() {
        assert_eq!(
            get_file_language(Path::new("a.py")),
            Some("Python".to_string())
        );
        assert_eq!(get_file_language(Path::new("a.go")), Some("Go".to_string()));
        assert_eq!(
            get_file_language(Path::new("a.java")),
            Some("Java".to_string())
        );
        assert_eq!(
            get_file_language(Path::new("a.cpp")),
            Some("C++".to_string())
        );
        assert_eq!(get_file_language(Path::new("a.c")), Some("C".to_string()));
        assert_eq!(
            get_file_language(Path::new("a.swift")),
            Some("Swift".to_string())
        );
        assert_eq!(
            get_file_language(Path::new("a.kt")),
            Some("Kotlin".to_string())
        );
        assert_eq!(
            get_file_language(Path::new("a.sql")),
            Some("SQL".to_string())
        );
        assert_eq!(
            get_file_language(Path::new("a.graphql")),
            Some("GraphQL".to_string())
        );
        assert_eq!(
            get_file_language(Path::new("a.proto")),
            Some("Protocol Buffers".to_string())
        );
    }

    // ============ is_binary_file tests ============

    #[test]
    fn test_is_binary_file_text_extensions() {
        let workspace = setup_workspace("binary_check");
        // We just need the path to check extension, doesn't need to exist for extension check optimization
        // BUT the function checks existence first! So we must create files.
        let f1 = workspace.join("main.rs");
        File::create(&f1).unwrap();
        assert_eq!(is_binary_file(&f1).unwrap(), false);

        let f2 = workspace.join("doc.md");
        File::create(&f2).unwrap();
        assert_eq!(is_binary_file(&f2).unwrap(), false);

        cleanup_workspace(&workspace);
    }

    #[test]
    fn test_is_binary_file_binary_extensions() {
        let workspace = setup_workspace("binary_check_ext");
        let f1 = workspace.join("image.png");
        File::create(&f1).unwrap();
        assert_eq!(is_binary_file(&f1).unwrap(), true);

        let f2 = workspace.join("program.exe");
        File::create(&f2).unwrap();
        assert_eq!(is_binary_file(&f2).unwrap(), true);

        cleanup_workspace(&workspace);
    }

    #[test]
    fn test_is_binary_file_no_extension_text_content() {
        let workspace = setup_workspace("binary_check_no_ext");

        let file_path = workspace.join("Makefile");
        let mut file = File::create(&file_path).unwrap();
        file.write_all(b"all: build\n\tcargo build").unwrap();

        // This will fall back to content check because "Makefile" logic is not correctly hit by extension logic
        // But content is text, so it should return false.
        assert_eq!(is_binary_file(&file_path).unwrap(), false);

        cleanup_workspace(&workspace);
    }

    #[test]
    fn test_is_binary_file_dotfile_text_content() {
        let workspace = setup_workspace("binary_check_dotfile");

        let file_path = workspace.join(".gitignore");
        let mut file = File::create(&file_path).unwrap();
        file.write_all(b"target/\n**/*.log").unwrap();

        assert_eq!(is_binary_file(&file_path).unwrap(), false);

        cleanup_workspace(&workspace);
    }

    #[test]
    fn test_is_binary_file_unknown_extension_binary_content() {
        let workspace = setup_workspace("binary_check_unknown");

        let file_path = workspace.join("custom.binfmt");
        let mut file = File::create(&file_path).unwrap();
        // Write some null bytes
        file.write_all(b"Hello\0World").unwrap();

        assert_eq!(is_binary_file(&file_path).unwrap(), true);

        cleanup_workspace(&workspace);
    }
}
