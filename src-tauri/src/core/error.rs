use serde::Serialize;
use serde_json::error;
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

