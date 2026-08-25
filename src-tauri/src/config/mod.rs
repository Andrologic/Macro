mod commands;
mod manager;
mod registry;
mod watcher;

pub use commands::*;
pub(crate) use manager::atomic_write_json;
pub use manager::{ConfigApiError, ConfigManager};
pub(crate) use registry::default_document;
pub use registry::{descriptors, schema_for_kind};
pub use types::*;
pub use watcher::{ConfigWatcher, ConfigWatcherState};

mod types;

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

static RUNTIME_CONFIG_MANAGER: OnceLock<ConfigManager> = OnceLock::new();

pub fn install_runtime_config_manager(manager: ConfigManager) -> Result<(), ConfigApiError> {
    RUNTIME_CONFIG_MANAGER
        .set(manager)
        .map_err(|_| ConfigApiError {
            code: "config.manager.already_installed".to_string(),
            message: "Le gestionnaire de configuration est déjà installé.".to_string(),
            document: None,
            diagnostics: Vec::new(),
        })
}

pub fn runtime_config_manager() -> Option<&'static ConfigManager> {
    RUNTIME_CONFIG_MANAGER.get()
}

pub fn resolve_config_root(app_config_dir: &Path) -> Result<PathBuf, ConfigApiError> {
    match std::env::var("MACRO_CONFIG_DIR") {
        Ok(value) => {
            let path = PathBuf::from(value);
            if !path.is_absolute() {
                return Err(ConfigApiError {
                    code: "config.root.not_absolute".to_string(),
                    message: "MACRO_CONFIG_DIR doit contenir un chemin absolu.".to_string(),
                    document: None,
                    diagnostics: Vec::new(),
                });
            }
            Ok(path)
        }
        Err(_) => Ok(app_config_dir.to_path_buf()),
    }
}

pub fn resolve_standalone_config_root() -> Result<PathBuf, ConfigApiError> {
    if let Some(root) = std::env::var_os("MACRO_CONFIG_DIR") {
        let path = PathBuf::from(root);
        if !path.is_absolute() {
            return Err(ConfigApiError {
                code: "config.root.not_absolute".to_string(),
                message: "MACRO_CONFIG_DIR doit contenir un chemin absolu.".to_string(),
                document: None,
                diagnostics: Vec::new(),
            });
        }
        return Ok(path);
    }

    #[cfg(target_os = "windows")]
    let base = std::env::var_os("APPDATA").map(PathBuf::from);
    #[cfg(target_os = "macos")]
    let base = std::env::var_os("HOME")
        .map(PathBuf::from)
        .map(|home| home.join("Library").join("Application Support"));
    #[cfg(all(unix, not(target_os = "macos")))]
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME")
                .map(PathBuf::from)
                .map(|home| home.join(".config"))
        });

    base.map(|path| path.join("com.macro.desktop"))
        .ok_or_else(|| ConfigApiError {
            code: "config.root.unavailable".to_string(),
            message:
                "Impossible de déterminer le dossier de configuration. Définissez MACRO_CONFIG_DIR."
                    .to_string(),
            document: None,
            diagnostics: Vec::new(),
        })
}
