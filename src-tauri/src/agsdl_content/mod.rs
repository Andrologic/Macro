//! Application entry points and explicit QA for shared native content.
pub(crate) use argentic_runtime::content::*;
#[cfg(all(target_os = "macos", feature = "agsdl-content-qa", debug_assertions))]
mod macos_launcher;
#[cfg(all(target_os = "macos", feature = "agsdl-content-qa", debug_assertions))]
pub(crate) mod qa;
#[cfg(all(target_os = "macos", feature = "agsdl-content-qa", debug_assertions))]
mod qa_cases;
#[cfg(all(
    test,
    target_os = "macos",
    feature = "agsdl-content-qa",
    debug_assertions
))]
mod qa_runner_tests;

#[cfg(all(target_os = "macos", feature = "agsdl-content-qa", debug_assertions))]
use std::sync::Arc;
#[cfg(all(target_os = "macos", feature = "agsdl-content-qa", debug_assertions))]
fn digest(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(bytes))
}
#[cfg(all(target_os = "macos", feature = "agsdl-content-qa", debug_assertions))]
fn error(code: &str, message: impl ToString) -> ContentError {
    ContentError {
        code: code.into(),
        pointer: String::new(),
        message: message.to_string(),
    }
}
