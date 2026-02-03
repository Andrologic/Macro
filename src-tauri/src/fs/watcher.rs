// File System Watcher
// Provides real-time file system event monitoring for the workspace

use crate::fs::dto::FsEventDto;
use notify::{event::{EventKind, ModifyKind, RenameMode}, Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
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
    let mut pending_events: Vec<Event> = Vec::new();

    loop {
        let mut rx_guard = rx.lock().await;

        match tokio::time::timeout(debounce_duration, rx_guard.recv()).await {
            Ok(Some(event)) => {
                // Process the event
                let mut keep_event = false;
                for path in &event.paths {
                    if should_ignore_path(path, &workspace) {
                        continue;
                    }
                    keep_event = true;
                }
                if keep_event {
                    pending_events.push(event);
                }
            }
            Ok(None) => {
                // Channel closed
                break;
            }
            Err(_) => {
                // Timeout - emit pending events
                drop(rx_guard);

                if !pending_events.is_empty() {
                    let mut events_to_emit: Vec<FsEventDto> = Vec::new();
                    let mut seen: HashSet<String> = HashSet::new();
                    for event in &pending_events {
                        for dto in convert_event_to_dtos(event, &workspace) {
                            let key = match &dto {
                                FsEventDto::Created { path } => format!("created:{}", path),
                                FsEventDto::Modified { path } => format!("modified:{}", path),
                                FsEventDto::Deleted { path } => format!("deleted:{}", path),
                                FsEventDto::Renamed { old_path, new_path } => {
                                    format!("renamed:{}->{}", old_path, new_path)
                                }
                            };
                            if seen.insert(key) {
                                events_to_emit.push(dto);
                            }
                        }
                    }

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

/// Convert a notify event to one or more FsEventDto entries
fn convert_event_to_dtos(event: &Event, workspace: &Path) -> Vec<FsEventDto> {
    let mut result = Vec::new();

    let paths: Vec<PathBuf> = event
        .paths
        .iter()
        .filter(|path| !should_ignore_path(path, workspace))
        .cloned()
        .collect();

    if paths.is_empty() {
        return result;
    }

    match &event.kind {
        EventKind::Create(_) => {
            for path in paths {
                result.push(FsEventDto::Created {
                    path: path.to_string_lossy().to_string(),
                });
            }
        }
        EventKind::Remove(_) => {
            for path in paths {
                result.push(FsEventDto::Deleted {
                    path: path.to_string_lossy().to_string(),
                });
            }
        }
        EventKind::Modify(ModifyKind::Name(RenameMode::Both))
        | EventKind::Modify(ModifyKind::Name(RenameMode::From))
        | EventKind::Modify(ModifyKind::Name(RenameMode::To)) => {
            if paths.len() >= 2 {
                result.push(FsEventDto::Renamed {
                    old_path: paths[0].to_string_lossy().to_string(),
                    new_path: paths[1].to_string_lossy().to_string(),
                });
            } else {
                for path in paths {
                    result.push(FsEventDto::Modified {
                        path: path.to_string_lossy().to_string(),
                    });
                }
            }
        }
        EventKind::Modify(_) => {
            for path in paths {
                result.push(FsEventDto::Modified {
                    path: path.to_string_lossy().to_string(),
                });
            }
        }
        _ => {
            for path in paths {
                result.push(FsEventDto::Modified {
                    path: path.to_string_lossy().to_string(),
                });
            }
        }
    }

    result
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
