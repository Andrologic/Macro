use serde::{ser::SerializeStruct, Serialize, Serializer};
use serde_json::json;
use thiserror::Error;

/// Backend error type that can be serialized and sent to the frontend
#[derive(Error, Debug)]
pub enum BackendError {
    #[error("IO error: {message}")]
    Io {
        message: String,
        #[source]
        source: std::io::Error,
    },

    #[error("Database error: {message}")]
    Database { message: String },

    #[error("Git error: {message}")]
    Git { message: String },

    #[error("Git object missing: {message}")]
    GitObjectMissing {
        message: String,
        object_id: Option<String>,
        operation: Option<String>,
        repository_path: Option<String>,
        partial_clone: bool,
        retry_attempted: bool,
        worktree_modified: Option<bool>,
        git_output: Option<String>,
    },

    #[error("Direct checkpoint missing: {message}")]
    DirectCheckpointMissing {
        message: String,
        checkpoint_id: String,
        project_path: String,
    },

    #[error("Direct checkpoint corrupt: {message}")]
    DirectCheckpointCorrupt {
        message: String,
        checkpoint_id: String,
        object_id: Option<String>,
        operation: Option<String>,
        retry_attempted: bool,
        accepted_history_at_risk: bool,
        git_output: Option<String>,
    },

    #[error("Direct checkpoint project mismatch: {message}")]
    DirectCheckpointProjectMismatch {
        message: String,
        checkpoint_id: String,
    },

    #[error("Git repository not found: {message}")]
    GitRepositoryNotFound { message: String },

    #[error("Git repository not clean: {message}")]
    GitRepositoryNotClean { message: String },

    #[error("Git branch not found: {message}")]
    GitBranchNotFound { message: String },

    #[error("Git conflict: {message}")]
    GitConflict { message: String },

    #[error("Git merge conflict: {message}")]
    GitMergeConflict { message: String },

    #[error("Git invalid commit: {message}")]
    GitInvalidCommit { message: String },

    #[error("File system error: {message}")]
    Filesystem { message: String },

    #[error("File system path outside workspace: {message}")]
    FilesystemPathOutsideWorkspace { message: String },

    #[error("File system Not Found: {message}")]
    FilesystemNotFound { message: String },

    #[error("File system Permission denied: {message}")]
    FilesystemPermissionDenied { message: String },

    #[error("File system Directory not found: {message}")]
    #[allow(dead_code)]
    FilesystemDirectoryNotFound { message: String },

    #[error("File system Is a directory: {message}")]
    FilesystemIsDirectory { message: String },

    #[error("File system Is a file: {message}")]
    FilesystemIsFile { message: String },

    #[error("File system Already exists: {message}")]
    FilesystemAlreadyExists { message: String },

    #[error("File system Binary file error: {message}")]
    #[allow(dead_code)]
    FilesystemBinaryFile { message: String },

    #[error("File system File too large: {message}")]
    FilesystemFileTooLarge { message: String },

    #[error("File system Invalid path: {message}")]
    FilesystemInvalidPath { message: String },

    #[error("File system Disk full: {message}")]
    FilesystemDiskFull { message: String },

    #[error("Resource pressure: {message}")]
    ResourcePressure { message: String },

    #[error("AI provider error: {message}")]
    #[allow(dead_code)]
    AI { message: String },

    #[error("Configuration error: {message}")]
    Config { message: String },

    #[error("Not found: {0}")]
    #[allow(dead_code)]
    NotFound(String),

    #[error("Permission denied: {0}")]
    #[allow(dead_code)]
    PermissionDenied(String),

    #[error("Validation error: {0}")]
    Validation(String),

    #[error("Revision conflict: {message}")]
    RevisionConflict { message: String },

    #[error("Internal server error: {message}")]
    Internal { message: String },
}

impl BackendError {
    pub fn code(&self) -> &'static str {
        match self {
            BackendError::Io { .. } => "Io",
            BackendError::Database { .. } => "Database",
            BackendError::Git { .. } => "Git",
            BackendError::GitObjectMissing { .. } => "GIT_OBJECT_MISSING",
            BackendError::DirectCheckpointMissing { .. } => "DIRECT_CHECKPOINT_MISSING",
            BackendError::DirectCheckpointCorrupt { .. } => "DIRECT_CHECKPOINT_CORRUPT",
            BackendError::DirectCheckpointProjectMismatch { .. } => {
                "DIRECT_CHECKPOINT_PROJECT_MISMATCH"
            }
            BackendError::GitRepositoryNotFound { .. } => "GitRepositoryNotFound",
            BackendError::GitRepositoryNotClean { .. } => "GitRepositoryNotClean",
            BackendError::GitBranchNotFound { .. } => "GitBranchNotFound",
            BackendError::GitConflict { .. } => "GitConflict",
            BackendError::GitMergeConflict { .. } => "GitMergeConflict",
            BackendError::GitInvalidCommit { .. } => "GitInvalidCommit",
            BackendError::Filesystem { .. } => "Filesystem",
            BackendError::FilesystemPathOutsideWorkspace { .. } => "FilesystemPathOutsideWorkspace",
            BackendError::FilesystemNotFound { .. } => "FilesystemNotFound",
            BackendError::FilesystemPermissionDenied { .. } => "FilesystemPermissionDenied",
            BackendError::FilesystemDirectoryNotFound { .. } => "FilesystemDirectoryNotFound",
            BackendError::FilesystemIsDirectory { .. } => "FilesystemIsDirectory",
            BackendError::FilesystemIsFile { .. } => "FilesystemIsFile",
            BackendError::FilesystemAlreadyExists { .. } => "FilesystemAlreadyExists",
            BackendError::FilesystemBinaryFile { .. } => "FilesystemBinaryFile",
            BackendError::FilesystemFileTooLarge { .. } => "FilesystemFileTooLarge",
            BackendError::FilesystemInvalidPath { .. } => "FilesystemInvalidPath",
            BackendError::FilesystemDiskFull { .. } => "FilesystemDiskFull",
            BackendError::ResourcePressure { .. } => "RESOURCE_PRESSURE",
            BackendError::AI { .. } => "AI",
            BackendError::Config { .. } => "Config",
            BackendError::NotFound(_) => "NotFound",
            BackendError::PermissionDenied(_) => "PermissionDenied",
            BackendError::Validation(_) => "Validation",
            BackendError::RevisionConflict { .. } => "REVISION_CONFLICT",
            BackendError::Internal { .. } => "Internal",
        }
    }

    pub fn message(&self) -> &str {
        match self {
            BackendError::Io { message, .. }
            | BackendError::Database { message }
            | BackendError::Git { message }
            | BackendError::GitObjectMissing { message, .. }
            | BackendError::DirectCheckpointMissing { message, .. }
            | BackendError::DirectCheckpointCorrupt { message, .. }
            | BackendError::DirectCheckpointProjectMismatch { message, .. }
            | BackendError::GitRepositoryNotFound { message }
            | BackendError::GitRepositoryNotClean { message }
            | BackendError::GitBranchNotFound { message }
            | BackendError::GitConflict { message }
            | BackendError::GitMergeConflict { message }
            | BackendError::GitInvalidCommit { message }
            | BackendError::Filesystem { message }
            | BackendError::FilesystemPathOutsideWorkspace { message }
            | BackendError::FilesystemNotFound { message }
            | BackendError::FilesystemPermissionDenied { message }
            | BackendError::FilesystemDirectoryNotFound { message }
            | BackendError::FilesystemIsDirectory { message }
            | BackendError::FilesystemIsFile { message }
            | BackendError::FilesystemAlreadyExists { message }
            | BackendError::FilesystemBinaryFile { message }
            | BackendError::FilesystemFileTooLarge { message }
            | BackendError::FilesystemInvalidPath { message }
            | BackendError::FilesystemDiskFull { message }
            | BackendError::ResourcePressure { message }
            | BackendError::RevisionConflict { message }
            | BackendError::AI { message }
            | BackendError::Config { message }
            | BackendError::Internal { message } => message,
            BackendError::NotFound(message)
            | BackendError::PermissionDenied(message)
            | BackendError::Validation(message) => message,
        }
    }

    pub fn is_git_object_missing(&self) -> bool {
        matches!(self, BackendError::GitObjectMissing { .. })
    }

    pub fn git_object_id(&self) -> Option<&str> {
        match self {
            BackendError::GitObjectMissing { object_id, .. } => object_id.as_deref(),
            _ => None,
        }
    }

    pub fn with_git_object_context(
        self,
        object_id: Option<String>,
        operation: &'static str,
    ) -> Self {
        match self {
            BackendError::GitObjectMissing {
                message,
                object_id: existing_object_id,
                operation: existing_operation,
                repository_path,
                partial_clone,
                retry_attempted,
                worktree_modified,
                git_output,
            } => BackendError::GitObjectMissing {
                message,
                object_id: existing_object_id.or(object_id),
                operation: existing_operation.or_else(|| Some(operation.to_string())),
                repository_path,
                partial_clone,
                retry_attempted,
                worktree_modified: Some(false).or(worktree_modified),
                git_output,
            },
            other => other,
        }
    }

    pub fn into_direct_checkpoint_corrupt(
        self,
        checkpoint_id: String,
        retry_attempted: bool,
        accepted_history_at_risk: bool,
    ) -> Self {
        match self {
            BackendError::GitObjectMissing {
                object_id,
                operation,
                git_output,
                ..
            } => BackendError::DirectCheckpointCorrupt {
                message: "Macro's internal review checkpoint is incomplete.".to_string(),
                checkpoint_id,
                object_id,
                operation,
                retry_attempted,
                accepted_history_at_risk,
                git_output,
            },
            other => other,
        }
    }

    pub fn git_object_missing(
        error: git2::Error,
        object_id: Option<String>,
        operation: Option<String>,
    ) -> Self {
        if error.class() == git2::ErrorClass::Odb && error.code() == git2::ErrorCode::NotFound {
            return BackendError::GitObjectMissing {
                message: "A Git object required for this operation is missing.".to_string(),
                object_id: object_id.or_else(|| extract_git_object_id(error.message())),
                operation,
                repository_path: None,
                partial_clone: false,
                retry_attempted: false,
                worktree_modified: Some(false),
                git_output: Some(error.to_string()),
            };
        }

        BackendError::Git {
            message: error.to_string(),
        }
    }

    pub fn with_git_object_diagnostics(
        self,
        repository_path: &std::path::Path,
        partial_clone: bool,
        retry_attempted: bool,
        git_output: Option<String>,
    ) -> Self {
        match self {
            BackendError::GitObjectMissing {
                message,
                object_id,
                operation,
                git_output: original_output,
                ..
            } => {
                let original_output = original_output
                    .map(|output| sanitize_git_error_output(&output, repository_path));
                let git_output =
                    git_output.map(|output| sanitize_git_error_output(&output, repository_path));
                let combined_output = match (original_output, git_output) {
                    (Some(libgit2), Some(git_cli)) => {
                        Some(format!("libgit2: {libgit2}\nGit CLI: {git_cli}"))
                    }
                    (Some(output), None) | (None, Some(output)) => Some(output),
                    (None, None) => None,
                };
                BackendError::GitObjectMissing {
                    message,
                    object_id,
                    operation,
                    repository_path: None,
                    partial_clone,
                    retry_attempted,
                    worktree_modified: Some(false),
                    git_output: combined_output,
                }
            }
            other => other,
        }
    }
}

fn sanitize_git_error_output(output: &str, repository_path: &std::path::Path) -> String {
    let mut repository_paths = vec![repository_path.to_path_buf()];
    if let Ok(canonical) = repository_path.canonicalize() {
        repository_paths.push(canonical);
    }
    let mut sanitized = output.to_string();
    for path in repository_paths {
        let path = path.to_string_lossy();
        for variant in [
            path.to_string(),
            path.replace('\\', "/"),
            path.replace('/', "\\"),
        ] {
            if variant.is_empty() {
                continue;
            }
            if let Ok(pattern) = regex::RegexBuilder::new(&regex::escape(&variant))
                .case_insensitive(true)
                .build()
            {
                sanitized = pattern.replace_all(&sanitized, "[redacted]").into_owned();
            }
        }
    }
    for pattern in [
        r#"'(?:(?i:[a-z]):[\\/]|\\\\|/)[^'\r\n]*'"#,
        r#"\"(?:(?i:[a-z]):[\\/]|\\\\|/)[^\"\r\n]*\""#,
    ] {
        if let Ok(pattern) = regex::Regex::new(pattern) {
            sanitized = pattern
                .replace_all(&sanitized, "[redacted-path]")
                .into_owned();
        }
    }
    if let Ok(windows_path) =
        regex::Regex::new(r#"(?i)(?P<prefix>^|[^a-z0-9])(?:[a-z]:[\\/]|\\\\)[^\s'\"]+"#)
    {
        sanitized = windows_path
            .replace_all(&sanitized, "${prefix}[redacted-path]")
            .into_owned();
    }
    if let Ok(unix_path) = regex::Regex::new(r#"(?m)(?P<prefix>^|[\s=])/[^\s'\"]+"#) {
        sanitized = unix_path
            .replace_all(&sanitized, "${prefix}[redacted-path]")
            .into_owned();
    }
    sanitized
        .split_whitespace()
        .map(|part| {
            let scp_remote = part.split_once(':').is_some_and(|(authority, path)| {
                authority.contains('@')
                    && !authority.contains('/')
                    && !authority.contains('\\')
                    && !path.is_empty()
            });
            if part.contains("://") || scp_remote {
                "[redacted]"
            } else {
                part
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn extract_git_object_id(message: &str) -> Option<String> {
    message
        .split(|character: char| !character.is_ascii_hexdigit())
        .find(|candidate| candidate.len() == 40 || candidate.len() == 64)
        .map(str::to_ascii_lowercase)
}

impl Serialize for BackendError {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut state = serializer.serialize_struct("BackendError", 3)?;
        state.serialize_field("code", self.code())?;
        state.serialize_field("message", self.message())?;
        if let BackendError::GitObjectMissing {
            object_id,
            operation,
            repository_path: _,
            partial_clone,
            retry_attempted,
            worktree_modified,
            git_output,
            ..
        } = self
        {
            state.serialize_field(
                "details",
                &json!({
                    "objectId": object_id,
                    "operation": operation,
                    "partialClone": partial_clone,
                    "retryAttempted": retry_attempted,
                    "worktreeModified": worktree_modified,
                    "gitOutput": git_output,
                }),
            )?;
        } else if let BackendError::DirectCheckpointMissing { checkpoint_id, .. } = self {
            state.serialize_field(
                "details",
                &json!({
                    "checkpointId": checkpoint_id,
                    "worktreeModified": false,
                }),
            )?;
        } else if let BackendError::DirectCheckpointCorrupt {
            checkpoint_id,
            object_id,
            operation,
            retry_attempted,
            accepted_history_at_risk,
            git_output: _,
            ..
        } = self
        {
            state.serialize_field(
                "details",
                &json!({
                    "checkpointId": checkpoint_id,
                    "objectId": object_id,
                    "operation": operation,
                    "retryAttempted": retry_attempted,
                    "acceptedHistoryAtRisk": accepted_history_at_risk,
                    "worktreeModified": false,
                }),
            )?;
        } else if let BackendError::DirectCheckpointProjectMismatch { checkpoint_id, .. } = self {
            state.serialize_field(
                "details",
                &json!({
                    "checkpointId": checkpoint_id,
                    "worktreeModified": false,
                }),
            )?;
        }
        state.end()
    }
}

impl From<std::io::Error> for BackendError {
    fn from(err: std::io::Error) -> Self {
        if is_too_many_open_files_error(&err) {
            return BackendError::ResourcePressure {
                message: err.to_string(),
            };
        }
        BackendError::Io {
            message: err.to_string(),
            source: err,
        }
    }
}

impl From<sqlx::Error> for BackendError {
    fn from(err: sqlx::Error) -> Self {
        BackendError::Database {
            message: err.to_string(),
        }
    }
}

impl From<git2::Error> for BackendError {
    fn from(err: git2::Error) -> Self {
        if err.class() == git2::ErrorClass::Odb && err.code() == git2::ErrorCode::NotFound {
            return BackendError::GitObjectMissing {
                message: "A Git object required for this operation is missing.".to_string(),
                object_id: extract_git_object_id(err.message()),
                operation: None,
                repository_path: None,
                partial_clone: false,
                retry_attempted: false,
                worktree_modified: None,
                git_output: Some(err.to_string()),
            };
        }
        BackendError::Git {
            message: err.to_string(),
        }
    }
}

impl From<config::ConfigError> for BackendError {
    fn from(err: config::ConfigError) -> Self {
        BackendError::Config {
            message: err.to_string(),
        }
    }
}

pub type Result<T> = std::result::Result<T, BackendError>;

pub fn is_too_many_open_files_error(err: &std::io::Error) -> bool {
    err.raw_os_error() == Some(24)
        || err
            .to_string()
            .to_lowercase()
            .contains("too many open files")
}

pub fn io_error_to_backend_error(err: std::io::Error, path: &std::path::Path) -> BackendError {
    use std::io::ErrorKind;

    if is_too_many_open_files_error(&err) {
        return BackendError::ResourcePressure {
            message: format!(
                "Too many open files while reading workspace path: {}",
                path.display()
            ),
        };
    }

    match err.kind() {
        ErrorKind::NotFound => BackendError::FilesystemNotFound {
            message: format!("Path not found: {}", path.display()),
        },
        ErrorKind::PermissionDenied => BackendError::FilesystemPermissionDenied {
            message: format!("Permission denied: {}", path.display()),
        },
        ErrorKind::AlreadyExists => BackendError::FilesystemAlreadyExists {
            message: format!("File or directory already exists: {}", path.display()),
        },
        ErrorKind::InvalidInput => BackendError::FilesystemInvalidPath {
            message: format!("Invalid path: {}", path.display()),
        },
        ErrorKind::WriteZero | ErrorKind::OutOfMemory => BackendError::FilesystemDiskFull {
            message: format!("No space left on device for path: {}", path.display()),
        },
        ErrorKind::Other => {
            let msg = err.to_string();
            if msg.contains("is a directory") {
                BackendError::FilesystemIsDirectory {
                    message: format!("Expected a file but found a directory: {}", path.display()),
                }
            } else {
                BackendError::Io {
                    message: msg,
                    source: err,
                }
            }
        }
        _ => BackendError::Io {
            message: err.to_string(),
            source: err,
        },
    }
}

#[cfg(test)]
mod tests {
    use crate::core::error::{sanitize_git_error_output, BackendError};
    #[test]
    fn test_error_variants_exist() {
        // Verify all error variants can be created
        let _ = BackendError::Io {
            message: "test".to_string(),
            source: std::io::Error::new(std::io::ErrorKind::NotFound, "test"),
        };
        let _ = BackendError::Database {
            message: "test".to_string(),
        };
        let _ = BackendError::Git {
            message: "test".to_string(),
        };
        let _ = BackendError::GitObjectMissing {
            message: "test".to_string(),
            object_id: None,
            operation: None,
            repository_path: None,
            partial_clone: false,
            retry_attempted: false,
            worktree_modified: Some(false),
            git_output: None,
        };
        let _ = BackendError::DirectCheckpointMissing {
            message: "test".to_string(),
            checkpoint_id: "task-1-0123456789abcdef".to_string(),
            project_path: "C:/project".to_string(),
        };
        let _ = BackendError::DirectCheckpointCorrupt {
            message: "test".to_string(),
            checkpoint_id: "task-1-0123456789abcdef".to_string(),
            object_id: None,
            operation: None,
            retry_attempted: true,
            accepted_history_at_risk: true,
            git_output: None,
        };
        let _ = BackendError::DirectCheckpointProjectMismatch {
            message: "test".to_string(),
            checkpoint_id: "task-1-0123456789abcdef".to_string(),
        };
        let _ = BackendError::GitRepositoryNotFound {
            message: "test".to_string(),
        };
        let _ = BackendError::GitRepositoryNotClean {
            message: "test".to_string(),
        };
        let _ = BackendError::GitBranchNotFound {
            message: "test".to_string(),
        };
        let _ = BackendError::GitConflict {
            message: "test".to_string(),
        };
        let _ = BackendError::GitMergeConflict {
            message: "test".to_string(),
        };
        let _ = BackendError::GitInvalidCommit {
            message: "test".to_string(),
        };
        let _ = BackendError::Filesystem {
            message: "test".to_string(),
        };
        let _ = BackendError::AI {
            message: "test".to_string(),
        };
        let _ = BackendError::Config {
            message: "test".to_string(),
        };
        let _ = BackendError::NotFound("test".to_string());
        let _ = BackendError::PermissionDenied("test".to_string());
        let _ = BackendError::Validation("test".to_string());
        let _ = BackendError::RevisionConflict {
            message: "test".to_string(),
        };
        let _ = BackendError::Internal {
            message: "test".to_string(),
        };
        let _ = BackendError::ResourcePressure {
            message: "too many open files".to_string(),
        };
    }

    #[test]
    fn test_error_from_io_error() {
        let io_err = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "test");
        let backend_err: BackendError = io_err.into();
        assert!(matches!(backend_err, BackendError::Io { .. }));
    }

    #[test]
    fn test_too_many_open_files_from_io_error() {
        let io_err = std::io::Error::from_raw_os_error(24);
        let backend_err: BackendError = io_err.into();
        assert!(matches!(backend_err, BackendError::ResourcePressure { .. }));
    }

    #[test]
    fn classifies_only_odb_not_found_as_missing_git_object() {
        let missing = git2::Error::new(
            git2::ErrorCode::NotFound,
            git2::ErrorClass::Odb,
            "object not found",
        );
        let classified = BackendError::git_object_missing(
            missing,
            Some("0123456789012345678901234567890123456789".to_string()),
            Some("review_index_blob".to_string()),
        );
        assert!(classified.is_git_object_missing());
        assert_eq!(
            classified.git_object_id(),
            Some("0123456789012345678901234567890123456789")
        );

        let reference_not_found = git2::Error::new(
            git2::ErrorCode::NotFound,
            git2::ErrorClass::Reference,
            "reference not found",
        );
        assert!(matches!(
            BackendError::from(reference_not_found),
            BackendError::Git { .. }
        ));
    }

    #[test]
    fn serializes_missing_git_object_with_stable_diagnostics() {
        let error = BackendError::GitObjectMissing {
            message: "missing".to_string(),
            object_id: Some("abc".to_string()),
            operation: Some("review_index_blob".to_string()),
            repository_path: None,
            partial_clone: false,
            retry_attempted: false,
            worktree_modified: Some(false),
            git_output: Some(
                "object not found in C:\\Users\\Oscar Name\\repo from https://token@example.test/repo.git".to_string(),
            ),
        }
        .with_git_object_diagnostics(
            std::path::Path::new("C:/Users/Oscar Name/repo"),
            true,
            true,
            Some("fatal: missing from git@forge.internal:private/repo.git".to_string()),
        );
        let value = serde_json::to_value(error).expect("serialize error");
        assert_eq!(value["code"], "GIT_OBJECT_MISSING");
        assert_eq!(value["details"]["objectId"], "abc");
        assert_eq!(value["details"]["partialClone"], true);
        assert_eq!(value["details"]["retryAttempted"], true);
        assert_eq!(value["details"]["worktreeModified"], false);
        assert!(value["details"].get("repositoryPath").is_none());
        assert!(!value.to_string().contains("C:/Users/Oscar Name/repo"));
        assert!(!value
            .to_string()
            .contains("C:\\\\Users\\\\Oscar Name\\\\repo"));
        assert_eq!(
            value["details"]["gitOutput"],
            "libgit2: object not found in [redacted] from [redacted]\nGit CLI: fatal: missing from [redacted]"
        );
    }

    #[test]
    fn sanitizes_absolute_git_paths_outside_the_repository() {
        let sanitized = sanitize_git_error_output(
            "config 'C:\\Users\\Alice Smith\\.gitconfig' alternate=C:\\Users\\Alice\\objects unix=/home/alice/.cache/git unc=\\\\server\\private\\objects",
            std::path::Path::new("C:/work/repository"),
        );

        assert!(!sanitized.contains("Alice"));
        assert!(!sanitized.contains("/home/alice"));
        assert!(!sanitized.contains("server"));
        assert!(sanitized.matches("[redacted-path]").count() >= 4);
    }

    #[test]
    fn extracts_object_id_from_libgit2_odb_message() {
        let object_id = "0123456789abcdef0123456789abcdef01234567";
        let missing = git2::Error::new(
            git2::ErrorCode::NotFound,
            git2::ErrorClass::Odb,
            format!("object not found - no match for id ({object_id})"),
        );
        let classified = BackendError::from(missing);
        assert_eq!(classified.git_object_id(), Some(object_id));
        let serialized =
            serde_json::to_value(classified).expect("serialize unknown mutation state");
        assert!(serialized["details"]["worktreeModified"].is_null());
    }

    #[test]
    fn serializes_direct_checkpoint_errors_without_a_profile_path() {
        let missing = BackendError::DirectCheckpointMissing {
            message: "missing".to_string(),
            checkpoint_id: "task-1-0123456789abcdef".to_string(),
            project_path: "C:/project".to_string(),
        };
        let missing = serde_json::to_value(missing).expect("serialize missing checkpoint");
        assert_eq!(missing["code"], "DIRECT_CHECKPOINT_MISSING");
        assert_eq!(missing["details"]["worktreeModified"], false);

        let corrupt = BackendError::DirectCheckpointCorrupt {
            message: "corrupt".to_string(),
            checkpoint_id: "task-1-0123456789abcdef".to_string(),
            object_id: Some("0123456789abcdef0123456789abcdef01234567".to_string()),
            operation: Some("direct_checkpoint_head_commit".to_string()),
            retry_attempted: true,
            accepted_history_at_risk: true,
            git_output: Some("object not found".to_string()),
        };
        let corrupt = serde_json::to_value(corrupt).expect("serialize corrupt checkpoint");
        assert_eq!(corrupt["code"], "DIRECT_CHECKPOINT_CORRUPT");
        assert_eq!(corrupt["details"]["acceptedHistoryAtRisk"], true);
        assert!(corrupt["details"].get("gitOutput").is_none());
        assert!(corrupt.to_string().find("Users").is_none());
    }
}
