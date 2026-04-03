use serde::Deserialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Deserialize)]
pub struct AppConfig {
    /// Root used for workspace-facing operations such as file tools and metadata.
    #[serde(default = "default_workspace_path")]
    pub workspace_path: PathBuf,

    #[serde(default)]
    #[allow(dead_code)]
    pub ai: AIConfig,
}

#[derive(Debug, Deserialize)]
pub struct AIConfig {
    #[serde(default)]
    #[allow(dead_code)]
    pub openai_api_key: Option<String>,

    #[serde(default)]
    #[allow(dead_code)]
    pub anthropic_api_key: Option<String>,

    #[serde(default = "default_local_api_url")]
    #[allow(dead_code)]
    pub local_api_url: String,
}

fn default_workspace_path() -> PathBuf {
    PathBuf::from(".")
}

fn default_local_api_url() -> String {
    "http://localhost:11434".to_string()
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            workspace_path: default_workspace_path(),
            ai: AIConfig::default(),
        }
    }
}

impl Default for AIConfig {
    fn default() -> Self {
        Self {
            openai_api_key: None,
            anthropic_api_key: None,
            local_api_url: default_local_api_url(),
        }
    }
}

fn resolve_workspace_path_for_cwd(workspace_path: PathBuf, cwd: &Path) -> PathBuf {
    if workspace_path.is_absolute() {
        return workspace_path;
    }

    let cwd_name = cwd.file_name().and_then(|name| name.to_str());
    let base = if workspace_path == Path::new(".") && cwd_name == Some("src-tauri") {
        cwd.parent().unwrap_or(cwd)
    } else {
        cwd
    };

    if workspace_path == Path::new(".") {
        base.to_path_buf()
    } else {
        base.join(workspace_path)
    }
}

fn normalize_workspace_path(workspace_path: PathBuf) -> PathBuf {
    match std::env::current_dir() {
        Ok(cwd) => resolve_workspace_path_for_cwd(workspace_path, &cwd),
        Err(_) => workspace_path,
    }
}

#[cfg(test)]
pub(crate) fn test_resolve_workspace_path_for_cwd(workspace_path: PathBuf, cwd: &Path) -> PathBuf {
    resolve_workspace_path_for_cwd(workspace_path, cwd)
}

pub fn load_config() -> crate::core::Result<AppConfig> {
    let mut settings = config::Config::builder()
        .set_default("workspace_path", ".")?
        .set_default("ai.local_api_url", "http://localhost:11434")?;

    // Try to load from config file if it exists
    if let Ok(settings_file) = std::env::var("MACRO_CONFIG") {
        settings = settings.add_source(config::File::with_name(&settings_file).required(false));
    }

    let mut config: AppConfig = settings
        .build()
        .map_err(|e| crate::core::error::BackendError::Config {
            message: e.to_string(),
        })?
        .try_deserialize()
        .map_err(|e| crate::core::error::BackendError::Config {
            message: e.to_string(),
        })?;

    config.workspace_path = normalize_workspace_path(config.workspace_path);

    Ok(config)
}
