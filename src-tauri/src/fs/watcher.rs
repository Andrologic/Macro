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
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{mpsc, Mutex};
use tracing::{debug, error, info, warn};

/// File system watcher that monitors workspace changes and emits events
pub struct FsWatcher {
    /// The underlying notify watcher
    _watcher: Arc<StdMutex<RecommendedWatcher>>,
    /// Workspace path being watched
    #[allow(dead_code)]
    workspace: PathBuf,
    /// Paths registered with the watcher
    #[allow(dead_code)]
    watched_paths: Arc<StdMutex<HashSet<PathBuf>>>,
    /// Channel sender for debouncing
    #[allow(dead_code)]
    debounce_tx: mpsc::UnboundedSender<Event>,
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
        let (debounce_tx, debounce_rx) = mpsc::unbounded_channel::<Event>();
        let debounce_rx = Arc::new(Mutex::new(debounce_rx));

        // Create the notify watcher
        let tx = debounce_tx.clone();
        let mut watcher = RecommendedWatcher::new(
            move |res: Result<Event, notify::Error>| {
                if let Ok(event) = res {
                    let _ = tx.send(event);
                }
            },
            Config::default().with_poll_interval(Duration::from_millis(100)),
        )?;

        let watch_plan = build_watch_plan(&workspace);
        for path in &watch_plan.watch_paths {
            watcher.watch(path, RecursiveMode::NonRecursive)?;
        }
        let watched_paths = Arc::new(StdMutex::new(
            watch_plan.watch_paths.iter().cloned().collect(),
        ));
        let watcher = Arc::new(StdMutex::new(watcher));

        info!(
            "File system watcher started for {:?}: watching {} directories, skipped {} ignored directories",
            workspace,
            watch_plan.watch_paths.len(),
            watch_plan.ignored_dir_count
        );

        // Spawn the debounce task using Tauri's async runtime
        let workspace_clone = workspace.clone();
        let task_watcher = watcher.clone();
        let task_watched_paths = watched_paths.clone();
        let debounce_handle = tauri::async_runtime::spawn(async move {
            debounce_task(
                debounce_rx,
                app_handle,
                workspace_clone,
                task_watcher,
                task_watched_paths,
            )
            .await;
        });

        Ok(FsWatcher {
            _watcher: watcher,
            workspace,
            watched_paths,
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

fn discover_unwatched_directories(
    event: &Event,
    workspace: &Path,
    watched_paths: &HashSet<PathBuf>,
) -> Vec<PathBuf> {
    let mut discovered = Vec::new();
    let mut ignored_dir_count = 0;
    for path in &event.paths {
        if !path.starts_with(workspace) || !path.is_dir() || should_ignore_path(path, workspace) {
            continue;
        }
        collect_watch_paths(path, workspace, &mut discovered, &mut ignored_dir_count);
    }
    discovered.retain(|path| !watched_paths.contains(path));
    discovered.sort();
    discovered.dedup();
    discovered
}

fn register_new_directories(
    event: &Event,
    workspace: &Path,
    watcher: &Arc<StdMutex<RecommendedWatcher>>,
    watched_paths: &Arc<StdMutex<HashSet<PathBuf>>>,
) {
    let mut watched = match watched_paths.lock() {
        Ok(watched) => watched,
        Err(_) => {
            warn!("File system watcher path registry is poisoned");
            return;
        }
    };
    let discovered = discover_unwatched_directories(event, workspace, &watched);
    if discovered.is_empty() {
        return;
    }
    let mut watcher = match watcher.lock() {
        Ok(watcher) => watcher,
        Err(_) => {
            warn!("File system watcher is poisoned");
            return;
        }
    };
    for path in discovered {
        match watcher.watch(&path, RecursiveMode::NonRecursive) {
            Ok(()) => {
                watched.insert(path);
            }
            Err(error) => warn!("Failed to watch new directory {:?}: {}", path, error),
        }
    }
}

fn removed_directory_roots(event: &Event) -> Vec<&Path> {
    match &event.kind {
        EventKind::Remove(_) | EventKind::Modify(ModifyKind::Name(RenameMode::From)) => {
            event.paths.iter().map(PathBuf::as_path).collect()
        }
        EventKind::Modify(ModifyKind::Name(RenameMode::Both)) => event
            .paths
            .first()
            .map(PathBuf::as_path)
            .into_iter()
            .collect(),
        _ => Vec::new(),
    }
}

fn unregister_removed_directories(
    event: &Event,
    watcher: &Arc<StdMutex<RecommendedWatcher>>,
    watched_paths: &Arc<StdMutex<HashSet<PathBuf>>>,
) {
    let removed_roots = removed_directory_roots(event);
    if removed_roots.is_empty() {
        return;
    }

    let removed_paths = {
        let mut watched = match watched_paths.lock() {
            Ok(watched) => watched,
            Err(_) => {
                warn!("File system watcher path registry is poisoned");
                return;
            }
        };
        let removed = watched
            .iter()
            .filter(|watched_path| {
                removed_roots
                    .iter()
                    .any(|root| *watched_path == *root || watched_path.starts_with(root))
            })
            .cloned()
            .collect::<Vec<_>>();
        for path in &removed {
            watched.remove(path);
        }
        removed
    };

    if removed_paths.is_empty() {
        return;
    }
    let mut watcher = match watcher.lock() {
        Ok(watcher) => watcher,
        Err(_) => {
            warn!("File system watcher is poisoned");
            return;
        }
    };
    for path in removed_paths {
        if let Err(error) = watcher.unwatch(&path) {
            debug!("Failed to unwatch removed directory {:?}: {}", path, error);
        }
    }
}

/// Debounce task that collects events and emits them to the frontend
async fn debounce_task(
    rx: Arc<Mutex<mpsc::UnboundedReceiver<Event>>>,
    app_handle: AppHandle,
    workspace: PathBuf,
    watcher: Arc<StdMutex<RecommendedWatcher>>,
    watched_paths: Arc<StdMutex<HashSet<PathBuf>>>,
) {
    let debounce_duration = Duration::from_millis(300);
    let mut pending_events: Vec<Event> = Vec::new();
    let mut ignored_event_count: usize = 0;

    loop {
        let mut rx_guard = rx.lock().await;

        match tokio::time::timeout(debounce_duration, rx_guard.recv()).await {
            Ok(Some(event)) => {
                unregister_removed_directories(&event, &watcher, &watched_paths);
                register_new_directories(&event, &workspace, &watcher, &watched_paths);
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
                    | ".macro"
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
        std::fs::create_dir_all(workspace.join(".macro/worktrees/generated")).expect(".macro");
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
        assert!(!watched.iter().any(|path| path.starts_with(".macro")));
        assert!(!watched.iter().any(|path| path.starts_with("node_modules")));
        assert!(!watched.iter().any(|path| path.starts_with("target")));
        assert_eq!(plan.ignored_dir_count, 4);
    }

    #[test]
    fn test_new_directory_event_extends_non_recursive_watch_plan() {
        let temp = tempfile::tempdir().expect("tempdir");
        let workspace = temp.path();
        std::fs::create_dir_all(workspace.join("src")).expect("src");
        let initial = build_watch_plan(workspace);
        let watched = initial.watch_paths.into_iter().collect::<HashSet<_>>();
        let created = workspace.join("generated");
        std::fs::create_dir_all(created.join("nested")).expect("new nested directory");
        std::fs::create_dir_all(created.join("node_modules/pkg")).expect("ignored directory");
        std::fs::create_dir_all(created.join(".macro/worktrees/task")).expect("macro worktrees");
        let event = Event::new(EventKind::Create(notify::event::CreateKind::Folder))
            .add_path(created.clone());

        let discovered = discover_unwatched_directories(&event, workspace, &watched);

        assert!(discovered.contains(&created));
        assert!(discovered.contains(&created.join("nested")));
        assert!(!discovered
            .iter()
            .any(|path| path.starts_with(created.join("node_modules"))));
        assert!(!discovered
            .iter()
            .any(|path| path.starts_with(created.join(".macro"))));
    }

    #[test]
    fn test_removed_directory_is_registered_again_after_recreation() {
        use std::sync::mpsc;
        use std::time::Instant;

        let temp = tempfile::tempdir().expect("tempdir");
        let workspace = temp.path().to_path_buf();
        let recreated = workspace.join("recreated");
        std::fs::create_dir_all(&recreated).expect("initial directory");

        let (event_tx, event_rx) = mpsc::channel();
        let mut raw_watcher = RecommendedWatcher::new(
            move |result: Result<Event, notify::Error>| {
                if let Ok(event) = result {
                    let _ = event_tx.send(event);
                }
            },
            Config::default().with_poll_interval(Duration::from_millis(50)),
        )
        .expect("watcher");
        raw_watcher
            .watch(&workspace, RecursiveMode::NonRecursive)
            .expect("watch workspace");
        raw_watcher
            .watch(&recreated, RecursiveMode::NonRecursive)
            .expect("watch initial directory");
        let watcher = Arc::new(StdMutex::new(raw_watcher));
        let watched_paths = Arc::new(StdMutex::new(HashSet::from([
            workspace.clone(),
            recreated.clone(),
        ])));

        std::fs::remove_dir_all(&recreated).expect("remove watched directory");
        let delete_deadline = Instant::now() + Duration::from_secs(5);
        while watched_paths
            .lock()
            .expect("watched paths")
            .contains(&recreated)
        {
            let remaining = delete_deadline
                .checked_duration_since(Instant::now())
                .expect("remove event before deadline");
            let event = event_rx
                .recv_timeout(remaining)
                .expect("receive remove event");
            unregister_removed_directories(&event, &watcher, &watched_paths);
            register_new_directories(&event, &workspace, &watcher, &watched_paths);
        }

        std::fs::create_dir_all(&recreated).expect("recreate directory");
        let create_deadline = Instant::now() + Duration::from_secs(5);
        while !watched_paths
            .lock()
            .expect("watched paths")
            .contains(&recreated)
        {
            let remaining = create_deadline
                .checked_duration_since(Instant::now())
                .expect("create event before deadline");
            let event = event_rx
                .recv_timeout(remaining)
                .expect("receive create event");
            unregister_removed_directories(&event, &watcher, &watched_paths);
            register_new_directories(&event, &workspace, &watcher, &watched_paths);
        }

        let nested_file = recreated.join("after-recreate.txt");
        std::fs::write(&nested_file, "watched").expect("write nested file");
        let file_deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let remaining = file_deadline
                .checked_duration_since(Instant::now())
                .expect("nested event before deadline");
            let event = event_rx
                .recv_timeout(remaining)
                .expect("receive nested file event");
            if event.paths.iter().any(|path| path == &nested_file) {
                break;
            }
        }
    }
}
