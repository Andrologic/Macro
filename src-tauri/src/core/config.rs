use serde::Deserialize;
use std::path::PathBuf;

#[derive(Debug, Deserialize)]
pub struct AppConfig {
    #[serde(default = "default_workspace_path")]
    pub workspace_path: PathBuf,

    #[serde(default = "default_db_path")]
    pub db_path: PathBuf,

    #[serde(default)]
    pub ai: AIConfig,
}

#[derive(Debug, Deserialize)]
pub struct AIConfig {
    #[serde(default)]
    pub openai_api_key: Option<String>,

    #[serde(default)]
    pub anthropic_api_key: Option<String>,

    #[serde(default = "default_local_api_url")]
    pub local_api_url: String,
}

fn default_workspace_path() -> PathBuf {
    PathBuf::from(".")
}

fn default_db_path() -> PathBuf {
    PathBuf::from("macro.db")
}

fn default_local_api_url() -> String {
    "http://localhost:11434".to_string()
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            workspace_path: default_workspace_path(),
            db_path: default_db_path(),
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

pub fn load_config() -> crate::core::Result<AppConfig> {
    let mut settings = config::Config::builder()
        .set_default("workspace_path", ".")?
        .set_default("db_path", "macro.db")?
        .set_default("ai.local_api_url", "http://localhost:11434")?;

    // Try to load from config file if it exists
    if let Ok(settings_file) = std::env::var("MACRO_CONFIG") {
        settings = settings.add_source(config::File::with_name(&settings_file).required(false));
    }

    settings
        .build()
        .map_err(|e| crate::core::error::BackendError::Config {
            message: e.to_string(),
        })?
        .try_deserialize()
        .map_err(|e| crate::core::error::BackendError::Config {
            message: e.to_string(),
        })
}
