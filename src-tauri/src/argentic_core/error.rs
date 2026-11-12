//! The `{ code, pointer, message }` triple of the TS `ConformanceError`.

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Failure {
    pub(crate) code: &'static str,
    pub(crate) pointer: String,
    pub(crate) message: String,
}

impl Failure {
    pub(crate) fn new(code: &'static str, pointer: &str, message: &str) -> Self {
        Self {
            code,
            pointer: pointer.to_owned(),
            message: message.to_owned(),
        }
    }
}

/// Counterpart of the TS `fail(code, pointer, message)`.
pub(crate) fn fail<T>(code: &'static str, pointer: &str, message: &str) -> Result<T, Failure> {
    Err(Failure::new(code, pointer, message))
}
