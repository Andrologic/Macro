#[cfg(target_os = "macos")]
use std::fs;
#[cfg(target_os = "macos")]
use std::path::PathBuf;
#[cfg(target_os = "macos")]
use std::sync::OnceLock;
#[cfg(target_os = "macos")]
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

#[cfg(target_os = "macos")]
static FILE_LOG_GUARD: OnceLock<WorkerGuard> = OnceLock::new();

#[cfg(target_os = "macos")]
fn macos_log_dir() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(PathBuf::from(home).join("Library/Logs/com.macro.desktop"))
}

pub fn init_logging() {
    // Default log level can be controlled via RUST_LOG environment variable
    // e.g., RUST_LOG=debug,sqlx=warn
    let env_filter = EnvFilter::from_default_env().add_directive(tracing::Level::INFO.into());
    let stderr_layer = tracing_subscriber::fmt::layer().with_writer(std::io::stderr);

    #[cfg(target_os = "macos")]
    if let Some(log_dir) = macos_log_dir() {
        if fs::create_dir_all(&log_dir).is_ok() {
            let file_appender = tracing_appender::rolling::never(log_dir, "macro.log");
            let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);
            let _ = FILE_LOG_GUARD.set(guard);

            tracing_subscriber::registry()
                .with(env_filter)
                .with(stderr_layer)
                .with(
                    tracing_subscriber::fmt::layer()
                        .with_ansi(false)
                        .with_writer(non_blocking),
                )
                .init();
            return;
        }
    }

    tracing_subscriber::registry()
        .with(env_filter)
        .with(stderr_layer)
        .init();
}
