use crate::config::atomic_write_json;
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::RwLock;

const STATE_SCHEMA_VERSION: u32 = 1;
const STATE_FILE_NAME: &str = "state.json";
const STATE_LOCK_FILE_NAME: &str = "state.lock";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StateSnapshot {
    pub schema_version: u32,
    pub values: BTreeMap<String, Value>,
}

impl Default for StateSnapshot {
    fn default() -> Self {
        Self {
            schema_version: STATE_SCHEMA_VERSION,
            values: BTreeMap::new(),
        }
    }
}

pub(crate) fn validate_backup_state(raw: &[u8]) -> Result<(), String> {
    let snapshot: StateSnapshot = serde_json::from_slice(raw).map_err(|error| error.to_string())?;
    if snapshot.schema_version != STATE_SCHEMA_VERSION {
        return Err("Unsupported native state version".into());
    }
    Ok(())
}

// Startup updater checks run before StateManager is initialized. Read the same
// atomically published document without repairing or defaulting invalid data.
pub(crate) fn read_persisted_value(
    app_data_dir: &Path,
    key: &str,
) -> Result<Option<Value>, String> {
    let raw = match fs::read(app_data_dir.join(STATE_FILE_NAME)) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    validate_backup_state(&raw)?;
    let snapshot: StateSnapshot =
        serde_json::from_slice(&raw).map_err(|error| error.to_string())?;
    Ok(snapshot.values.get(key).cloned())
}

#[derive(Clone)]
pub struct StateManager {
    path: Arc<PathBuf>,
    lock_path: Arc<PathBuf>,
    snapshot: Arc<RwLock<StateSnapshot>>,
    read_only: bool,
}

impl StateManager {
    pub fn initialize(app_data_dir: &Path) -> Result<Self, String> {
        fs::create_dir_all(app_data_dir).map_err(|error| error.to_string())?;
        let path = app_data_dir.join(STATE_FILE_NAME);
        let lock_path = app_data_dir.join(STATE_LOCK_FILE_NAME);
        let _file_lock = lock_state_file(&lock_path)?;
        let mut read_only = false;
        let snapshot = if path.exists() {
            let raw = fs::read(&path).map_err(|error| error.to_string())?;
            match serde_json::from_slice::<StateSnapshot>(&raw) {
                Ok(snapshot) if snapshot.schema_version == STATE_SCHEMA_VERSION => snapshot,
                Ok(_) => {
                    read_only = true;
                    tracing::warn!(
                        path = %path.display(),
                        "state.json utilise une version non prise en charge et ne sera pas modifié"
                    );
                    StateSnapshot::default()
                }
                Err(error) => {
                    tracing::warn!(
                        path = %path.display(),
                        %error,
                        "state.json est invalide, démarrage avec un état temporaire vide"
                    );
                    StateSnapshot::default()
                }
            }
        } else {
            let snapshot = StateSnapshot::default();
            atomic_write_json(
                &path,
                &serde_json::to_value(&snapshot).map_err(|error| error.to_string())?,
            )?;
            snapshot
        };
        Ok(Self {
            path: Arc::new(path),
            lock_path: Arc::new(lock_path),
            snapshot: Arc::new(RwLock::new(snapshot)),
            read_only,
        })
    }

    pub async fn snapshot(&self) -> StateSnapshot {
        self.snapshot.read().await.clone()
    }

    pub async fn set(&self, key: String, value: Value) -> Result<StateSnapshot, String> {
        self.ensure_writable()?;
        validate_state_key(&key)?;
        self.mutate(move |snapshot| {
            snapshot.values.insert(key, value);
        })
        .await
    }

    pub async fn delete(&self, key: &str) -> Result<StateSnapshot, String> {
        self.ensure_writable()?;
        validate_state_key(key)?;
        let key = key.to_string();
        self.mutate(move |snapshot| {
            snapshot.values.remove(&key);
        })
        .await
    }

    pub async fn clear(&self) -> Result<StateSnapshot, String> {
        self.ensure_writable()?;
        self.mutate(|snapshot| snapshot.values.clear()).await
    }

    async fn mutate<F>(&self, mutation: F) -> Result<StateSnapshot, String>
    where
        F: FnOnce(&mut StateSnapshot) + Send + 'static,
    {
        self.ensure_writable()?;
        let mut published_snapshot = self.snapshot.write().await;
        let path = self.path.as_ref().clone();
        let lock_path = self.lock_path.as_ref().clone();
        let next =
            tokio::task::spawn_blocking(move || mutate_state_file(&path, &lock_path, mutation))
                .await
                .map_err(|error| {
                    format!("La mise à jour de state.json a été interrompue : {error}")
                })??;

        *published_snapshot = next.clone();
        Ok(next)
    }

    fn ensure_writable(&self) -> Result<(), String> {
        if self.read_only {
            return Err(
                "state.json utilise une version non prise en charge et reste en lecture seule."
                    .to_string(),
            );
        }
        Ok(())
    }
}

fn lock_state_file(lock_path: &Path) -> Result<File, String> {
    let file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(lock_path)
        .map_err(|error| {
            format!(
                "Impossible d’ouvrir le verrou d’état {} : {error}",
                lock_path.display()
            )
        })?;
    FileExt::lock_exclusive(&file).map_err(|error| {
        format!(
            "Impossible de verrouiller l’état {} : {error}",
            lock_path.display()
        )
    })?;
    Ok(file)
}

fn mutate_state_file<F>(path: &Path, lock_path: &Path, mutation: F) -> Result<StateSnapshot, String>
where
    F: FnOnce(&mut StateSnapshot),
{
    let _file_lock = lock_state_file(lock_path)?;
    let mut snapshot = if path.exists() {
        let raw = fs::read(path).map_err(|error| error.to_string())?;
        let snapshot = serde_json::from_slice::<StateSnapshot>(&raw).map_err(|error| {
            format!("state.json est invalide et ne peut pas être modifié : {error}")
        })?;
        if snapshot.schema_version != STATE_SCHEMA_VERSION {
            return Err(
                "state.json utilise une version non prise en charge et reste en lecture seule."
                    .to_string(),
            );
        }
        snapshot
    } else {
        StateSnapshot::default()
    };

    mutation(&mut snapshot);
    atomic_write_json(
        path,
        &serde_json::to_value(&snapshot).map_err(|error| error.to_string())?,
    )?;
    Ok(snapshot)
}

fn validate_state_key(key: &str) -> Result<(), String> {
    if key.trim().is_empty() || key.len() > 160 || key.contains(['/', '\\']) {
        return Err("La clé d’état n’est pas valide.".to_string());
    }
    Ok(())
}

#[tauri::command]
pub async fn state_get_snapshot(
    manager: tauri::State<'_, StateManager>,
) -> Result<StateSnapshot, String> {
    Ok(manager.snapshot().await)
}

#[tauri::command]
pub async fn state_set_value(
    manager: tauri::State<'_, StateManager>,
    key: String,
    value: Value,
) -> Result<StateSnapshot, String> {
    manager.set(key, value).await
}

#[tauri::command]
pub async fn state_delete_value(
    manager: tauri::State<'_, StateManager>,
    key: String,
) -> Result<StateSnapshot, String> {
    manager.delete(&key).await
}

#[tauri::command]
pub async fn state_clear(manager: tauri::State<'_, StateManager>) -> Result<StateSnapshot, String> {
    manager.clear().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn invalid_state_survives_startup_and_every_mutation() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join(STATE_FILE_NAME);
        let original = b"{truncated state";
        fs::write(&path, original).unwrap();
        let manager = StateManager::initialize(temp.path()).unwrap();
        assert!(manager.set("session".into(), json!("new")).await.is_err());
        assert!(manager.delete("session").await.is_err());
        assert!(manager.clear().await.is_err());
        assert!(manager.snapshot().await.values.is_empty());
        assert_eq!(fs::read(path).unwrap(), original);
    }

    #[tokio::test]
    async fn state_is_atomic_and_separate_from_configuration() {
        let temp = tempfile::tempdir().expect("tempdir");
        let manager = StateManager::initialize(temp.path()).expect("state manager");
        manager
            .set("windowWidth".to_string(), json!(1280))
            .await
            .expect("set state");
        let persisted: StateSnapshot = serde_json::from_slice(
            &fs::read(temp.path().join(STATE_FILE_NAME)).expect("state file"),
        )
        .expect("valid state");
        assert_eq!(persisted.values.get("windowWidth"), Some(&json!(1280)));
    }

    #[tokio::test]
    async fn future_state_version_is_never_overwritten() {
        let temp = tempfile::tempdir().expect("tempdir");
        let path = temp.path().join(STATE_FILE_NAME);
        fs::write(&path, br#"{"schemaVersion":99,"values":{"kept":true}}"#).expect("future state");
        let original = fs::read(&path).expect("original state");
        let manager = StateManager::initialize(temp.path()).expect("state manager");

        let error = manager
            .set("windowWidth".to_string(), json!(1280))
            .await
            .expect_err("future state must remain read-only");

        assert!(error.contains("lecture seule"));
        assert_eq!(fs::read(&path).expect("preserved state"), original);
    }

    #[tokio::test]
    async fn unsupported_older_state_version_is_never_overwritten() {
        let temp = tempfile::tempdir().expect("tempdir");
        let path = temp.path().join(STATE_FILE_NAME);
        fs::write(&path, br#"{"schemaVersion":0,"values":{"kept":true}}"#).expect("older state");
        let original = fs::read(&path).expect("original state");
        let manager = StateManager::initialize(temp.path()).expect("state manager");

        let error = manager
            .set("windowWidth".to_string(), json!(1280))
            .await
            .expect_err("older state must remain read-only");

        assert!(error.contains("lecture seule"));
        assert_eq!(fs::read(&path).expect("preserved state"), original);
        assert!(validate_backup_state(&original).is_err());
    }

    #[tokio::test]
    async fn failed_persistence_does_not_publish_the_candidate_snapshot() {
        let temp = tempfile::tempdir().expect("tempdir");
        let path = temp.path().join(STATE_FILE_NAME);
        let manager = StateManager::initialize(temp.path()).expect("state manager");
        manager
            .set("kept".to_string(), json!(true))
            .await
            .expect("seed state");
        manager
            .set("removed".to_string(), json!(true))
            .await
            .expect("seed removable state");

        let before = fs::read(&path).expect("original state");
        // Keep the readable source intact, but fail the publication lock after
        // the candidate has been mutated.
        let publication_lock = path.with_extension("json.lock");
        fs::remove_file(&publication_lock).expect("remove publication lock");
        fs::create_dir(&publication_lock).expect("block publication");

        manager
            .set("uncommitted".to_string(), json!(true))
            .await
            .expect_err("persistence must fail");
        manager
            .delete("removed")
            .await
            .expect_err("delete persistence must fail");
        manager
            .clear()
            .await
            .expect_err("clear persistence must fail");

        let snapshot = manager.snapshot().await;
        assert_eq!(snapshot.values.get("kept"), Some(&json!(true)));
        assert_eq!(snapshot.values.get("removed"), Some(&json!(true)));
        assert!(!snapshot.values.contains_key("uncommitted"));
        assert_eq!(fs::read(&path).expect("preserved state"), before);
    }

    #[tokio::test]
    async fn independent_managers_reload_the_locked_snapshot_before_each_mutation() {
        let temp = tempfile::tempdir().expect("tempdir");
        let first = StateManager::initialize(temp.path()).expect("first state manager");
        let second = StateManager::initialize(temp.path()).expect("second state manager");

        first
            .set("first".to_string(), json!(1))
            .await
            .expect("first write");
        let after_second_write = second
            .set("second".to_string(), json!(2))
            .await
            .expect("second write from a stale manager");
        assert_eq!(after_second_write.values.get("first"), Some(&json!(1)));
        assert_eq!(after_second_write.values.get("second"), Some(&json!(2)));

        let after_stale_delete = first
            .delete("second")
            .await
            .expect("delete from a stale manager");
        assert_eq!(after_stale_delete.values.get("first"), Some(&json!(1)));
        assert!(!after_stale_delete.values.contains_key("second"));

        second
            .set("third".to_string(), json!(3))
            .await
            .expect("third write from a stale manager");
        let after_stale_clear = first.clear().await.expect("clear from a stale manager");
        assert!(after_stale_clear.values.is_empty());

        let persisted: StateSnapshot = serde_json::from_slice(
            &fs::read(temp.path().join(STATE_FILE_NAME)).expect("state file"),
        )
        .expect("valid state");
        assert!(persisted.values.is_empty());
    }
}
