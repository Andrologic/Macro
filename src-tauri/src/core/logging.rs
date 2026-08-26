use std::fs;
use std::path::PathBuf;
use std::sync::OnceLock;
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

static FILE_LOG_GUARD: OnceLock<WorkerGuard> = OnceLock::new();

fn platform_log_dir() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        let local_app_data = std::env::var_os("LOCALAPPDATA")?;
        return Some(PathBuf::from(local_app_data).join("com.macro.desktop/logs"));
    }

    #[cfg(target_os = "macos")]
    {
        let home = std::env::var_os("HOME")?;
        return Some(PathBuf::from(home).join("Library/Logs/com.macro.desktop"));
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if let Some(state_home) = std::env::var_os("XDG_STATE_HOME") {
            return Some(PathBuf::from(state_home).join("macro/logs"));
        }
        let home = std::env::var_os("HOME")?;
        Some(PathBuf::from(home).join(".local/state/macro/logs"))
    }
}

pub fn init_logging() {
    // Default log level can be controlled via RUST_LOG environment variable
    // e.g., RUST_LOG=debug,sqlx=warn
    let env_filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| {
        // Tao can emit noisy event-loop ordering warnings during heavy webview redraws
        // such as opening/closing CodeMirror diff modals. Keep real app warnings visible.
        EnvFilter::new("info,tao::platform_impl::platform::event_loop::runner=error")
    });
    // rmcp's OAuth implementation emits authorization codes at debug level.
    // Keep that module at info even when a broad RUST_LOG=debug/trace is set.
    let env_filter = env_filter.add_directive(
        "rmcp::transport::auth=info"
            .parse()
            .expect("static tracing directive must parse"),
    );
    let stderr_layer = tracing_subscriber::fmt::layer().with_writer(std::io::stderr);

    if let Some(log_dir) = platform_log_dir() {
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
