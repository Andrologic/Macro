use super::chatgpt::parse_serialized_chatgpt_secret;
use super::store::test_store;
use super::{
    delete_api_key, delete_provider_secret, get_api_key, get_chatgpt_secret, init,
    metadata_for_api_key, set_api_key, set_chatgpt_secret, ChatGptSecret,
};
use std::collections::BTreeMap;

fn secret() -> ChatGptSecret {
    ChatGptSecret {
        access_token: "access-token".to_string(),
        refresh_token: "refresh-token".to_string(),
        access_token_expires_at: Some("2026-05-09T12:00:00Z".to_string()),
        account_id: Some("acct-123".to_string()),
        auth_source: "oauth".to_string(),
    }
}

#[test]
fn public_secret_helpers_roundtrip_api_keys_and_chatgpt_sessions() {
    let _guard = super::lock_test_store();
    let temp = tempfile::tempdir().expect("tempdir");
    init(temp.path()).expect("initialize local secret store");
    let api_provider_id = format!("api-{}", uuid::Uuid::new_v4());
    let chatgpt_provider_id = format!("chatgpt-{}", uuid::Uuid::new_v4());
    let chatgpt_secret = secret();

    set_api_key(&api_provider_id, "test-api-key").expect("set api key");
    assert_eq!(
        get_api_key(&api_provider_id)
            .expect("get api key")
            .as_deref(),
        Some("test-api-key")
    );
    delete_api_key(&api_provider_id).expect("delete api key");
    assert!(get_api_key(&api_provider_id)
        .expect("get deleted api key")
        .is_none());

    set_chatgpt_secret(&chatgpt_provider_id, &chatgpt_secret).expect("set ChatGPT secret");
    assert_eq!(
        get_chatgpt_secret(&chatgpt_provider_id).expect("get ChatGPT secret"),
        Some(chatgpt_secret)
    );
    delete_provider_secret(&chatgpt_provider_id).expect("delete ChatGPT secret");
    assert!(get_chatgpt_secret(&chatgpt_provider_id)
        .expect("get deleted ChatGPT secret")
        .is_none());
}

#[test]
fn speech_secret_metadata_accepts_current_and_legacy_prefixes() {
    for id in ["speech-provider:dictation", "speech:dictation"] {
        let metadata = metadata_for_api_key(id.to_string());
        assert_eq!(metadata.namespace, "speech");
        assert_eq!(metadata.secret_ref, "macro-secret://speech/dictation");
    }
}

#[test]
fn init_clears_public_secret_caches_when_store_path_changes() {
    let _guard = super::lock_test_store();
    let first = tempfile::tempdir().expect("first tempdir");
    let second = tempfile::tempdir().expect("second tempdir");
    let provider_id = format!("provider-{}", uuid::Uuid::new_v4());

    init(first.path()).expect("initialize first store");
    set_api_key(&provider_id, "test-api-key").expect("set first key");
    assert_eq!(
        get_api_key(&provider_id).expect("get first key").as_deref(),
        Some("test-api-key")
    );

    init(second.path()).expect("initialize second store");

    assert!(get_api_key(&provider_id)
        .expect("get key from second store")
        .is_none());
}

#[test]
fn local_store_roundtrips_api_keys_and_chatgpt_sessions() {
    let temp = tempfile::tempdir().expect("tempdir");
    let path = temp.path().join("provider-secrets.json");
    let store = test_store(path);
    let chatgpt_secret = secret();

    store
        .update_file(|data| {
            data.api_keys
                .insert("openai".to_string(), "test-api-key".to_string());
            data.chatgpt_sessions
                .insert("chatgpt".to_string(), chatgpt_secret.clone());
        })
        .expect("write secrets");

    let data = store.read_file().expect("read secrets");
    assert_eq!(
        data.api_keys.get("openai").map(String::as_str),
        Some("test-api-key")
    );
    assert_eq!(data.chatgpt_sessions.get("chatgpt"), Some(&chatgpt_secret));

    let persisted: serde_json::Value = serde_json::from_slice(
        &std::fs::read(temp.path().join("provider-secrets.json")).expect("persisted secrets"),
    )
    .expect("valid JSON");
    assert_eq!(persisted["version"], serde_json::json!(2));
    assert_eq!(
        persisted.pointer("/namespaces/providers/openai"),
        Some(&serde_json::json!("test-api-key"))
    );
    assert!(persisted.get("api_keys").is_none());
}

#[test]
fn init_backs_up_a_legacy_secret_file_before_upgrading_it() {
    let _guard = super::lock_test_store();
    let temp = tempfile::tempdir().expect("tempdir");
    let path = temp.path().join("provider-secrets.json");
    let legacy = r#"{"version":1,"api_keys":{"openai":"kept"},"chatgpt_sessions":{}}"#;
    std::fs::write(&path, legacy).expect("legacy secrets");

    init(temp.path()).expect("upgrade secret store");

    assert_eq!(
        std::fs::read_to_string(temp.path().join("provider-secrets.json.v1.bak"))
            .expect("version backup"),
        legacy
    );
    assert_eq!(
        get_api_key("openai").expect("migrated secret").as_deref(),
        Some("kept")
    );
}

#[test]
fn local_store_deletes_entries_without_removing_other_secrets() {
    let temp = tempfile::tempdir().expect("tempdir");
    let path = temp.path().join("provider-secrets.json");
    let store = test_store(path);

    store
        .update_file(|data| {
            data.api_keys
                .insert("openai".to_string(), "test-api-key".to_string());
            data.api_keys
                .insert("anthropic".to_string(), "test-api-key".to_string());
            data.chatgpt_sessions
                .insert("chatgpt".to_string(), secret());
        })
        .expect("write initial secrets");

    store
        .update_file(|data| {
            data.api_keys.remove("openai");
            data.chatgpt_sessions.remove("chatgpt");
        })
        .expect("delete selected secrets");

    let data = store.read_file().expect("read secrets");
    assert!(!data.api_keys.contains_key("openai"));
    assert!(!data.chatgpt_sessions.contains_key("chatgpt"));
    assert_eq!(
        data.api_keys.get("anthropic").map(String::as_str),
        Some("test-api-key")
    );
}

#[test]
fn missing_store_file_reads_as_empty_store() {
    let temp = tempfile::tempdir().expect("tempdir");
    let path = temp.path().join("provider-secrets.json");
    let store = test_store(path);

    let data = store.read_file().expect("read missing file");

    assert_eq!(data.api_keys, BTreeMap::new());
    assert_eq!(data.chatgpt_sessions, BTreeMap::new());
}

#[test]
fn corrupt_store_file_is_quarantined_and_replaced_with_empty_store() {
    let temp = tempfile::tempdir().expect("tempdir");
    let path = temp.path().join("provider-secrets.json");
    std::fs::write(&path, "{not json").expect("write corrupt file");
    let store = test_store(path.clone());

    let data = store.read_file().expect("corrupt file should quarantine");

    assert_eq!(data.api_keys, BTreeMap::new());
    assert_eq!(data.chatgpt_sessions, BTreeMap::new());
    assert!(path.exists());
    let quarantined = std::fs::read_dir(temp.path())
        .expect("read tempdir")
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .filter(|name| name.starts_with("provider-secrets.json.corrupt-"))
        .collect::<Vec<_>>();
    assert_eq!(quarantined.len(), 1);
}

#[cfg(unix)]
#[test]
fn local_store_file_uses_private_unix_permissions() {
    use std::os::unix::fs::PermissionsExt;

    let temp = tempfile::tempdir().expect("tempdir");
    let path = temp.path().join("provider-secrets.json");
    let store = test_store(path.clone());

    store
        .update_file(|data| {
            data.api_keys
                .insert("openai".to_string(), "test-api-key".to_string());
        })
        .expect("write secrets");

    let mode = std::fs::metadata(path)
        .expect("metadata")
        .permissions()
        .mode()
        & 0o777;
    assert_eq!(mode, 0o600);
}

#[test]
fn legacy_chatgpt_secret_can_still_be_deserialized_for_explicit_imports() {
    let encoded = r#"{"version":1,"kind":"chatgpt","payload":{"access_token":"access","refresh_token":"refresh","id_token":"id","account_id":"acct-123","client_id":"client","last_refresh":null,"source":"oauth"}}"#;

    let decoded = parse_serialized_chatgpt_secret(encoded)
        .expect("parse")
        .expect("secret");

    assert_eq!(decoded.access_token, "access");
    assert_eq!(decoded.refresh_token, "refresh");
    assert_eq!(decoded.account_id.as_deref(), Some("acct-123"));
    assert_eq!(decoded.auth_source, "oauth");
}

#[test]
fn local_store_reads_legacy_chatgpt_session_shapes_without_external_secret_access() {
    let temp = tempfile::tempdir().expect("tempdir");
    let path = temp.path().join("provider-secrets.json");
    std::fs::write(
        &path,
        r#"{"version":1,"api_keys":{},"chatgpt_sessions":{"chatgpt":{"version":1,"kind":"chatgpt","payload":{"access_token":"access","refresh_token":"refresh","id_token":"id","account_id":"acct-123","client_id":"client","last_refresh":null,"source":"oauth"}}}}"#,
    )
    .expect("write legacy local store");
    let store = test_store(path);

    let data = store.read_file().expect("read legacy local store");

    let decoded = data
        .chatgpt_sessions
        .get("chatgpt")
        .expect("legacy session converted");
    assert_eq!(decoded.access_token, "access");
    assert_eq!(decoded.refresh_token, "refresh");
    assert_eq!(decoded.account_id.as_deref(), Some("acct-123"));
    assert_eq!(decoded.auth_source, "oauth");
}
