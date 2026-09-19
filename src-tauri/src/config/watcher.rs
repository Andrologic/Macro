use super::{ConfigChangeSource, ConfigManager};
use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Emitter};
use tokio::sync::watch;

pub struct ConfigWatcher {
    state: Mutex<WatcherState>,
}

struct WatcherState {
    // This backend is never changed by project reconciliation.
    _global_watcher: RecommendedWatcher,
    signal_tx: watch::Sender<u64>,
    roots: RootSubscriptions<RecommendedWatcher>,
}

struct RootSubscriptions<W> {
    project_roots: BTreeMap<String, PathBuf>,
    subscriptions: BTreeMap<PathBuf, Subscription<W>>,
}

struct Subscription<W> {
    _backend: W,
    identity: DirectoryIdentity,
    invalidated: Arc<AtomicBool>,
}

#[derive(Debug, PartialEq, Eq)]
struct DirectoryIdentity {
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
    created: Option<SystemTime>,
}

impl DirectoryIdentity {
    fn read(root: &Path) -> Result<Self, String> {
        let metadata = root.metadata().map_err(|error| error.to_string())?;
        if !metadata.is_dir() {
            return Err("Configuration root is not a directory".into());
        }
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;
        Ok(Self {
            #[cfg(unix)]
            device: metadata.dev(),
            #[cfg(unix)]
            inode: metadata.ino(),
            created: metadata.created().ok(),
        })
    }
}

pub type ConfigWatcherState = Arc<ConfigWatcher>;

impl ConfigWatcher {
    #[cfg(test)]
    pub(crate) fn for_test(root: &Path) -> Self {
        let (signal_tx, _signal_rx) = watch::channel(0_u64);
        Self {
            state: Mutex::new(
                WatcherState::new(root, signal_tx).expect("test configuration watcher"),
            ),
        }
    }

    pub fn start(
        root: PathBuf,
        manager: ConfigManager,
        app: AppHandle,
    ) -> Result<ConfigWatcherState, String> {
        let (signal_tx, mut signal_rx) = watch::channel(0_u64);
        let watcher_state = Arc::new(Self {
            state: Mutex::new(WatcherState::new(&root, signal_tx)?),
        });

        tauri::async_runtime::spawn(async move {
            let debounce = Duration::from_millis(250);
            while signal_rx.changed().await.is_ok() {
                tokio::time::sleep(debounce).await;
                signal_rx.borrow_and_update();
                for outcome in manager
                    .reload_all_changed(ConfigChangeSource::ExternalEditor)
                    .await
                {
                    match outcome {
                        Ok(outcome) if outcome.invalid => {
                            let _ = app.emit("config://invalid", &outcome.document);
                        }
                        Ok(outcome) => {
                            if let Some(pending) = &outcome.pending {
                                let _ = app.emit("config://pending-sensitive-change", pending);
                            } else if outcome.changed {
                                let _ = app.emit("config://changed", &outcome.document);
                            }
                            if outcome.restart_required {
                                let _ = app.emit("config://restart-required", &outcome.document);
                            }
                        }
                        Err(error) => {
                            tracing::warn!(
                                code = %error.code,
                                message = %error.message,
                                "Échec du rechargement de la configuration"
                            );
                        }
                    }
                }
            }
        });

        Ok(watcher_state)
    }

    /// Replace the complete set of project subscriptions, including removals.
    pub fn reconcile_project_roots(&self, roots: &BTreeMap<String, PathBuf>) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Le verrou du watcher de configuration est empoisonné.".to_string())?;
        state.roots.project_roots = roots.clone();
        state.reconcile()
    }

    pub fn watch_project_root(&self, project_id: &str, root: &Path) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Le verrou du watcher de configuration est empoisonné.".to_string())?;
        state
            .roots
            .project_roots
            .insert(project_id.to_string(), root.to_path_buf());
        state.reconcile()
    }
}

// Own the backend before attempting watch: even a partially installed recursive
// watch is disposed of on error by dropping the entire backend.
fn install_backend<W>(
    mut backend: W,
    install: impl FnOnce(&mut W) -> notify::Result<()>,
) -> Result<W, String> {
    install(&mut backend).map_err(|error| error.to_string())?;
    Ok(backend)
}

fn invalidates_root(root: &Path, result: &notify::Result<Event>) -> bool {
    match result {
        Err(_) => true,
        Ok(event) => {
            event.need_rescan()
                || (matches!(
                    event.kind,
                    notify::EventKind::Remove(_)
                        | notify::EventKind::Modify(notify::event::ModifyKind::Name(_))
                ) && event.paths.iter().any(|path| root.starts_with(path)))
        }
    }
}

fn make_backend(
    root: &Path,
    mode: RecursiveMode,
    signal_tx: watch::Sender<u64>,
    invalidated: Arc<AtomicBool>,
) -> Result<RecommendedWatcher, String> {
    let callback_root = root.to_path_buf();
    let backend = RecommendedWatcher::new(
        move |result: notify::Result<Event>| {
            if invalidates_root(&callback_root, &result) {
                invalidated.store(true, Ordering::Release);
            }
            // Errors/rescans must also wake the consumer, not just ordinary events.
            signal_tx.send_modify(|generation| *generation = generation.wrapping_add(1));
        },
        Config::default().with_poll_interval(Duration::from_millis(100)),
    )
    .map_err(|error| error.to_string())?;
    install_backend(backend, |backend| backend.watch(root, mode))
}

impl WatcherState {
    fn new(root: &Path, signal_tx: watch::Sender<u64>) -> Result<Self, String> {
        let root = root.canonicalize().map_err(|error| error.to_string())?;
        DirectoryIdentity::read(&root)?;
        let global_watcher = make_backend(
            &root,
            RecursiveMode::NonRecursive,
            signal_tx.clone(),
            Arc::new(AtomicBool::new(false)),
        )?;
        Ok(Self {
            _global_watcher: global_watcher,
            signal_tx,
            roots: RootSubscriptions {
                project_roots: BTreeMap::new(),
                subscriptions: BTreeMap::new(),
            },
        })
    }

    fn reconcile(&mut self) -> Result<(), String> {
        let signal_tx = &self.signal_tx;
        self.roots.reconcile(|root, invalidated| {
            make_backend(
                root,
                RecursiveMode::Recursive,
                signal_tx.clone(),
                invalidated,
            )
        })
    }
}

impl<W> RootSubscriptions<W> {
    fn reconcile(
        &mut self,
        mut create: impl FnMut(&Path, Arc<AtomicBool>) -> Result<W, String>,
    ) -> Result<(), String> {
        let mut desired = BTreeMap::new();
        let mut errors = Vec::new();
        for (project_id, root) in &self.project_roots {
            let resolved = root
                .canonicalize()
                .map_err(|error| error.to_string())
                .and_then(|root| DirectoryIdentity::read(&root).map(|identity| (root, identity)));
            match resolved {
                Ok((root, identity)) => {
                    desired.insert(root, identity);
                }
                Err(error) => errors.push(format!(
                    "Cannot resolve configuration root for project {project_id} ({}): {error}",
                    root.display()
                )),
            }
        }

        // Dispose of obsolete, replaced or invalidated backends before any additions.
        // Each backend owns only one root, so partial cleanup cannot affect siblings
        // or overlapping project roots. No fallible per-path unwatch is necessary.
        self.subscriptions.retain(|root, subscription| {
            desired.get(root) == Some(&subscription.identity)
                && !subscription.invalidated.load(Ordering::Acquire)
        });
        for (root, identity) in desired {
            if self.subscriptions.contains_key(&root) {
                continue;
            }
            let invalidated = Arc::new(AtomicBool::new(false));
            match create(&root, invalidated.clone()) {
                Ok(backend) => {
                    // Detect replacement during installation as well. A callback
                    // racing after this check still leaves its flag set for retry.
                    if DirectoryIdentity::read(&root).as_ref() != Ok(&identity)
                        || invalidated.load(Ordering::Acquire)
                    {
                        drop(backend);
                        errors.push(format!(
                            "Configuration root changed while watching {}",
                            root.display()
                        ));
                        continue;
                    }
                    self.subscriptions.insert(
                        root,
                        Subscription {
                            _backend: backend,
                            identity,
                            invalidated,
                        },
                    );
                }
                Err(error) => errors.push(format!("Cannot watch {}: {error}", root.display())),
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    struct BackendGuard(Arc<AtomicUsize>);
    impl Drop for BackendGuard {
        fn drop(&mut self) {
            self.0.fetch_sub(1, Ordering::SeqCst);
        }
    }
    fn mock_backend(active: &Arc<AtomicUsize>, fail: bool) -> Result<BackendGuard, String> {
        install_backend(BackendGuard(active.clone()), |_| {
            // Mutate backend-owned resources before returning the injected error.
            active.fetch_add(1, Ordering::SeqCst);
            if fail {
                Err(notify::Error::generic("partially installed"))
            } else {
                Ok(())
            }
        })
    }
    fn roots<W>() -> RootSubscriptions<W> {
        RootSubscriptions {
            project_roots: BTreeMap::new(),
            subscriptions: BTreeMap::new(),
        }
    }

    #[test]
    fn partial_installation_is_dropped_and_replacement_failure_removes_old_backend() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let active = Arc::new(AtomicUsize::new(0));
        let mut roots = roots();
        roots.project_roots.insert("a".into(), first.path().into());
        roots
            .reconcile(|_, _| mock_backend(&active, false))
            .unwrap();
        assert_eq!(active.load(Ordering::SeqCst), 1);
        roots.project_roots.insert("a".into(), second.path().into());
        assert!(roots
            .reconcile(|_, _| {
                assert_eq!(active.load(Ordering::SeqCst), 0);
                mock_backend(&active, true)
            })
            .is_err());
        assert_eq!(active.load(Ordering::SeqCst), 0);
        assert!(roots.subscriptions.is_empty());
        roots
            .reconcile(|_, _| mock_backend(&active, false))
            .unwrap();
        roots.project_roots.clear();
        roots
            .reconcile(|_, _| panic!("unexpected creation"))
            .unwrap();
        assert_eq!(active.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn aliases_share_backend_and_missing_replacement_removes_it() {
        let directory = tempfile::tempdir().unwrap();
        let active = Arc::new(AtomicUsize::new(0));
        let mut roots = roots();
        roots
            .project_roots
            .insert("a".into(), directory.path().into());
        roots
            .project_roots
            .insert("b".into(), directory.path().join("."));
        roots
            .reconcile(|_, _| mock_backend(&active, false))
            .unwrap();
        assert_eq!(active.load(Ordering::SeqCst), 1);
        roots.project_roots.remove("a");
        roots
            .reconcile(|_, _| panic!("unchanged identity"))
            .unwrap();
        roots
            .project_roots
            .insert("b".into(), directory.path().join("missing"));
        assert!(roots.reconcile(|_, _| panic!("missing root")).is_err());
        assert_eq!(active.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn invalidation_rebuilds_and_partial_success_is_retained() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let active = Arc::new(AtomicUsize::new(0));
        let mut roots = roots();
        roots.project_roots.insert("a".into(), first.path().into());
        roots.project_roots.insert("b".into(), second.path().into());
        let second_root = second.path().canonicalize().unwrap();
        assert!(roots
            .reconcile(|path, _| mock_backend(&active, path == second_root))
            .is_err());
        assert_eq!(active.load(Ordering::SeqCst), 1);
        roots
            .reconcile(|path, _| {
                assert_eq!(path, second_root);
                mock_backend(&active, false)
            })
            .unwrap();
        let first_root = first.path().canonicalize().unwrap();
        roots.subscriptions[&first_root]
            .invalidated
            .store(true, Ordering::Release);
        roots
            .reconcile(|path, _| {
                assert_eq!(path, first_root);
                assert_eq!(active.load(Ordering::SeqCst), 1);
                mock_backend(&active, false)
            })
            .unwrap();
        assert_eq!(active.load(Ordering::SeqCst), 2);
    }

    #[cfg(unix)]
    #[test]
    fn identity_change_rebuilds_even_without_callback() {
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join("project");
        std::fs::create_dir(&root).unwrap();
        let active = Arc::new(AtomicUsize::new(0));
        let mut roots = roots();
        roots.project_roots.insert("a".into(), root.clone());
        roots
            .reconcile(|_, _| mock_backend(&active, false))
            .unwrap();
        let canonical = root.canonicalize().unwrap();
        let old_flag = roots.subscriptions[&canonical].invalidated.clone();
        std::fs::write(root.join("config"), "content change").unwrap();
        roots
            .reconcile(|_, _| panic!("content changes do not replace the directory"))
            .unwrap();
        // Keep the old inode allocated to make identity replacement deterministic.
        std::fs::rename(&root, parent.path().join("previous")).unwrap();
        std::fs::create_dir(&root).unwrap();
        roots
            .reconcile(|_, _| {
                assert_eq!(active.load(Ordering::SeqCst), 0);
                mock_backend(&active, false)
            })
            .unwrap();
        assert!(!Arc::ptr_eq(
            &old_flag,
            &roots.subscriptions[&canonical].invalidated
        ));
    }

    #[test]
    fn invalidation_during_installation_drops_backend_and_is_retryable() {
        let directory = tempfile::tempdir().unwrap();
        let active = Arc::new(AtomicUsize::new(0));
        let mut roots = roots();
        roots
            .project_roots
            .insert("a".into(), directory.path().into());
        assert!(roots
            .reconcile(|_, invalidated| {
                let backend = mock_backend(&active, false)?;
                invalidated.store(true, Ordering::Release);
                Ok(backend)
            })
            .is_err());
        assert_eq!(active.load(Ordering::SeqCst), 0);
        assert!(roots.subscriptions.is_empty());
        roots
            .reconcile(|_, _| mock_backend(&active, false))
            .unwrap();
        assert_eq!(active.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn root_events_errors_and_rescans_invalidate_but_child_changes_do_not() {
        use notify::event::{Flag, ModifyKind, RemoveKind, RenameMode};
        let root = Path::new("project");
        assert!(invalidates_root(
            root,
            &Err(notify::Error::generic("lost events"))
        ));
        assert!(invalidates_root(
            root,
            &Ok(Event::new(notify::EventKind::Other).set_flag(Flag::Rescan))
        ));
        for kind in [
            notify::EventKind::Remove(RemoveKind::Folder),
            notify::EventKind::Modify(ModifyKind::Name(RenameMode::From)),
        ] {
            assert!(invalidates_root(
                root,
                &Ok(Event::new(kind).add_path(root.into()))
            ));
            assert!(!invalidates_root(
                root,
                &Ok(Event::new(kind).add_path(root.join("child")))
            ));
        }
    }

    fn wait_for_signal(rx: &mut watch::Receiver<u64>) {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !rx.has_changed().unwrap() {
            assert!(std::time::Instant::now() < deadline, "missing native event");
            std::thread::sleep(Duration::from_millis(20));
        }
        rx.borrow_and_update();
    }

    #[test]
    fn native_shared_global_and_nested_roots_are_independent() {
        let global = tempfile::tempdir().unwrap();
        let nested = global.path().join("nested");
        std::fs::create_dir(&nested).unwrap();
        let (tx, mut rx) = watch::channel(0);
        let mut state = WatcherState::new(global.path(), tx).unwrap();
        state
            .roots
            .project_roots
            .insert("a".into(), global.path().into());
        state
            .roots
            .project_roots
            .insert("b".into(), global.path().join("."));
        state.roots.project_roots.insert("nested".into(), nested);
        state.reconcile().unwrap();
        assert_eq!(state.roots.subscriptions.len(), 2);
        let flag = state.roots.subscriptions[&global.path().canonicalize().unwrap()]
            .invalidated
            .clone();
        state.reconcile().unwrap();
        assert!(Arc::ptr_eq(
            &flag,
            &state.roots.subscriptions[&global.path().canonicalize().unwrap()].invalidated
        ));
        state.roots.project_roots.clear();
        state.reconcile().unwrap();
        assert!(state.roots.subscriptions.is_empty());
        rx.borrow_and_update();
        std::fs::write(global.path().join("global-config"), "changed").unwrap();
        wait_for_signal(&mut rx);
    }

    #[test]
    fn native_recreated_root_receives_events_after_reconciliation() {
        let global = tempfile::tempdir().unwrap();
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join("project");
        std::fs::create_dir(&root).unwrap();
        let (tx, _rx) = watch::channel(0);
        let mut state = WatcherState::new(global.path(), tx).unwrap();
        state.roots.project_roots.insert("a".into(), root.clone());
        state.reconcile().unwrap();
        let canonical = root.canonicalize().unwrap();
        let old_flag = state.roots.subscriptions[&canonical].invalidated.clone();
        std::fs::remove_dir(&root).unwrap();
        std::fs::create_dir(&root).unwrap();
        // Observe removal before reconciling even on filesystems that reuse identity.
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !old_flag.load(Ordering::Acquire)
            && DirectoryIdentity::read(&root).unwrap()
                == state.roots.subscriptions[&canonical].identity
        {
            assert!(
                std::time::Instant::now() < deadline,
                "replacement not detected"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        // A fresh channel isolates events emitted by the rebuilt backend from
        // deletion events still queued on the old backend and global watcher.
        let (tx, mut rx) = watch::channel(0);
        state.signal_tx = tx;
        state.reconcile().unwrap();
        assert!(!Arc::ptr_eq(
            &old_flag,
            &state.roots.subscriptions[&canonical].invalidated
        ));
        rx.borrow_and_update();
        std::fs::write(root.join("config"), "changed").unwrap();
        wait_for_signal(&mut rx);
    }
}
