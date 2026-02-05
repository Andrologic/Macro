use serde::Serialize;
use thiserror::Error;

/// Backend error type that can be serialized and sent to the frontend
#[derive(Error, Debug, Serialize)]
#[serde(tag = "code")]
pub enum BackendError {
    #[error("IO error: {message}")]
    Io {
        message: String,
        #[serde(skip)]
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
    FilesystemDirectoryNotFound { message: String },

    #[error("File system Is a directory: {message}")]
    FilesystemIsDirectory { message: String },

    #[error("File system Is a file: {message}")]
    FilesystemIsFile { message: String },

    #[error("File system Already exists: {message}")]
    FilesystemAlreadyExists { message: String },

    #[error("File system Binary file error: {message}")]
    FilesystemBinaryFile { message: String },

    #[error("File system File too large: {message}")]
    FilesystemFileTooLarge { message: String },

    #[error("File system Invalid path: {message}")]
    FilesystemInvalidPath { message: String },

    #[error("File system Disk full: {message}")]
    FilesystemDiskFull { message: String },

    #[error("Index error: {message}")]
    Index { message: String },

    #[error("AI provider error: {message}")]
    AI { message: String },

    #[error("Configuration error: {message}")]
    Config { message: String },

    #[error("Not found: {0}")]
    NotFound(String),

    #[error("Permission denied: {0}")]
    PermissionDenied(String),

    #[error("Validation error: {0}")]
    Validation(String),

    #[error("Internal server error: {message}")]
    Internal { message: String },
}

impl From<std::io::Error> for BackendError {
    fn from(err: std::io::Error) -> Self {
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

pub fn io_error_to_backend_error(err: std::io::Error, path: &std::path::Path) -> BackendError {
    use std::io::ErrorKind;

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
    }

    #[test]
    fn test_error_from_io_error() {
        let io_err = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "test");
        let backend_err: BackendError = io_err.into();
        assert!(matches!(backend_err, BackendError::Io { .. }));
    }
}
