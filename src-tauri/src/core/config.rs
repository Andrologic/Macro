use serde::Deserialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Deserialize)]
pub struct AppConfig {
    /// Root used for workspace-facing operations such as file tools and metadata.
    #[serde(default = "default_workspace_path", alias = "defaultWorkspace")]
    pub workspace_path: PathBuf,

    #[serde(default)]
    #[allow(dead_code)]
    pub ai: AIConfig,

    #[serde(skip)]
    pub workspace_path_source: WorkspacePathSource,
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

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum WorkspacePathSource {
    #[default]
    Default,
    Configured,
}

impl WorkspacePathSource {
    pub fn is_default(self) -> bool {
        matches!(self, Self::Default)
    }
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
            workspace_path_source: WorkspacePathSource::Default,
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

fn workspace_path_source_for_config(
    settings_file: Option<&str>,
) -> crate::core::Result<WorkspacePathSource> {
    let Some(settings_file) = settings_file else {
        return Ok(WorkspacePathSource::Default);
    };

    let settings = config::Config::builder()
        .add_source(config::File::with_name(settings_file).required(false))
        .build()
        .map_err(|error| crate::core::error::BackendError::Config {
            message: error.to_string(),
        })?;

    if settings.get_string("workspace_path").is_ok() {
        Ok(WorkspacePathSource::Configured)
    } else {
        Ok(WorkspacePathSource::Default)
    }
}

fn config_dir_runtime_file() -> crate::core::Result<Option<PathBuf>> {
    let Some(raw) = std::env::var_os("MACRO_CONFIG_DIR") else {
        return Ok(None);
    };
    let directory = PathBuf::from(raw);
    if !directory.is_absolute() {
        return Err(crate::core::error::BackendError::Config {
            message: "MACRO_CONFIG_DIR doit contenir un chemin absolu.".to_string(),
        });
    }
    Ok(Some(directory.join("runtime.json")))
}

fn workspace_path_source_for_runtime(path: &Path) -> crate::core::Result<WorkspacePathSource> {
    if !path.exists() {
        return Ok(WorkspacePathSource::Default);
    }
    let raw = std::fs::read(path).map_err(|error| crate::core::error::BackendError::Config {
        message: format!("Impossible de lire {} : {error}", path.display()),
    })?;
    let value: serde_json::Value =
        serde_json::from_slice(&raw).map_err(|error| crate::core::error::BackendError::Config {
            message: format!(
                "Configuration JSON invalide dans {} : {error}",
                path.display()
            ),
        })?;
    Ok(
        if value
            .get("defaultWorkspace")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|path| !path.trim().is_empty())
        {
            WorkspacePathSource::Configured
        } else {
            WorkspacePathSource::Default
        },
    )
}

pub fn resolve_desktop_default_workspace_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("workspace")
}

fn finalize_desktop_workspace_path_for_mode(
    config: &mut AppConfig,
    app_data_dir: &Path,
    use_app_data_default: bool,
) {
    if config.workspace_path_source.is_default() && use_app_data_default {
        config.workspace_path = resolve_desktop_default_workspace_path(app_data_dir);
    }
}

pub fn finalize_desktop_workspace_path(
    config: &mut AppConfig,
    app_data_dir: &Path,
) -> crate::core::Result<()> {
    finalize_desktop_workspace_path_for_mode(config, app_data_dir, !cfg!(debug_assertions));
    Ok(())
}

pub fn apply_runtime_workspace(
    config: &mut AppConfig,
    runtime: &serde_json::Value,
) -> crate::core::Result<()> {
    let Some(raw_path) = runtime
        .get("defaultWorkspace")
        .and_then(serde_json::Value::as_str)
    else {
        return Ok(());
    };
    if raw_path.trim().is_empty() {
        return Err(crate::core::error::BackendError::Config {
            message: "runtime.json.defaultWorkspace ne peut pas être vide.".to_string(),
        });
    }
    config.workspace_path = normalize_workspace_path(PathBuf::from(raw_path));
    config.workspace_path_source = WorkspacePathSource::Configured;
    Ok(())
}

#[cfg(test)]
pub(crate) fn test_resolve_workspace_path_for_cwd(workspace_path: PathBuf, cwd: &Path) -> PathBuf {
    resolve_workspace_path_for_cwd(workspace_path, cwd)
}

#[cfg(test)]
pub(crate) fn test_workspace_path_source_for_config(
    settings_file: Option<&str>,
) -> crate::core::Result<WorkspacePathSource> {
    workspace_path_source_for_config(settings_file)
}

#[cfg(test)]
pub(crate) fn test_finalize_desktop_workspace_path_for_mode(
    config: &mut AppConfig,
    app_data_dir: &Path,
    use_app_data_default: bool,
) {
    finalize_desktop_workspace_path_for_mode(config, app_data_dir, use_app_data_default);
}

pub fn load_config() -> crate::core::Result<AppConfig> {
    let runtime_file = config_dir_runtime_file()?;
    let legacy_settings_file = std::env::var("MACRO_CONFIG").ok();
    let workspace_path_source = if let Some(path) = runtime_file.as_deref() {
        workspace_path_source_for_runtime(path)?
    } else {
        workspace_path_source_for_config(legacy_settings_file.as_deref())?
    };
    let mut settings = config::Config::builder()
        .set_default("workspace_path", ".")?
        .set_default("ai.local_api_url", "http://localhost:11434")?;

    if let Some(runtime_file) = runtime_file {
        settings = settings.add_source(
            config::File::from(runtime_file)
                .format(config::FileFormat::Json)
                .required(false),
        );
    } else if let Some(settings_file) = legacy_settings_file.as_ref() {
        tracing::warn!("MACRO_CONFIG est déprécié ; utilisez MACRO_CONFIG_DIR avec runtime.json.");
        settings = settings.add_source(config::File::with_name(settings_file).required(false));
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
    config.workspace_path_source = workspace_path_source;

    Ok(config)
}
