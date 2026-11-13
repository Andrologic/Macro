//! Guarded native shutdown and payload-free lifecycle diagnostics.
use crate::{agsdl_host::HostState, ai::AiState, core::db_state::DbPool};
use std::time::{Duration, Instant};
use tauri::{Manager, WebviewWindow};

static PREPARE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

pub(crate) struct Phase {
    name: &'static str,
    started: Instant,
    finished: bool,
}
impl Phase {
    pub(crate) fn begin(name: &'static str) -> Self {
        tracing::info!(event = "app_shutdown_phase", phase = name, state = "begin");
        Self {
            name,
            started: Instant::now(),
            finished: false,
        }
    }
    pub(crate) fn finish(mut self, succeeded: bool) {
        self.finished = true;
        tracing::info!(
            event = "app_shutdown_phase",
            phase = self.name,
            state = if succeeded { "returned" } else { "incomplete" },
            elapsed_ms = self.started.elapsed().as_millis() as u64
        );
    }
}

/// Returning from a phase is an ordering observation, not a physical receipt.
pub(crate) fn run_phase<T>(name: &'static str, operation: impl FnOnce() -> T) -> T {
    let phase = Phase::begin(name);
    let result = operation();
    phase.finish(true);
    result
}
impl Drop for Phase {
    fn drop(&mut self) {
        if !self.finished {
            tracing::warn!(
                event = "app_shutdown_phase",
                phase = self.name,
                state = "abandoned",
                elapsed_ms = self.started.elapsed().as_millis() as u64
            );
        }
    }
}

fn require_main(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("APP_SHUTDOWN_UNAVAILABLE".into())
    }
}

#[tauri::command]
pub(crate) async fn app_shutdown_active_runs(window: WebviewWindow) -> Result<Vec<String>, String> {
    require_main(&window)?;
    let phase = Phase::begin("activity_snapshot");
    let result = async {
        let pool = window
            .state::<DbPool>()
            .wait_until_ready()
            .await
            .map_err(|_| "APP_SHUTDOWN_UNAVAILABLE")?;
        window
            .state::<HostState>()
            .shutdown_active_runs(&pool)
            .await
            .map_err(|_| "APP_SHUTDOWN_UNAVAILABLE")
    }
    .await;
    phase.finish(result.is_ok());
    result.map_err(String::from)
}

#[tauri::command]
pub(crate) async fn app_shutdown_prepare(
    window: WebviewWindow,
    approved_runs: Vec<String>,
) -> Result<(), String> {
    require_main(&window)?;
    let _prepare = PREPARE.lock().await;
    let phase = Phase::begin("native_execution_retirement");
    let result = async {
        let pool = window
            .state::<DbPool>()
            .wait_until_ready()
            .await
            .map_err(|_| "APP_SHUTDOWN_UNAVAILABLE".to_string())?;
        let host = window.state::<HostState>();
        let ai = window.state::<AiState>();
        // The deadline bounds the caller only. Supervisors and physical owners
        // remain retained; an incomplete attempt can be retried through Quit.
        tokio::time::timeout(
            Duration::from_secs(10),
            host.prepare_shutdown(&pool, &ai.stream_tasks, &approved_runs),
        )
        .await
        .map_err(|_| "APP_SHUTDOWN_PENDING".to_string())?
        .map_err(|error| error.code)
    }
    .await;
    phase.finish(result.is_ok());
    result
}
