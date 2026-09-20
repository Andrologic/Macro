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
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio_util::sync::CancellationToken;
use tracing::{debug, error, info, warn};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct WatchDirectoryIdentity {
    volume: u64,
    file: u64,
}

#[cfg(unix)]
fn watch_directory_identity(path: &Path) -> Option<WatchDirectoryIdentity> {
    use std::os::unix::fs::MetadataExt;
    let metadata = fs::symlink_metadata(path).ok()?;
    Some(WatchDirectoryIdentity {
        volume: metadata.dev(),
        file: metadata.ino(),
    })
}

#[cfg(windows)]
fn watch_directory_identity(path: &Path) -> Option<WatchDirectoryIdentity> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_DELETE,
        FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };

    let mut wide_path = path.as_os_str().encode_wide().collect::<Vec<_>>();
    wide_path.push(0);
    let handle = unsafe {
        CreateFileW(
            wide_path.as_ptr(),
            0,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return None;
    }
    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    let succeeded = unsafe { GetFileInformationByHandle(handle, &mut information) } != 0;
    unsafe { CloseHandle(handle) };
    succeeded.then_some(WatchDirectoryIdentity {
        volume: u64::from(information.dwVolumeSerialNumber),
        file: (u64::from(information.nFileIndexHigh) << 32) | u64::from(information.nFileIndexLow),
    })
}

#[cfg(not(any(unix, windows)))]
fn watch_directory_identity(_path: &Path) -> Option<WatchDirectoryIdentity> {
    None
}

fn safe_watch_directory_identity(path: &Path, workspace: &Path) -> Option<WatchDirectoryIdentity> {
    let relative = path.strip_prefix(workspace).ok()?;
    let mut current = workspace.to_path_buf();
    for component in relative.components() {
        let std::path::Component::Normal(segment) = component else {
            return None;
        };
        current.push(segment);
        let metadata = fs::symlink_metadata(&current).ok()?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return None;
        }
    }
    let metadata = fs::symlink_metadata(path).ok()?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return None;
    }
    let identity_before = watch_directory_identity(path)?;
    let canonical_workspace = fs::canonicalize(workspace).ok()?;
    let canonical_path = fs::canonicalize(path).ok()?;
    if !canonical_path.starts_with(&canonical_workspace) {
        return None;
    }
    let metadata = fs::symlink_metadata(path).ok()?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return None;
    }
    (watch_directory_identity(path)? == identity_before).then_some(identity_before)
}

// Serialize revocation with publication, including an emission already in progress.
// Taking the callback also releases its AppHandle before waiting for native cleanup.
type EventSink = Arc<StdMutex<Option<Box<dyn FnMut(&[FsEventDto]) + Send>>>>;

// notify may retire its native thread after the watcher object is dropped.
// Closing the oneshot marks actual callback destruction, after its event sender.
struct NativeEventHandler {
    events: mpsc::UnboundedSender<Event>,
    _retirement: oneshot::Sender<()>,
}

impl notify::EventHandler for NativeEventHandler {
    fn handle_event(&mut self, result: Result<Event, notify::Error>) {
        if let Ok(event) = result {
            let _ = self.events.send(event);
        }
    }
}

/// Owns the debounce task and revokes its right to publish before retirement.
pub struct FsWatcher {
    workspace: PathBuf,
    cancellation: CancellationToken,
    sink: EventSink,
    debounce_handle: Option<tauri::async_runtime::JoinHandle<()>>,
    callback_retired: Option<oneshot::Receiver<()>>,
    #[cfg(test)]
    watched_paths: Arc<StdMutex<HashSet<PathBuf>>>,
    #[cfg(test)]
    debounce_tx: mpsc::UnboundedSender<Event>,
}

impl FsWatcher {
    pub fn new(
        workspace: PathBuf,
        app_handle: AppHandle,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        Self::new_with_sink(workspace, Duration::from_millis(300), move |events| {
            if let Err(error) = app_handle.emit("fs:change", events) {
                error!("Failed to emit fs:change event: {}", error);
            }
        })
    }

    fn new_with_sink(
        workspace: PathBuf,
        debounce_duration: Duration,
        emit: impl FnMut(&[FsEventDto]) + Send + 'static,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        let (debounce_tx, debounce_rx) = mpsc::unbounded_channel::<Event>();
        let (retirement, callback_retired) = oneshot::channel();
        let mut watcher = RecommendedWatcher::new(
            NativeEventHandler {
                events: debounce_tx.clone(),
                _retirement: retirement,
            },
            Config::default().with_poll_interval(Duration::from_millis(100)),
        )?;

        // Complete fallible registration before spawning. Any failure drops the
        // native watcher, its callback and all registrations acquired so far.
        let watch_plan = build_watch_plan(&workspace);
        for path in &watch_plan.watch_paths {
            watcher.watch(path, RecursiveMode::NonRecursive)?;
        }
        let watched_paths = Arc::new(StdMutex::new(
            watch_plan.watch_paths.iter().cloned().collect(),
        ));
        let watcher = Arc::new(StdMutex::new(watcher));
        let cancellation = CancellationToken::new();
        let sink: EventSink = Arc::new(StdMutex::new(Some(Box::new(emit))));

        info!(
            "File system watcher started for {:?}: watching {} directories, skipped {} ignored directories",
            workspace,
            watch_plan.watch_paths.len(),
            watch_plan.ignored_dir_count
        );

        // The task is the sole owner of the native watcher. Its callback can
        // keep the event channel open, but cannot keep cancellation pending.
        let debounce_handle = tauri::async_runtime::spawn(debounce_task(
            debounce_rx,
            sink.clone(),
            workspace.clone(),
            watcher,
            watched_paths.clone(),
            cancellation.clone(),
            debounce_duration,
        ));

        Ok(Self {
            workspace,
            cancellation,
            sink,
            debounce_handle: Some(debounce_handle),
            callback_retired: Some(callback_retired),
            #[cfg(test)]
            watched_paths,
            #[cfg(test)]
            debounce_tx,
        })
    }

    fn revoke(&self) {
        self.cancellation.cancel();
        let callback = self.sink.lock().unwrap_or_else(|e| e.into_inner()).take();
        drop(callback);
    }

    /// Revoke publication, discard pending events and wait for task/native cleanup.
    /// Repeated calls are harmless. Cancelling this future retains the join handle
    /// so a later call can finish waiting. No durable filesystem operation is aborted.
    pub async fn stop(&mut self) {
        self.revoke();
        if let Some(handle) = self.debounce_handle.as_mut() {
            if let Err(error) = handle.await {
                warn!("File system watcher task failed during shutdown: {}", error);
            }
            self.debounce_handle = None;
        }
        if let Some(retired) = self.callback_retired.as_mut() {
            // Sender closure is the completion signal, so RecvError is expected.
            let _ = retired.await;
            self.callback_retired = None;
        }
    }

    #[allow(dead_code)]
    pub fn workspace(&self) -> &Path {
        &self.workspace
    }
}

impl Drop for FsWatcher {
    fn drop(&mut self) {
        self.revoke();
        if let Some(handle) = self.debounce_handle.take() {
            // Drop cannot await. This task only monitors paths and publishes
            // notifications; abort releases it at its next yield. Use stop to join.
            handle.abort();
        }
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
    if watch_paths.is_empty() && safe_watch_directory_identity(workspace, workspace).is_some() {
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

    let Some(identity_before) = safe_watch_directory_identity(current, workspace) else {
        return;
    };

    let entries = match fs::read_dir(current) {
        Ok(entries) => entries.flatten().collect::<Vec<_>>(),
        Err(error) => {
            warn!("Failed to read watcher directory {:?}: {}", current, error);
            if safe_watch_directory_identity(current, workspace) == Some(identity_before) {
                watch_paths.push(current.to_path_buf());
            }
            return;
        }
    };

    if safe_watch_directory_identity(current, workspace) != Some(identity_before) {
        return;
    }
    watch_paths.push(current.to_path_buf());

    for entry in entries {
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
        if safe_watch_directory_identity(path, workspace).is_none()
            || should_ignore_path(path, workspace)
        {
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
        let Some(identity_before) = safe_watch_directory_identity(&path, workspace) else {
            continue;
        };
        match watcher.watch(&path, RecursiveMode::NonRecursive) {
            Ok(()) => {
                if safe_watch_directory_identity(&path, workspace) == Some(identity_before) {
                    watched.insert(path);
                } else if let Err(error) = watcher.unwatch(&path) {
                    debug!("Failed to unwatch replaced directory {:?}: {}", path, error);
                }
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
    mut rx: mpsc::UnboundedReceiver<Event>,
    sink: EventSink,
    workspace: PathBuf,
    watcher: Arc<StdMutex<RecommendedWatcher>>,
    watched_paths: Arc<StdMutex<HashSet<PathBuf>>>,
    cancellation: CancellationToken,
    debounce_duration: Duration,
) {
    let mut pending_events: Vec<Event> = Vec::new();
    let mut ignored_event_count: usize = 0;

    loop {
        let received = tokio::select! {
            biased;
            _ = cancellation.cancelled() => break,
            received = tokio::time::timeout(debounce_duration, rx.recv()) => received,
        };
        match received {
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
                        let mut sink = sink.lock().unwrap_or_else(|e| e.into_inner());
                        if !cancellation.is_cancelled() {
                            if let Some(emit) = sink.as_mut() {
                                emit(&events_to_emit);
                            }
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

/// Called only once application exit has been accepted, never for a guarded close.
/// Native watcher destruction can wait on OS callbacks, so run it off the event
/// loop and bound only the caller's wait. Cleanup continues if that budget expires.
pub fn shutdown_watcher(app_handle: &AppHandle) {
    let Some(watcher) = app_handle.try_state::<Arc<Mutex<FsWatcher>>>() else {
        return;
    };
    let watcher = watcher.inner().clone();
    let (finished_tx, finished_rx) = std::sync::mpsc::sync_channel(1);
    let _cleanup = tauri::async_runtime::spawn(async move {
        watcher.lock().await.stop().await;
        let _ = finished_tx.send(());
    });
    // Use an OS timeout: even a native callback blocking the runtime's timer
    // driver must not leave the application event loop waiting indefinitely.
    match finished_rx.recv_timeout(Duration::from_secs(2)) {
        Ok(()) => {}
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
            warn!("File system watcher shutdown task ended without reporting completion");
        }
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            warn!("File system watcher shutdown exceeded its 2-second budget");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn wait_for_directory(watcher: &FsWatcher, path: &Path) {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if watcher.watched_paths.lock().expect("paths").contains(path) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("native event registered the new directory");
    }

    async fn wait_for_callback_release(tx: &mpsc::UnboundedSender<Event>) {
        tokio::time::timeout(Duration::from_secs(5), async {
            // notify's Windows/Linux destructors request native thread shutdown;
            // callback destruction may follow the watcher object's destruction.
            while tx.strong_count() != 1 {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("native listener released its callback sender");
    }

    #[tokio::test]
    async fn lifecycle_stop_delivers_then_retires_native_listener_and_task() {
        let temp = tempfile::tempdir().expect("workspace");
        let workspace = fs::canonicalize(temp.path()).expect("canonical workspace");
        let (emitted_tx, mut emitted_rx) = mpsc::unbounded_channel();
        let mut watcher = FsWatcher::new_with_sink(
            workspace.clone(),
            Duration::from_millis(30),
            move |events| {
                let _ = emitted_tx.send(events.to_vec());
            },
        )
        .expect("watcher");
        let file = workspace.join("observed.txt");
        fs::write(&file, "before stop").expect("write observed file");
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let events = emitted_rx.recv().await.expect("live event sink");
                if events.iter().any(|event| match event {
                    FsEventDto::Created { path } | FsEventDto::Modified { path } => {
                        Path::new(path) == file
                    }
                    _ => false,
                }) {
                    break;
                }
            }
        })
        .await
        .expect("real filesystem mutation was emitted");

        tokio::time::timeout(Duration::from_secs(5), watcher.stop())
            .await
            .expect("stop joined the task");
        assert!(watcher.debounce_tx.is_closed(), "receiver retired");
        assert_eq!(Arc::strong_count(&watcher.watched_paths), 1);
        assert_eq!(
            watcher.debounce_tx.strong_count(),
            1,
            "native callback retired"
        );
        // Drain publications completed before stop; the sink must now be closed.
        while emitted_rx.try_recv().is_ok() {}
        fs::write(&file, "after stop").expect("write after stop");
        assert!(
            matches!(
                emitted_rx.try_recv(),
                Err(mpsc::error::TryRecvError::Disconnected)
            ),
            "no late publication"
        );
        watcher.stop().await;
        assert!(watcher.debounce_handle.is_none());
    }

    #[tokio::test]
    async fn lifecycle_stop_discards_pending_native_debounce() {
        let temp = tempfile::tempdir().expect("workspace");
        let workspace = fs::canonicalize(temp.path()).expect("canonical workspace");
        let (emitted_tx, mut emitted_rx) = mpsc::unbounded_channel();
        let mut watcher =
            FsWatcher::new_with_sink(workspace.clone(), Duration::from_secs(30), move |events| {
                let _ = emitted_tx.send(events.to_vec());
            })
            .expect("watcher");
        let created = workspace.join("pending");
        fs::create_dir(&created).expect("create watched directory");
        wait_for_directory(&watcher, &created).await;
        assert!(
            matches!(emitted_rx.try_recv(), Err(mpsc::error::TryRecvError::Empty)),
            "debounce still pending"
        );

        // A stop must wake the actual loop, not wait out its 30-second debounce.
        tokio::time::timeout(Duration::from_secs(5), watcher.stop())
            .await
            .expect("stop woke and joined the pending loop");
        assert!(
            matches!(
                emitted_rx.try_recv(),
                Err(mpsc::error::TryRecvError::Disconnected)
            ),
            "pending batch discarded"
        );
        assert!(watcher.debounce_tx.is_closed());
        assert_eq!(
            watcher.debounce_tx.strong_count(),
            1,
            "native callback retired"
        );
        watcher.stop().await;
    }

    #[tokio::test]
    async fn lifecycle_drop_revokes_pending_sink_and_releases_native_loop() {
        let temp = tempfile::tempdir().expect("workspace");
        let workspace = fs::canonicalize(temp.path()).expect("canonical workspace");
        let (emitted_tx, mut emitted_rx) = mpsc::unbounded_channel();
        let watcher =
            FsWatcher::new_with_sink(workspace.clone(), Duration::from_secs(30), move |events| {
                let _ = emitted_tx.send(events.to_vec());
            })
            .expect("watcher");
        let created = workspace.join("pending-drop");
        fs::create_dir(&created).expect("create watched directory");
        wait_for_directory(&watcher, &created).await;
        let tx = watcher.debounce_tx.clone();
        let paths = Arc::downgrade(&watcher.watched_paths);

        drop(watcher);
        assert!(
            matches!(
                emitted_rx.try_recv(),
                Err(mpsc::error::TryRecvError::Disconnected)
            ),
            "Drop revoked the sink"
        );
        tokio::time::timeout(Duration::from_secs(5), tx.closed())
            .await
            .expect("Drop retired the event receiver");
        wait_for_callback_release(&tx).await;
        assert!(paths.upgrade().is_none(), "task released its registry");
    }

    #[tokio::test]
    async fn lifecycle_stop_waits_for_an_emission_already_in_progress() {
        let temp = tempfile::tempdir().expect("workspace");
        let workspace = fs::canonicalize(temp.path()).expect("canonical workspace");
        let (entered_tx, mut entered_rx) = mpsc::unbounded_channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let mut watcher =
            FsWatcher::new_with_sink(workspace.clone(), Duration::from_millis(30), move |_| {
                let _ = entered_tx.send(());
                // A failed test must also release the runtime worker.
                let _ = release_rx.recv_timeout(Duration::from_secs(5));
            })
            .expect("watcher");
        fs::write(workspace.join("in-flight.txt"), "event").expect("write event");
        tokio::time::timeout(Duration::from_secs(5), entered_rx.recv())
            .await
            .expect("sink entered before deadline")
            .expect("sink entered");

        let (stopped_tx, stopped_rx) = std::sync::mpsc::channel();
        let cancellation = watcher.cancellation.clone();
        // Use a separate thread because stop synchronizes with the blocking sink.
        let stopping = std::thread::spawn(move || {
            tauri::async_runtime::block_on(watcher.stop());
            stopped_tx.send(()).expect("report stop");
        });
        tokio::time::timeout(Duration::from_secs(5), cancellation.cancelled())
            .await
            .expect("stop began revocation");
        let pending = stopped_rx.try_recv();
        release_tx.send(()).expect("release sink");
        assert!(matches!(pending, Err(std::sync::mpsc::TryRecvError::Empty)));
        stopped_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("stop completed after sink returned");
        stopping.join().expect("stop thread");
        assert!(
            matches!(
                entered_rx.try_recv(),
                Err(mpsc::error::TryRecvError::Disconnected)
            ),
            "sink retired"
        );
    }

    #[cfg(windows)]
    fn link_directory(link: &Path, target: &Path) {
        let link = PathBuf::from(link.to_string_lossy().replace('/', "\\"));
        let target = PathBuf::from(target.to_string_lossy().replace('/', "\\"));
        let status = crate::core::process::background_command("cmd")
            .args(["/d", "/c", "mklink /J"])
            .arg(&link)
            .arg(&target)
            .status()
            .expect("create Windows junction");
        assert!(status.success(), "mklink /J must create the test junction");
    }

    #[cfg(unix)]
    fn link_directory(link: &Path, target: &Path) {
        std::os::unix::fs::symlink(target, link).expect("create directory symlink");
    }

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
    fn test_new_directory_event_does_not_follow_a_linked_directory() {
        let workspace = tempfile::tempdir().expect("workspace");
        let outside = tempfile::tempdir().expect("outside directory");
        std::fs::create_dir_all(outside.path().join("nested")).expect("outside nested directory");
        let linked = workspace.path().join("linked");
        link_directory(&linked, outside.path());
        let event = Event::new(EventKind::Create(notify::event::CreateKind::Folder))
            .add_path(linked.clone());

        let discovered = discover_unwatched_directories(&event, workspace.path(), &HashSet::new());

        assert!(discovered.is_empty());
    }

    #[test]
    fn test_watch_identity_detects_a_directory_replaced_after_discovery() {
        let workspace = tempfile::tempdir().expect("workspace");
        let watched = workspace.path().join("watched");
        std::fs::create_dir(&watched).expect("watched directory");
        let discovered_identity = safe_watch_directory_identity(&watched, workspace.path())
            .expect("initial directory identity");

        std::fs::rename(&watched, workspace.path().join("original-watched"))
            .expect("move original directory");
        std::fs::create_dir(&watched).expect("replacement directory");

        assert_ne!(
            safe_watch_directory_identity(&watched, workspace.path()),
            Some(discovered_identity)
        );
    }

    #[test]
    fn test_removed_directory_is_registered_again_after_recreation() {
        use std::sync::mpsc;
        use std::time::Instant;

        let temp = tempfile::tempdir().expect("tempdir");
        // Native backends report canonical paths, including macOS /var aliases.
        let workspace = fs::canonicalize(temp.path()).expect("canonical workspace");
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
