use crate::db::{repository, DbError, DbResult};
use serde::{Deserialize, Serialize};
use sqlx::sqlite::SqlitePool;
use std::collections::HashMap;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

const DEV_PROVIDER_OVERRIDES_FILE: &str = "ai-keys.local.json";
const DEV_PROVIDER_OVERRIDES_DIR: &str = "dev";
const DECLARATIVE_PROVIDER_TYPES: &[&str] = &[
    "openai",
    "anthropic",
    "gemini",
    "ollama",
    "lmstudio",
    "openrouter",
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DevProviderOverrideConfig {
    pub name: Option<String>,
    pub provider_type: Option<String>,
    pub api_key: Option<String>,
    pub base_url: Option<String>,
    pub is_local: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DevProviderOverridesFile {
    pub providers: Option<HashMap<String, DevProviderOverrideConfig>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeclaredDevProvider {
    pub id: String,
    pub name: String,
    pub provider_type: String,
    pub base_url: String,
    pub is_local: bool,
}

fn trim_optional(value: &mut Option<String>) {
    if let Some(trimmed) = value
        .as_ref()
        .map(|entry| entry.trim())
        .filter(|entry| !entry.is_empty())
    {
        *value = Some(trimmed.to_string());
    } else {
        *value = None;
    }
}

fn normalize_base_url(value: &str) -> String {
    value.trim_end_matches('/').to_string()
}

fn default_is_local(provider_type: &str) -> bool {
    provider_type == "ollama" || provider_type == "lmstudio"
}

impl DevProviderOverrideConfig {
    fn normalize_in_place(&mut self) {
        trim_optional(&mut self.name);
        trim_optional(&mut self.provider_type);
        trim_optional(&mut self.api_key);
        trim_optional(&mut self.base_url);

        if let Some(provider_type) = self.provider_type.as_mut() {
            *provider_type = provider_type.to_lowercase();
        }

        if let Some(base_url) = self.base_url.as_mut() {
            *base_url = normalize_base_url(base_url);
        }
    }

    fn is_declarative_candidate(&self) -> bool {
        self.name.is_some() || self.provider_type.is_some() || self.is_local.is_some()
    }

    fn to_declared_provider(
        &self,
        provider_id: &str,
    ) -> Result<Option<DeclaredDevProvider>, String> {
        if !self.is_declarative_candidate() {
            return Ok(None);
        }

        let name = self
            .name
            .as_ref()
            .filter(|value| !value.trim().is_empty())
            .cloned()
            .ok_or_else(|| {
                format!(
                    "Declarative dev provider \"{}\" must include a non-empty name.",
                    provider_id
                )
            })?;
        let provider_type = self
            .provider_type
            .as_ref()
            .filter(|value| !value.trim().is_empty())
            .cloned()
            .ok_or_else(|| {
                format!(
                    "Declarative dev provider \"{}\" must include a non-empty providerType.",
                    provider_id
                )
            })?;
        let base_url = self
            .base_url
            .as_ref()
            .filter(|value| !value.trim().is_empty())
            .cloned()
            .ok_or_else(|| {
                format!(
                    "Declarative dev provider \"{}\" must include a non-empty baseUrl.",
                    provider_id
                )
            })?;

        if provider_type == "chatgpt" || provider_type == "copilot" {
            return Err(format!(
                "Declarative dev provider \"{}\" cannot use linked providerType \"{}\".",
                provider_id, provider_type
            ));
        }

        if !DECLARATIVE_PROVIDER_TYPES.contains(&provider_type.as_str()) {
            return Err(format!(
                "Declarative dev provider \"{}\" has unsupported providerType \"{}\".",
                provider_id, provider_type
            ));
        }

        Ok(Some(DeclaredDevProvider {
            id: provider_id.to_string(),
            name,
            provider_type: provider_type.clone(),
            base_url,
            is_local: self
                .is_local
                .unwrap_or_else(|| default_is_local(&provider_type)),
        }))
    }
}

impl DevProviderOverridesFile {
    fn normalize_and_validate(mut self) -> Result<Self, String> {
        if let Some(providers) = self.providers.as_mut() {
            for (provider_id, config) in providers.iter_mut() {
                if provider_id.trim().is_empty() {
                    return Err("Dev provider override keys must not be empty.".to_string());
                }

                config.normalize_in_place();
                config.to_declared_provider(provider_id)?;
            }
        }

        Ok(self)
    }

    pub fn declared_providers(&self) -> Result<Vec<DeclaredDevProvider>, String> {
        let Some(providers) = self.providers.as_ref() else {
            return Ok(Vec::new());
        };

        providers
            .iter()
            .map(|(provider_id, config)| config.to_declared_provider(provider_id))
            .filter_map(|result| match result {
                Ok(Some(provider)) => Some(Ok(provider)),
                Ok(None) => None,
                Err(error) => Some(Err(error)),
            })
            .collect()
    }
}

pub fn resolve_dev_provider_overrides_path(workspace_root: &Path) -> PathBuf {
    workspace_root
        .join(DEV_PROVIDER_OVERRIDES_DIR)
        .join(DEV_PROVIDER_OVERRIDES_FILE)
}

pub fn load_dev_provider_overrides_from_path(path: &Path) -> Option<DevProviderOverridesFile> {
    let contents = match fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == ErrorKind::NotFound => return None,
        Err(error) => {
            tracing::warn!(
                path = %path.display(),
                "Failed to read dev provider overrides: {}",
                error
            );
            return None;
        }
    };

    match serde_json::from_str::<DevProviderOverridesFile>(&contents) {
        Ok(parsed) => match parsed.normalize_and_validate() {
            Ok(validated) => Some(validated),
            Err(error) => {
                tracing::warn!(
                    path = %path.display(),
                    "Invalid dev provider overrides: {}",
                    error
                );
                None
            }
        },
        Err(error) => {
            tracing::warn!(
                path = %path.display(),
                "Failed to parse dev provider overrides: {}",
                error
            );
            None
        }
    }
}

pub fn load_dev_provider_overrides_from_workspace(
    workspace_root: &Path,
) -> Option<DevProviderOverridesFile> {
    let path = resolve_dev_provider_overrides_path(workspace_root);
    load_dev_provider_overrides_from_path(&path)
}

pub async fn sync_declared_dev_providers_from_workspace(
    pool: &SqlitePool,
    workspace_root: &Path,
) -> DbResult<()> {
    let Some(overrides) = load_dev_provider_overrides_from_workspace(workspace_root) else {
        return Ok(());
    };

    let declared_providers = overrides
        .declared_providers()
        .map_err(DbError::Validation)?;

    for provider in declared_providers {
        repository::upsert_provider_config_by_id(
            pool,
            &provider.id,
            &provider.name,
            &provider.provider_type,
            &provider.base_url,
            provider.is_local,
        )
        .await?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        load_dev_provider_overrides_from_path, load_dev_provider_overrides_from_workspace,
        resolve_dev_provider_overrides_path, sync_declared_dev_providers_from_workspace,
        DevProviderOverrideConfig, DevProviderOverridesFile,
    };
    use sqlx::sqlite::SqlitePoolOptions;
    use sqlx::Row;
    use std::collections::HashMap;
    use std::fs;
    use tempfile::TempDir;

    async fn create_provider_config_table(pool: &sqlx::SqlitePool) {
        sqlx::query(
            r#"
            CREATE TABLE provider_configs (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                provider_type TEXT NOT NULL,
                base_url TEXT NOT NULL,
                api_key TEXT,
                has_stored_api_key INTEGER NOT NULL DEFAULT 0,
                is_enabled INTEGER NOT NULL DEFAULT 1,
                is_local INTEGER NOT NULL DEFAULT 0,
                auth_status TEXT,
                auth_source TEXT,
                plan_type TEXT,
                account_label TEXT,
                token_expires_at TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            "#,
        )
        .execute(pool)
        .await
        .expect("create provider_configs");
    }

    async fn create_test_pool() -> sqlx::SqlitePool {
        SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("connect sqlite")
    }

    #[test]
    fn resolves_dev_provider_overrides_path_from_workspace_root() {
        let root = TempDir::new().expect("temp dir");
        let path = resolve_dev_provider_overrides_path(root.path());
        assert_eq!(path, root.path().join("dev").join("ai-keys.local.json"));
    }

    #[test]
    fn returns_none_when_dev_provider_overrides_file_is_missing() {
        let root = TempDir::new().expect("temp dir");
        assert_eq!(
            load_dev_provider_overrides_from_workspace(root.path()),
            None
        );
    }

    #[test]
    fn returns_none_when_dev_provider_overrides_file_is_invalid_json() {
        let root = TempDir::new().expect("temp dir");
        let dev_dir = root.path().join("dev");
        fs::create_dir_all(&dev_dir).expect("create dev dir");
        fs::write(dev_dir.join("ai-keys.local.json"), "{not-json").expect("write invalid json");

        assert_eq!(
            load_dev_provider_overrides_from_workspace(root.path()),
            None
        );
    }

    #[test]
    fn loads_valid_legacy_dev_provider_overrides_file() {
        let root = TempDir::new().expect("temp dir");
        let dev_dir = root.path().join("dev");
        fs::create_dir_all(&dev_dir).expect("create dev dir");
        fs::write(
            dev_dir.join("ai-keys.local.json"),
            r#"{"providers":{"openrouter":{"apiKey":"test-api-key","baseUrl":"https://openrouter.ai/api/v1"}}}"#,
        )
        .expect("write valid json");

        let mut providers = HashMap::new();
        providers.insert(
            "openrouter".to_string(),
            DevProviderOverrideConfig {
                name: None,
                provider_type: None,
                api_key: Some("test-api-key".to_string()),
                base_url: Some("https://openrouter.ai/api/v1".to_string()),
                is_local: None,
            },
        );

        assert_eq!(
            load_dev_provider_overrides_from_path(&dev_dir.join("ai-keys.local.json")),
            Some(DevProviderOverridesFile {
                providers: Some(providers),
            })
        );
    }

    #[test]
    fn loads_valid_declarative_dev_provider_overrides_file() {
        let root = TempDir::new().expect("temp dir");
        let dev_dir = root.path().join("dev");
        fs::create_dir_all(&dev_dir).expect("create dev dir");
        fs::write(
            dev_dir.join("ai-keys.local.json"),
            r#"{"providers":{"opencode-go":{"name":"OpenCode Go","providerType":"openai","baseUrl":"https://opencode.ai/zen/go/v1/","apiKey":"go-test"}}}"#,
        )
        .expect("write valid json");

        let parsed = load_dev_provider_overrides_from_path(&dev_dir.join("ai-keys.local.json"))
            .expect("parsed config");
        let providers = parsed.providers.as_ref().expect("providers map");
        let config = providers.get("opencode-go").expect("opencode-go config");

        assert_eq!(config.name.as_deref(), Some("OpenCode Go"));
        assert_eq!(config.provider_type.as_deref(), Some("openai"));
        assert_eq!(
            config.base_url.as_deref(),
            Some("https://opencode.ai/zen/go/v1")
        );
        assert_eq!(config.api_key.as_deref(), Some("go-test"));
        assert_eq!(config.is_local, None);

        let declared = parsed.declared_providers().expect("declared providers");
        assert_eq!(declared.len(), 1);
        assert_eq!(declared[0].id, "opencode-go");
        assert_eq!(declared[0].name, "OpenCode Go");
        assert_eq!(declared[0].provider_type, "openai");
        assert_eq!(declared[0].base_url, "https://opencode.ai/zen/go/v1");
        assert!(!declared[0].is_local);
    }

    #[test]
    fn returns_none_when_declarative_provider_type_is_invalid() {
        let root = TempDir::new().expect("temp dir");
        let dev_dir = root.path().join("dev");
        fs::create_dir_all(&dev_dir).expect("create dev dir");
        fs::write(
            dev_dir.join("ai-keys.local.json"),
            r#"{"providers":{"bad-provider":{"name":"Bad","providerType":"chatgpt","baseUrl":"https://example.com/v1"}}}"#,
        )
        .expect("write invalid config");

        assert_eq!(
            load_dev_provider_overrides_from_path(&dev_dir.join("ai-keys.local.json")),
            None
        );
    }

    #[tokio::test]
    async fn sync_declared_dev_providers_creates_and_updates_declared_rows_only() {
        let root = TempDir::new().expect("temp dir");
        let dev_dir = root.path().join("dev");
        fs::create_dir_all(&dev_dir).expect("create dev dir");
        fs::write(
            dev_dir.join("ai-keys.local.json"),
            r#"{
                "providers": {
                    "minimax": {
                        "name": "MiniMax",
                        "providerType": "openai",
                        "baseUrl": "https://api.minimax.io/v1/",
                        "apiKey": "secret"
                    }
                }
            }"#,
        )
        .expect("write config");

        let pool = create_test_pool().await;
        create_provider_config_table(&pool).await;

        sqlx::query(
            r#"
            INSERT INTO provider_configs (
                id, name, provider_type, base_url, api_key, has_stored_api_key, is_enabled, is_local,
                auth_status, auth_source, plan_type, account_label, token_expires_at, created_at, updated_at
            )
            VALUES
                ('minimax', 'Old MiniMax', 'openai', 'https://old.example/v1', NULL, 0, 1, 0, NULL, NULL, NULL, NULL, NULL, 'now', 'now'),
                ('manual-provider', 'Manual Provider', 'openai', 'https://manual.example/v1', NULL, 1, 1, 0, NULL, NULL, NULL, NULL, NULL, 'now', 'now')
            "#,
        )
        .execute(&pool)
        .await
        .expect("seed providers");

        sync_declared_dev_providers_from_workspace(&pool, root.path())
            .await
            .expect("sync declared providers");

        let minimax = sqlx::query(
            "SELECT name, provider_type, base_url, has_stored_api_key, is_local FROM provider_configs WHERE id = 'minimax'",
        )
        .fetch_one(&pool)
        .await
        .expect("minimax row");
        assert_eq!(minimax.get::<String, _>("name"), "MiniMax");
        assert_eq!(minimax.get::<String, _>("provider_type"), "openai");
        assert_eq!(
            minimax.get::<String, _>("base_url"),
            "https://api.minimax.io/v1"
        );
        assert_eq!(minimax.get::<i32, _>("has_stored_api_key"), 0);
        assert_eq!(minimax.get::<i32, _>("is_local"), 0);

        let manual = sqlx::query(
            "SELECT name, base_url, has_stored_api_key FROM provider_configs WHERE id = 'manual-provider'",
        )
        .fetch_one(&pool)
        .await
        .expect("manual provider row");
        assert_eq!(manual.get::<String, _>("name"), "Manual Provider");
        assert_eq!(
            manual.get::<String, _>("base_url"),
            "https://manual.example/v1"
        );
        assert_eq!(manual.get::<i32, _>("has_stored_api_key"), 1);
    }
}
