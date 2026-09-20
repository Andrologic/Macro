use crate::db::DbError;
use serde::{Serialize, Serializer};

#[derive(Debug)]
pub struct CommandError {
    pub message: String,
}
#[derive(Serialize, ts_rs::TS)]
pub struct CommandErrorPayload<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub code: Option<&'a str>,
    pub message: &'a str,
}

impl Serialize for CommandError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        CommandErrorPayload {
            message: &self.message,
            code: self.code(),
        }
        .serialize(serializer)
    }
}

impl From<DbError> for CommandError {
    fn from(err: DbError) -> Self {
        CommandError {
            message: err.to_string(),
        }
    }
}

pub(crate) type CommandResult<T> = Result<T, CommandError>;

pub(crate) fn command_error(message: impl Into<String>) -> CommandError {
    CommandError {
        message: message.into(),
    }
}

impl CommandError {
    pub fn code(&self) -> Option<&'static str> {
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
