//! Pilot credentials: native ownership, silent access and explicit recovery.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::{Arc, OnceLock};
use tauri::Emitter;

mod flow;
#[cfg(target_os = "macos")]
mod lifecycle;
mod manager;
mod native;
#[cfg(any(target_os = "macos", test))]
mod session;
#[cfg(test)]
mod tests;
pub(crate) mod transport;

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
    fn silent_capture_supported(&self) -> bool {
        false
    }
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
    tracing::info!(identifier = %app.config().identifier, version = env!("CARGO_PKG_VERSION"),
        debug_build = cfg!(debug_assertions), "Macro Connect credential build identity");
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

pub fn suspend(reason: &'static str) {
    if let Some(manager) = MANAGER.get() {
        manager.suspend_for(reason, false);
    }
}

async fn blocking<T: Send + 'static>(
    operation: impl FnOnce() -> Result<T, PilotSecretError> + Send + 'static,
) -> Result<T, PilotSecretError> {
    crate::secrets::blocking::run(operation)
        .await
        .map_err(|_| PilotSecretError::VaultUnavailable)?
}

#[tauri::command]
pub async fn pilot_vault_activate(
    context: PilotVaultContext,
    generation: Option<String>,
) -> Result<VaultLease, PilotSecretError> {
    let manager = manager()?;
    blocking(move || manager.activate(context, generation.as_deref())).await
}

#[tauri::command]
pub async fn pilot_vault_invalidate(
    generation: Option<String>,
) -> Result<VaultLease, PilotSecretError> {
    let manager = manager()?;
    blocking(move || manager.invalidate(generation.as_deref())).await
}

#[tauri::command]
pub async fn pilot_vault_resume(
    scopes: Vec<PilotSecretScope>,
    generation: String,
) -> Result<VaultLease, PilotSecretError> {
    let manager = manager()?;
    blocking(move || {
        let result = manager.resume(&scopes, &generation);
        tracing::info!(mode = "explicit", result = ?result.as_ref().map(|lease| lease.status),
            "Macro Connect credential recovery");
        result
    })
    .await
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

#[cfg(test)]
pub(crate) fn qualification_backup_context(
    actual: &serde_json::Value,
    original_id: &str,
    attached: bool,
) {
    tests::qualification_backup_context(actual, original_id, attached);
}

/// Connection identifiers are intent only. Native /me and pair preflight still
/// establish account, producer identity and current rights from the relay.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TransferConnectionInput {
    context: PilotVaultContext,
    generation: String,
    instance_creation_id: String,
    account_id: String,
    device_id: String,
    instance_id: String,
    capabilities: Vec<String>,
}
impl TransferConnectionInput {
    fn intent(self) -> transport::Intent {
        transport::Intent {
            context: self.context,
            generation: self.generation,
            instance_creation_id: self.instance_creation_id,
            account_id: Some(self.account_id),
            device_id: Some(self.device_id),
            scope: transport::Scope::Producer {
                instance_id: self.instance_id,
            },
            capabilities: self.capabilities,
        }
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TransferSendInput {
    connection: TransferConnectionInput,
    target_instance_id: String,
    conversation_id: String,
    runtime: String,
    inspection_handle: String,
    provider_id: String,
    model_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TransferReceiveInput {
    connection: TransferConnectionInput,
}

#[tauri::command]
pub(crate) async fn connect_transfer_send(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    pool: tauri::State<'_, crate::core::db_state::DbPool>,
    config: tauri::State<'_, crate::config::ConfigManager>,
    runtime: tauri::State<'_, crate::connect::TransferRuntime>,
    admission: tauri::State<'_, crate::db::chat_admission::runtime::ChatAdmissionRuntime>,
    input: TransferSendInput,
) -> super::CommandResult<String> {
    let launcher = runtime
        .codec_launcher(&app, &pool)
        .map_err(super::command_error)?;
    send_transfer(
        manager().map_err(|_| super::command_error("vault_unavailable"))?,
        None,
        &pool,
        &config,
        &runtime,
        &launcher,
        &admission,
        window.label(),
        input,
    )
    .await
}

/// Body of `connect_transfer_send`, with the vault and relay address explicit.
async fn send_transfer<B: Vault + 'static>(
    manager: Arc<Manager<B>>,
    loopback: Option<std::net::SocketAddr>,
    pool: &crate::core::db_state::DbPool,
    config: &crate::config::ConfigManager,
    runtime: &crate::connect::TransferRuntime,
    launcher: &crate::connect::runtime::CodecLauncher,
    admission: &crate::db::chat_admission::runtime::ChatAdmissionRuntime,
    window: &str,
    input: TransferSendInput,
) -> super::CommandResult<String> {
    use super::command_error;
    let _job = runtime.begin_transfer().map_err(command_error)?;
    let ready = pool.wait_until_ready_context().await?;
    let result = async {
        let mut verified = transport::bootstrap(
            manager.clone(),
            input.connection.intent(),
            runtime,
            launcher,
            &ready,
            loopback,
            &tokio_util::sync::CancellationToken::new(),
        )
        .await?;
        verified
            .controller_for(manager.clone(), &ready, &input.target_instance_id)
            .await?;
        let verified = Arc::new(verified);
        let result = flow::send(
            manager,
            pool,
            admission,
            config,
            launcher,
            &verified,
            &ready,
            window,
            &input.runtime,
            &input.inspection_handle,
            &input.conversation_id,
            &input.provider_id,
            &input.model_id,
        )
        .await;
        Arc::try_unwrap(verified)
            .map_err(|_| "transport_retained")?
            .close()
            .await?;
        result
    }
    .await;
    if result.is_err() {
        runtime.revoke();
    }
    result.map_err(command_error)
}

#[tauri::command]
pub(crate) async fn connect_transfer_receive(
    app: tauri::AppHandle,
    pool: tauri::State<'_, crate::core::db_state::DbPool>,
    config: tauri::State<'_, crate::config::ConfigManager>,
    runtime: tauri::State<'_, crate::connect::TransferRuntime>,
    input: TransferReceiveInput,
) -> super::CommandResult<String> {
    let launcher = runtime
        .codec_launcher(&app, &pool)
        .map_err(super::command_error)?;
    receive_transfer(
        manager().map_err(|_| super::command_error("vault_unavailable"))?,
        None,
        &pool,
        &config,
        &runtime,
        &launcher,
        input,
    )
    .await
}

/// Body of `connect_transfer_receive`, with the vault and relay address explicit.
async fn receive_transfer<B: Vault + 'static>(
    manager: Arc<Manager<B>>,
    loopback: Option<std::net::SocketAddr>,
    pool: &crate::core::db_state::DbPool,
    config: &crate::config::ConfigManager,
    runtime: &crate::connect::TransferRuntime,
    launcher: &crate::connect::runtime::CodecLauncher,
    input: TransferReceiveInput,
) -> super::CommandResult<String> {
    use super::command_error;
    let job = runtime.begin_receive().map_err(command_error)?;
    let ready = pool.wait_until_ready_context().await?;
    let result: Result<String, &'static str> = async {
        let verified = transport::bootstrap(
            manager.clone(),
            input.connection.intent(),
            runtime,
            launcher,
            &ready,
            loopback,
            &tokio_util::sync::CancellationToken::new(),
        )
        .await?;
        let (conversation, _prepared) =
            flow::receive(manager, pool, config, launcher, verified, &ready, &job).await?;
        Ok(conversation)
    }
    .await;
    if result.is_err() {
        runtime.revoke();
    }
    result.map_err(command_error)
}

#[tauri::command]
pub(crate) fn connect_transfer_interrupt_idle(
    runtime: tauri::State<'_, crate::connect::TransferRuntime>,
) -> super::CommandResult<()> {
    runtime.interrupt_idle().map_err(super::command_error)
}
