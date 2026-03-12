use super::store::{
    chunk_secret_entry_id, cleanup_chunk_entries_best_effort,
    cleanup_previous_chunked_secret_best_effort, delete_chunked_secret,
    delete_legacy_chunked_secret_best_effort, generated_chunk_secret_entry_id,
    parse_chatgpt_secret, parse_chunked_manifest, read_chunked_secret, split_by_storage_limit,
    storage_limit_bytes, storage_size_bytes, ChunkedSecretPayload, LegacyChatGptSecret,
    SecretEnvelope, SecretStorageProfile, SecretStore, SECRET_CHUNK_SIZE_BYTES,
    WINDOWS_CREDENTIAL_BLOB_LIMIT_BYTES,
};
use super::{ChatGptSecret, SecretError};
use keyring::Error;
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

#[derive(Default)]
struct InMemorySecretStore {
    entries: Mutex<HashMap<String, String>>,
    fail_writes_once: Mutex<HashSet<String>>,
}

impl InMemorySecretStore {
    fn fail_next_write(&self, entry_id: &str) {
        self.fail_writes_once
            .lock()
            .expect("fail_writes_once lock")
            .insert(entry_id.to_string());
    }

    fn get(&self, entry_id: &str) -> Option<String> {
        self.entries
            .lock()
            .expect("entries lock")
            .get(entry_id)
            .cloned()
    }
}

impl SecretStore for InMemorySecretStore {
    fn read_entry(&self, entry_id: &str) -> Result<Option<String>, keyring::Error> {
        Ok(self
            .entries
            .lock()
            .expect("entries lock")
            .get(entry_id)
            .cloned())
    }

    fn write_entry(&self, entry_id: &str, value: &str) -> Result<(), keyring::Error> {
        if self
            .fail_writes_once
            .lock()
            .expect("fail_writes_once lock")
            .remove(entry_id)
        {
            return Err(Error::Invalid(
                "mock".to_string(),
                format!("write failed for {entry_id}"),
            ));
        }

        self.entries
            .lock()
            .expect("entries lock")
            .insert(entry_id.to_string(), value.to_string());
        Ok(())
    }

    fn delete_entry(&self, entry_id: &str) -> Result<(), keyring::Error> {
        self.entries.lock().expect("entries lock").remove(entry_id);
        Ok(())
    }
}

fn set_chatgpt_secret_with_store(
    store: &InMemorySecretStore,
    provider_id: &str,
    secret: &ChatGptSecret,
    profile: SecretStorageProfile,
    generation: &str,
) -> Result<(), SecretError> {
    let envelope = SecretEnvelope {
        version: 2,
        kind: "chatgpt_session".to_string(),
        payload: secret.clone(),
    };
    let serialized = serde_json::to_string(&envelope).expect("serialize");
    let previous_root = store.read_entry(provider_id)?;
    let previous_manifest = previous_root
        .as_deref()
        .and_then(parse_chunked_manifest)
        .map(|manifest| manifest.payload);

    if storage_size_bytes(&serialized, profile) <= storage_limit_bytes(profile) {
        store.write_entry(provider_id, &serialized)?;
        cleanup_previous_chunked_secret_best_effort(store, provider_id, previous_manifest.as_ref());
        return Ok(());
    }

    let chunks = split_by_storage_limit(&serialized, profile);
    let chunk_entry_ids = (0..chunks.len())
        .map(|index| generated_chunk_secret_entry_id(provider_id, generation, index))
        .collect::<Vec<_>>();
    let mut written_chunk_ids = Vec::new();

    for (entry_id, chunk) in chunk_entry_ids.iter().zip(chunks.iter()) {
        if let Err(error) = store.write_entry(entry_id, chunk) {
            cleanup_chunk_entries_best_effort(
                store,
                provider_id,
                &written_chunk_ids,
                "rollback_new_chunks",
            );
            return Err(error.into());
        }
        written_chunk_ids.push(entry_id.clone());
    }

    let manifest = SecretEnvelope {
        version: 2,
        kind: "chatgpt_session_chunked".to_string(),
        payload: ChunkedSecretPayload {
            parts: chunks.len(),
            generation: Some(generation.to_string()),
        },
    };
    let manifest_serialized = serde_json::to_string(&manifest).expect("serialize manifest");
    if let Err(error) = store.write_entry(provider_id, &manifest_serialized) {
        cleanup_chunk_entries_best_effort(
            store,
            provider_id,
            &chunk_entry_ids,
            "rollback_new_chunks",
        );
        return Err(error.into());
    }

    cleanup_previous_chunked_secret_best_effort(store, provider_id, previous_manifest.as_ref());
    Ok(())
}

fn get_chatgpt_secret_with_store(
    store: &InMemorySecretStore,
    provider_id: &str,
) -> Result<Option<ChatGptSecret>, SecretError> {
    let Some(secret) = store.read_entry(provider_id)? else {
        return Ok(None);
    };

    if let Some(parsed) = parse_chatgpt_secret(&secret)? {
        return Ok(Some(parsed));
    }

    if let Some(manifest) = parse_chunked_manifest(&secret) {
        let Some(serialized) = read_chunked_secret(store, provider_id, &manifest.payload)? else {
            return Ok(None);
        };
        return parse_chatgpt_secret(&serialized);
    }

    Ok(None)
}

fn delete_provider_secret_with_store(
    store: &InMemorySecretStore,
    provider_id: &str,
) -> Result<(), SecretError> {
    if let Some(secret) = store.read_entry(provider_id)? {
        if let Some(manifest) = parse_chunked_manifest(&secret) {
            delete_chunked_secret(store, provider_id, &manifest.payload)?;
        }
    }

    delete_legacy_chunked_secret_best_effort(store, provider_id)?;
    store.delete_entry(provider_id)?;
    Ok(())
}

fn large_chatgpt_secret() -> ChatGptSecret {
    ChatGptSecret {
        access_token: "a".repeat(3000),
        refresh_token: "b".repeat(3000),
        access_token_expires_at: Some("2026-03-10T00:00:00Z".to_string()),
        account_id: Some("acct".to_string()),
        auth_source: "browser".to_string(),
    }
}

#[test]
fn chatgpt_secret_envelope_roundtrip() {
    let secret = ChatGptSecret {
        access_token: "access".to_string(),
        refresh_token: "refresh".to_string(),
        access_token_expires_at: Some("2026-03-10T00:00:00Z".to_string()),
        account_id: Some("acct".to_string()),
        auth_source: "browser".to_string(),
    };

    let encoded = serde_json::to_string(&SecretEnvelope {
        version: 2,
        kind: "chatgpt_session".to_string(),
        payload: secret.clone(),
    })
    .expect("serialize");
    let decoded: SecretEnvelope<ChatGptSecret> =
        serde_json::from_str(&encoded).expect("deserialize");

    assert_eq!(decoded.version, 2);
    assert_eq!(decoded.kind, "chatgpt_session");
    assert_eq!(decoded.payload, secret);
}

#[test]
fn legacy_secret_can_be_deserialized() {
    let legacy = LegacyChatGptSecret {
        access_token: "access".to_string(),
        refresh_token: "refresh".to_string(),
        id_token: "id".to_string(),
        account_id: Some("acct".to_string()),
        client_id: Some("client".to_string()),
        last_refresh: Some("2026-03-10T00:00:00Z".to_string()),
        source: "codex".to_string(),
    };
    let encoded = serde_json::to_string(&SecretEnvelope {
        version: 1,
        kind: "chatgpt".to_string(),
        payload: legacy,
    })
    .expect("serialize");

    let decoded: SecretEnvelope<LegacyChatGptSecret> =
        serde_json::from_str(&encoded).expect("deserialize");

    assert_eq!(decoded.version, 1);
    assert_eq!(decoded.kind, "chatgpt");
    assert_eq!(decoded.payload.account_id.as_deref(), Some("acct"));
}

#[test]
fn windows_storage_profile_detects_2400_ascii_as_too_large() {
    let value = "a".repeat(2400);

    assert_eq!(
        storage_size_bytes(&value, SecretStorageProfile::WindowsCredentialBlob),
        4800
    );
    assert!(
        storage_size_bytes(&value, SecretStorageProfile::WindowsCredentialBlob)
            > storage_limit_bytes(SecretStorageProfile::WindowsCredentialBlob)
    );
    assert_eq!(
        storage_limit_bytes(SecretStorageProfile::WindowsCredentialBlob),
        WINDOWS_CREDENTIAL_BLOB_LIMIT_BYTES
    );
}

#[test]
fn split_by_storage_limit_preserves_content_for_windows_profile() {
    let value = "a".repeat(SECRET_CHUNK_SIZE_BYTES * 2 + 17);
    let chunks = split_by_storage_limit(&value, SecretStorageProfile::WindowsCredentialBlob);

    assert!(chunks.len() >= 3);
    assert!(chunks.iter().all(|chunk| {
        storage_size_bytes(chunk, SecretStorageProfile::WindowsCredentialBlob)
            <= storage_limit_bytes(SecretStorageProfile::WindowsCredentialBlob)
    }));
    assert_eq!(chunks.concat(), value);
}

#[test]
fn chunk_manifest_roundtrip() {
    let manifest = SecretEnvelope {
        version: 2,
        kind: "chatgpt_session_chunked".to_string(),
        payload: ChunkedSecretPayload {
            parts: 3,
            generation: Some("gen-123".to_string()),
        },
    };

    let encoded = serde_json::to_string(&manifest).expect("serialize");
    let decoded: SecretEnvelope<ChunkedSecretPayload> =
        serde_json::from_str(&encoded).expect("deserialize");

    assert_eq!(decoded.kind, "chatgpt_session_chunked");
    assert_eq!(decoded.payload.parts, 3);
    assert_eq!(decoded.payload.generation.as_deref(), Some("gen-123"));
}

#[test]
fn legacy_chunk_manifest_without_generation_is_still_supported() {
    let encoded = r#"{"version":2,"kind":"chatgpt_session_chunked","payload":{"parts":2}}"#;
    let decoded: SecretEnvelope<ChunkedSecretPayload> =
        serde_json::from_str(encoded).expect("deserialize");

    assert_eq!(decoded.payload.parts, 2);
    assert_eq!(decoded.payload.generation, None);
}

#[test]
fn staged_write_failure_keeps_existing_secret_readable() {
    let store = InMemorySecretStore::default();
    let provider_id = "chatgpt";
    let existing_secret = ChatGptSecret {
        access_token: "existing-access".to_string(),
        refresh_token: "existing-refresh".to_string(),
        access_token_expires_at: Some("2026-03-10T00:00:00Z".to_string()),
        account_id: Some("acct-existing".to_string()),
        auth_source: "browser".to_string(),
    };
    let new_secret = large_chatgpt_secret();

    set_chatgpt_secret_with_store(
        &store,
        provider_id,
        &existing_secret,
        SecretStorageProfile::Utf8Bytes,
        "gen-old",
    )
    .expect("write existing");

    store.fail_next_write(provider_id);
    let error = set_chatgpt_secret_with_store(
        &store,
        provider_id,
        &new_secret,
        SecretStorageProfile::WindowsCredentialBlob,
        "gen-new",
    )
    .expect_err("manifest write should fail");
    assert!(matches!(error, SecretError::Keyring(_)));

    let persisted = get_chatgpt_secret_with_store(&store, provider_id)
        .expect("read persisted")
        .expect("existing secret remains");
    assert_eq!(persisted, existing_secret);
    assert!(store
        .get(&generated_chunk_secret_entry_id(provider_id, "gen-new", 0))
        .is_none());
}

#[test]
fn successful_swap_cleans_up_previous_legacy_chunks() {
    let store = InMemorySecretStore::default();
    let provider_id = "chatgpt";
    let old_secret = large_chatgpt_secret();
    let old_envelope = SecretEnvelope {
        version: 2,
        kind: "chatgpt_session".to_string(),
        payload: old_secret,
    };
    let old_serialized = serde_json::to_string(&old_envelope).expect("serialize");
    let old_chunks = split_by_storage_limit(&old_serialized, SecretStorageProfile::Utf8Bytes);
    for (index, chunk) in old_chunks.iter().enumerate() {
        store
            .write_entry(&chunk_secret_entry_id(provider_id, index), chunk)
            .expect("write legacy chunk");
    }
    let old_manifest = SecretEnvelope {
        version: 2,
        kind: "chatgpt_session_chunked".to_string(),
        payload: ChunkedSecretPayload {
            parts: old_chunks.len(),
            generation: None,
        },
    };
    store
        .write_entry(
            provider_id,
            &serde_json::to_string(&old_manifest).expect("serialize old manifest"),
        )
        .expect("write old manifest");

    let new_secret = ChatGptSecret {
        access_token: "access".to_string(),
        refresh_token: "refresh".to_string(),
        access_token_expires_at: Some("2026-03-10T00:00:00Z".to_string()),
        account_id: Some("acct".to_string()),
        auth_source: "browser".to_string(),
    };
    set_chatgpt_secret_with_store(
        &store,
        provider_id,
        &new_secret,
        SecretStorageProfile::Utf8Bytes,
        "gen-new",
    )
    .expect("write new secret");

    assert!(store.get(&chunk_secret_entry_id(provider_id, 0)).is_none());
    let persisted = get_chatgpt_secret_with_store(&store, provider_id)
        .expect("read new secret")
        .expect("new secret exists");
    assert_eq!(persisted, new_secret);
}

#[test]
fn delete_provider_secret_removes_new_and_legacy_chunks() {
    let store = InMemorySecretStore::default();
    let provider_id = "chatgpt";
    let secret = large_chatgpt_secret();

    set_chatgpt_secret_with_store(
        &store,
        provider_id,
        &secret,
        SecretStorageProfile::WindowsCredentialBlob,
        "gen-current",
    )
    .expect("write current chunked secret");
    store
        .write_entry(&chunk_secret_entry_id(provider_id, 0), "legacy")
        .expect("write legacy chunk");

    delete_provider_secret_with_store(&store, provider_id).expect("delete provider secret");

    assert!(store.get(provider_id).is_none());
    assert!(store
        .get(&generated_chunk_secret_entry_id(
            provider_id,
            "gen-current",
            0
        ))
        .is_none());
    assert!(store.get(&chunk_secret_entry_id(provider_id, 0)).is_none());
}
