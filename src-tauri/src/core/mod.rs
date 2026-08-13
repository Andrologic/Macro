pub mod config;
pub mod environment;
pub mod error;
pub mod http_auth;
pub mod logging;
pub mod process;
pub mod tool_policy;

#[cfg(test)]
pub mod config_tests;
#[cfg(test)]
pub mod error_tests;

#[allow(unused_imports)]
pub use config::AppConfig;
pub use config::{finalize_desktop_workspace_path, load_config};
pub use environment::init_process_environment;
#[allow(unused_imports)]
pub use error::BackendError;
pub use error::Result;
pub use logging::init_logging;
