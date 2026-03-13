use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

const DEV_PROVIDER_OVERRIDES_FILE: &str = "ai-keys.local.json";
const DEV_PROVIDER_OVERRIDES_DIR: &str = "dev";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DevProviderOverrideConfig {
    pub api_key: Option<String>,
    pub base_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DevProviderOverridesFile {
    pub providers: Option<HashMap<String, DevProviderOverrideConfig>>,
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
        Ok(parsed) => Some(parsed),
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

#[cfg(test)]
mod tests {
    use super::{
        load_dev_provider_overrides_from_path, load_dev_provider_overrides_from_workspace,
        resolve_dev_provider_overrides_path, DevProviderOverrideConfig, DevProviderOverridesFile,
    };
    use std::collections::HashMap;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn resolves_dev_provider_overrides_path_from_workspace_root() {
        let root = TempDir::new().expect("temp dir");
        let path = resolve_dev_provider_overrides_path(root.path());
        assert_eq!(path, root.path().join("dev").join("ai-keys.local.json"));
    }

    #[test]
    fn returns_none_when_dev_provider_overrides_file_is_missing() {
        let root = TempDir::new().expect("temp dir");
        assert_eq!(load_dev_provider_overrides_from_workspace(root.path()), None);
    }

    #[test]
    fn returns_none_when_dev_provider_overrides_file_is_invalid_json() {
        let root = TempDir::new().expect("temp dir");
        let dev_dir = root.path().join("dev");
        fs::create_dir_all(&dev_dir).expect("create dev dir");
        fs::write(dev_dir.join("ai-keys.local.json"), "{not-json").expect("write invalid json");

        assert_eq!(load_dev_provider_overrides_from_workspace(root.path()), None);
    }

    #[test]
    fn loads_valid_dev_provider_overrides_file() {
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
                api_key: Some("test-api-key".to_string()),
                base_url: Some("https://openrouter.ai/api/v1".to_string()),
            },
        );

        assert_eq!(
            load_dev_provider_overrides_from_path(&dev_dir.join("ai-keys.local.json")),
            Some(DevProviderOverridesFile {
                providers: Some(providers),
            })
        );
    }
}
