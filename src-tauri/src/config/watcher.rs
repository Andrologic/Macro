use super::{ConfigChangeSource, ConfigDocumentKind, ConfigManager, ConfigScope};
use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

pub struct ConfigWatcher {
    watcher: Mutex<RecommendedWatcher>,
    watched_roots: Mutex<BTreeSet<PathBuf>>,
    project_roots: Arc<Mutex<BTreeMap<PathBuf, String>>>,
}

pub type ConfigWatcherState = Arc<ConfigWatcher>;

impl ConfigWatcher {
    pub fn start(
        root: PathBuf,
        manager: ConfigManager,
        app: AppHandle,
    ) -> Result<ConfigWatcherState, String> {
        let (tx, mut rx) = mpsc::channel::<Event>(128);
        let callback_tx = tx.clone();
        let mut watcher = RecommendedWatcher::new(
            move |result: Result<Event, notify::Error>| {
                if let Ok(event) = result {
                    let _ = callback_tx.try_send(event);
                }
            },
            Config::default().with_poll_interval(Duration::from_millis(100)),
        )
        .map_err(|error| error.to_string())?;
        watcher
            .watch(&root, RecursiveMode::NonRecursive)
            .map_err(|error| error.to_string())?;

        let project_roots = Arc::new(Mutex::new(BTreeMap::new()));
        let watcher_state = Arc::new(Self {
            watcher: Mutex::new(watcher),
            watched_roots: Mutex::new(BTreeSet::from([root.clone()])),
            project_roots: project_roots.clone(),
        });

        tauri::async_runtime::spawn(async move {
            let debounce = Duration::from_millis(250);
            let mut pending_paths = BTreeSet::new();
            loop {
                match tokio::time::timeout(debounce, rx.recv()).await {
                    Ok(Some(event)) => {
                        pending_paths.extend(event.paths);
                    }
                    Ok(None) => break,
                    Err(_) if pending_paths.is_empty() => continue,
                    Err(_) => {
                        let paths = std::mem::take(&mut pending_paths);
                        for path in paths {
                            let Some(kind) = kind_for_path(&path) else {
                                continue;
                            };
                            let scope = scope_for_path(&path, &root, &project_roots);
                            match manager
                                .reload(kind, scope, ConfigChangeSource::ExternalEditor)
                                .await
                            {
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
                                    tracing::warn!(
                                        path = %path.display(),
                                        code = %error.code,
                                        message = %error.message,
                                        "Échec du rechargement de la configuration"
                                    );
                                }
                            }
                        }
                    }
                }
            }
        });

        Ok(watcher_state)
    }

    pub fn watch_project_root(&self, project_id: &str, root: &Path) -> Result<(), String> {
        let canonical = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
        let mut watched_roots = self
            .watched_roots
            .lock()
            .map_err(|_| "Le verrou du watcher de configuration est empoisonné.".to_string())?;
        if !watched_roots.insert(canonical.clone()) {
            return Ok(());
        }
        self.project_roots
            .lock()
            .map_err(|_| "Le verrou du watcher de configuration est empoisonné.".to_string())?
            .insert(canonical.clone(), project_id.to_string());
        self.watcher
            .lock()
            .map_err(|_| "Le verrou du watcher de configuration est empoisonné.".to_string())?
            .watch(&canonical, RecursiveMode::Recursive)
            .map_err(|error| error.to_string())
    }
}

fn scope_for_path(
    path: &Path,
    global_root: &Path,
    project_roots: &Mutex<BTreeMap<PathBuf, String>>,
) -> ConfigScope {
    if path.starts_with(global_root) {
        return ConfigScope::User;
    }
    project_roots
        .lock()
        .ok()
        .and_then(|roots| {
            roots
                .iter()
                .filter(|(root, _)| path.starts_with(root))
                .max_by_key(|(root, _)| root.components().count())
                .map(|(_, project_id)| ConfigScope::Project {
                    project_id: project_id.clone(),
                })
        })
        .unwrap_or(ConfigScope::User)
}

fn kind_for_path(path: &Path) -> Option<ConfigDocumentKind> {
    let file_name = path.file_name()?.to_str()?;
    ConfigDocumentKind::ALL
        .into_iter()
        .find(|kind| kind.file_name() == file_name)
}
