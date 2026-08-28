use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use minisign_verify::{PublicKey, Signature};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Cursor, Write},
    path::{Path, PathBuf},
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;

const UPDATE_DIRECTORY: &str = "app-updates";
const MANIFEST_FILE: &str = "staged-update.json";
const CLEAN_SHUTDOWN_FILE: &str = "clean-shutdown.json";
const MAX_ACTIVATION_ATTEMPTS: u8 = 2;
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
const INSTALLER_CLOSE_REQUEST_FILE: &str = "macro-installer-close.request";
const INSTALLER_CLOSE_ACCEPTED_FILE: &str = "macro-installer-close.accepted";
const INSTALLER_CLOSE_CANCELLED_FILE: &str = "macro-installer-close.cancelled";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum StagedUpdatePhase {
    Staged,
    Activating,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedUpdateManifest {
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

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Le chemin de mise à jour est invalide.".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Impossible de créer le cache des mises à jour : {error}"))?;
    let temporary = path.with_extension("part");
    {
        let mut file = fs::File::create(&temporary)
            .map_err(|error| format!("Impossible de préparer la mise à jour : {error}"))?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| format!("Impossible d'enregistrer la mise à jour : {error}"))?;
    }
    if path.exists() {
        fs::remove_file(path)
            .map_err(|error| format!("Impossible de remplacer l'ancienne mise à jour : {error}"))?;
    }
    fs::rename(&temporary, path)
        .map_err(|error| format!("Impossible de finaliser la mise à jour : {error}"))
}

fn write_manifest(app: &AppHandle, manifest: &StagedUpdateManifest) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(manifest)
        .map_err(|error| format!("Impossible d'enregistrer l'état de la mise à jour : {error}"))?;
    atomic_write(&manifest_path(app)?, &bytes)
}

fn package_digest(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn package_file_name(version: &str) -> String {
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
    format!("staged-update-{safe_version}.bin")
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

fn clear_staged_update(app: &AppHandle) -> Result<(), String> {
    let directory = update_dir(app)?;
    clear_staged_update_directory(&directory)?;
    cleanup_installer_artifacts(app);
    Ok(())
}

fn read_manifest_recovering(app: &AppHandle) -> Result<Option<StagedUpdateManifest>, String> {
    match read_manifest(app) {
        Ok(manifest) => Ok(manifest),
        Err(_) => {
            clear_staged_update(app)?;
            Ok(None)
        }
    }
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
    let marker_path = clean_shutdown_path(&app)?;
    let Some(manifest) = read_manifest_recovering(&app)? else {
        return remove_file_if_present(&marker_path);
    };
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
    cleanup_installer_artifacts(&app);
    let current_version = app.package_info().version.to_string();
    let mut update = read_manifest_recovering(&app)?;
    if let Some(item) = update.as_ref() {
        if !staged_update_belongs_to_current_install(item, &current_version) {
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
    let mut builder = app
        .updater_builder()
        .target(target.clone())
        .timeout(CHECK_TIMEOUT);
    if allow_downgrades {
        builder = builder.version_comparator(|current, release| release.version != current);
    }
    let updater = builder.build().map_err(|error| error.to_string())?;
    let Some(update) = updater.check().await.map_err(|error| error.to_string())? else {
        return Ok(AppUpdateSnapshot {
            current_version,
            update: read_manifest_recovering(&app)?,
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
    let package_file = package_file_name(&update.version);
    let manifest = StagedUpdateManifest {
        current_version: update.current_version.clone(),
        version: update.version.clone(),
        date: update.date.map(|value| value.to_string()),
        notes: update.body.unwrap_or_default(),
        target,
        package_file: package_file.clone(),
        signature: update.signature.clone(),
        sha256: package_digest(&bytes),
        package_size,
        phase: StagedUpdatePhase::Staged,
        activation_attempts: 0,
        error: None,
    };
    atomic_write(&package_path(&app, &package_file)?, &bytes)?;
    write_manifest(&app, &manifest)?;

    if let Ok(entries) = fs::read_dir(update_dir(&app)?) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with("staged-update-") && name.ends_with(".bin") && name != package_file
            {
                let _ = fs::remove_file(entry.path());
            }
        }
    }

    Ok(AppUpdateSnapshot {
        current_version,
        update: Some(manifest),
    })
}

#[tauri::command]
pub fn app_update_discard(app: AppHandle) -> Result<(), String> {
    clear_staged_update(&app)
}

#[tauri::command]
pub fn app_update_install_now(app: AppHandle) -> Result<(), String> {
    activate_staged_update(&app, true).map(|_| ())
}

pub fn activate_staged_update(app: &AppHandle, force: bool) -> Result<bool, String> {
    if cfg!(debug_assertions) && !force {
        return Ok(false);
    }
    let Some(mut manifest) = read_manifest_recovering(app)? else {
        return Ok(false);
    };
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
    use std::os::windows::process::CommandExt;

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

    std::process::Command::new(&installer_path)
        .args(["/S", "/R", "/UPDATE"])
        .creation_flags(0x0800_0000)
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
    let mut builder = app
        .updater_builder()
        .target(manifest.target.clone())
        .timeout(CHECK_TIMEOUT)
        .version_comparator(|current, release| release.version != current);
    let updater = builder.build().map_err(|error| error.to_string())?;
    let update = tauri::async_runtime::block_on(updater.check())
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "La version préparée n'est plus disponible.".to_string())?;
    if update.version != manifest.version {
        return Err("La version préparée ne correspond plus à la version publiée.".to_string());
    }
    update.install(bytes).map_err(|error| error.to_string())?;
    clear_staged_update(app)?;
    app.restart();
}

#[cfg(test)]
mod tests {
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};

    use super::{
        clean_shutdown_matches, clear_staged_update_directory, package_digest, read_manifest_file,
        staged_update_belongs_to_current_install, verify_update_signature, CleanShutdownMarker,
        DownloadProgressEvent, StagedUpdateManifest, StagedUpdatePhase,
    };

    const TEST_PUBLIC_KEY: &str = "untrusted comment: minisign public key E7620F1842B4E81F\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
    const TEST_SIGNATURE: &str = "untrusted comment: signature from minisign secret key\nRUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\ntrusted comment: timestamp:1556193335\tfile:test\ny/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==";

    fn manifest(from: &str, to: &str) -> StagedUpdateManifest {
        StagedUpdateManifest {
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
