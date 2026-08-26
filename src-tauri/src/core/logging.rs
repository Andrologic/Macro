use std::fs;
use std::io::{self, Write};
use std::path::PathBuf;
use std::sync::OnceLock;
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

static FILE_LOG_GUARD: OnceLock<WorkerGuard> = OnceLock::new();
const MAX_DAILY_LOG_BYTES: u64 = 20 * 1024 * 1024;

struct DailySizeLimitedWriter<W> {
    inner: W,
    day: chrono::NaiveDate,
    written: u64,
    max_bytes: u64,
}

impl<W: Write> Write for DailySizeLimitedWriter<W> {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        let today = chrono::Utc::now().date_naive();
        if today != self.day {
            self.day = today;
            self.written = 0;
        }

        let remaining = self.max_bytes.saturating_sub(self.written) as usize;
        if remaining > 0 {
            let accepted = remaining.min(buffer.len());
            self.inner.write_all(&buffer[..accepted])?;
            self.written += accepted as u64;
        }
        Ok(buffer.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

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
            let file_appender = tracing_appender::rolling::RollingFileAppender::builder()
                .rotation(tracing_appender::rolling::Rotation::DAILY)
                .filename_prefix("macro")
                .filename_suffix("log")
                .max_log_files(7)
                .build(&log_dir);
            if let Ok(file_appender) = file_appender {
                let today = chrono::Utc::now().date_naive();
                let current_log = log_dir.join(format!("macro.{today}.log"));
                let written = fs::metadata(current_log)
                    .map(|metadata| metadata.len())
                    .unwrap_or(0);
                let limited_writer = DailySizeLimitedWriter {
                    inner: file_appender,
                    day: today,
                    written,
                    max_bytes: MAX_DAILY_LOG_BYTES,
                };
                let (non_blocking, guard) = tracing_appender::non_blocking(limited_writer);
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
    }

    tracing_subscriber::registry()
        .with(env_filter)
        .with(stderr_layer)
        .init();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn daily_size_limited_writer_discards_bytes_after_the_limit() {
        let mut writer = DailySizeLimitedWriter {
            inner: Vec::new(),
            day: chrono::Utc::now().date_naive(),
            written: 3,
            max_bytes: 5,
        };

        assert_eq!(writer.write(b"abcd").expect("write succeeds"), 4);
        assert_eq!(writer.inner, b"ab");
        assert_eq!(writer.written, 5);
    }
}
