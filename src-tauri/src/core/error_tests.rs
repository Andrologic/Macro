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
