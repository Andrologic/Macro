use crate::config::atomic_write_json;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::RwLock;

const STATE_SCHEMA_VERSION: u32 = 1;
const STATE_FILE_NAME: &str = "state.json";

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

#[derive(Clone)]
pub struct StateManager {
    path: Arc<PathBuf>,
    snapshot: Arc<RwLock<StateSnapshot>>,
    read_only: bool,
}

impl StateManager {
    pub fn initialize(app_data_dir: &Path) -> Result<Self, String> {
        fs::create_dir_all(app_data_dir).map_err(|error| error.to_string())?;
        let path = app_data_dir.join(STATE_FILE_NAME);
        let mut read_only = false;
        let snapshot = if path.exists() {
            let raw = fs::read(&path).map_err(|error| error.to_string())?;
            match serde_json::from_slice::<StateSnapshot>(&raw) {
                Ok(snapshot) if snapshot.schema_version <= STATE_SCHEMA_VERSION => snapshot,
                Ok(_) => {
                    read_only = true;
                    tracing::warn!(
                        path = %path.display(),
                        "state.json utilise une version future et ne sera pas modifié"
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
            snapshot: Arc::new(RwLock::new(snapshot)),
            read_only,
        })
    }

    async fn persist(&self, snapshot: &StateSnapshot) -> Result<(), String> {
        self.ensure_writable()?;
        atomic_write_json(
            self.path.as_path(),
            &serde_json::to_value(snapshot).map_err(|error| error.to_string())?,
        )
    }

    pub async fn snapshot(&self) -> StateSnapshot {
        self.snapshot.read().await.clone()
    }

    pub async fn set(&self, key: String, value: Value) -> Result<StateSnapshot, String> {
        self.ensure_writable()?;
        validate_state_key(&key)?;
        let mut snapshot = self.snapshot.write().await;
        snapshot.values.insert(key, value);
        self.persist(&snapshot).await?;
        Ok(snapshot.clone())
    }

    pub async fn delete(&self, key: &str) -> Result<StateSnapshot, String> {
        self.ensure_writable()?;
        validate_state_key(key)?;
        let mut snapshot = self.snapshot.write().await;
        snapshot.values.remove(key);
        self.persist(&snapshot).await?;
        Ok(snapshot.clone())
    }

    pub async fn clear(&self) -> Result<StateSnapshot, String> {
        self.ensure_writable()?;
        let mut snapshot = self.snapshot.write().await;
        snapshot.values.clear();
        self.persist(&snapshot).await?;
        Ok(snapshot.clone())
    }

    fn ensure_writable(&self) -> Result<(), String> {
        if self.read_only {
            return Err(
                "state.json utilise une version plus récente et reste en lecture seule."
                    .to_string(),
            );
        }
        Ok(())
    }
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
}
