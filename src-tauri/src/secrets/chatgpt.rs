use super::store::{
    active_storage_profile, cleanup_chunk_entries_best_effort,
    cleanup_previous_chunked_secret_best_effort, delete_chunked_secret,
    delete_legacy_chunked_secret_best_effort, delete_secret_entry, generated_chunk_secret_entry_id,
    parse_chatgpt_secret, parse_chunked_manifest, read_chunked_secret, split_by_storage_limit,
    storage_limit_bytes, storage_size_bytes, ChunkedSecretPayload, KeyringSecretStore,
    SecretEnvelope, SecretStore,
};
use super::{ChatGptSecret, SecretError};
use tracing::{debug, info, warn};

pub fn get_chatgpt_secret(provider_id: &str) -> Result<Option<ChatGptSecret>, SecretError> {
    let store = KeyringSecretStore;
    let Some(secret) = store.read_entry(provider_id)? else {
        return Ok(None);
    };

    if let Some(parsed) = parse_chatgpt_secret(&secret)? {
        return Ok(Some(parsed));
    }

    if let Some(manifest) = parse_chunked_manifest(&secret) {
        let Some(serialized) = read_chunked_secret(&store, provider_id, &manifest.payload)? else {
            return Ok(None);
        };
        return parse_chatgpt_secret(&serialized);
    }

    Ok(None)
}

pub fn migrate_legacy_chatgpt_secret(
    provider_id: &str,
) -> Result<Option<ChatGptSecret>, SecretError> {
    let store = KeyringSecretStore;
    let Some(secret) = store.read_entry(provider_id)? else {
        return Ok(None);
    };

    if let Ok(envelope) = serde_json::from_str::<SecretEnvelope<ChatGptSecret>>(&secret) {
        if envelope.version == 2 && envelope.kind == "chatgpt_session" {
            return Ok(Some(envelope.payload));
        }
    }

    let migrated = if let Some(manifest) = parse_chunked_manifest(&secret) {
        let Some(serialized) = read_chunked_secret(&store, provider_id, &manifest.payload)? else {
            return Ok(None);
        };
        parse_chatgpt_secret(&serialized)?
    } else {
        parse_chatgpt_secret(&secret)?
    };

    if let Some(ref migrated_secret) = migrated {
        set_chatgpt_secret(provider_id, migrated_secret)?;
    }

    Ok(migrated)
}

pub fn set_chatgpt_secret(provider_id: &str, secret: &ChatGptSecret) -> Result<(), SecretError> {
    let store = KeyringSecretStore;
    let profile = active_storage_profile();
    let envelope = SecretEnvelope {
        version: 2,
        kind: "chatgpt_session".to_string(),
        payload: secret.clone(),
    };
    let serialized = serde_json::to_string(&envelope)?;
    let serialized_storage_bytes = storage_size_bytes(&serialized, profile);
    let storage_limit = storage_limit_bytes(profile);
    let previous_root = store.read_entry(provider_id)?;
    let previous_manifest = previous_root
        .as_deref()
        .and_then(parse_chunked_manifest)
        .map(|manifest| manifest.payload);

    debug!(
        provider_id = %provider_id,
        phase = "serialize",
        serialized_bytes = serialized.len(),
        storage_bytes = serialized_storage_bytes,
        storage_limit,
        profile = ?profile,
        "prepared ChatGPT secret for keyring persistence"
    );

    if serialized_storage_bytes <= storage_limit {
        debug!(
            provider_id = %provider_id,
            phase = "write_manifest",
            storage_bytes = serialized_storage_bytes,
            "writing ChatGPT secret directly to keyring"
        );
        store.write_entry(provider_id, &serialized)?;
        cleanup_previous_chunked_secret_best_effort(
            &store,
            provider_id,
            previous_manifest.as_ref(),
        );
        return Ok(());
    }

    let generation = format!("v{}", uuid::Uuid::new_v4().simple());
    let chunks = split_by_storage_limit(&serialized, profile);
    info!(
        provider_id = %provider_id,
        phase = "chunk",
        chunk_count = chunks.len(),
        serialized_bytes = serialized.len(),
        storage_bytes = serialized_storage_bytes,
        storage_limit,
        profile = ?profile,
        "chunking ChatGPT secret for keyring persistence"
    );

    let chunk_entry_ids = (0..chunks.len())
        .map(|index| generated_chunk_secret_entry_id(provider_id, &generation, index))
        .collect::<Vec<_>>();
    let mut written_chunk_ids = Vec::new();

    for (entry_id, chunk) in chunk_entry_ids.iter().zip(chunks.iter()) {
        debug!(
            provider_id = %provider_id,
            phase = "write_chunks",
            entry_id = %entry_id,
            chunk_storage_bytes = storage_size_bytes(chunk, profile),
            "writing ChatGPT secret chunk"
        );
        if let Err(error) = store.write_entry(entry_id, chunk) {
            warn!(
                provider_id = %provider_id,
                phase = "write_chunks",
                entry_id = %entry_id,
                error = %error,
                "failed to write ChatGPT secret chunk"
            );
            cleanup_chunk_entries_best_effort(
                &store,
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
            generation: Some(generation),
        },
    };
    let manifest_serialized = serde_json::to_string(&manifest)?;
    debug!(
        provider_id = %provider_id,
        phase = "write_manifest",
        manifest_storage_bytes = storage_size_bytes(&manifest_serialized, profile),
        chunk_count = chunks.len(),
        "writing ChatGPT chunk manifest"
    );
    if let Err(error) = store.write_entry(provider_id, &manifest_serialized) {
        warn!(
            provider_id = %provider_id,
            phase = "write_manifest",
            error = %error,
            "failed to write ChatGPT chunk manifest"
        );
        cleanup_chunk_entries_best_effort(
            &store,
            provider_id,
            &chunk_entry_ids,
            "rollback_new_chunks",
        );
        return Err(error.into());
    }

    cleanup_previous_chunked_secret_best_effort(&store, provider_id, previous_manifest.as_ref());
    Ok(())
}

pub fn delete_provider_secret(provider_id: &str) -> Result<(), SecretError> {
    let store = KeyringSecretStore;
    if let Some(secret) = store.read_entry(provider_id)? {
        if let Some(manifest) = parse_chunked_manifest(&secret) {
            delete_chunked_secret(&store, provider_id, &manifest.payload)?;
        }
    }

    delete_legacy_chunked_secret_best_effort(&store, provider_id)?;
    delete_secret_entry(provider_id)?;
    Ok(())
}
