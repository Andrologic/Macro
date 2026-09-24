//! Pilot credentials: native ownership, silent access and explicit recovery.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::{Arc, OnceLock};
use tauri::Emitter;

#[cfg(target_os = "macos")]
mod lifecycle;
mod manager;
mod native;
#[cfg(test)]
mod tests;

use manager::Manager;
use native::SystemVault;

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PilotSecretKind {
    SessionToken,
    InstanceKey,
    ClaimSecret,
    PollSecret,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PilotSecretScope {
    pub configuration_id: String,
    pub relay_origin: String,
    pub kind: PilotSecretKind,
    pub resource_id: String,
}

#[derive(Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PilotVaultContext {
    pub configuration_id: String,
    pub relay_origin: String,
    pub owner_id: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PilotSecretError {
    InvalidScope,
    InvalidSecret,
    VaultUnavailable,
    InterventionRequired,
    Cancelled,
    ContextChanged,
    Suspended,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VaultStatus {
    Ready,
    InterventionRequired,
    Cancelled,
    Suspended,
    VaultUnavailable,
}

#[derive(Clone, Debug, Serialize)]
pub struct VaultLease {
    pub generation: String,
    pub status: VaultStatus,
}

fn valid_id(value: &str) -> bool {
    (8..=128).contains(&value.len())
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
}

fn entry_name(scope: &PilotSecretScope) -> Result<String, PilotSecretError> {
    if !valid_id(&scope.configuration_id) || !valid_id(&scope.resource_id) {
        return Err(PilotSecretError::InvalidScope);
    }
    let origin =
        reqwest::Url::parse(&scope.relay_origin).map_err(|_| PilotSecretError::InvalidScope)?;
    if origin.scheme() != "https"
        || origin.host_str().is_none()
        || !origin.username().is_empty()
        || origin.password().is_some()
        || origin.query().is_some()
        || origin.fragment().is_some()
        || origin.path() != "/"
    {
        return Err(PilotSecretError::InvalidScope);
    }
    // A structured tuple prevents separator collisions; the hash keeps keychain
    // labels bounded and avoids disclosing relay/instance names in the OS UI.
    let tuple = serde_json::to_vec(&(
        &scope.configuration_id,
        origin.origin().ascii_serialization(),
        scope.kind,
        &scope.resource_id,
    ))
    .map_err(|_| PilotSecretError::InvalidScope)?;
    Ok(format!("v1:{:x}", Sha256::digest(tuple)))
}

fn validate_secret(secret: &str) -> Result<(), PilotSecretError> {
    // 256 bits, canonical base64url without padding. Length alone is insufficient:
    // the unused low bits of the last character must also be zero.
    if secret.len() != 43 {
        return Err(PilotSecretError::InvalidSecret);
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(secret)
        .map_err(|_| PilotSecretError::InvalidSecret)?;
    if bytes.len() != 32 || URL_SAFE_NO_PAD.encode(&bytes) != secret {
        return Err(PilotSecretError::InvalidSecret);
    }
    Ok(())
}

pub(super) trait Vault: Send + Sync {
    fn prepare_resume(&self, _kind: PilotSecretKind) -> Result<(), PilotSecretError> {
        Ok(())
    }
    fn read(
        &self,
        key: &str,
        kind: PilotSecretKind,
        interactive: bool,
    ) -> Result<Option<String>, PilotSecretError>;
    fn write(&self, key: &str, kind: PilotSecretKind, secret: &str)
        -> Result<(), PilotSecretError>;
    fn delete(&self, key: &str, kind: PilotSecretKind) -> Result<(), PilotSecretError>;
}

static MANAGER: OnceLock<Arc<Manager<SystemVault>>> = OnceLock::new();
static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

pub fn setup(app: &tauri::AppHandle) {
    // The namespace is native configuration, never an IPC argument. There is no
    // fallback to production credentials from another application identity.
    let service = native::service_for_identifier(&app.config().identifier);
    let _ = APP.set(app.clone());
    let _ = MANAGER.set(Arc::new(Manager::new(SystemVault::new(service))));
    #[cfg(target_os = "macos")]
    lifecycle::install();
}

fn manager() -> Result<Arc<Manager<SystemVault>>, PilotSecretError> {
    MANAGER
        .get()
        .cloned()
        .ok_or(PilotSecretError::VaultUnavailable)
}

pub(super) fn emit(lease: &VaultLease) {
    if let Some(app) = APP.get() {
        let _ = app.emit("pilot-vault-state", lease);
    }
}

pub fn suspend() {
    if let Some(manager) = MANAGER.get() {
        manager.suspend();
    }
}

async fn blocking<T: Send + 'static>(
    operation: impl FnOnce() -> Result<T, PilotSecretError> + Send + 'static,
) -> Result<T, PilotSecretError> {
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|_| PilotSecretError::VaultUnavailable)?
}

#[tauri::command]
pub fn pilot_vault_activate(
    context: PilotVaultContext,
    generation: Option<String>,
) -> Result<VaultLease, PilotSecretError> {
    manager()?.activate(context, generation.as_deref())
}

#[tauri::command]
pub fn pilot_vault_invalidate(generation: Option<String>) -> Result<VaultLease, PilotSecretError> {
    manager()?.invalidate(generation.as_deref())
}

#[tauri::command]
pub async fn pilot_vault_resume(
    scopes: Vec<PilotSecretScope>,
    generation: String,
) -> Result<VaultLease, PilotSecretError> {
    let manager = manager()?;
    blocking(move || manager.resume(&scopes, &generation)).await
}

#[tauri::command]
pub async fn pilot_secret_read(
    scope: PilotSecretScope,
    generation: String,
) -> Result<Option<String>, PilotSecretError> {
    let manager = manager()?;
    blocking(move || manager.read(&scope, &generation)).await
}

#[tauri::command]
pub async fn pilot_secret_write(
    scope: PilotSecretScope,
    secret: String,
    generation: String,
) -> Result<(), PilotSecretError> {
    let manager = manager()?;
    blocking(move || manager.write(&scope, &generation, &secret)).await
}

#[tauri::command]
pub async fn pilot_secret_delete(
    scope: PilotSecretScope,
    generation: String,
) -> Result<(), PilotSecretError> {
    let manager = manager()?;
    blocking(move || manager.delete(&scope, &generation)).await
}
