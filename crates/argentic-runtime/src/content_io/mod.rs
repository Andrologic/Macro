//! Native content-reader lifecycle, shared with the host executable.
pub mod file_helper;
#[cfg(all(target_os = "macos", not(feature = "agsdl-content-qa")))]
mod macos_launcher;
#[cfg(all(target_os = "macos", feature = "agsdl-content-qa"))]
#[doc(hidden)]
pub mod macos_launcher;

use std::sync::Arc;
pub type ContentResourceOwner =
    Arc<dyn Fn(tokio::task::JoinHandle<Result<(), String>>) -> Result<(), String> + Send + Sync>;
