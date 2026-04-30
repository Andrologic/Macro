#[cfg(test)]
mod tests {
    use crate::core::error::BackendError;
    use serde_json::json;

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

    fn assert_serialized_error(error: BackendError, code: &str, message: &str) {
        let serialized = serde_json::to_value(error).expect("serialize backend error");
        assert_eq!(
            serialized,
            json!({
                "code": code,
                "message": message,
            })
        );
    }

    #[test]
    fn test_error_serializes_stable_code_and_message_shape() {
        assert_serialized_error(
            BackendError::Validation("invalid branch".to_string()),
            "Validation",
            "invalid branch",
        );
        assert_serialized_error(
            BackendError::NotFound("missing task".to_string()),
            "NotFound",
            "missing task",
        );
        assert_serialized_error(
            BackendError::PermissionDenied("locked repo".to_string()),
            "PermissionDenied",
            "locked repo",
        );
        assert_serialized_error(
            BackendError::Git {
                message: "git failed".to_string(),
            },
            "Git",
            "git failed",
        );
        assert_serialized_error(
            BackendError::Internal {
                message: "unexpected".to_string(),
            },
            "Internal",
            "unexpected",
        );
    }

    #[test]
    fn test_all_error_variants_are_serializable() {
        let variants = vec![
            BackendError::Io {
                message: "io".to_string(),
                source: std::io::Error::other("io"),
            },
            BackendError::Database {
                message: "database".to_string(),
            },
            BackendError::Git {
                message: "git".to_string(),
            },
            BackendError::GitRepositoryNotFound {
                message: "repository not found".to_string(),
            },
            BackendError::GitRepositoryNotClean {
                message: "repository not clean".to_string(),
            },
            BackendError::GitBranchNotFound {
                message: "branch not found".to_string(),
            },
            BackendError::GitConflict {
                message: "conflict".to_string(),
            },
            BackendError::GitMergeConflict {
                message: "merge conflict".to_string(),
            },
            BackendError::GitInvalidCommit {
                message: "invalid commit".to_string(),
            },
            BackendError::Filesystem {
                message: "filesystem".to_string(),
            },
            BackendError::FilesystemPathOutsideWorkspace {
                message: "outside workspace".to_string(),
            },
            BackendError::FilesystemNotFound {
                message: "not found".to_string(),
            },
            BackendError::FilesystemPermissionDenied {
                message: "permission denied".to_string(),
            },
            BackendError::FilesystemDirectoryNotFound {
                message: "directory not found".to_string(),
            },
            BackendError::FilesystemIsDirectory {
                message: "is directory".to_string(),
            },
            BackendError::FilesystemIsFile {
                message: "is file".to_string(),
            },
            BackendError::FilesystemAlreadyExists {
                message: "already exists".to_string(),
            },
            BackendError::FilesystemBinaryFile {
                message: "binary file".to_string(),
            },
            BackendError::FilesystemFileTooLarge {
                message: "file too large".to_string(),
            },
            BackendError::FilesystemInvalidPath {
                message: "invalid path".to_string(),
            },
            BackendError::FilesystemDiskFull {
                message: "disk full".to_string(),
            },
            BackendError::Index {
                message: "index".to_string(),
            },
            BackendError::AI {
                message: "ai".to_string(),
            },
            BackendError::Config {
                message: "config".to_string(),
            },
            BackendError::NotFound("not found".to_string()),
            BackendError::PermissionDenied("permission denied".to_string()),
            BackendError::Validation("validation".to_string()),
            BackendError::Internal {
                message: "internal".to_string(),
            },
        ];

        for error in variants {
            let serialized = serde_json::to_value(error).expect("serialize backend error");
            assert!(serialized
                .get("code")
                .and_then(|value| value.as_str())
                .is_some());
            assert!(serialized
                .get("message")
                .and_then(|value| value.as_str())
                .is_some());
        }
    }
}
