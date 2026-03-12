use keyring::Entry;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use tracing::{debug, warn};

const SERVICE_NAME: &str = "macro";
pub(super) const SECRET_CHUNK_SIZE_BYTES: usize = 2400;
pub(super) const WINDOWS_CREDENTIAL_BLOB_LIMIT_BYTES: usize = 2560;
static KEYRING_UNAVAILABLE: AtomicBool = AtomicBool::new(false);

#[derive(Debug, thiserror::Error)]
pub enum SecretError {
    #[error("Keyring error: {0}")]
    Keyring(#[from] keyring::Error),
    #[error("Secret serialization error: {0}")]
    Serde(#[from] serde_json::Error),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ChatGptSecret {
    pub access_token: String,
    pub refresh_token: String,
    pub access_token_expires_at: Option<String>,
    pub account_id: Option<String>,
    pub auth_source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(super) struct LegacyChatGptSecret {
    pub(super) access_token: String,
    pub(super) refresh_token: String,
    pub(super) id_token: String,
    pub(super) account_id: Option<String>,
    pub(super) client_id: Option<String>,
    pub(super) last_refresh: Option<String>,
    pub(super) source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct SecretEnvelope<T> {
    pub(super) version: u8,
    pub(super) kind: String,
    pub(super) payload: T,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(super) struct ChunkedSecretPayload {
    pub(super) parts: usize,
    pub(super) generation: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum SecretStorageProfile {
    Utf8Bytes,
    WindowsCredentialBlob,
}

pub(super) trait SecretStore {
    fn read_entry(&self, entry_id: &str) -> Result<Option<String>, keyring::Error>;
    fn write_entry(&self, entry_id: &str, value: &str) -> Result<(), keyring::Error>;
    fn delete_entry(&self, entry_id: &str) -> Result<(), keyring::Error>;
}

#[derive(Debug, Clone, Copy)]
pub(super) struct KeyringSecretStore;

impl SecretStore for KeyringSecretStore {
    fn read_entry(&self, entry_id: &str) -> Result<Option<String>, keyring::Error> {
        if KEYRING_UNAVAILABLE.load(Ordering::Relaxed) {
            return Ok(None);
        }

        let entry = Entry::new(SERVICE_NAME, entry_id)?;
        match entry.get_password() {
            Ok(password) => Ok(Some(password)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) if is_unavailable_error(&error) => {
                mark_unavailable_once();
                Ok(None)
            }
            Err(error) => Err(error),
        }
    }

    fn write_entry(&self, entry_id: &str, value: &str) -> Result<(), keyring::Error> {
        if KEYRING_UNAVAILABLE.load(Ordering::Relaxed) {
            return Ok(());
        }

        let entry = Entry::new(SERVICE_NAME, entry_id)?;
        match entry.set_password(value) {
            Ok(_) => Ok(()),
            Err(error) if is_unavailable_error(&error) => {
                mark_unavailable_once();
                Ok(())
            }
            Err(error) => Err(error),
        }
    }

    fn delete_entry(&self, entry_id: &str) -> Result<(), keyring::Error> {
        if KEYRING_UNAVAILABLE.load(Ordering::Relaxed) {
            return Ok(());
        }

        let entry = Entry::new(SERVICE_NAME, entry_id)?;
        match entry.delete_password() {
            Ok(_) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) if is_unavailable_error(&error) => {
                mark_unavailable_once();
                Ok(())
            }
            Err(error) => Err(error),
        }
    }
}

fn is_unavailable_error(error: &keyring::Error) -> bool {
    let message = error.to_string().to_lowercase();
    message.contains("serviceunknown")
        || message.contains("not activatable")
        || message.contains("secret service")
        || message.contains("platform secure storage failure")
}

fn mark_unavailable_once() {
    if !KEYRING_UNAVAILABLE.swap(true, Ordering::Relaxed) {
        warn!("Keyring unavailable, secret persistence disabled for this session");
    }
}

pub(super) fn read_secret(provider_id: &str) -> Result<Option<String>, keyring::Error> {
    let store = KeyringSecretStore;
    store.read_entry(provider_id)
}

pub(super) fn write_secret(provider_id: &str, value: &str) -> Result<(), keyring::Error> {
    let store = KeyringSecretStore;
    store.write_entry(provider_id, value)
}

pub(super) fn delete_secret_entry(provider_id: &str) -> Result<(), keyring::Error> {
    let store = KeyringSecretStore;
    store.delete_entry(provider_id)
}

pub(super) fn chunk_secret_entry_id(provider_id: &str, index: usize) -> String {
    format!("{provider_id}::chunk::{index}")
}

pub(super) fn generated_chunk_secret_entry_id(
    provider_id: &str,
    generation: &str,
    index: usize,
) -> String {
    format!("{provider_id}::chunk::{generation}::{index}")
}

pub(super) fn active_storage_profile() -> SecretStorageProfile {
    if cfg!(target_os = "windows") {
        SecretStorageProfile::WindowsCredentialBlob
    } else {
        SecretStorageProfile::Utf8Bytes
    }
}

pub(super) fn storage_limit_bytes(profile: SecretStorageProfile) -> usize {
    match profile {
        SecretStorageProfile::Utf8Bytes => SECRET_CHUNK_SIZE_BYTES,
        SecretStorageProfile::WindowsCredentialBlob => WINDOWS_CREDENTIAL_BLOB_LIMIT_BYTES,
    }
}

pub(super) fn storage_size_bytes(value: &str, profile: SecretStorageProfile) -> usize {
    match profile {
        SecretStorageProfile::Utf8Bytes => value.len(),
        SecretStorageProfile::WindowsCredentialBlob => value.encode_utf16().count() * 2,
    }
}

fn char_storage_size_bytes(ch: char, profile: SecretStorageProfile) -> usize {
    match profile {
        SecretStorageProfile::Utf8Bytes => ch.len_utf8(),
        SecretStorageProfile::WindowsCredentialBlob => ch.len_utf16() * 2,
    }
}

pub(super) fn split_by_storage_limit(value: &str, profile: SecretStorageProfile) -> Vec<String> {
    let max_bytes = storage_limit_bytes(profile);
    let mut chunks = Vec::new();
    let mut start = 0usize;
    let mut current_bytes = 0usize;

    for (index, ch) in value.char_indices() {
        let char_len = char_storage_size_bytes(ch, profile);
        if current_bytes + char_len > max_bytes && index > start {
            chunks.push(value[start..index].to_string());
            start = index;
            current_bytes = 0;
        }
        current_bytes += char_len;
    }

    if start < value.len() {
        chunks.push(value[start..].to_string());
    }

    if chunks.is_empty() {
        chunks.push(String::new());
    }

    chunks
}

pub(super) fn parse_chunked_manifest(secret: &str) -> Option<SecretEnvelope<ChunkedSecretPayload>> {
    let manifest = serde_json::from_str::<SecretEnvelope<ChunkedSecretPayload>>(secret).ok()?;
    if manifest.kind.ends_with("_chunked") {
        Some(manifest)
    } else {
        None
    }
}

pub(super) fn read_chunked_secret<S: SecretStore>(
    store: &S,
    provider_id: &str,
    payload: &ChunkedSecretPayload,
) -> Result<Option<String>, SecretError> {
    let mut combined = String::new();

    for index in 0..payload.parts {
        let entry_id = match payload.generation.as_deref() {
            Some(generation) => generated_chunk_secret_entry_id(provider_id, generation, index),
            None => chunk_secret_entry_id(provider_id, index),
        };
        let Some(chunk) = store.read_entry(&entry_id)? else {
            return Ok(None);
        };
        combined.push_str(&chunk);
    }

    Ok(Some(combined))
}

pub(super) fn delete_chunked_secret<S: SecretStore>(
    store: &S,
    provider_id: &str,
    payload: &ChunkedSecretPayload,
) -> Result<(), SecretError> {
    for index in 0..payload.parts {
        let entry_id = match payload.generation.as_deref() {
            Some(generation) => generated_chunk_secret_entry_id(provider_id, generation, index),
            None => chunk_secret_entry_id(provider_id, index),
        };
        store.delete_entry(&entry_id)?;
    }

    Ok(())
}

pub(super) fn delete_legacy_chunked_secret_best_effort<S: SecretStore>(
    store: &S,
    provider_id: &str,
) -> Result<(), SecretError> {
    for index in 0.. {
        let entry_id = chunk_secret_entry_id(provider_id, index);
        let Some(_) = store.read_entry(&entry_id)? else {
            break;
        };
        store.delete_entry(&entry_id)?;
    }

    Ok(())
}

pub(super) fn cleanup_chunk_entries_best_effort<S: SecretStore>(
    store: &S,
    provider_id: &str,
    entry_ids: &[String],
    phase: &str,
) {
    for entry_id in entry_ids {
        if let Err(error) = store.delete_entry(entry_id) {
            warn!(
                provider_id = %provider_id,
                phase,
                entry_id = %entry_id,
                error = %error,
                "failed to delete ChatGPT secret chunk during cleanup"
            );
        }
    }
}

pub(super) fn cleanup_previous_chunked_secret_best_effort<S: SecretStore>(
    store: &S,
    provider_id: &str,
    previous_manifest: Option<&ChunkedSecretPayload>,
) {
    let Some(previous_manifest) = previous_manifest else {
        return;
    };

    debug!(
        provider_id = %provider_id,
        phase = "cleanup_old_chunks",
        previous_parts = previous_manifest.parts,
        previous_generation = previous_manifest.generation.as_deref().unwrap_or("legacy"),
        "cleaning up previous ChatGPT secret chunks"
    );

    if let Err(error) = delete_chunked_secret(store, provider_id, previous_manifest) {
        warn!(
            provider_id = %provider_id,
            phase = "cleanup_old_chunks",
            error = %error,
            "failed to delete previous ChatGPT secret chunks"
        );
    }
}

pub(super) fn parse_chatgpt_secret(serialized: &str) -> Result<Option<ChatGptSecret>, SecretError> {
    if let Ok(envelope) = serde_json::from_str::<SecretEnvelope<ChatGptSecret>>(serialized) {
        if envelope.version == 2 && envelope.kind == "chatgpt_session" {
            return Ok(Some(envelope.payload));
        }
    }

    if let Ok(envelope) = serde_json::from_str::<SecretEnvelope<LegacyChatGptSecret>>(serialized) {
        if envelope.version == 1 && envelope.kind == "chatgpt" {
            return Ok(Some(ChatGptSecret {
                access_token: envelope.payload.access_token,
                refresh_token: envelope.payload.refresh_token,
                access_token_expires_at: None,
                account_id: envelope.payload.account_id,
                auth_source: envelope.payload.source,
            }));
        }
    }

    Ok(None)
}
