// File System Watcher
// Provides real-time file system event monitoring for the workspace

use crate::fs::dto::FsEventDto;
use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{mpsc, Mutex};
use tracing::{debug, error, info, warn};

/// File system watcher that monitors workspace changes and emits events
pub struct FsWatcher {
    /// The underlying notify watcher
    _watcher: RecommendedWatcher,
    /// Workspace path being watched
    workspace: PathBuf,
    /// Channel sender for debouncing
    debounce_tx: mpsc::Sender<Event>,
    /// Handle to the debounce task
    _debounce_handle: tokio::task::JoinHandle<()>,
}

impl FsWatcher {
    /// Create a new file system watcher for the given workspace
    /// 
    /// # Arguments
    /// * `workspace` - The workspace directory to watch
    /// * `app_handle` - Tauri app handle for emitting events
    /// 
    /// # Returns
    /// * `Result<Self, Box<dyn std::error::Error>>` - The watcher instance or error
    pub fn new(
        workspace: PathBuf,
        app_handle: AppHandle,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        let (debounce_tx, debounce_rx) = mpsc::channel::<Event>(100);
        let debounce_rx = Arc::new(Mutex::new(debounce_rx));

        // Create the notify watcher
        let tx = debounce_tx.clone();
        let mut watcher = RecommendedWatcher::new(
            move |res: Result<Event, notify::Error>| {
                if let Ok(event) = res {
                    let _ = tx.try_send(event);
                }
            },
            Config::default().with_poll_interval(Duration::from_millis(100)),
        )?;

        // Start watching the workspace recursively
        watcher.watch(&workspace, RecursiveMode::Recursive)?;

        info!("File system watcher started for: {:?}", workspace);

        // Spawn the debounce task
        let workspace_clone = workspace.clone();
        let debounce_handle = tokio::spawn(async move {
            debounce_task(debounce_rx, app_handle, workspace_clone).await;
        });

        Ok(FsWatcher {
            _watcher: watcher,
            workspace,
            debounce_tx,
            _debounce_handle: debounce_handle,
        })
    }

    /// Get the workspace path being watched
    pub fn workspace(&self) -> &Path {
        &self.workspace
    }
}

/// Debounce task that collects events and emits them to the frontend
async fn debounce_task(
    rx: Arc<Mutex<mpsc::Receiver<Event>>>,
    app_handle: AppHandle,
    workspace: PathBuf,
) {
    let debounce_duration = Duration::from_millis(300);
    let mut pending_events: HashSet<PathBuf> = HashSet::new();
    let mut last_event_time = tokio::time::Instant::now();

    loop {
        let mut rx_guard = rx.lock().await;

        match tokio::time::timeout(debounce_duration, rx_guard.recv()).await {
            Ok(Some(event)) => {
                // Process the event
                for path in &event.paths {
                    if should_ignore_path(path, &workspace) {
                        continue;
                    }
                    pending_events.insert(path.clone());
                }
                last_event_time = tokio::time::Instant::now();
            }
            Ok(None) => {
                // Channel closed
                break;
            }
            Err(_) => {
                // Timeout - emit pending events
                drop(rx_guard);

                if !pending_events.is_empty() {
                    let events_to_emit: Vec<FsEventDto> = pending_events
                        .iter()
                        .filter_map(|path| convert_to_dto(path, &workspace))
                        .collect();

                    if !events_to_emit.is_empty() {
                        debug!("Emitting {} file system events", events_to_emit.len());
                        if let Err(e) = app_handle.emit("fs:change", &events_to_emit) {
                            error!("Failed to emit fs:change event: {}", e);
                        }
                    }

                    pending_events.clear();
                }
            }
        }
    }
}

/// Check if a path should be ignored based on default patterns
fn should_ignore_path(path: &Path, workspace: &Path) -> bool {
    // Get the relative path from workspace
    let relative = match path.strip_prefix(workspace) {
        Ok(r) => r,
        Err(_) => return false, // Not in workspace, don't ignore
    };

    // Check each component of the path
    for component in relative.components() {
        if let Some(name) = component.as_os_str().to_str() {
            // Check hidden files (starting with .)
            if name.starts_with('.') && name != "." {
                // But allow .gitignore and similar config files
                if name == ".git" {
                    return true;
                }
            }

            // Check default ignored directories
            if matches!(
                name,
                "node_modules"
                    | "target"
                    | ".next"
                    | ".nuxt"
                    | "dist"
                    | "build"
                    | "__pycache__"
                    | ".cache"
            ) {
                return true;
            }
        }
    }

    false
}

/// Convert a file system path to an FsEventDto
fn convert_to_dto(path: &Path, _workspace: &Path) -> Option<FsEventDto> {
    let path_str = path.to_string_lossy().to_string();

    // For now, we emit a generic modified event
    // In a full implementation, we'd track the actual event type
    Some(FsEventDto::Modified { path: path_str })
}

/// Initialize the file system watcher and store it in app state
/// 
/// # Arguments
/// * `app` - The Tauri app handle
/// * `workspace` - The workspace path to watch
/// 
/// # Returns
/// * `Result<(), Box<dyn std::error::Error>>` - Success or error
pub fn init_watcher(
    app: &tauri::App,
    workspace: PathBuf,
) -> Result<(), Box<dyn std::error::Error>> {
    let app_handle = app.handle().clone();

    match FsWatcher::new(workspace, app_handle) {
        Ok(watcher) => {
            app.manage(Arc::new(Mutex::new(watcher)));
            info!("File system watcher initialized successfully");
            Ok(())
        }
        Err(e) => {
            warn!("Failed to initialize file system watcher: {}", e);
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn test_should_ignore_path() {
        let workspace = PathBuf::from("/workspace");

        // Should ignore node_modules
        assert!(should_ignore_path(
            Path::new("/workspace/node_modules/package.json"),
            &workspace
        ));

        // Should ignore .git
        assert!(should_ignore_path(
            Path::new("/workspace/.git/config"),
            &workspace
        ));

        // Should ignore target (Rust build dir)
        assert!(should_ignore_path(
            Path::new("/workspace/target/debug/main"),
            &workspace
        ));

        // Should not ignore regular files
        assert!(!should_ignore_path(
            Path::new("/workspace/src/main.rs"),
            &workspace
        ));

        // Should not ignore .gitignore (config file)
        assert!(!should_ignore_path(
            Path::new("/workspace/.gitignore"),
            &workspace
        ));
    }
}
