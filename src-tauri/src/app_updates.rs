#[cfg(target_os = "windows")]
use crate::core::process::background_command;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use fs2::FileExt;
use minisign_verify::{PublicKey, Signature};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[cfg(target_os = "windows")]
use std::io::Cursor;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex},
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;
use tempfile::{Builder as TempFileBuilder, NamedTempFile};

const UPDATE_DIRECTORY: &str = "app-updates";
const MANIFEST_FILE: &str = "staged-update.json";
const CLEAN_SHUTDOWN_FILE: &str = "clean-shutdown.json";
const UPDATE_GENERATION_FILE: &str = "stage-generation";
const PUBLICATION_BACKUP_FILE: &str = "staged-update.publication-backup.json";
const UPDATE_LOCK_FILE: &str = "update-state.lock";
const MAX_ACTIVATION_ATTEMPTS: u8 = 2;
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
const INSTALLER_CLOSE_REQUEST_FILE: &str = "macro-installer-close.request";
const INSTALLER_CLOSE_ACCEPTED_FILE: &str = "macro-installer-close.accepted";
const INSTALLER_CLOSE_CANCELLED_FILE: &str = "macro-installer-close.cancelled";
static UPDATE_ATOMIC_WRITE_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));
static UPDATE_STATE_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

#[cfg(test)]
static UPDATE_PUBLICATION_AFTER_MANIFEST_HOOK: LazyLock<
    Mutex<
        Option<(
            String,
            std::sync::Arc<std::sync::Barrier>,
            std::sync::Arc<std::sync::Barrier>,
        )>,
    >,
> = LazyLock::new(|| Mutex::new(None));

#[cfg(test)]
static UPDATE_FAIL_AFTER_PACKAGE: LazyLock<Mutex<Option<String>>> =
    LazyLock::new(|| Mutex::new(None));

#[cfg(test)]
static UPDATE_FAIL_AFTER_MANIFEST: LazyLock<Mutex<Option<String>>> =
    LazyLock::new(|| Mutex::new(None));

fn lock_update_state() -> std::sync::MutexGuard<'static, ()> {
    UPDATE_STATE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn lock_update_directory(directory: &Path) -> Result<fs::File, String> {
    fs::create_dir_all(directory)
        .map_err(|error| format!("Impossible de préparer le verrou des mises à jour : {error}"))?;
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .open(directory.join(UPDATE_LOCK_FILE))
        .map_err(|error| format!("Impossible d'ouvrir le verrou des mises à jour : {error}"))?;
    file.lock_exclusive()
        .map_err(|error| format!("Impossible de verrouiller les mises à jour : {error}"))?;
    Ok(file)
}

#[cfg(test)]
fn install_publication_after_manifest_hook(
    package_file: String,
    reached: std::sync::Arc<std::sync::Barrier>,
    release: std::sync::Arc<std::sync::Barrier>,
) {
    *UPDATE_PUBLICATION_AFTER_MANIFEST_HOOK
        .lock()
        .expect("update publication hook mutex") = Some((package_file, reached, release));
}

#[cfg(test)]
fn pause_after_manifest_publication(package_file: &str) {
    let hook = {
        let mut hooks = UPDATE_PUBLICATION_AFTER_MANIFEST_HOOK
            .lock()
            .expect("update publication hook mutex");
        if hooks
            .as_ref()
            .is_some_and(|(expected, _, _)| expected == package_file)
        {
            hooks.take()
        } else {
            None
        }
    };
    if let Some((_, reached, release)) = hook {
        reached.wait();
        release.wait();
    }
}

#[cfg(not(test))]
fn pause_after_manifest_publication(_package_file: &str) {}

#[cfg(test)]
fn install_fail_after_package_publication(package_file: String) {
    *UPDATE_FAIL_AFTER_PACKAGE
        .lock()
        .expect("update package failure hook mutex") = Some(package_file);
}

#[cfg(test)]
fn fail_after_package_publication(package_file: &str) -> Result<(), String> {
    let should_fail = {
        let mut hook = UPDATE_FAIL_AFTER_PACKAGE
            .lock()
            .expect("update package failure hook mutex");
        hook.as_deref() == Some(package_file) && hook.take().is_some()
    };
    if should_fail {
        Err("injected failure after package publication".to_string())
    } else {
        Ok(())
    }
}

#[cfg(test)]
fn install_fail_after_manifest_publication(package_file: String) {
    *UPDATE_FAIL_AFTER_MANIFEST
        .lock()
        .expect("update manifest failure hook mutex") = Some(package_file);
}

#[cfg(test)]
fn fail_after_manifest_publication(package_file: &str) -> Result<(), String> {
    let should_fail = {
        let mut hook = UPDATE_FAIL_AFTER_MANIFEST
            .lock()
            .expect("update manifest failure hook mutex");
        hook.as_deref() == Some(package_file) && hook.take().is_some()
    };
    if should_fail {
        Err("injected failure after manifest publication".to_string())
    } else {
        Ok(())
    }
}

#[cfg(not(test))]
fn fail_after_manifest_publication(_package_file: &str) -> Result<(), String> {
    Ok(())
}

#[cfg(not(test))]
fn fail_after_package_publication(_package_file: &str) -> Result<(), String> {
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum StagedUpdatePhase {
    Staged,
    Activating,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StagedUpdateManifest {
    #[serde(default)]
    pub generation: String,
    pub current_version: String,
    pub version: String,
    pub date: Option<String>,
    pub notes: String,
    pub target: String,
    pub package_file: String,
    pub signature: String,
    pub sha256: String,
    pub package_size: u64,
    pub phase: StagedUpdatePhase,
    pub activation_attempts: u8,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct StagedUpdatePublicationBackup {
    generation: String,
    manifest: Option<StagedUpdateManifest>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CleanShutdownMarker {
    current_version: String,
    staged_version: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateSnapshot {
    pub current_version: String,
    pub update: Option<StagedUpdateManifest>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum DownloadProgressEvent {
    Started { content_length: Option<u64> },
    Progress { chunk_length: usize },
    Finished,
}

fn update_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_cache_dir()
        .map(|path| path.join(UPDATE_DIRECTORY))
        .map_err(|error| format!("Impossible d'ouvrir le cache des mises à jour : {error}"))
}

fn target_matches_persisted_channel(app_data_dir: &Path, target: &str) -> Result<bool, String> {
    let value = crate::state_manager::read_persisted_value(app_data_dir, "updateChannel")?;
    let channel = match value {
        None => "stable",
        Some(serde_json::Value::String(channel)) if channel == "stable" => "stable",
        Some(serde_json::Value::String(channel)) if channel == "preview" => "preview",
        _ => return Err("UPDATE_CHANNEL_INVALID".to_string()),
    };
    Ok(target
        .strip_prefix(channel)
        .is_some_and(|suffix| suffix.starts_with('-')))
}

fn update_target_matches_channel(app: &AppHandle, target: &str) -> Result<bool, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    target_matches_persisted_channel(&app_data_dir, target)
}

fn manifest_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(update_dir(app)?.join(MANIFEST_FILE))
}

fn package_path(app: &AppHandle, package_file: &str) -> Result<PathBuf, String> {
    let file_name = Path::new(package_file)
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| *value == package_file && value.starts_with("staged-update-"))
        .ok_or_else(|| "UPDATE_STATE_INVALID".to_string())?;
    Ok(update_dir(app)?.join(file_name))
}

fn clean_shutdown_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(update_dir(app)?.join(CLEAN_SHUTDOWN_FILE))
}

fn read_manifest_file(path: &Path) -> Result<Option<StagedUpdateManifest>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let contents = fs::read_to_string(&path)
        .map_err(|error| format!("Impossible de lire l'état de la mise à jour : {error}"))?;
    serde_json::from_str(&contents)
        .map(Some)
        .map_err(|error| format!("L'état de la mise à jour est illisible : {error}"))
}

fn read_manifest(app: &AppHandle) -> Result<Option<StagedUpdateManifest>, String> {
    read_manifest_file(&manifest_path(app)?)
}

pub(crate) fn diagnostic_manifest(app: &AppHandle) -> Result<Option<StagedUpdateManifest>, String> {
    read_manifest(app)
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let _write_guard = UPDATE_ATOMIC_WRITE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    atomic_write_with(path, bytes, persist_temporary_file, sync_parent_directory)
}

fn atomic_write_with<F, S>(
    path: &Path,
    bytes: &[u8],
    persist: F,
    sync_parent: S,
) -> Result<(), String>
where
    F: FnOnce(NamedTempFile, &Path) -> Result<(), String>,
    S: FnOnce(&Path) -> Result<(), String>,
{
    let parent = path
        .parent()
        .ok_or_else(|| "Le chemin de mise à jour est invalide.".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Impossible de créer le cache des mises à jour : {error}"))?;
    let mut temporary = TempFileBuilder::new()
        .prefix(".macro-update-")
        .tempfile_in(parent)
        .map_err(|error| format!("Impossible de préparer la mise à jour : {error}"))?;
    temporary
        .write_all(bytes)
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|error| format!("Impossible d'enregistrer la mise à jour : {error}"))?;
    persist(temporary, path)?;
    if let Err(error) = sync_parent(parent) {
        // The rename is the commit point: returning an ordinary error here
        // would falsely promise callers that the previous file still exists.
        // Keep the committed state and surface the durability uncertainty in
        // local logs without including the private cache path.
        tracing::warn!(
            action = "update_atomic_write_directory_sync_failed",
            reason = %error,
            "The update state was replaced, but directory durability could not be confirmed."
        );
    }
    Ok(())
}

fn persist_temporary_file(temporary: NamedTempFile, path: &Path) -> Result<(), String> {
    temporary
        .persist(path)
        .map(|_| ())
        .map_err(|error| format!("Impossible de finaliser la mise à jour : {}", error.error))
}

#[cfg(unix)]
fn sync_parent_directory(parent: &Path) -> Result<(), String> {
    fs::File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("Impossible de synchroniser le cache des mises à jour : {error}"))
}

#[cfg(not(unix))]
fn sync_parent_directory(_parent: &Path) -> Result<(), String> {
    Ok(())
}

fn write_manifest_file(path: &Path, manifest: &StagedUpdateManifest) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(manifest)
        .map_err(|error| format!("Impossible d'enregistrer l'état de la mise à jour : {error}"))?;
    atomic_write(path, &bytes)
}

fn write_manifest(app: &AppHandle, manifest: &StagedUpdateManifest) -> Result<(), String> {
    write_manifest_file(&manifest_path(app)?, manifest)
}

fn package_digest(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn package_file_name(version: &str, sha256: &str) -> String {
    let safe_version: String = version
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect();
    format!("staged-update-{safe_version}-{sha256}.bin")
}

fn staged_update_belongs_to_current_install(
    manifest: &StagedUpdateManifest,
    current_version: &str,
) -> bool {
    manifest.current_version == current_version && manifest.version != current_version
}

fn clean_shutdown_matches(
    marker: &CleanShutdownMarker,
    manifest: &StagedUpdateManifest,
    current_version: &str,
) -> bool {
    marker.current_version == current_version && marker.staged_version == manifest.version
}

fn updater_public_key(app: &AppHandle) -> Result<&str, String> {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|value| value.get("pubkey"))
        .and_then(|value| value.as_str())
        .ok_or_else(|| "UPDATE_SIGNATURE_CONFIG_MISSING".to_string())
}

fn verify_update_signature(bytes: &[u8], signature: &str, public_key: &str) -> Result<(), String> {
    let decoded_key = BASE64
        .decode(public_key)
        .ok()
        .and_then(|value| String::from_utf8(value).ok())
        .ok_or_else(|| "UPDATE_SIGNATURE_CONFIG_INVALID".to_string())?;
    let decoded_signature = BASE64
        .decode(signature)
        .ok()
        .and_then(|value| String::from_utf8(value).ok())
        .ok_or_else(|| "UPDATE_SIGNATURE_INVALID".to_string())?;
    let public_key = PublicKey::decode(&decoded_key)
        .map_err(|_| "UPDATE_SIGNATURE_CONFIG_INVALID".to_string())?;
    let signature = Signature::decode(&decoded_signature)
        .map_err(|_| "UPDATE_SIGNATURE_INVALID".to_string())?;
    public_key
        .verify(bytes, &signature, true)
        .map_err(|_| "UPDATE_SIGNATURE_INVALID".to_string())
}

fn remove_file_if_present(path: &Path) -> Result<(), String> {
    if path.exists() {
        fs::remove_file(path).map_err(|_| "UPDATE_CACHE_CLEANUP_FAILED".to_string())?;
    }
    Ok(())
}

fn cleanup_installer_artifacts(app: &AppHandle) {
    let Ok(directory) = update_dir(app) else {
        return;
    };
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with("Macro-") && name.ends_with("-setup.exe") {
            let _ = fs::remove_file(entry.path());
        }
    }
}

fn clear_staged_update_directory(directory: &Path) -> Result<(), String> {
    remove_file_if_present(&directory.join(MANIFEST_FILE))?;
    remove_file_if_present(&directory.join(PUBLICATION_BACKUP_FILE))?;
    remove_file_if_present(&directory.join(CLEAN_SHUTDOWN_FILE))?;
    if let Ok(entries) = fs::read_dir(&directory) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with("staged-update-") && name.ends_with(".bin") {
                remove_file_if_present(&entry.path())?;
            }
        }
    }
    Ok(())
}

fn read_update_generation_directory(directory: &Path) -> Result<String, String> {
    match fs::read_to_string(directory.join(UPDATE_GENERATION_FILE)) {
        Ok(generation) => Ok(generation),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok("initial-generation".to_string())
        }
        Err(error) => Err(format!(
            "Impossible de lire la génération des mises à jour : {error}"
        )),
    }
}

fn invalidate_update_generation_directory(directory: &Path) -> Result<(), String> {
    write_update_generation_directory(directory, &uuid::Uuid::new_v4().to_string())
}

fn write_update_generation_directory(directory: &Path, generation: &str) -> Result<(), String> {
    atomic_write(
        &directory.join(UPDATE_GENERATION_FILE),
        generation.as_bytes(),
    )
}

fn invalidate_and_clear_staged_update_directory(directory: &Path) -> Result<(), String> {
    invalidate_update_generation_directory(directory)?;
    clear_staged_update_directory(directory)
}

fn cleanup_staged_packages_except(directory: &Path, package_file: &str) {
    if let Ok(entries) = fs::read_dir(directory) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with("staged-update-") && name.ends_with(".bin") && name != package_file
            {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
}

fn read_publication_backup(
    directory: &Path,
) -> Result<Option<StagedUpdatePublicationBackup>, String> {
    let path = directory.join(PUBLICATION_BACKUP_FILE);
    if !path.exists() {
        return Ok(None);
    }
    let contents = fs::read_to_string(&path)
        .map_err(|error| format!("Impossible de lire la transaction de mise à jour : {error}"))?;
    serde_json::from_str(&contents)
        .map(Some)
        .map_err(|error| format!("La transaction de mise à jour est illisible : {error}"))
}

fn write_publication_backup(
    directory: &Path,
    backup: &StagedUpdatePublicationBackup,
) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(backup).map_err(|error| {
        format!("Impossible d'enregistrer la transaction de mise à jour : {error}")
    })?;
    atomic_write(&directory.join(PUBLICATION_BACKUP_FILE), &bytes)
}

fn staged_manifest_package_is_valid(directory: &Path, manifest: &StagedUpdateManifest) -> bool {
    let valid_package_file = Path::new(&manifest.package_file)
        .file_name()
        .and_then(|value| value.to_str())
        .is_some_and(|value| {
            value == manifest.package_file
                && value.starts_with("staged-update-")
                && value.ends_with(".bin")
        });
    if !valid_package_file {
        return false;
    }
    let package_path = directory.join(&manifest.package_file);
    let Ok(metadata) = fs::metadata(&package_path) else {
        return false;
    };
    if metadata.len() != manifest.package_size {
        return false;
    }
    let Ok(bytes) = fs::read(package_path) else {
        return false;
    };
    package_digest(&bytes) == manifest.sha256
}

fn recover_publication_backup(
    directory: &Path,
    backup: StagedUpdatePublicationBackup,
) -> Result<Option<StagedUpdateManifest>, String> {
    match backup.manifest {
        Some(manifest)
            if !backup.generation.is_empty()
                && manifest.generation == backup.generation
                && staged_manifest_package_is_valid(directory, &manifest) =>
        {
            write_manifest_file(&directory.join(MANIFEST_FILE), &manifest)?;
            write_update_generation_directory(directory, &backup.generation)?;
            cleanup_staged_packages_except(directory, &manifest.package_file);
            remove_file_if_present(&directory.join(PUBLICATION_BACKUP_FILE))?;
            Ok(Some(manifest))
        }
        None if !backup.generation.is_empty() => {
            remove_file_if_present(&directory.join(MANIFEST_FILE))?;
            remove_file_if_present(&directory.join(CLEAN_SHUTDOWN_FILE))?;
            cleanup_staged_packages_except(directory, "");
            write_update_generation_directory(directory, &backup.generation)?;
            remove_file_if_present(&directory.join(PUBLICATION_BACKUP_FILE))?;
            Ok(None)
        }
        _ => Err("UPDATE_STATE_INVALID".to_string()),
    }
}

#[cfg(test)]
fn publish_staged_update_directory(
    directory: &Path,
    manifest: &StagedUpdateManifest,
    bytes: &[u8],
) -> Result<StagedUpdateManifest, String> {
    publish_staged_update_directory_with_generation(directory, manifest, bytes, None)
}

fn publish_staged_update_directory_with_generation(
    directory: &Path,
    manifest: &StagedUpdateManifest,
    bytes: &[u8],
    expected_generation: Option<&str>,
) -> Result<StagedUpdateManifest, String> {
    let package_file = manifest.package_file.as_str();
    let valid_package_file = Path::new(package_file)
        .file_name()
        .and_then(|value| value.to_str())
        .is_some_and(|value| {
            value == package_file && value.starts_with("staged-update-") && value.ends_with(".bin")
        });
    if !valid_package_file {
        return Err("UPDATE_STATE_INVALID".to_string());
    }

    let _state_guard = lock_update_state();
    let _file_guard = lock_update_directory(directory)?;
    if let Some(expected_generation) = expected_generation {
        let current_generation = read_update_generation_directory(directory)?;
        if current_generation != expected_generation {
            return Err("UPDATE_STAGE_CANCELLED".to_string());
        }
    }
    let previous_manifest = read_manifest_file(&directory.join(MANIFEST_FILE))?;
    let previous_generation = read_update_generation_directory(directory)?;
    write_publication_backup(
        directory,
        &StagedUpdatePublicationBackup {
            generation: previous_generation,
            manifest: previous_manifest,
        },
    )?;
    let next_generation = uuid::Uuid::new_v4().to_string();
    let mut published_manifest = manifest.clone();
    published_manifest.generation.clone_from(&next_generation);
    atomic_write(&directory.join(package_file), bytes)?;
    fail_after_package_publication(package_file)?;
    write_manifest_file(&directory.join(MANIFEST_FILE), &published_manifest)?;
    fail_after_manifest_publication(package_file)?;
    write_update_generation_directory(directory, &next_generation)?;
    pause_after_manifest_publication(package_file);
    cleanup_staged_packages_except(directory, package_file);
    remove_file_if_present(&directory.join(PUBLICATION_BACKUP_FILE))?;
    Ok(published_manifest)
}

fn clear_staged_update(app: &AppHandle) -> Result<(), String> {
    let directory = update_dir(app)?;
    invalidate_and_clear_staged_update_directory(&directory)?;
    cleanup_installer_artifacts(app);
    Ok(())
}

fn read_manifest_directory_recovering_unlocked(
    directory: &Path,
) -> Result<Option<StagedUpdateManifest>, String> {
    let backup = match read_publication_backup(directory) {
        Ok(backup) => backup,
        Err(_) => {
            invalidate_and_clear_staged_update_directory(directory)?;
            return Ok(None);
        }
    };
    if let Some(backup) = backup {
        let manifest = read_manifest_file(&directory.join(MANIFEST_FILE))
            .ok()
            .flatten();
        let current_generation = read_update_generation_directory(directory)?;
        if manifest.as_ref().is_some_and(|value| {
            !value.generation.is_empty()
                && value.generation == current_generation
                && staged_manifest_package_is_valid(directory, value)
        }) {
            remove_file_if_present(&directory.join(PUBLICATION_BACKUP_FILE))?;
            if let Some(manifest) = manifest.as_ref() {
                cleanup_staged_packages_except(directory, &manifest.package_file);
            }
            return Ok(manifest);
        }
        return match recover_publication_backup(directory, backup) {
            Ok(manifest) => Ok(manifest),
            Err(_) => {
                invalidate_and_clear_staged_update_directory(directory)?;
                Ok(None)
            }
        };
    }
    match read_manifest_file(&directory.join(MANIFEST_FILE)) {
        Ok(Some(manifest)) => {
            let current_generation = read_update_generation_directory(directory)?;
            if manifest.generation.is_empty() || manifest.generation != current_generation {
                clear_staged_update_directory(directory)?;
                return Ok(None);
            }
            Ok(Some(manifest))
        }
        Ok(None) => {
            // A committed installation may have removed the manifest before a
            // secondary cache deletion failed. Retry orphan cleanup on reads.
            if let Err(error) = clear_staged_update_directory(directory) {
                tracing::warn!("Update cache cleanup remains incomplete: {error}");
            }
            Ok(None)
        }
        Err(_) => {
            invalidate_and_clear_staged_update_directory(directory)?;
            Ok(None)
        }
    }
}

#[cfg(test)]
fn read_manifest_directory_recovering(
    directory: &Path,
) -> Result<Option<StagedUpdateManifest>, String> {
    let _state_guard = lock_update_state();
    let _file_guard = lock_update_directory(directory)?;
    read_manifest_directory_recovering_unlocked(directory)
}

fn read_manifest_recovering_unlocked(
    app: &AppHandle,
) -> Result<Option<StagedUpdateManifest>, String> {
    read_manifest_directory_recovering_unlocked(&update_dir(app)?)
}

fn installer_marker(name: &str) -> PathBuf {
    std::env::temp_dir().join(name)
}

#[tauri::command]
pub fn app_installer_close_request_pending() -> bool {
    installer_marker(INSTALLER_CLOSE_REQUEST_FILE).exists()
}

#[tauri::command]
pub fn app_installer_close_respond(accepted: bool) -> Result<(), String> {
    let response = installer_marker(if accepted {
        INSTALLER_CLOSE_ACCEPTED_FILE
    } else {
        INSTALLER_CLOSE_CANCELLED_FILE
    });
    fs::write(&response, if accepted { "accepted" } else { "cancelled" })
        .map_err(|error| format!("Impossible de répondre à l'installateur : {error}"))?;
    let request = installer_marker(INSTALLER_CLOSE_REQUEST_FILE);
    if request.exists() {
        fs::remove_file(request)
            .map_err(|error| format!("Impossible de terminer la demande de fermeture : {error}"))?;
    }
    Ok(())
}

fn verified_package(app: &AppHandle, manifest: &StagedUpdateManifest) -> Result<Vec<u8>, String> {
    let bytes = fs::read(package_path(app, &manifest.package_file)?)
        .map_err(|_| "UPDATE_PACKAGE_MISSING".to_string())?;
    if bytes.len() as u64 != manifest.package_size || package_digest(&bytes) != manifest.sha256 {
        return Err("UPDATE_PACKAGE_INVALID".to_string());
    }
    verify_update_signature(&bytes, &manifest.signature, updater_public_key(app)?)?;
    Ok(bytes)
}

fn mark_clean_shutdown(app: &AppHandle) -> Result<(), String> {
    let _state_guard = lock_update_state();
    let _file_guard = lock_update_directory(&update_dir(app)?)?;
    let marker_path = clean_shutdown_path(&app)?;
    let Some(manifest) = read_manifest_recovering_unlocked(&app)? else {
        return remove_file_if_present(&marker_path);
    };
    if !update_target_matches_channel(app, &manifest.target)? {
        return remove_file_if_present(&marker_path);
    }
    let marker = CleanShutdownMarker {
        current_version: app.package_info().version.to_string(),
        staged_version: manifest.version,
    };
    let bytes = serde_json::to_vec(&marker).map_err(|_| "UPDATE_STATE_INVALID".to_string())?;
    atomic_write(&marker_path, &bytes)
}

#[tauri::command]
pub fn app_update_exit_after_clean_shutdown(app: AppHandle) -> Result<(), String> {
    // A damaged update cache must never trap the user in an app they cannot close.
    // Failure to write the marker simply postpones activation until a later clean exit.
    let _ = mark_clean_shutdown(&app);
    app.exit(0);
    Ok(())
}

#[tauri::command]
pub fn app_exit_cleanly(app: AppHandle) -> Result<(), String> {
    let _state_guard = lock_update_state();
    let _file_guard = lock_update_directory(&update_dir(&app)?)?;
    remove_file_if_present(&clean_shutdown_path(&app)?)?;
    app.exit(0);
    Ok(())
}

fn consume_matching_clean_shutdown(
    app: &AppHandle,
    manifest: &StagedUpdateManifest,
    current_version: &str,
) -> Result<bool, String> {
    let path = clean_shutdown_path(app)?;
    if !path.exists() {
        return Ok(false);
    }
    let marker = fs::read(&path)
        .map_err(|_| "UPDATE_STATE_INVALID".to_string())
        .and_then(|bytes| {
            serde_json::from_slice::<CleanShutdownMarker>(&bytes)
                .map_err(|_| "UPDATE_STATE_INVALID".to_string())
        });
    remove_file_if_present(&path)?;
    let marker = marker?;
    Ok(clean_shutdown_matches(&marker, manifest, current_version))
}

#[tauri::command]
pub fn app_update_status(app: AppHandle) -> Result<AppUpdateSnapshot, String> {
    let _state_guard = lock_update_state();
    let _file_guard = lock_update_directory(&update_dir(&app)?)?;
    cleanup_installer_artifacts(&app);
    let current_version = app.package_info().version.to_string();
    let mut update = read_manifest_recovering_unlocked(&app)?;
    if let Some(item) = update.as_ref() {
        if !update_target_matches_channel(&app, &item.target)? {
            update = None;
        } else if !staged_update_belongs_to_current_install(item, &current_version) {
            clear_staged_update(&app)?;
            update = None;
        }
    }
    Ok(AppUpdateSnapshot {
        current_version,
        update,
    })
}

#[tauri::command]
pub async fn app_update_check_and_stage(
    app: AppHandle,
    target: String,
    allow_downgrades: bool,
) -> Result<AppUpdateSnapshot, String> {
    let current_version = app.package_info().version.to_string();
    if !update_target_matches_channel(&app, &target)? {
        return Err("UPDATE_CHANNEL_CHANGED".to_string());
    }
    let update_directory = update_dir(&app)?;
    let stage_generation = {
        let _state_guard = lock_update_state();
        let _file_guard = lock_update_directory(&update_directory)?;
        read_update_generation_directory(&update_directory)?
    };
    let mut builder = app
        .updater_builder()
        .target(target.clone())
        .timeout(CHECK_TIMEOUT);
    if allow_downgrades {
        builder = builder.version_comparator(|current, release| release.version != current);
    }
    let updater = builder.build().map_err(|error| error.to_string())?;
    let Some(update) = updater.check().await.map_err(|error| error.to_string())? else {
        let _state_guard = lock_update_state();
        let _file_guard = lock_update_directory(&update_directory)?;
        return Ok(AppUpdateSnapshot {
            current_version,
            update: read_manifest_recovering_unlocked(&app)?.filter(|manifest| {
                update_target_matches_channel(&app, &manifest.target).unwrap_or(false)
            }),
        });
    };

    let event_app = app.clone();
    let mut download_started = false;
    let bytes = update
        .download(
            move |chunk_length, content_length| {
                if !download_started {
                    download_started = true;
                    let _ = event_app.emit(
                        "app-update://download-progress",
                        DownloadProgressEvent::Started { content_length },
                    );
                }
                let _ = event_app.emit(
                    "app-update://download-progress",
                    DownloadProgressEvent::Progress { chunk_length },
                );
            },
            {
                let event_app = app.clone();
                move || {
                    let _ = event_app.emit(
                        "app-update://download-progress",
                        DownloadProgressEvent::Finished,
                    );
                }
            },
        )
        .await
        .map_err(|error| error.to_string())?;

    let package_size = bytes.len() as u64;
    let sha256 = package_digest(&bytes);
    let package_file = package_file_name(&update.version, &sha256);
    let manifest = StagedUpdateManifest {
        generation: String::new(),
        current_version: update.current_version.clone(),
        version: update.version.clone(),
        date: update.date.map(|value| value.to_string()),
        notes: update.body.unwrap_or_default(),
        target,
        package_file: package_file.clone(),
        signature: update.signature.clone(),
        sha256,
        package_size,
        phase: StagedUpdatePhase::Staged,
        activation_attempts: 0,
        error: None,
    };
    if !update_target_matches_channel(&app, &manifest.target)? {
        return Err("UPDATE_CHANNEL_CHANGED".to_string());
    }
    let manifest = publish_staged_update_directory_with_generation(
        &update_directory,
        &manifest,
        &bytes,
        Some(&stage_generation),
    )?;

    Ok(AppUpdateSnapshot {
        current_version,
        update: Some(manifest),
    })
}

#[tauri::command]
pub fn app_update_discard(app: AppHandle) -> Result<(), String> {
    let _state_guard = lock_update_state();
    let _file_guard = lock_update_directory(&update_dir(&app)?)?;
    clear_staged_update(&app)
}

#[tauri::command]
pub fn app_update_install_now(app: AppHandle) -> Result<(), String> {
    require_activation_started(activate_staged_update(&app, true)?)
}

fn require_activation_started(started: bool) -> Result<(), String> {
    if started {
        Ok(())
    } else {
        Err("UPDATE_STAGED_PACKAGE_MISSING".to_string())
    }
}

pub fn activate_staged_update(app: &AppHandle, force: bool) -> Result<bool, String> {
    if cfg!(debug_assertions) && !force {
        return Ok(false);
    }
    let _state_guard = lock_update_state();
    let _file_guard = lock_update_directory(&update_dir(app)?)?;
    let Some(mut manifest) = read_manifest_recovering_unlocked(app)? else {
        return Ok(false);
    };
    // A failed discard must not reactivate a package from the previous channel,
    // including startup activation before the frontend store exists.
    if !update_target_matches_channel(app, &manifest.target)? {
        return Ok(false);
    }
    let current_version = app.package_info().version.to_string();
    if !staged_update_belongs_to_current_install(&manifest, &current_version) {
        clear_staged_update(app)?;
        return Ok(false);
    }
    if !force && !consume_matching_clean_shutdown(app, &manifest, &current_version)? {
        return Ok(false);
    }
    if manifest.activation_attempts >= MAX_ACTIVATION_ATTEMPTS && !force {
        manifest.phase = StagedUpdatePhase::Failed;
        manifest.error = Some("L'installation a échoué à deux reprises.".to_string());
        write_manifest(app, &manifest)?;
        return Ok(false);
    }

    let bytes = match verified_package(app, &manifest) {
        Ok(bytes) => bytes,
        Err(error) => {
            manifest.phase = StagedUpdatePhase::Failed;
            manifest.error = Some(error.clone());
            write_manifest(app, &manifest)?;
            return Err(error);
        }
    };
    manifest.phase = StagedUpdatePhase::Activating;
    manifest.activation_attempts = manifest.activation_attempts.saturating_add(1);
    manifest.error = None;
    write_manifest(app, &manifest)?;

    match install_package(app, &manifest, &bytes) {
        Ok(()) => Ok(true),
        Err(error) => {
            manifest.phase = StagedUpdatePhase::Failed;
            manifest.error = Some(error.clone());
            write_manifest(app, &manifest)?;
            Err(error)
        }
    }
}

#[cfg(target_os = "windows")]
fn windows_product_version(path: &Path) -> Result<String, String> {
    use std::{ffi::c_void, os::windows::ffi::OsStrExt, ptr};
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW,
    };

    let path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut handle = 0;
    let size = unsafe { GetFileVersionInfoSizeW(path.as_ptr(), &mut handle) };
    if size == 0 {
        return Err("UPDATE_INSTALLER_VERSION_MISSING".to_string());
    }
    let mut data = vec![0_u8; size as usize];
    if unsafe { GetFileVersionInfoW(path.as_ptr(), 0, size, data.as_mut_ptr().cast::<c_void>()) }
        == 0
    {
        return Err("UPDATE_INSTALLER_VERSION_MISSING".to_string());
    }

    let translation_query: Vec<u16> = "\\VarFileInfo\\Translation\0".encode_utf16().collect();
    let mut translation = ptr::null_mut::<c_void>();
    let mut translation_size = 0;
    if unsafe {
        VerQueryValueW(
            data.as_ptr().cast::<c_void>(),
            translation_query.as_ptr(),
            &mut translation,
            &mut translation_size,
        )
    } == 0
        || translation_size < 4
    {
        return Err("UPDATE_INSTALLER_VERSION_MISSING".to_string());
    }
    let translation = unsafe { std::slice::from_raw_parts(translation.cast::<u16>(), 2) };
    let product_query: Vec<u16> = format!(
        "\\StringFileInfo\\{:04x}{:04x}\\ProductVersion\0",
        translation[0], translation[1]
    )
    .encode_utf16()
    .collect();
    let mut product_version = ptr::null_mut::<c_void>();
    let mut product_version_size = 0;
    if unsafe {
        VerQueryValueW(
            data.as_ptr().cast::<c_void>(),
            product_query.as_ptr(),
            &mut product_version,
            &mut product_version_size,
        )
    } == 0
        || product_version_size == 0
    {
        return Err("UPDATE_INSTALLER_VERSION_MISSING".to_string());
    }
    let value = unsafe {
        std::slice::from_raw_parts(product_version.cast::<u16>(), product_version_size as usize)
    };
    let version = String::from_utf16_lossy(value)
        .trim_matches('\0')
        .trim()
        .trim_start_matches('v')
        .to_string();
    if version.is_empty() {
        Err("UPDATE_INSTALLER_VERSION_MISSING".to_string())
    } else {
        Ok(version)
    }
}

fn installer_version_matches(declared: &str, embedded: &str) -> bool {
    let declared = declared.trim().trim_start_matches('v');
    let embedded = embedded.trim().trim_start_matches('v');
    embedded == declared || embedded.strip_suffix(".0") == Some(declared)
}

#[cfg(target_os = "windows")]
fn install_package(
    app: &AppHandle,
    manifest: &StagedUpdateManifest,
    bytes: &[u8],
) -> Result<(), String> {
    let directory = update_dir(app)?;
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Impossible de préparer l'installateur : {error}"))?;
    let installer_path = directory.join(format!("Macro-{}-setup.exe", manifest.version));

    if bytes.starts_with(b"PK\x03\x04") {
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
            .map_err(|error| format!("L'archive de mise à jour est illisible : {error}"))?;
        let mut found = false;
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index).map_err(|error| error.to_string())?;
            let Some(name) = entry.enclosed_name() else {
                continue;
            };
            if name.extension().and_then(|value| value.to_str()) != Some("exe") {
                continue;
            }
            let mut output = fs::File::create(&installer_path)
                .map_err(|error| format!("Impossible d'extraire l'installateur : {error}"))?;
            std::io::copy(&mut entry, &mut output)
                .map_err(|error| format!("Impossible d'extraire l'installateur : {error}"))?;
            output.sync_all().map_err(|error| error.to_string())?;
            found = true;
            break;
        }
        if !found {
            return Err("L'archive ne contient aucun installateur Macro.".to_string());
        }
    } else if bytes.starts_with(b"MZ") {
        atomic_write(&installer_path, bytes)?;
    } else {
        return Err("Le format du paquet de mise à jour n'est pas pris en charge.".to_string());
    }

    let embedded_version = windows_product_version(&installer_path)?;
    if !installer_version_matches(&manifest.version, &embedded_version) {
        let _ = fs::remove_file(&installer_path);
        return Err("UPDATE_INSTALLER_VERSION_MISMATCH".to_string());
    }

    background_command(&installer_path)
        .args(["/S", "/R", "/UPDATE"])
        .spawn()
        .map_err(|error| format!("Impossible de lancer l'installation silencieuse : {error}"))?;
    app.exit(0);
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn install_package(
    app: &AppHandle,
    manifest: &StagedUpdateManifest,
    bytes: &[u8],
) -> Result<(), String> {
    let updater = app
        .updater_builder()
        .target(manifest.target.clone())
        .build()
        .map_err(|error| error.to_string())?;
    let update = updater
        .update_from_release(staged_release(manifest)?)
        .map_err(|error| error.to_string())?;
    finish_local_install(
        || update.install(bytes).map_err(|error| error.to_string()),
        || clear_staged_update(app),
        || app.restart(),
    )
}

#[cfg(not(target_os = "windows"))]
fn staged_release(
    manifest: &StagedUpdateManifest,
) -> Result<tauri_plugin_updater::RemoteRelease, String> {
    // Installation only consumes verified local bytes. This URL is never requested.
    serde_json::from_value(serde_json::json!({
        "version": manifest.version,
        "notes": manifest.notes,
        "url": "https://cached-update.invalid/unused",
        "signature": manifest.signature,
    }))
    .map_err(|error| format!("UPDATE_STATE_INVALID: {error}"))
}

#[cfg(not(target_os = "windows"))]
fn finish_local_install(
    install: impl FnOnce() -> Result<(), String>,
    cleanup: impl FnOnce() -> Result<(), String>,
    restart: impl FnOnce(),
) -> Result<(), String> {
    install()?;
    // Once replacement has committed, cleanup must not turn success into failure.
    // On the next launch, the version check invalidates any remaining old cache.
    if let Err(error) = cleanup() {
        tracing::warn!("Update installed; cache cleanup will be retried: {error}");
    }
    restart();
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn persisted_channel_blocks_old_packages_after_failed_invalidation_and_restart() {
        let profile = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        assert!(
            super::target_matches_persisted_channel(profile.path(), "stable-windows-x86_64")
                .unwrap()
        );
        assert!(
            !super::target_matches_persisted_channel(profile.path(), "windows-x86_64").unwrap()
        );
        let mut old_manifest = manifest("0.1.0", "0.1.1");
        old_manifest.target = "stable-windows-x86_64".to_string();
        std::fs::write(
            cache.path().join(super::MANIFEST_FILE),
            serde_json::to_vec(&old_manifest).unwrap(),
        )
        .unwrap();
        // A failure at the first reset write leaves the old manifest untouched.
        std::fs::create_dir(cache.path().join(super::UPDATE_GENERATION_FILE)).unwrap();
        std::fs::write(
            profile.path().join("state.json"),
            br#"{"schemaVersion":1,"values":{"updateChannel":"preview"}}"#,
        )
        .unwrap();
        assert!(super::invalidate_and_clear_staged_update_directory(cache.path()).is_err());
        let recovered = read_manifest_file(&cache.path().join(super::MANIFEST_FILE))
            .unwrap()
            .unwrap();
        assert!(
            !super::target_matches_persisted_channel(profile.path(), &recovered.target).unwrap()
        );
        // Fresh reads use durable state, with no frontend or in-memory blocker.
        assert!(
            !super::target_matches_persisted_channel(profile.path(), "stable-windows-x86_64")
                .unwrap()
        );
        assert!(
            super::target_matches_persisted_channel(profile.path(), "preview-windows-x86_64")
                .unwrap()
        );
        std::fs::write(profile.path().join("state.json"), b"corrupt").unwrap();
        assert!(
            super::target_matches_persisted_channel(profile.path(), "stable-windows-x86_64")
                .is_err()
        );
        std::fs::write(
            profile.path().join("state.json"),
            br#"{"schemaVersion":2,"values":{"updateChannel":"stable"}}"#,
        )
        .unwrap();
        assert!(
            super::target_matches_persisted_channel(profile.path(), "stable-windows-x86_64")
                .is_err()
        );
    }

    #[test]
    fn forced_activation_requires_a_staged_package() {
        assert_eq!(
            super::require_activation_started(false),
            Err("UPDATE_STAGED_PACKAGE_MISSING".into())
        );
        assert_eq!(super::require_activation_started(true), Ok(()));
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn committed_install_restarts_even_when_cleanup_fails() {
        let calls = std::cell::RefCell::new(Vec::new());
        super::finish_local_install(
            || {
                calls.borrow_mut().push("install");
                Ok(())
            },
            || {
                calls.borrow_mut().push("cleanup");
                Err("permission denied".into())
            },
            || calls.borrow_mut().push("restart"),
        )
        .unwrap();
        assert_eq!(*calls.borrow(), vec!["install", "cleanup", "restart"]);
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn committed_install_restarts_after_each_cache_cleanup_failure() {
        for blocked in [
            super::MANIFEST_FILE,
            super::PUBLICATION_BACKUP_FILE,
            super::CLEAN_SHUTDOWN_FILE,
            "staged-update-blocked.bin",
        ] {
            let directory = tempfile::tempdir().unwrap();
            std::fs::create_dir(directory.path().join(blocked)).unwrap();
            let restarted = std::cell::Cell::new(false);
            super::finish_local_install(
                || Ok(()),
                || super::invalidate_and_clear_staged_update_directory(directory.path()),
                || restarted.set(true),
            )
            .unwrap();
            assert!(
                restarted.get(),
                "cleanup failure at {blocked} prevented restart"
            );
            std::fs::remove_dir(directory.path().join(blocked)).unwrap();
            super::invalidate_and_clear_staged_update_directory(directory.path()).unwrap();
        }
    }

    #[test]
    fn absent_manifest_retries_orphan_cleanup_without_blocking_status() {
        let directory = tempfile::tempdir().unwrap();
        let marker = directory.path().join(super::CLEAN_SHUTDOWN_FILE);
        std::fs::create_dir(&marker).unwrap();
        assert!(super::read_manifest_directory_recovering(directory.path())
            .unwrap()
            .is_none());
        std::fs::remove_dir(&marker).unwrap();
        std::fs::write(&marker, b"synthetic").unwrap();
        let package = directory.path().join("staged-update-orphan.bin");
        std::fs::write(&package, b"synthetic").unwrap();
        assert!(super::read_manifest_directory_recovering(directory.path())
            .unwrap()
            .is_none());
        assert!(!marker.exists());
        assert!(!package.exists());
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn staged_release_preserves_the_verified_package_metadata() {
        let staged = manifest("1.0.0", "1.1.0");
        let release = super::staged_release(&staged).unwrap();
        assert_eq!(release.version.to_string(), staged.version);
        assert_eq!(
            release.signature(&staged.target).unwrap(),
            &staged.signature
        );
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn failed_install_preserves_cache_and_does_not_restart() {
        assert_eq!(
            super::finish_local_install(
                || Err("installer rejected".into()),
                || panic!("must retain cache"),
                || panic!("must not restart"),
            ),
            Err("installer rejected".into())
        );
    }

    use crate::core::process::background_command;
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
    use std::time::Duration;

    use super::{
        atomic_write, atomic_write_with, clean_shutdown_matches, clear_staged_update_directory,
        install_fail_after_manifest_publication, install_fail_after_package_publication,
        install_publication_after_manifest_hook, invalidate_and_clear_staged_update_directory,
        lock_update_directory, package_digest, package_file_name, persist_temporary_file,
        publish_staged_update_directory, publish_staged_update_directory_with_generation,
        read_manifest_directory_recovering, read_manifest_file, read_update_generation_directory,
        staged_update_belongs_to_current_install, sync_parent_directory, verify_update_signature,
        write_update_generation_directory, CleanShutdownMarker, DownloadProgressEvent,
        StagedUpdateManifest, StagedUpdatePhase,
    };

    const TEST_PUBLIC_KEY: &str = "untrusted comment: minisign public key E7620F1842B4E81F\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
    const TEST_SIGNATURE: &str = "untrusted comment: signature from minisign secret key\nRUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\ntrusted comment: timestamp:1556193335\tfile:test\ny/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==";

    fn manifest(from: &str, to: &str) -> StagedUpdateManifest {
        StagedUpdateManifest {
            generation: String::new(),
            current_version: from.to_string(),
            version: to.to_string(),
            date: None,
            notes: String::new(),
            target: "windows-x86_64".to_string(),
            package_file: "staged-update-test.bin".to_string(),
            signature: String::new(),
            sha256: String::new(),
            package_size: 0,
            phase: StagedUpdatePhase::Staged,
            activation_attempts: 0,
            error: None,
        }
    }

    #[test]
    fn package_digest_is_stable() {
        assert_eq!(
            package_digest(b"macro"),
            "27d66c0dcef19a926429158d80111b954a5c23d076833347da3e27b91e4b423d"
        );
    }

    #[test]
    fn atomic_write_replaces_the_previous_file() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("manifest.json");
        std::fs::write(&path, b"old-state").unwrap();

        atomic_write(&path, b"new-state").unwrap();

        assert_eq!(std::fs::read(&path).unwrap(), b"new-state");
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn atomic_write_keeps_the_previous_file_when_replacement_fails() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("manifest.json");
        std::fs::write(&path, b"usable-old-state").unwrap();

        let result = atomic_write_with(
            &path,
            b"new-state",
            |_temporary, _destination| Err("simulated replacement failure".to_string()),
            sync_parent_directory,
        );

        assert_eq!(result, Err("simulated replacement failure".to_string()));
        assert_eq!(std::fs::read(&path).unwrap(), b"usable-old-state");
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn atomic_write_preserves_previous_file_on_native_replacement_failure() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("manifest.json");
        std::fs::write(&path, b"usable-old-state").unwrap();

        #[cfg(unix)]
        let result = {
            use std::os::unix::fs::PermissionsExt;
            let original_mode = std::fs::metadata(directory.path())
                .unwrap()
                .permissions()
                .mode();
            atomic_write_with(
                &path,
                b"new-state",
                |temporary, destination| {
                    std::fs::set_permissions(
                        directory.path(),
                        std::fs::Permissions::from_mode(0o500),
                    )
                    .unwrap();
                    match temporary.persist(destination) {
                        Ok(_) => {
                            std::fs::set_permissions(
                                directory.path(),
                                std::fs::Permissions::from_mode(original_mode),
                            )
                            .unwrap();
                            Ok(())
                        }
                        Err(error) => {
                            std::fs::set_permissions(
                                directory.path(),
                                std::fs::Permissions::from_mode(original_mode),
                            )
                            .unwrap();
                            let message =
                                format!("Impossible de finaliser la mise à jour : {}", error.error);
                            drop(error);
                            Err(message)
                        }
                    }
                },
                sync_parent_directory,
            )
        };

        #[cfg(windows)]
        let result = {
            use std::os::windows::fs::OpenOptionsExt;
            let locked = std::fs::OpenOptions::new()
                .read(true)
                .share_mode(0)
                .open(&path)
                .unwrap();
            let result = atomic_write_with(
                &path,
                b"new-state",
                persist_temporary_file,
                sync_parent_directory,
            );
            drop(locked);
            result
        };

        assert!(result.is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"usable-old-state");
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn atomic_write_keeps_committed_state_when_directory_sync_is_uncertain() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("manifest.json");
        std::fs::write(&path, b"old-state").unwrap();

        let result = atomic_write_with(&path, b"new-state", persist_temporary_file, |_parent| {
            Err("simulated directory sync failure".to_string())
        });

        assert_eq!(result, Ok(()));
        assert_eq!(std::fs::read(&path).unwrap(), b"new-state");
    }

    #[test]
    fn progress_events_use_frontend_field_names() {
        assert_eq!(
            serde_json::to_value(DownloadProgressEvent::Started {
                content_length: Some(42),
            })
            .unwrap(),
            serde_json::json!({ "type": "started", "contentLength": 42 })
        );
        assert_eq!(
            serde_json::to_value(DownloadProgressEvent::Progress { chunk_length: 7 }).unwrap(),
            serde_json::json!({ "type": "progress", "chunkLength": 7 })
        );
    }

    #[test]
    fn signature_is_rechecked_and_rejects_tampering() {
        let public_key = BASE64.encode(TEST_PUBLIC_KEY);
        let signature = BASE64.encode(TEST_SIGNATURE);
        assert!(verify_update_signature(b"test", &signature, &public_key).is_ok());
        assert_eq!(
            verify_update_signature(b"tampered", &signature, &public_key),
            Err("UPDATE_SIGNATURE_INVALID".to_string())
        );
    }

    #[test]
    fn staged_update_cannot_replace_a_different_manual_install() {
        let staged = manifest("1.2.0", "1.3.0");
        assert!(staged_update_belongs_to_current_install(&staged, "1.2.0"));
        assert!(!staged_update_belongs_to_current_install(&staged, "1.4.0"));
        assert!(!staged_update_belongs_to_current_install(&staged, "1.3.0"));
    }

    #[test]
    fn clean_shutdown_marker_must_match_the_staged_update() {
        let staged = manifest("1.2.0", "1.3.0");
        let matching = CleanShutdownMarker {
            current_version: "1.2.0".to_string(),
            staged_version: "1.3.0".to_string(),
        };
        let stale = CleanShutdownMarker {
            current_version: "1.1.0".to_string(),
            staged_version: "1.3.0".to_string(),
        };
        assert!(clean_shutdown_matches(&matching, &staged, "1.2.0"));
        assert!(!clean_shutdown_matches(&stale, &staged, "1.2.0"));
    }

    #[test]
    fn corrupt_manifest_cache_can_be_cleared_without_leaving_a_package_or_marker() {
        let directory = std::env::temp_dir().join(format!(
            "macro-update-corrupt-manifest-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let manifest_path = directory.join(super::MANIFEST_FILE);
        let package_path = directory.join("staged-update-corrupt.bin");
        let marker_path = directory.join(super::CLEAN_SHUTDOWN_FILE);
        std::fs::write(&manifest_path, b"{\"version\":").unwrap();
        std::fs::write(&package_path, b"package").unwrap();
        std::fs::write(&marker_path, b"marker").unwrap();

        assert!(read_manifest_file(&manifest_path).is_err());
        clear_staged_update_directory(&directory).unwrap();
        assert!(!manifest_path.exists());
        assert!(!package_path.exists());
        assert!(!marker_path.exists());

        std::fs::remove_dir(&directory).unwrap();
    }

    #[test]
    fn concurrent_atomic_writes_do_not_share_a_partial_file() {
        let temp = tempfile::tempdir().expect("tempdir");
        let target = temp.path().join("staged-update.bin");
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
        let mut writers = Vec::new();
        for value in 0_u8..8 {
            let target = target.clone();
            let barrier = barrier.clone();
            writers.push(std::thread::spawn(move || {
                let bytes = vec![value; 256 * 1024];
                barrier.wait();
                atomic_write(&target, &bytes)
            }));
        }

        for writer in writers {
            writer.join().expect("writer thread").expect("atomic write");
        }

        let persisted = std::fs::read(&target).expect("persisted update");
        assert_eq!(persisted.len(), 256 * 1024);
        assert!(persisted.iter().all(|byte| *byte == persisted[0]));
        assert!(std::fs::read_dir(temp.path())
            .expect("update directory")
            .flatten()
            .all(|entry| !entry.file_name().to_string_lossy().ends_with(".part")));
    }

    #[test]
    fn concurrent_publications_keep_the_manifest_and_package_together() {
        let temp = tempfile::tempdir().expect("tempdir");
        let first_bytes = vec![1_u8; 128 * 1024];
        let second_bytes = vec![2_u8; 128 * 1024];
        let mut first_manifest = manifest("1.0.0", "1.1.0");
        first_manifest.package_file = "staged-update-1.1.0.bin".to_string();
        first_manifest.package_size = first_bytes.len() as u64;
        first_manifest.sha256 = package_digest(&first_bytes);
        let mut second_manifest = manifest("1.0.0", "1.2.0");
        second_manifest.package_file = "staged-update-1.2.0.bin".to_string();
        second_manifest.package_size = second_bytes.len() as u64;
        second_manifest.sha256 = package_digest(&second_bytes);

        let reached = std::sync::Arc::new(std::sync::Barrier::new(2));
        let release = std::sync::Arc::new(std::sync::Barrier::new(2));
        install_publication_after_manifest_hook(
            first_manifest.package_file.clone(),
            reached.clone(),
            release.clone(),
        );

        let first_directory = temp.path().to_path_buf();
        let first = std::thread::spawn(move || {
            publish_staged_update_directory(&first_directory, &first_manifest, &first_bytes)
        });
        reached.wait();

        let second_directory = temp.path().to_path_buf();
        let (finished_tx, finished_rx) = std::sync::mpsc::channel();
        let second = std::thread::spawn(move || {
            let result =
                publish_staged_update_directory(&second_directory, &second_manifest, &second_bytes);
            finished_tx.send(result.clone()).expect("send result");
            result
        });

        assert!(matches!(
            finished_rx.recv_timeout(Duration::from_millis(150)),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
        ));
        release.wait();
        first
            .join()
            .expect("first publication thread")
            .expect("first publication");
        finished_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("second publication result")
            .expect("second publication");
        second
            .join()
            .expect("second publication thread")
            .expect("second publication");

        let persisted_manifest = read_manifest_file(&temp.path().join(super::MANIFEST_FILE))
            .expect("read final manifest")
            .expect("final manifest");
        assert_eq!(persisted_manifest.version, "1.2.0");
        let persisted_package = std::fs::read(temp.path().join(&persisted_manifest.package_file))
            .expect("manifest package");
        assert_eq!(
            persisted_package.len() as u64,
            persisted_manifest.package_size
        );
        assert_eq!(
            package_digest(&persisted_package),
            persisted_manifest.sha256
        );
        assert!(!temp.path().join("staged-update-1.1.0.bin").exists());
    }

    #[test]
    fn discard_invalidates_a_publication_that_started_before_it() {
        let temp = tempfile::tempdir().expect("tempdir");
        let directory = temp.path().to_path_buf();
        let bytes = b"downloaded before discard".to_vec();
        let digest = package_digest(&bytes);
        let mut staged_manifest = manifest("1.0.0", "1.1.0");
        staged_manifest.package_file = package_file_name("1.1.0", &digest);
        staged_manifest.package_size = bytes.len() as u64;
        staged_manifest.sha256 = digest;
        let started_generation =
            read_update_generation_directory(&directory).expect("initial generation");
        let reached = std::sync::Arc::new(std::sync::Barrier::new(2));
        let release = std::sync::Arc::new(std::sync::Barrier::new(2));

        let publish_directory = directory.clone();
        let publish_reached = reached.clone();
        let publish_release = release.clone();
        let publication = std::thread::spawn(move || {
            publish_reached.wait();
            publish_release.wait();
            publish_staged_update_directory_with_generation(
                &publish_directory,
                &staged_manifest,
                &bytes,
                Some(&started_generation),
            )
        });

        reached.wait();
        {
            let _state_guard = super::lock_update_state();
            let _file_guard = lock_update_directory(&directory).expect("lock update directory");
            invalidate_and_clear_staged_update_directory(&directory).expect("discard update");
        }
        release.wait();

        assert!(matches!(
            publication.join().expect("publication thread"),
            Err(error) if error == "UPDATE_STAGE_CANCELLED"
        ));
        assert!(!directory.join(super::MANIFEST_FILE).exists());
        assert!(!directory.join("staged-update-1.1.0.bin").exists());
    }

    #[test]
    fn successful_publication_fences_an_older_download() {
        let temp = tempfile::tempdir().expect("tempdir");
        let started_generation =
            read_update_generation_directory(temp.path()).expect("initial generation");

        let newer_bytes = b"newer download".to_vec();
        let newer_digest = package_digest(&newer_bytes);
        let mut newer_manifest = manifest("1.0.0", "1.2.0");
        newer_manifest.package_file = package_file_name("1.2.0", &newer_digest);
        newer_manifest.package_size = newer_bytes.len() as u64;
        newer_manifest.sha256 = newer_digest;
        let published = publish_staged_update_directory_with_generation(
            temp.path(),
            &newer_manifest,
            &newer_bytes,
            Some(&started_generation),
        )
        .expect("publish newer download");

        let older_bytes = b"older slow download".to_vec();
        let older_digest = package_digest(&older_bytes);
        let mut older_manifest = manifest("1.0.0", "1.1.0");
        older_manifest.package_file = package_file_name("1.1.0", &older_digest);
        older_manifest.package_size = older_bytes.len() as u64;
        older_manifest.sha256 = older_digest;
        assert!(matches!(
            publish_staged_update_directory_with_generation(
                temp.path(),
                &older_manifest,
                &older_bytes,
                Some(&started_generation),
            ),
            Err(error) if error == "UPDATE_STAGE_CANCELLED"
        ));

        assert_eq!(
            read_update_generation_directory(temp.path()).expect("published generation"),
            published.generation
        );
        let persisted = read_manifest_directory_recovering(temp.path())
            .expect("read staged update")
            .expect("newer update remains staged");
        assert_eq!(persisted.version, "1.2.0");
        assert_eq!(persisted.generation, published.generation);
        assert!(!temp.path().join(&older_manifest.package_file).exists());
    }

    #[test]
    fn generation_advance_hides_a_manifest_left_by_interrupted_discard() {
        let temp = tempfile::tempdir().expect("tempdir");
        let bytes = b"abandoned staged update".to_vec();
        let digest = package_digest(&bytes);
        let mut staged_manifest = manifest("1.0.0", "1.1.0");
        staged_manifest.package_file = package_file_name("1.1.0", &digest);
        staged_manifest.package_size = bytes.len() as u64;
        staged_manifest.sha256 = digest;
        let published = publish_staged_update_directory(temp.path(), &staged_manifest, &bytes)
            .expect("publish staged update");

        let discarded_generation = uuid::Uuid::new_v4().to_string();
        write_update_generation_directory(temp.path(), &discarded_generation)
            .expect("persist discard generation before cleanup");
        assert!(temp.path().join(super::MANIFEST_FILE).exists());
        assert_ne!(published.generation, discarded_generation);

        assert!(read_manifest_directory_recovering(temp.path())
            .expect("recover interrupted discard")
            .is_none());
        assert!(!temp.path().join(super::MANIFEST_FILE).exists());
        assert!(!temp.path().join(&staged_manifest.package_file).exists());
    }

    #[test]
    fn update_directory_lock_child() {
        let Ok(directory) = std::env::var("MACRO_TEST_UPDATE_LOCK_DIRECTORY") else {
            return;
        };
        let directory = std::path::PathBuf::from(directory);
        std::fs::write(directory.join("child-started"), b"started").expect("signal child start");
        let _guard = lock_update_directory(&directory).expect("child update lock");
        std::fs::write(directory.join("child-acquired"), b"acquired")
            .expect("signal child acquisition");
    }

    #[test]
    fn update_directory_lock_serializes_an_independent_process() {
        let temp = tempfile::tempdir().expect("tempdir");
        let guard = lock_update_directory(temp.path()).expect("parent update lock");
        let mut child =
            background_command(std::env::current_exe().expect("current test executable"))
                .args([
                    "--exact",
                    "app_updates::tests::update_directory_lock_child",
                    "--nocapture",
                ])
                .env("MACRO_TEST_UPDATE_LOCK_DIRECTORY", temp.path())
                .spawn()
                .expect("spawn independent updater client");
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !temp.path().join("child-started").exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(temp.path().join("child-started").exists());
        std::thread::sleep(Duration::from_millis(150));
        assert!(!temp.path().join("child-acquired").exists());

        drop(guard);
        let status = child.wait().expect("wait for independent updater client");
        assert!(status.success());
        assert!(temp.path().join("child-acquired").exists());
    }

    #[test]
    fn failed_package_publication_keeps_the_previous_manifest_valid() {
        let temp = tempfile::tempdir().expect("tempdir");
        let old_bytes = b"old package".to_vec();
        let old_digest = package_digest(&old_bytes);
        let mut old_manifest = manifest("1.0.0", "1.1.0");
        old_manifest.package_file = package_file_name("1.1.0", &old_digest);
        old_manifest.package_size = old_bytes.len() as u64;
        old_manifest.sha256 = old_digest;
        publish_staged_update_directory(temp.path(), &old_manifest, &old_bytes)
            .expect("publish old update");

        let new_bytes = b"new package".to_vec();
        let new_digest = package_digest(&new_bytes);
        let mut new_manifest = manifest("1.0.0", "1.2.0");
        new_manifest.package_file = package_file_name("1.2.0", &new_digest);
        new_manifest.package_size = new_bytes.len() as u64;
        new_manifest.sha256 = new_digest;
        install_fail_after_package_publication(new_manifest.package_file.clone());

        let error = publish_staged_update_directory(temp.path(), &new_manifest, &new_bytes)
            .expect_err("injected publication failure");
        assert_eq!(error, "injected failure after package publication");

        let persisted_manifest = read_manifest_file(&temp.path().join(super::MANIFEST_FILE))
            .expect("read previous manifest")
            .expect("previous manifest");
        assert_eq!(persisted_manifest.version, "1.1.0");
        let persisted_package = std::fs::read(temp.path().join(&persisted_manifest.package_file))
            .expect("previous package");
        assert_eq!(
            package_digest(&persisted_package),
            persisted_manifest.sha256
        );

        publish_staged_update_directory(temp.path(), &new_manifest, &new_bytes)
            .expect("retry new update");
        let retried_manifest = read_manifest_file(&temp.path().join(super::MANIFEST_FILE))
            .expect("read retried manifest")
            .expect("retried manifest");
        assert_eq!(retried_manifest.version, "1.2.0");
        assert!(temp.path().join(&retried_manifest.package_file).exists());
        assert!(!temp.path().join(&old_manifest.package_file).exists());
    }

    #[test]
    fn interrupted_manifest_publication_restores_the_previous_generation() {
        let temp = tempfile::tempdir().expect("tempdir");
        let old_bytes = b"old package".to_vec();
        let old_digest = package_digest(&old_bytes);
        let mut old_manifest = manifest("1.0.0", "1.1.0");
        old_manifest.package_file = package_file_name("1.1.0", &old_digest);
        old_manifest.package_size = old_bytes.len() as u64;
        old_manifest.sha256 = old_digest;
        let published_old = publish_staged_update_directory(temp.path(), &old_manifest, &old_bytes)
            .expect("publish old update");

        let new_bytes = b"new package".to_vec();
        let new_digest = package_digest(&new_bytes);
        let mut new_manifest = manifest("1.0.0", "1.2.0");
        new_manifest.package_file = package_file_name("1.2.0", &new_digest);
        new_manifest.package_size = new_bytes.len() as u64;
        new_manifest.sha256 = new_digest;
        install_fail_after_manifest_publication(new_manifest.package_file.clone());

        let error = publish_staged_update_directory(temp.path(), &new_manifest, &new_bytes)
            .expect_err("injected manifest publication failure");
        assert_eq!(error, "injected failure after manifest publication");
        assert!(temp.path().join(super::PUBLICATION_BACKUP_FILE).exists());

        let recovered = read_manifest_directory_recovering(temp.path())
            .expect("recover interrupted publication")
            .expect("previous update remains staged");
        assert_eq!(recovered.generation, published_old.generation);
        assert_eq!(recovered.version, "1.1.0");
        assert!(temp.path().join(&old_manifest.package_file).exists());
        assert!(!temp.path().join(&new_manifest.package_file).exists());
        assert!(!temp.path().join(super::PUBLICATION_BACKUP_FILE).exists());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn embedded_installer_version_must_match_the_release() {
        assert!(super::installer_version_matches("1.2.3", "1.2.3"));
        assert!(super::installer_version_matches("1.2.3", "1.2.3.0"));
        assert!(!super::installer_version_matches("2.0.0", "1.2.3"));
        assert!(!super::installer_version_matches(
            "1.2.3-beta.2",
            "1.2.3-beta.1"
        ));
    }
}
