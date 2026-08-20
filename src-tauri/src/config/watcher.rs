use super::{ConfigChangeSource, ConfigManager};
use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::watch;

pub struct ConfigWatcher {
    watcher: Mutex<RecommendedWatcher>,
    watched_roots: Mutex<BTreeSet<PathBuf>>,
}

pub type ConfigWatcherState = Arc<ConfigWatcher>;

impl ConfigWatcher {
    pub fn start(
        root: PathBuf,
        manager: ConfigManager,
        app: AppHandle,
    ) -> Result<ConfigWatcherState, String> {
        let (signal_tx, mut signal_rx) = watch::channel(0_u64);
        let mut watcher = RecommendedWatcher::new(
            move |result: Result<Event, notify::Error>| {
                if result.is_ok() {
                    signal_tx.send_modify(|generation| {
                        *generation = generation.wrapping_add(1);
                    });
                }
            },
            Config::default().with_poll_interval(Duration::from_millis(100)),
        )
        .map_err(|error| error.to_string())?;
        watcher
            .watch(&root, RecursiveMode::NonRecursive)
            .map_err(|error| error.to_string())?;

        let watcher_state = Arc::new(Self {
            watcher: Mutex::new(watcher),
            watched_roots: Mutex::new(BTreeSet::from([root.clone()])),
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

    pub fn watch_project_root(&self, _project_id: &str, root: &Path) -> Result<(), String> {
        let canonical = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
        let mut watched_roots = self
            .watched_roots
            .lock()
            .map_err(|_| "Le verrou du watcher de configuration est empoisonné.".to_string())?;
        if watched_roots.contains(&canonical) {
            return Ok(());
        }
        self.watcher
            .lock()
            .map_err(|_| "Le verrou du watcher de configuration est empoisonné.".to_string())?
            .watch(&canonical, RecursiveMode::Recursive)
            .map_err(|error| error.to_string())?;
        watched_roots.insert(canonical);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_watch_is_not_remembered() {
        let watcher = RecommendedWatcher::new(
            |_| {},
            Config::default().with_poll_interval(Duration::from_millis(100)),
        )
        .expect("watcher");
        let state = ConfigWatcher {
            watcher: Mutex::new(watcher),
            watched_roots: Mutex::new(BTreeSet::new()),
        };
        let missing = tempfile::tempdir().expect("tempdir").path().join("missing");

        assert!(state.watch_project_root("project", &missing).is_err());
        assert!(state.watched_roots.lock().expect("roots").is_empty());
    }
}
