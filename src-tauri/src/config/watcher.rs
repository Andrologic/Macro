use super::{ConfigChangeSource, ConfigManager};
use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::watch;

pub struct ConfigWatcher {
    state: Mutex<WatcherState>,
}

struct WatcherState {
    // Kept alive independently; reconciliation never changes this subscription.
    _global_watcher: RecommendedWatcher,
    project_watcher: RecommendedWatcher,
    roots: RootSubscriptions,
}

struct RootSubscriptions {
    global_root: PathBuf,
    // Requested paths are retained for retries through the compatibility API.
    project_roots: BTreeMap<String, PathBuf>,
    // Confirmed project subscriptions, plus a NonRecursive global sentinel when
    // no project subscription shares that path. The global backend stays independent.
    watched_roots: BTreeMap<PathBuf, RecursiveMode>,
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

impl WatcherState {
    fn new(root: &Path, signal_tx: watch::Sender<u64>) -> Result<Self, String> {
        let root = root.canonicalize().map_err(|error| error.to_string())?;
        let make_watcher = |signal_tx: watch::Sender<u64>| {
            RecommendedWatcher::new(
                move |result: Result<Event, notify::Error>| {
                    if result.is_ok() {
                        signal_tx.send_modify(|generation| {
                            *generation = generation.wrapping_add(1);
                        });
                    }
                },
                Config::default().with_poll_interval(Duration::from_millis(100)),
            )
            .map_err(|error| error.to_string())
        };
        let mut global_watcher = make_watcher(signal_tx.clone())?;
        global_watcher
            .watch(&root, RecursiveMode::NonRecursive)
            .map_err(|error| error.to_string())?;
        let project_watcher = make_watcher(signal_tx)?;
        Ok(Self {
            _global_watcher: global_watcher,
            project_watcher,
            roots: RootSubscriptions {
                global_root: root.clone(),
                project_roots: BTreeMap::new(),
                watched_roots: BTreeMap::from([(root, RecursiveMode::NonRecursive)]),
            },
        })
    }

    fn reconcile(&mut self) -> Result<(), String> {
        let watcher = &mut self.project_watcher;
        self.roots.reconcile(|root, subscribe| {
            if let Some(mode) = subscribe {
                watcher.watch(root, mode)
            } else {
                watcher.unwatch(root)
            }
        })
    }
}

impl RootSubscriptions {
    fn reconcile(
        &mut self,
        mut update: impl FnMut(&Path, Option<RecursiveMode>) -> notify::Result<()>,
    ) -> Result<(), String> {
        // The global subscription is pinned, even when no project uses it.
        // An exact project match adds a separate recursive project subscription.
        // The global backend always remains nonrecursive.
        let mut desired = BTreeMap::from([(self.global_root.clone(), RecursiveMode::NonRecursive)]);
        let mut errors = Vec::new();
        for (project_id, root) in &self.project_roots {
            match root.canonicalize() {
                Ok(root) => {
                    desired.insert(root, RecursiveMode::Recursive);
                }
                Err(error) => errors.push(format!(
                    "Cannot resolve configuration root for project {project_id} ({}): {error}",
                    root.display()
                )),
            }
        }

        // Remove obsolete subscriptions even if resolution or a new watch fails.
        let obsolete: Vec<_> = self
            .watched_roots
            .keys()
            .filter(|root| !desired.contains_key(*root))
            .cloned()
            .collect();
        for root in obsolete {
            match update(&root, None) {
                Ok(()) => {
                    self.watched_roots.remove(&root);
                }
                Err(error) => {
                    // The backend may already have dropped a deleted root.
                    if matches!(&error.kind, notify::ErrorKind::WatchNotFound) {
                        self.watched_roots.remove(&root);
                    }
                    errors.push(format!("Cannot unwatch {}: {error}", root.display()));
                }
            }
        }
        // NonRecursive means only the independent global subscription remains.
        // Remove the project subscription instead of rewatching an existing path:
        // notify on Windows does not stop the previous handle when rewatching.
        let missing: Vec<_> = desired
            .iter()
            .filter(|(root, mode)| self.watched_roots.get(*root) != Some(*mode))
            .map(|(root, mode)| (root.clone(), *mode))
            .collect();
        for (root, mode) in missing {
            let subscribe = (mode == RecursiveMode::Recursive).then_some(mode);
            match update(&root, subscribe) {
                Ok(()) => {
                    self.watched_roots.insert(root, mode);
                }
                Err(error) => {
                    if subscribe.is_none()
                        && matches!(&error.kind, notify::ErrorKind::WatchNotFound)
                    {
                        self.watched_roots.insert(root.clone(), mode);
                    }
                    let action = if subscribe.is_some() {
                        "watch"
                    } else {
                        "unwatch"
                    };
                    errors.push(format!("Cannot {action} {}: {error}", root.display()));
                }
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

    fn subscriptions(global: &Path) -> RootSubscriptions {
        let global_root = global.canonicalize().expect("global root");
        RootSubscriptions {
            watched_roots: BTreeMap::from([(global_root.clone(), RecursiveMode::NonRecursive)]),
            global_root,
            project_roots: BTreeMap::new(),
        }
    }

    fn apply(roots: &mut RootSubscriptions) -> Vec<(PathBuf, Option<RecursiveMode>)> {
        let mut calls = Vec::new();
        roots
            .reconcile(|path, subscribe| {
                calls.push((path.to_path_buf(), subscribe));
                Ok(())
            })
            .expect("reconcile");
        calls
    }

    #[test]
    fn add_share_move_remove_and_preserve_global() {
        let global = tempfile::tempdir().unwrap();
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let first = first.path().canonicalize().unwrap();
        let second = second.path().canonicalize().unwrap();
        let mut roots = subscriptions(global.path());
        roots.project_roots.insert("a".into(), first.clone());
        roots.project_roots.insert("b".into(), first.join("."));
        assert_eq!(
            apply(&mut roots),
            vec![(first.clone(), Some(RecursiveMode::Recursive))]
        );
        assert!(apply(&mut roots).is_empty());
        roots.project_roots.insert("a".into(), second.clone());
        assert_eq!(
            apply(&mut roots),
            vec![(second.clone(), Some(RecursiveMode::Recursive))]
        );
        roots.project_roots.remove("b");
        assert_eq!(apply(&mut roots), vec![(first, None)]);
        roots.project_roots.insert("a".into(), global.path().into());
        assert_eq!(
            apply(&mut roots),
            vec![
                (second, None),
                (roots.global_root.clone(), Some(RecursiveMode::Recursive)),
            ]
        );
        roots.project_roots.clear();
        assert_eq!(apply(&mut roots), vec![(roots.global_root.clone(), None)]);
        assert_eq!(
            roots.watched_roots,
            BTreeMap::from([(roots.global_root.clone(), RecursiveMode::NonRecursive)])
        );
    }

    #[test]
    fn missing_replacement_removes_old_subscription_and_can_retry() {
        let global = tempfile::tempdir().unwrap();
        let old = tempfile::tempdir().unwrap();
        let mut roots = subscriptions(global.path());
        let old = old.path().canonicalize().unwrap();
        roots.project_roots.insert("a".into(), old.clone());
        apply(&mut roots);
        let missing = global.path().join("missing");
        roots.project_roots.insert("a".into(), missing.clone());
        let mut calls = Vec::new();
        assert!(roots
            .reconcile(|path, subscribe| {
                calls.push((path.to_path_buf(), subscribe));
                Ok(())
            })
            .is_err());
        assert_eq!(calls, vec![(old, None)]);
        assert_eq!(roots.watched_roots.len(), 1);
        std::fs::create_dir(&missing).unwrap();
        assert_eq!(
            apply(&mut roots),
            vec![(
                missing.canonicalize().unwrap(),
                Some(RecursiveMode::Recursive)
            )]
        );
    }

    #[test]
    fn partial_backend_failures_preserve_confirmed_state_and_retry() {
        let global = tempfile::tempdir().unwrap();
        let old = tempfile::tempdir().unwrap();
        let new = tempfile::tempdir().unwrap();
        let old = old.path().canonicalize().unwrap();
        let new = new.path().canonicalize().unwrap();
        let mut roots = subscriptions(global.path());
        roots.project_roots.insert("a".into(), old.clone());
        apply(&mut roots);
        roots.project_roots.insert("a".into(), new.clone());
        let error = roots
            .reconcile(|_, _| Err(notify::Error::generic("injected")))
            .unwrap_err();
        assert!(error.contains("Cannot unwatch"));
        assert!(error.contains("Cannot watch"));
        assert!(roots.watched_roots.contains_key(&old));
        assert!(!roots.watched_roots.contains_key(&new));
        // A successful removal must survive a failing addition.
        assert!(roots
            .reconcile(|_, subscribe| {
                if subscribe.is_some() {
                    Err(notify::Error::generic("injected"))
                } else {
                    Ok(())
                }
            })
            .is_err());
        assert!(!roots.watched_roots.contains_key(&old));
        assert_eq!(
            apply(&mut roots),
            vec![(new, Some(RecursiveMode::Recursive))]
        );
        assert!(apply(&mut roots).is_empty());
    }

    #[test]
    fn successful_addition_is_not_repeated_after_failed_removal() {
        let global = tempfile::tempdir().unwrap();
        let old = tempfile::tempdir().unwrap();
        let new = tempfile::tempdir().unwrap();
        let old = old.path().canonicalize().unwrap();
        let new = new.path().canonicalize().unwrap();
        let mut roots = subscriptions(global.path());
        roots.project_roots.insert("a".into(), old.clone());
        apply(&mut roots);
        roots.project_roots.insert("a".into(), new.clone());
        assert!(roots
            .reconcile(|_, subscribe| {
                if subscribe.is_some() {
                    Ok(())
                } else {
                    Err(notify::Error::generic("injected"))
                }
            })
            .is_err());
        assert!(roots.watched_roots.contains_key(&new));
        assert!(roots.watched_roots.contains_key(&old));
        assert_eq!(apply(&mut roots), vec![(old, None)]);
    }

    #[test]
    fn compatibility_api_replaces_by_id_and_full_reconciliation_removes_projects() {
        let global = tempfile::tempdir().unwrap();
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let state = ConfigWatcher::for_test(global.path());
        state.watch_project_root("a", first.path()).unwrap();
        state.watch_project_root("b", first.path()).unwrap();
        state.watch_project_root("a", second.path()).unwrap();
        state.watch_project_root("b", second.path()).unwrap();
        {
            let locked = state.state.lock().unwrap();
            assert_eq!(locked.roots.project_roots.len(), 2);
            assert_eq!(locked.roots.watched_roots.len(), 2);
            assert!(!locked
                .roots
                .watched_roots
                .contains_key(&first.path().canonicalize().unwrap()));
        }
        state.reconcile_project_roots(&BTreeMap::new()).unwrap();
        let locked = state.state.lock().unwrap();
        assert!(locked.roots.project_roots.is_empty());
        assert_eq!(
            locked.roots.watched_roots,
            BTreeMap::from([(
                locked.roots.global_root.clone(),
                RecursiveMode::NonRecursive
            )])
        );
    }

    #[test]
    fn shared_global_project_subscription_is_retryable_without_rewatching() {
        let global = tempfile::tempdir().unwrap();
        let mut roots = subscriptions(global.path());
        let global = roots.global_root.clone();
        assert!(apply(&mut roots).is_empty());
        roots.project_roots.insert("a".into(), global.clone());
        roots.project_roots.insert("b".into(), global.join("."));
        assert!(roots
            .reconcile(|path, mode| {
                assert_eq!(path, global);
                assert_eq!(mode, Some(RecursiveMode::Recursive));
                Err(notify::Error::generic("upgrade failed"))
            })
            .is_err());
        assert_eq!(roots.watched_roots[&global], RecursiveMode::NonRecursive);
        assert_eq!(
            apply(&mut roots),
            vec![(global.clone(), Some(RecursiveMode::Recursive))]
        );
        roots.project_roots.remove("a");
        assert!(apply(&mut roots).is_empty());
        roots.project_roots.clear();
        assert!(roots
            .reconcile(|path, mode| {
                assert_eq!(path, global);
                assert_eq!(mode, None);
                Err(notify::Error::generic("downgrade failed"))
            })
            .is_err());
        assert_eq!(roots.watched_roots[&global], RecursiveMode::Recursive);
        assert_eq!(apply(&mut roots), vec![(global.clone(), None)]);
        assert!(apply(&mut roots).is_empty());
        assert_eq!(
            roots.watched_roots,
            BTreeMap::from([(global, RecursiveMode::NonRecursive)])
        );
    }

    #[test]
    fn real_backends_keep_global_subscription_after_repeated_sharing() {
        let global = tempfile::tempdir().unwrap();
        let state = ConfigWatcher::for_test(global.path());
        let root = global.path().canonicalize().unwrap();
        for _ in 0..3 {
            state.watch_project_root("a", &root).unwrap();
            state.watch_project_root("b", &root).unwrap();
            state
                .reconcile_project_roots(&BTreeMap::from([("b".into(), root.clone())]))
                .unwrap();
            assert_eq!(
                state.state.lock().unwrap().roots.watched_roots[&root],
                RecursiveMode::Recursive
            );
            state.reconcile_project_roots(&BTreeMap::new()).unwrap();
            let mut locked = state.state.lock().unwrap();
            assert_eq!(
                locked.roots.watched_roots[&root],
                RecursiveMode::NonRecursive
            );
            // The recursive subscription was actually removed, not replaced.
            // Windows accepts unwatch requests asynchronously, including unknown paths.
            #[cfg(not(target_os = "windows"))]
            {
                let error = locked.project_watcher.unwatch(&root).unwrap_err();
                assert!(matches!(error.kind, notify::ErrorKind::WatchNotFound));
            }
        }
        // Probe the independent global backend only after all reconciliation is done.
        // Success proves its subscription survived every project removal.
        state
            .state
            .lock()
            .unwrap()
            ._global_watcher
            .unwatch(&root)
            .unwrap();
    }

    #[test]
    fn already_absent_shared_project_watch_restores_global_sentinel() {
        let global = tempfile::tempdir().unwrap();
        let mut roots = subscriptions(global.path());
        let root = roots.global_root.clone();
        roots.project_roots.insert("a".into(), root.clone());
        apply(&mut roots);
        roots.project_roots.clear();
        assert!(roots
            .reconcile(|path, mode| {
                assert_eq!(path, root);
                assert_eq!(mode, None);
                Err(notify::Error::watch_not_found())
            })
            .is_err());
        assert_eq!(roots.watched_roots[&root], RecursiveMode::NonRecursive);
        assert!(apply(&mut roots).is_empty());
    }

    #[test]
    fn already_absent_watch_is_removed_from_state_but_reports_error() {
        let global = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        let mut roots = subscriptions(global.path());
        roots
            .project_roots
            .insert("a".into(), project.path().into());
        apply(&mut roots);
        roots.project_roots.clear();
        assert!(roots
            .reconcile(|_, _| Err(notify::Error::watch_not_found()))
            .is_err());
        assert_eq!(roots.watched_roots.len(), 1);
        assert!(apply(&mut roots).is_empty());
    }
}
