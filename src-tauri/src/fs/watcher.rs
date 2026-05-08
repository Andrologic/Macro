// File System Watcher
// Provides real-time file system event monitoring for the workspace

use crate::fs::dto::FsEventDto;
use notify::{
    event::{EventKind, ModifyKind, RenameMode},
    Config, Event, RecommendedWatcher, RecursiveMode, Watcher,
};
use std::collections::HashSet;
use std::fs;
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
    #[allow(dead_code)]
    workspace: PathBuf,
    /// Number of paths registered with the watcher
    #[allow(dead_code)]
    watched_path_count: usize,
    /// Channel sender for debouncing
    #[allow(dead_code)]
    debounce_tx: mpsc::Sender<Event>,
    /// Handle to the debounce task
    _debounce_handle: tauri::async_runtime::JoinHandle<()>,
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

        let watch_plan = build_watch_plan(&workspace);
        for path in &watch_plan.watch_paths {
            watcher.watch(path, RecursiveMode::NonRecursive)?;
        }

        info!(
            "File system watcher started for {:?}: watching {} directories, skipped {} ignored directories",
            workspace,
            watch_plan.watch_paths.len(),
            watch_plan.ignored_dir_count
        );

        // Spawn the debounce task using Tauri's async runtime
        let workspace_clone = workspace.clone();
        let debounce_handle = tauri::async_runtime::spawn(async move {
            debounce_task(debounce_rx, app_handle, workspace_clone).await;
        });

        Ok(FsWatcher {
            _watcher: watcher,
            workspace,
            watched_path_count: watch_plan.watch_paths.len(),
            debounce_tx,
            _debounce_handle: debounce_handle,
        })
    }

    /// Get the workspace path being watched
    #[allow(dead_code)]
    pub fn workspace(&self) -> &Path {
        &self.workspace
    }
}

struct WatchPlan {
    watch_paths: Vec<PathBuf>,
    ignored_dir_count: usize,
}

fn build_watch_plan(workspace: &Path) -> WatchPlan {
    let mut watch_paths = Vec::new();
    let mut ignored_dir_count = 0;
    collect_watch_paths(
        workspace,
        workspace,
        &mut watch_paths,
        &mut ignored_dir_count,
    );
    if watch_paths.is_empty() {
        watch_paths.push(workspace.to_path_buf());
    }
    WatchPlan {
        watch_paths,
        ignored_dir_count,
    }
}

fn collect_watch_paths(
    current: &Path,
    workspace: &Path,
    watch_paths: &mut Vec<PathBuf>,
    ignored_dir_count: &mut usize,
) {
    if should_ignore_path(current, workspace) {
        *ignored_dir_count += 1;
        return;
    }

    watch_paths.push(current.to_path_buf());

    let entries = match fs::read_dir(current) {
        Ok(entries) => entries,
        Err(error) => {
            warn!("Failed to read watcher directory {:?}: {}", current, error);
            return;
        }
    };

    for entry in entries.flatten() {
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(_) => continue,
        };
        if !file_type.is_dir() {
            continue;
        }
        let path = entry.path();
        collect_watch_paths(&path, workspace, watch_paths, ignored_dir_count);
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
    let mut ignored_event_count: usize = 0;

    loop {
        let mut rx_guard = rx.lock().await;

        match tokio::time::timeout(debounce_duration, rx_guard.recv()).await {
            Ok(Some(event)) => {
                // Process the event
                let mut keep_event = false;
                for path in &event.paths {
                    if should_ignore_path(path, &workspace) {
                        ignored_event_count += 1;
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

                if ignored_event_count > 0 {
                    debug!(
                        "Ignored {} file system events from ignored paths",
                        ignored_event_count
                    );
                    ignored_event_count = 0;
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
                    | "coverage"
                    | ".turbo"
                    | ".vite"
                    | ".parcel-cache"
                    | ".pytest_cache"
                    | ".mypy_cache"
                    | ".ruff_cache"
                    | ".venv"
                    | "venv"
                    | ".codex"
                    | ".kilo"
                    | ".macro-worktrees"
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
        | EventKind::Modify(ModifyKind::Name(RenameMode::To))
            if paths.len() >= 2 =>
        {
            result.push(FsEventDto::Renamed {
                old_path: paths[0].to_string_lossy().to_string(),
                new_path: paths[1].to_string_lossy().to_string(),
            });
        }
        EventKind::Modify(ModifyKind::Name(RenameMode::Both))
        | EventKind::Modify(ModifyKind::Name(RenameMode::From))
        | EventKind::Modify(ModifyKind::Name(RenameMode::To)) => {
            for path in paths {
                result.push(FsEventDto::Modified {
                    path: path.to_string_lossy().to_string(),
                });
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

        assert!(should_ignore_path(
            Path::new("/workspace/.codex/worktrees/123/project/src/main.ts"),
            &workspace
        ));

        assert!(should_ignore_path(
            Path::new("/workspace/.kilo/plans/plan.md"),
            &workspace
        ));

        assert!(should_ignore_path(
            Path::new("/workspace/.vite/deps/react.js"),
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

    #[test]
    fn test_build_watch_plan_skips_ignored_directories_before_registration() {
        let temp = tempfile::tempdir().expect("tempdir");
        let workspace = temp.path();
        std::fs::create_dir_all(workspace.join("src/nested")).expect("src");
        std::fs::create_dir_all(workspace.join(".codex/worktrees/generated")).expect(".codex");
        std::fs::create_dir_all(workspace.join("node_modules/pkg")).expect("node_modules");
        std::fs::create_dir_all(workspace.join("target/debug")).expect("target");

        let plan = build_watch_plan(workspace);
        let watched: Vec<String> = plan
            .watch_paths
            .iter()
            .map(|path| {
                path.strip_prefix(workspace)
                    .unwrap_or(path)
                    .to_string_lossy()
                    .replace('\\', "/")
            })
            .collect();

        assert!(watched.iter().any(|path| path.is_empty()));
        assert!(watched.iter().any(|path| path == "src"));
        assert!(watched.iter().any(|path| path == "src/nested"));
        assert!(!watched.iter().any(|path| path.starts_with(".codex")));
        assert!(!watched.iter().any(|path| path.starts_with("node_modules")));
        assert!(!watched.iter().any(|path| path.starts_with("target")));
        assert_eq!(plan.ignored_dir_count, 3);
    }
}
