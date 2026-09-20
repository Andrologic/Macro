use super::manager::DirectoryIdentity;
use super::{ConfigChangeSource, ConfigDocument, ConfigDocumentKind, ConfigManager, ConfigScope};
use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::watch;

pub struct ConfigWatcher {
    state: Mutex<WatcherState>,
}

struct WatcherState {
    // This backend is never changed by project reconciliation.
    _global_watcher: RecommendedWatcher,
    global_invalidated: Arc<AtomicBool>,
    global_backend_errors: Arc<Mutex<BTreeMap<PathBuf, String>>>,
    signal_tx: watch::Sender<u64>,
    roots: RootSubscriptions<RecommendedWatcher>,
    backend_errors: Arc<Mutex<BTreeMap<PathBuf, String>>>,
    observed_absences: Arc<Mutex<BTreeSet<PathBuf>>>,
}

struct RootSubscriptions<W> {
    project_roots: BTreeMap<String, PathBuf>,
    subscriptions: BTreeMap<PathBuf, Subscription<W>>,
    revision: u64,
}

struct Subscription<W> {
    // Each unique canonical root owns a native backend and its worker thread(s).
    // IDs share it; nested roots do not. Resource cost follows roots, not IDs.
    _backend: W,
    identity: DirectoryIdentity,
    invalidated: Arc<AtomicBool>,
}

pub type ConfigWatcherState = Arc<ConfigWatcher>;

impl ConfigWatcher {
    #[cfg(test)]
    pub(crate) fn desired_project_roots(&self) -> BTreeMap<String, PathBuf> {
        self.state
            .lock()
            .expect("test configuration watcher lock")
            .roots
            .project_roots
            .clone()
    }

    #[cfg(test)]
    pub(crate) fn subscribed_project_roots(&self) -> Vec<PathBuf> {
        self.state
            .lock()
            .expect("test configuration watcher lock")
            .roots
            .subscriptions
            .keys()
            .cloned()
            .collect()
    }

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
        let (signal_tx, signal_rx) = watch::channel(0_u64);
        let watcher_state = Arc::new(Self {
            state: Mutex::new(WatcherState::new(&root, signal_tx)?),
        });

        let weak = Arc::downgrade(&watcher_state);
        tauri::async_runtime::spawn(async move {
            maintain_subscriptions(
                weak,
                signal_rx,
                Duration::from_secs(2),
                Duration::from_millis(250),
                |errors| {
                    let manager = &manager;
                    let app = &app;
                    async move {
                        publish_maintenance_status(manager, errors, |document| {
                            let _ = app.emit("config://changed", &document);
                        })
                        .await;
                    }
                },
                |reload_requested, observed_absences| {
                    let manager = &manager;
                    let app = &app;
                    async move {
                        let (changed_manager, mut errors) =
                            refresh_project_state(manager, observed_absences, |document| {
                                let _ = app.emit("config://changed", &document);
                            })
                            .await;
                        if !reload_requested && !changed_manager {
                            return errors;
                        }
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
                                        let _ =
                                            app.emit("config://pending-sensitive-change", pending);
                                    } else if outcome.changed {
                                        let _ = app.emit("config://changed", &outcome.document);
                                    }
                                    if outcome.restart_required {
                                        let _ = app
                                            .emit("config://restart-required", &outcome.document);
                                    }
                                }
                                Err(error) => {
                                    errors.push(format!("{}: {}", error.code, error.message));
                                }
                            }
                        }
                        errors
                    }
                },
            )
            .await;
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

    pub fn unregister_project_root(&self, project_id: &str) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Le verrou du watcher de configuration est empoisonné.".to_string())?;
        state.roots.project_roots.remove(project_id);
        // Reconciliation drops obsolete backends before attempting any retry.
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

// A purge has no surviving document reload outcome. Notify snapshot consumers
// directly when root refresh changes the cache, including an empty replacement.
async fn refresh_project_state(
    manager: &ConfigManager,
    observed_absences: Vec<String>,
    mut notify_changed: impl FnMut(ConfigDocument),
) -> (bool, Vec<String>) {
    // Consume observed disappearances even if the same directory is already back.
    // The manager retains failed transitions for retry before allowing reuse.
    let observed = !observed_absences.is_empty();
    let mut errors = Vec::new();
    for project_id in observed_absences {
        if let Err(error) = manager.observe_project_root_unavailable(&project_id).await {
            errors.push(format!("{}: {}", error.code, error.message));
        }
    }
    let (changed, refresh_errors) = manager.refresh_project_roots().await;
    let changed = changed || observed;
    errors.extend(
        refresh_errors
            .into_iter()
            .map(|error| format!("{}: {}", error.code, error.message)),
    );
    if changed {
        match manager
            .get_document(ConfigDocumentKind::Runtime, ConfigScope::User)
            .await
        {
            Ok(document) => notify_changed(document),
            Err(error) => errors.push(format!("{}: {}", error.code, error.message)),
        }
    }
    (changed, errors)
}

async fn publish_maintenance_status(
    manager: &ConfigManager,
    errors: Vec<String>,
    mut notify_changed: impl FnMut(ConfigDocument),
) {
    let message = (!errors.is_empty()).then(|| format!(
        "La surveillance des configurations est dégradée : {}. Une nouvelle tentative est prévue automatiquement.",
        errors.join(" ; ")
    ));
    notify_changed(manager.record_maintenance_diagnostic(message).await);
}

struct MaintenanceBackoff {
    failures: u32,
    next_attempt: tokio::time::Instant,
}

impl MaintenanceBackoff {
    fn new() -> Self {
        Self {
            failures: 0,
            next_attempt: tokio::time::Instant::now(),
        }
    }

    fn ready(&self) -> bool {
        tokio::time::Instant::now() >= self.next_attempt
    }

    fn finish(&mut self, failed: bool, base: Duration) {
        if failed {
            let delay = base
                .saturating_mul(1_u32 << self.failures.min(5))
                .min(Duration::from_secs(30));
            self.failures = self.failures.saturating_add(1);
            self.next_attempt = tokio::time::Instant::now() + delay;
        } else {
            self.failures = 0;
            self.next_attempt = tokio::time::Instant::now();
        }
    }
}

// Keep only a Weak reference across every await, including manager refresh/reload.
// During failure cooldown, leave events pending in the coalescing watch channel:
// even an error storm cannot wake this loop faster than its bounded periodic tick.
// This shared budget can delay healthy roots too, by up to the 30-second cooldown.
async fn maintain_subscriptions<F, Fut, R, ReportFuture>(
    state: Weak<ConfigWatcher>,
    mut signal_rx: watch::Receiver<u64>,
    retry_interval: Duration,
    debounce: Duration,
    mut report_status: R,
    mut refresh_and_reload: F,
) where
    F: FnMut(bool, Vec<String>) -> Fut,
    Fut: std::future::Future<Output = Vec<String>>,
    R: FnMut(Vec<String>) -> ReportFuture,
    ReportFuture: std::future::Future<Output = ()>,
{
    let mut interval = tokio::time::interval(retry_interval);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut last_revision = 0;
    let mut last_errors = Vec::new();
    let mut backoff = MaintenanceBackoff::new();
    loop {
        let event = tokio::select! {
            changed = signal_rx.changed(), if backoff.ready() => {
                if changed.is_err() { return; }
                true
            }
            _ = tokio::time::sleep_until(backoff.next_attempt), if !backoff.ready() => false,
            _ = interval.tick() => false,
        };
        if state.strong_count() == 0 {
            return;
        }
        if !backoff.ready() {
            continue;
        }
        // A cooldown wakes through its timer, not through changed(). Consume any
        // event queued during that wait so a failing root cannot starve healthy ones.
        let event = event || signal_rx.has_changed().unwrap_or(false);
        if event {
            tokio::time::sleep(debounce).await;
            signal_rx.borrow_and_update();
        }
        let (revision, invalidated, observed_absences, mut errors) = {
            let Some(state) = state.upgrade() else {
                return;
            };
            let Ok(mut locked) = state.state.lock() else {
                tracing::warn!("Le verrou du watcher de configuration est empoisonné.");
                return;
            };
            let global_invalidated = locked.global_invalidated.load(Ordering::Acquire);
            let invalidated = global_invalidated
                || locked
                    .roots
                    .subscriptions
                    .values()
                    .any(|subscription| subscription.invalidated.load(Ordering::Acquire));
            // Consume callback failures before reconciliation can replace their
            // backend. A successful reinstall does not erase the observed outage.
            let requested: std::collections::BTreeSet<_> = locked
                .roots
                .project_roots
                .values()
                .map(|root| root.canonicalize().unwrap_or_else(|_| root.clone()))
                .collect();
            let mut errors = match locked.backend_errors.lock() {
                Ok(mut pending) => std::mem::take(&mut *pending)
                    .into_iter()
                    .filter(|(root, _)| requested.contains(root))
                    .map(|(root, error)| {
                        format!(
                            "Project configuration watcher ({}): {error}",
                            root.display()
                        )
                    })
                    .collect::<Vec<_>>(),
                Err(_) => vec!["Project configuration watcher error lock poisoned".into()],
            };
            let observed_absences = match locked.observed_absences.lock() {
                Ok(mut pending) => {
                    let roots = std::mem::take(&mut *pending);
                    locked
                        .roots
                        .project_roots
                        .iter()
                        .filter_map(|(id, root)| {
                            let canonical = root.canonicalize().unwrap_or_else(|_| root.clone());
                            roots.contains(&canonical).then(|| id.clone())
                        })
                        .collect()
                }
                Err(_) => {
                    errors.push("Project configuration watcher observation lock poisoned".into());
                    Vec::new()
                }
            };
            errors.extend(locked.reconcile().err());
            // Global status is independent of project aliases and is never pruned
            // with the requested project roots. A lost global watch stays invalid
            // until this ConfigWatcher is replaced; project maintenance cannot fix it.
            if global_invalidated {
                errors.push("Global configuration watcher invalidated; restart required".into());
            }
            match locked.global_backend_errors.lock() {
                Ok(global_errors) => errors.extend(global_errors.iter().map(|(root, error)| {
                    format!("Global configuration watcher ({}): {error}", root.display())
                })),
                Err(_) => errors.push("Global configuration watcher error lock poisoned".into()),
            }
            (
                locked.roots.revision,
                invalidated,
                observed_absences,
                errors,
            )
        };
        // Manager checks run after releasing the watcher mutex. They can request
        // reload when in-memory document identity changed, even on a quiet tick.
        let changed = revision != last_revision;
        last_revision = revision;
        errors.extend(refresh_and_reload(event || changed, observed_absences).await);
        errors.sort();
        errors.dedup();
        if errors != last_errors {
            report_status(errors.clone()).await;
            if errors.is_empty() {
                tracing::info!("Maintenance du watcher de configuration rétablie");
            } else {
                tracing::warn!(message = %errors.join("; "), "Échec de la maintenance du watcher de configuration");
            }
        }
        // Also back off repeated asynchronous invalidations, even when a fresh
        // backend initially reports successful installation before emitting Err.
        backoff.finish(!errors.is_empty() || invalidated, retry_interval);
        last_errors = errors;
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
        Ok(event) => event.need_rescan() || observes_root_absence(root, result),
    }
}

fn observes_root_absence(root: &Path, result: &notify::Result<Event>) -> bool {
    matches!(result, Ok(event) if matches!(event.kind,
        notify::EventKind::Remove(_) | notify::EventKind::Modify(notify::event::ModifyKind::Name(_)))
        && event.paths.iter().any(|path| root.starts_with(path)))
}

fn record_backend_result(
    root: &Path,
    result: notify::Result<Event>,
    signal_tx: &watch::Sender<u64>,
    invalidated: &AtomicBool,
    backend_errors: &Mutex<BTreeMap<PathBuf, String>>,
    observed_absences: Option<&Mutex<BTreeSet<PathBuf>>>,
) {
    // This set outlives a backend and is consumed before reconciliation. Record
    // before coalescing repeated invalidations: an Err may precede a Remove.
    if observes_root_absence(root, &result) {
        if let Some(observations) = observed_absences {
            if let Ok(mut pending) = observations.lock() {
                pending.insert(root.to_path_buf());
            }
        }
    }
    if let Ok(mut errors) = backend_errors.lock() {
        match &result {
            Err(error) => {
                let message = error.to_string();
                if errors.get(root) != Some(&message) {
                    tracing::warn!(root = %root.display(), message = %message, "Erreur du watcher de configuration");
                    errors.insert(root.to_path_buf(), message);
                }
            }
            Ok(_) if !invalidated.load(Ordering::Acquire) => {
                if errors.remove(root).is_some() {
                    tracing::info!(root = %root.display(), "Watcher de configuration rétabli");
                }
            }
            Ok(_) => {}
        }
    }
    if invalidates_root(root, &result) && invalidated.swap(true, Ordering::AcqRel) {
        return; // One wakeup per invalidated backend, including repeated errors.
    }
    // Errors/rescans must also wake the consumer, not just ordinary events.
    signal_tx.send_modify(|generation| *generation = generation.wrapping_add(1));
}

fn make_backend(
    root: &Path,
    mode: RecursiveMode,
    signal_tx: watch::Sender<u64>,
    invalidated: Arc<AtomicBool>,
    backend_errors: Arc<Mutex<BTreeMap<PathBuf, String>>>,
    observed_absences: Option<Arc<Mutex<BTreeSet<PathBuf>>>>,
) -> Result<RecommendedWatcher, String> {
    let callback_root = root.to_path_buf();
    let backend = RecommendedWatcher::new(
        move |result: notify::Result<Event>| {
            record_backend_result(
                &callback_root,
                result,
                &signal_tx,
                &invalidated,
                &backend_errors,
                observed_absences.as_deref(),
            );
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
        let backend_errors = Arc::new(Mutex::new(BTreeMap::new()));
        let global_invalidated = Arc::new(AtomicBool::new(false));
        let global_backend_errors = Arc::new(Mutex::new(BTreeMap::new()));
        let global_watcher = make_backend(
            &root,
            RecursiveMode::NonRecursive,
            signal_tx.clone(),
            global_invalidated.clone(),
            global_backend_errors.clone(),
            None,
        )?;
        Ok(Self {
            _global_watcher: global_watcher,
            global_invalidated,
            global_backend_errors,
            signal_tx,
            backend_errors,
            observed_absences: Arc::new(Mutex::new(BTreeSet::new())),
            roots: RootSubscriptions {
                project_roots: BTreeMap::new(),
                subscriptions: BTreeMap::new(),
                revision: 0,
            },
        })
    }

    fn reconcile(&mut self) -> Result<(), String> {
        let signal_tx = &self.signal_tx;
        let backend_errors = &self.backend_errors;
        let observed_absences = &self.observed_absences;
        let requested: std::collections::BTreeSet<_> = self
            .roots
            .project_roots
            .values()
            .filter_map(|root| root.canonicalize().ok())
            .collect();
        if let Ok(mut errors) = backend_errors.lock() {
            errors.retain(|root, _| requested.contains(root));
        }
        self.roots.reconcile(|root, invalidated| {
            make_backend(
                root,
                RecursiveMode::Recursive,
                signal_tx.clone(),
                invalidated,
                backend_errors.clone(),
                Some(observed_absences.clone()),
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
        let previous_count = self.subscriptions.len();
        self.subscriptions.retain(|root, subscription| {
            desired.get(root) == Some(&subscription.identity)
                && !subscription.invalidated.load(Ordering::Acquire)
        });
        if self.subscriptions.len() != previous_count {
            self.revision = self.revision.wrapping_add(1);
        }
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
                    self.revision = self.revision.wrapping_add(1);
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
            revision: 0,
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

    async fn wait_until(mut ready: impl FnMut() -> bool) {
        tokio::time::timeout(Duration::from_secs(5), async {
            while !ready() {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("condition not reached");
    }

    #[tokio::test]
    async fn root_purge_notifies_snapshot_consumers_once_without_file_changes() {
        let temp = tempfile::tempdir().unwrap();
        let manager = ConfigManager::initialize(temp.path().join("global"))
            .await
            .unwrap();
        let root = manager
            .register_project_root("project", temp.path().join("metadata"))
            .await
            .unwrap();
        let scope = ConfigScope::Project {
            project_id: "project".into(),
        };
        manager
            .get_document(ConfigDocumentKind::Tools, scope)
            .await
            .unwrap();
        std::fs::rename(&root, root.with_file_name("old-config")).unwrap();
        std::fs::create_dir(&root).unwrap();
        let mut notifications = Vec::new();
        let (changed, errors) = refresh_project_state(&manager, Vec::new(), |document| {
            notifications.push(document)
        })
        .await;
        assert!(changed);
        assert!(errors.is_empty());
        assert_eq!(notifications.len(), 1);
        assert_eq!(notifications[0].kind, ConfigDocumentKind::Runtime);
        let (changed, errors) = refresh_project_state(&manager, Vec::new(), |document| {
            notifications.push(document)
        })
        .await;
        assert!(!changed);
        assert!(errors.is_empty());
        assert_eq!(notifications.len(), 1);
    }

    #[test]
    fn only_root_disappearance_events_record_an_absence_even_after_invalidation() {
        let root = Path::new("/project/config");
        let (tx, _) = watch::channel(0);
        let invalidated = AtomicBool::new(false);
        let errors = Mutex::new(BTreeMap::new());
        let observations = Mutex::new(BTreeSet::new());
        let mut rescan = Event::new(notify::EventKind::Other);
        rescan.attrs.set_flag(notify::event::Flag::Rescan);
        for result in [
            Err(notify::Error::generic("watch failure")),
            Ok(rescan),
            Ok(
                Event::new(notify::EventKind::Remove(notify::event::RemoveKind::File))
                    .add_path(root.join("tools.json")),
            ),
        ] {
            record_backend_result(
                root,
                result,
                &tx,
                &invalidated,
                &errors,
                Some(&observations),
            );
            assert!(observations.lock().unwrap().is_empty());
        }
        for path in [root.to_path_buf(), root.parent().unwrap().to_path_buf()] {
            for kind in [
                notify::EventKind::Remove(notify::event::RemoveKind::Folder),
                notify::EventKind::Modify(notify::event::ModifyKind::Name(
                    notify::event::RenameMode::From,
                )),
            ] {
                record_backend_result(
                    root,
                    Ok(Event::new(kind).add_path(path.clone())),
                    &tx,
                    &invalidated,
                    &errors,
                    Some(&observations),
                );
                assert!(observations.lock().unwrap().remove(root));
            }
        }
    }

    #[tokio::test]
    async fn native_absence_survives_backend_reinstallation_before_manager_refresh() {
        use crate::config::{ConfigPatchRequest, JsonPatchOperation};
        let temp = tempfile::tempdir().unwrap();
        let manager = ConfigManager::initialize(temp.path().join("global"))
            .await
            .unwrap();
        let root = manager
            .register_project_root("project", temp.path().join("metadata"))
            .await
            .unwrap();
        let scope = ConfigScope::Project {
            project_id: "project".into(),
        };
        let document = manager
            .get_document(ConfigDocumentKind::Tools, scope.clone())
            .await
            .unwrap();
        let original = manager
            .apply_patch(ConfigPatchRequest {
                kind: ConfigDocumentKind::Tools,
                scope,
                expected_etag: document.etag,
                patch: vec![JsonPatchOperation {
                    op: "add".into(),
                    path: "/riskLevel".into(),
                    from: None,
                    value: Some(serde_json::json!("strict")),
                }],
                source: ConfigChangeSource::Agent,
            })
            .await
            .unwrap()
            .pending_change
            .unwrap();
        let identity = DirectoryIdentity::read(&root).unwrap();
        let (tx, rx) = watch::channel(0);
        let state = Arc::new(ConfigWatcher {
            state: Mutex::new(WatcherState::new(manager.root(), tx).unwrap()),
        });
        state.watch_project_root("project", &root).unwrap();
        state.watch_project_root("removed", &root).unwrap();
        // Deliver the native callback after the directory is already available
        // with its original identity, then replace its backend before maintenance.
        // No timing assumption about a platform's native event delivery is needed.
        {
            let locked = state.state.lock().unwrap();
            let backend = locked.roots.subscriptions.get(&root).unwrap();
            record_backend_result(
                &root,
                Ok(
                    Event::new(notify::EventKind::Remove(notify::event::RemoveKind::Folder))
                        .add_path(root.clone()),
                ),
                &locked.signal_tx,
                &backend.invalidated,
                &locked.backend_errors,
                Some(&locked.observed_absences),
            );
        }
        state.watch_project_root("project", &root).unwrap();
        state.unregister_project_root("removed").unwrap();
        assert_eq!(DirectoryIdentity::read(&root).unwrap(), identity);
        let (events_tx, mut events_rx) = tokio::sync::mpsc::unbounded_channel();
        let refresh_manager = manager.clone();
        let task = tokio::spawn(maintain_subscriptions(
            Arc::downgrade(&state),
            rx,
            Duration::from_millis(30),
            Duration::ZERO,
            |_| std::future::ready(()),
            move |_, observations| {
                assert!(observations.is_empty() || observations == vec!["project".to_string()]);
                let manager = refresh_manager.clone();
                let events = events_tx.clone();
                async move {
                    refresh_project_state(&manager, observations, |document| {
                        events.send(document).unwrap();
                    })
                    .await
                    .1
                }
            },
        ));
        let event = tokio::time::timeout(Duration::from_secs(3), events_rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(event.kind, ConfigDocumentKind::Runtime);
        assert!(manager.accept_pending_change(&original.id).await.is_err());
        let renewed = manager.list_pending_changes().await.pop().unwrap();
        assert_ne!(renewed.id, original.id);
        assert_eq!(renewed.proposed_document, original.proposed_document);
        manager.accept_pending_change(&renewed.id).await.unwrap();
        drop(state);
        tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn maintenance_recovers_recreated_root_without_manual_reconciliation() {
        let global = tempfile::tempdir().unwrap();
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join("project");
        std::fs::create_dir(&root).unwrap();
        let (tx, rx) = watch::channel(0);
        let state = Arc::new(ConfigWatcher {
            state: Mutex::new(WatcherState::new(global.path(), tx).unwrap()),
        });
        state.watch_project_root("a", &root).unwrap();
        let canonical = root.canonicalize().unwrap();
        let weak = Arc::downgrade(&state);
        let (reload_tx, mut reload_rx) = tokio::sync::mpsc::unbounded_channel();
        let file = root.join("config");
        let observed_file = file.clone();
        let callback_state = weak.clone();
        let task = tokio::spawn(maintain_subscriptions(
            weak.clone(),
            rx,
            Duration::from_millis(50),
            Duration::from_millis(20),
            |_| std::future::ready(()),
            move |reload_requested, _| {
                let state = callback_state.upgrade().unwrap();
                assert!(
                    state.state.try_lock().is_ok(),
                    "reload must run outside the mutex"
                );
                let content = std::fs::read_to_string(&observed_file).ok();
                if reload_requested {
                    reload_tx.send(content).unwrap();
                }
                std::future::ready(Vec::new())
            },
        ));
        std::fs::remove_dir(&root).unwrap();
        wait_until(|| state.state.lock().unwrap().roots.subscriptions.is_empty()).await;
        // This path is outside the global root and its project backend is gone:
        // only periodic maintenance can discover its recreation.
        std::fs::create_dir(&root).unwrap();
        wait_until(|| {
            state
                .state
                .lock()
                .unwrap()
                .roots
                .subscriptions
                .contains_key(&canonical)
        })
        .await;
        // Let the revision-triggered reload finish before testing a new native event.
        tokio::time::sleep(Duration::from_millis(200)).await;
        while reload_rx.try_recv().is_ok() {}
        std::fs::write(&file, "new content").unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if reload_rx.recv().await.unwrap().as_deref() == Some("new content") {
                    break;
                }
            }
        })
        .await
        .expect("new file was not observed automatically");
        drop(state);
        assert!(weak.upgrade().is_none());
        tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn asynchronous_project_failures_survive_successful_reinstallation_and_recover() {
        let temp = tempfile::tempdir().unwrap();
        let manager = ConfigManager::initialize(temp.path().join("global"))
            .await
            .unwrap();
        let root = temp.path().join("project");
        std::fs::create_dir(&root).unwrap();
        let (tx, rx) = watch::channel(0);
        let state = Arc::new(ConfigWatcher {
            state: Mutex::new(WatcherState::new(manager.root(), tx).unwrap()),
        });
        state.watch_project_root("project", &root).unwrap();
        let canonical = root.canonicalize().unwrap();
        let inject = Arc::new(AtomicBool::new(true));
        let inject_callback = inject.clone();
        let attempts = Arc::new(AtomicUsize::new(0));
        let count = attempts.clone();
        let weak = Arc::downgrade(&state);
        let callback_state = weak.clone();
        let report_manager = manager.clone();
        let (event_tx, mut event_rx) = tokio::sync::mpsc::unbounded_channel();
        let task = tokio::spawn(maintain_subscriptions(
            weak,
            rx,
            Duration::from_millis(30),
            Duration::ZERO,
            move |errors| {
                let manager = report_manager.clone();
                let event_tx = event_tx.clone();
                async move {
                    publish_maintenance_status(&manager, errors, |document| {
                        event_tx.send(document).unwrap();
                    })
                    .await;
                }
            },
            move |_, _| {
                if inject_callback.load(Ordering::Acquire) {
                    let state = callback_state.upgrade().unwrap();
                    let locked = state.state.lock().unwrap();
                    let installed = locked
                        .roots
                        .subscriptions
                        .get(&canonical)
                        .expect("installation succeeds before the asynchronous failure");
                    record_backend_result(
                        &canonical,
                        Err(notify::Error::generic("asynchronous project failure")),
                        &locked.signal_tx,
                        &installed.invalidated,
                        &locked.backend_errors,
                        Some(&locked.observed_absences),
                    );
                    count.fetch_add(1, Ordering::SeqCst);
                }
                std::future::ready(Vec::new())
            },
        ));
        let degraded = tokio::time::timeout(Duration::from_secs(2), event_rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(degraded
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.message.contains("asynchronous project failure")));
        assert_eq!(
            manager.get_snapshot(&[]).await.unwrap().diagnostics.len(),
            1
        );
        wait_until(|| attempts.load(Ordering::SeqCst) >= 3).await;
        assert!(
            event_rx.try_recv().is_err(),
            "repeated callback errors must not repeat the warning"
        );
        inject.store(false, Ordering::Release);
        let recovered = tokio::time::timeout(Duration::from_secs(3), event_rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(recovered.diagnostics.is_empty());
        assert!(manager
            .get_snapshot(&[])
            .await
            .unwrap()
            .diagnostics
            .is_empty());
        assert_eq!(state.subscribed_project_roots().len(), 1);
        drop(state);
        tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn maintenance_failure_and_recovery_are_queryable_and_notified_once() {
        let temp = tempfile::tempdir().unwrap();
        let manager = ConfigManager::initialize(temp.path().join("global"))
            .await
            .unwrap();
        manager
            .record_reconciliation_diagnostic(Some("registry warning".into()))
            .await;
        let (tx, rx) = watch::channel(0);
        let state = Arc::new(ConfigWatcher {
            state: Mutex::new(WatcherState::new(manager.root(), tx).unwrap()),
        });
        let (events_tx, mut events_rx) = tokio::sync::mpsc::unbounded_channel();
        let report_manager = manager.clone();
        let task = tokio::spawn(maintain_subscriptions(
            Arc::downgrade(&state),
            rx,
            Duration::from_millis(30),
            Duration::ZERO,
            move |errors| {
                let manager = report_manager.clone();
                let events_tx = events_tx.clone();
                async move {
                    publish_maintenance_status(&manager, errors, |document| {
                        events_tx.send(document).unwrap();
                    })
                    .await;
                }
            },
            |_, _| std::future::ready(Vec::new()),
        ));
        tokio::time::sleep(Duration::from_millis(60)).await;
        assert!(events_rx.try_recv().is_err(), "healthy startup stays quiet");
        let missing = temp.path().join("missing");
        assert!(state.watch_project_root("project", &missing).is_err());
        let degraded = tokio::time::timeout(Duration::from_secs(2), events_rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(degraded
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.message.contains("project")));
        assert_eq!(
            manager.get_snapshot(&[]).await.unwrap().diagnostics.len(),
            2
        );
        tokio::time::sleep(Duration::from_millis(120)).await;
        assert!(
            events_rx.try_recv().is_err(),
            "unchanged error is not repeated"
        );
        std::fs::create_dir(&missing).unwrap();
        let recovered = tokio::time::timeout(Duration::from_secs(2), events_rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(recovered.diagnostics.len(), 1);
        assert_eq!(recovered.diagnostics[0].message, "registry warning");
        assert_eq!(
            manager.get_snapshot(&[]).await.unwrap().diagnostics.len(),
            1
        );
        drop(state);
        tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn quiet_and_failed_periodic_passes_do_not_reload_or_retain_state() {
        let global = tempfile::tempdir().unwrap();
        let missing_parent = tempfile::tempdir().unwrap();
        let (tx, rx) = watch::channel(0);
        let state = Arc::new(ConfigWatcher {
            state: Mutex::new(WatcherState::new(global.path(), tx).unwrap()),
        });
        assert!(state
            .watch_project_root("missing", &missing_parent.path().join("missing"))
            .is_err());
        let calls = Arc::new(AtomicUsize::new(0));
        let counter = calls.clone();
        let weak = Arc::downgrade(&state);
        let task = tokio::spawn(maintain_subscriptions(
            weak.clone(),
            rx,
            Duration::from_millis(30),
            Duration::from_millis(10),
            |_| std::future::ready(()),
            move |reload_requested, _| {
                if reload_requested {
                    counter.fetch_add(1, Ordering::SeqCst);
                }
                std::future::ready(Vec::new())
            },
        ));
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        state.unregister_project_root("missing").unwrap();
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        drop(state);
        assert!(weak.upgrade().is_none());
        tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn persistent_errors_and_event_storm_cannot_bypass_cooldown() {
        let global = tempfile::tempdir().unwrap();
        let (tx, rx) = watch::channel(0_u64);
        let state = Arc::new(ConfigWatcher {
            state: Mutex::new(WatcherState::new(global.path(), tx.clone()).unwrap()),
        });
        let attempts = Arc::new(AtomicUsize::new(0));
        let counter = attempts.clone();
        let event_reloads = Arc::new(AtomicUsize::new(0));
        let reload_counter = event_reloads.clone();
        let task = tokio::spawn(maintain_subscriptions(
            Arc::downgrade(&state),
            rx,
            Duration::from_millis(40),
            Duration::ZERO,
            |_| std::future::ready(()),
            move |reload_requested, _| {
                counter.fetch_add(1, Ordering::SeqCst);
                if reload_requested {
                    reload_counter.fetch_add(1, Ordering::SeqCst);
                }
                std::future::ready(vec!["permanent manager failure".into()])
            },
        ));
        tokio::time::timeout(Duration::from_secs(2), async {
            while attempts.load(Ordering::SeqCst) == 0 {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        })
        .await
        .unwrap();
        let deadline = tokio::time::Instant::now() + Duration::from_millis(200);
        while tokio::time::Instant::now() < deadline {
            tx.send_modify(|generation| *generation += 1);
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        // Attempts at approximately 0, 40, 120ms; none may follow every event.
        assert!((1..=3).contains(&attempts.load(Ordering::SeqCst)));
        assert!(
            event_reloads.load(Ordering::SeqCst) > 0,
            "queued healthy-root events must survive permanent reconciliation errors"
        );
        drop(state);
        // Keep tx alive to prove shutdown uses Weak even during cooldown.
        tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn global_errors_and_invalidation_each_enforce_cooldown() {
        for invalidation_only in [false, true] {
            let global = tempfile::tempdir().unwrap();
            let root = global.path().canonicalize().unwrap();
            let (tx, rx) = watch::channel(0_u64);
            let state = Arc::new(ConfigWatcher {
                state: Mutex::new(WatcherState::new(global.path(), tx.clone()).unwrap()),
            });
            state.watch_project_root("shared", &root).unwrap();
            {
                let locked = state.state.lock().unwrap();
                assert!(!Arc::ptr_eq(
                    &locked.backend_errors,
                    &locked.global_backend_errors
                ));
                if invalidation_only {
                    locked.global_invalidated.store(true, Ordering::Release);
                } else {
                    locked
                        .global_backend_errors
                        .lock()
                        .unwrap()
                        .insert(root.clone(), "permanent global failure".into());
                    locked
                        .backend_errors
                        .lock()
                        .unwrap()
                        .insert(root.clone(), "project failure".into());
                }
            }
            state.unregister_project_root("shared").unwrap();
            {
                let locked = state.state.lock().unwrap();
                assert!(locked.backend_errors.lock().unwrap().is_empty());
                if !invalidation_only {
                    assert_eq!(
                        locked
                            .global_backend_errors
                            .lock()
                            .unwrap()
                            .get(&root)
                            .map(String::as_str),
                        Some("permanent global failure")
                    );
                }
            }
            let attempts = Arc::new(AtomicUsize::new(0));
            let counter = attempts.clone();
            let task = tokio::spawn(maintain_subscriptions(
                Arc::downgrade(&state),
                rx,
                Duration::from_millis(40),
                Duration::ZERO,
                |_| std::future::ready(()),
                move |_, _| {
                    counter.fetch_add(1, Ordering::SeqCst);
                    std::future::ready(Vec::new())
                },
            ));
            let deadline = tokio::time::Instant::now() + Duration::from_millis(200);
            while tokio::time::Instant::now() < deadline {
                tx.send_modify(|generation| *generation += 1);
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
            assert!((1..=3).contains(&attempts.load(Ordering::SeqCst)));
            drop(state);
            tokio::time::timeout(Duration::from_secs(2), task)
                .await
                .unwrap()
                .unwrap();
        }
    }

    #[test]
    fn maintenance_backoff_caps_at_thirty_seconds_and_resets_after_recovery() {
        let mut backoff = MaintenanceBackoff::new();
        for expected in [2, 4, 8, 16, 30, 30, 30] {
            let before = tokio::time::Instant::now();
            backoff.finish(true, Duration::from_secs(2));
            let delay = backoff.next_attempt.duration_since(before);
            assert!(delay >= Duration::from_secs(expected));
            assert!(delay < Duration::from_secs(expected) + Duration::from_millis(100));
            assert!(!backoff.ready());
        }
        backoff.finish(false, Duration::from_secs(2));
        assert!(backoff.ready());
        assert_eq!(backoff.failures, 0);
    }

    #[test]
    fn unregister_preserves_shared_root_and_drops_last_owner_despite_other_errors() {
        let global = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        let state = ConfigWatcher::for_test(global.path());
        state.watch_project_root("a", project.path()).unwrap();
        state
            .watch_project_root("b", &project.path().join("."))
            .unwrap();
        assert!(state
            .watch_project_root("missing", &project.path().join("missing"))
            .is_err());
        assert!(state.unregister_project_root("a").is_err());
        assert_eq!(
            state.subscribed_project_roots(),
            vec![project.path().canonicalize().unwrap()]
        );
        assert!(state.unregister_project_root("b").is_err());
        assert!(state.subscribed_project_roots().is_empty());
        let locked = state.state.lock().unwrap();
        assert!(locked.roots.subscriptions.is_empty());
        assert_eq!(locked.roots.project_roots.len(), 1);
        assert!(locked.roots.project_roots.contains_key("missing"));
    }
}
