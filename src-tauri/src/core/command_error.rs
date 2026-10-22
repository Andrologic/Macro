use super::error::BackendError;
use crate::db::DbError;
use serde::{Serialize, Serializer};

#[derive(Debug)]
pub struct CommandError {
    pub message: String,
    pub(crate) backend: Option<Box<BackendError>>,
}
#[derive(Serialize, ts_rs::TS)]
pub struct CommandErrorPayload<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub code: Option<&'a str>,
    pub message: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub details: Option<&'a serde_json::Value>,
}

impl Serialize for CommandError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let backend_payload = self
            .backend
            .as_ref()
            .and_then(|error| serde_json::to_value(error).ok());
        CommandErrorPayload {
            message: &self.message,
            code: self.code(),
            details: backend_payload
                .as_ref()
                .and_then(|value| value.get("details")),
        }
        .serialize(serializer)
    }
}

impl From<BackendError> for CommandError {
    fn from(error: BackendError) -> Self {
        Self {
            message: error.to_string(),
            backend: Some(Box::new(error)),
        }
    }
}

impl From<DbError> for CommandError {
    fn from(error: DbError) -> Self {
        let message = error.to_string();
        let backend = match error {
            DbError::Validation(_) => BackendError::Validation(message.clone()),
            _ => BackendError::Database {
                message: message.clone(),
            },
        };
        Self::from(backend).with_message(message)
    }
}

pub(crate) type CommandResult<T> = Result<T, CommandError>;

pub(crate) fn command_error(message: impl Into<String>) -> CommandError {
    CommandError {
        message: message.into(),
        backend: None,
    }
}

impl CommandError {
    pub(crate) fn with_message(mut self, message: impl Into<String>) -> Self {
        self.message = message.into();
        self
    }

    pub fn code(&self) -> Option<&'static str> {
        if let Some(error) = self.backend.as_ref() {
            return Some(error.code());
        }
        // Compatibility for historical string-only producers outside the typed paths.
        if self.message.starts_with("Web fetch destination blocked:") {
            return Some("WEB_FETCH_DESTINATION_BLOCKED");
        }
        if self.message.contains("Revision conflict:") {
            return Some("REVISION_CONFLICT");
        }
        if self.message.starts_with("Tool execution cancelled:") {
            return Some("TOOL_EXECUTION_CANCELLED");
        }
        if self.message.starts_with("Tool execution timed out") {
            return Some("TOOL_EXECUTION_TIMEOUT");
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn typed_codes_survive_message_changes_and_serialization() {
        for (error, code) in [
            (
                BackendError::RevisionConflict {
                    message: "changed remotely".into(),
                },
                "REVISION_CONFLICT",
            ),
            (
                BackendError::ToolExecutionCancelled {
                    message: "stopped".into(),
                },
                "TOOL_EXECUTION_CANCELLED",
            ),
            (
                BackendError::ToolExecutionTimeout {
                    message: "budget exhausted".into(),
                },
                "TOOL_EXECUTION_TIMEOUT",
            ),
            (
                BackendError::Database {
                    message: "storage offline".into(),
                },
                "Database",
            ),
        ] {
            let error = CommandError::from(error).with_message("Different words");
            let payload = serde_json::to_value(&error).unwrap();
            assert_eq!(error.code(), Some(code));
            assert_eq!(payload["code"], code);
            assert_eq!(payload["message"], "Different words");
        }
    }

    #[test]
    fn conversion_preserves_public_backend_context_after_message_decoration() {
        let error = BackendError::DirectCheckpointMissing {
            message: "Unavailable".into(),
            checkpoint_id: "checkpoint-example".into(),
            project_path: "private-project-path".into(),
        };
        let expected = serde_json::to_value(&error).unwrap();
        let converted = CommandError::from(error).with_message("Operation failed: unavailable");
        let payload = serde_json::to_value(converted).unwrap();
        assert_eq!(payload["code"], expected["code"]);
        assert_eq!(payload["details"], expected["details"]);
        assert!(!payload.to_string().contains("private-project-path"));
    }

    #[tokio::test]
    async fn actual_database_failure_keeps_its_code_at_the_command_boundary() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        let error = sqlx::query("INSERT INTO missing_table VALUES (1)")
            .execute(&pool)
            .await
            .unwrap_err();
        let original = DbError::from(error);
        let message = original.to_string();
        let payload = serde_json::to_value(CommandError::from(original)).unwrap();
        assert_eq!(payload["code"], "Database");
        assert_eq!(payload["message"], message);
    }

    #[test]
    fn database_validation_is_distinct_from_storage_failure() {
        let error = CommandError::from(DbError::Validation("invalid input".into()));
        assert_eq!(error.code(), Some("Validation"));
        assert_eq!(error.message, "Validation error: invalid input");
    }
}
