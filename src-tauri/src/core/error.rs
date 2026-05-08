use serde::{ser::SerializeStruct, Serialize, Serializer};
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

    #[error("Index error: {message}")]
    #[allow(dead_code)]
    Index { message: String },

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

    #[error("Internal server error: {message}")]
    Internal { message: String },
}

impl BackendError {
    fn code(&self) -> &'static str {
        match self {
            BackendError::Io { .. } => "Io",
            BackendError::Database { .. } => "Database",
            BackendError::Git { .. } => "Git",
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
            BackendError::Index { .. } => "Index",
            BackendError::AI { .. } => "AI",
            BackendError::Config { .. } => "Config",
            BackendError::NotFound(_) => "NotFound",
            BackendError::PermissionDenied(_) => "PermissionDenied",
            BackendError::Validation(_) => "Validation",
            BackendError::Internal { .. } => "Internal",
        }
    }

    fn message(&self) -> &str {
        match self {
            BackendError::Io { message, .. }
            | BackendError::Database { message }
            | BackendError::Git { message }
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
            | BackendError::Index { message }
            | BackendError::AI { message }
            | BackendError::Config { message }
            | BackendError::Internal { message } => message,
            BackendError::NotFound(message)
            | BackendError::PermissionDenied(message)
            | BackendError::Validation(message) => message,
        }
    }
}

impl Serialize for BackendError {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut state = serializer.serialize_struct("BackendError", 2)?;
        state.serialize_field("code", self.code())?;
        state.serialize_field("message", self.message())?;
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
    use crate::core::error::BackendError;
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
        let _ = BackendError::Index {
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
}
