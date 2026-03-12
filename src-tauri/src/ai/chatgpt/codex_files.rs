use super::types::{
    CodexVersionFile, ModelsCacheEntry, ModelsCacheFile, DEFAULT_CODEX_CLIENT_VERSION,
};
use std::ffi::OsString;
use std::path::PathBuf;

fn read_models_cache_file() -> Result<ModelsCacheFile, String> {
    let path = codex_models_cache_path()?;
    let content = std::fs::read_to_string(&path)
        .map_err(|error| format!("Failed to read {}: {}", path.display(), error))?;
    serde_json::from_str(&content)
        .map_err(|error| format!("Failed to parse {}: {}", path.display(), error))
}

pub(super) fn load_cached_model_entries() -> Result<Vec<ModelsCacheEntry>, String> {
    let cache = read_models_cache_file()?;
    Ok(cache.models)
}

fn read_codex_version_file() -> Result<CodexVersionFile, String> {
    let path = codex_version_path()?;
    let content = std::fs::read_to_string(&path)
        .map_err(|error| format!("Failed to read {}: {}", path.display(), error))?;
    serde_json::from_str(&content)
        .map_err(|error| format!("Failed to parse {}: {}", path.display(), error))
}

pub(super) fn resolve_codex_client_version() -> Result<String, String> {
    if let Ok(cache) = read_models_cache_file() {
        if let Some(client_version) = cache
            .client_version
            .filter(|value| !value.trim().is_empty())
        {
            return Ok(client_version);
        }
    }

    if let Ok(version) = read_codex_version_file() {
        if let Some(client_version) = version
            .latest_version
            .filter(|value| !value.trim().is_empty())
        {
            return Ok(client_version);
        }
    }

    Ok(DEFAULT_CODEX_CLIENT_VERSION.to_string())
}

fn codex_models_cache_path() -> Result<PathBuf, String> {
    codex_home_dir().map(|path| path.join("models_cache.json"))
}

fn codex_version_path() -> Result<PathBuf, String> {
    codex_home_dir().map(|path| path.join("version.json"))
}

fn codex_home_dir() -> Result<PathBuf, String> {
    if let Some(codex_home) = std::env::var_os("CODEX_HOME").filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(codex_home));
    }

    let home = default_home_dir()
        .ok_or_else(|| "Could not resolve the user home directory.".to_string())?;
    Ok(PathBuf::from(home).join(".codex"))
}

fn default_home_dir() -> Option<OsString> {
    std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))
}
