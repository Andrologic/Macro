mod api_keys;
mod chatgpt;
mod store;

#[cfg(test)]
mod tests;

pub use api_keys::{delete_api_key, get_api_key, set_api_key};
pub use chatgpt::{delete_provider_secret, get_chatgpt_secret, set_chatgpt_secret};
use std::path::Path;
pub use store::{ChatGptSecret, SecretError};

#[cfg(test)]
static SECRET_STORE_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
pub(crate) fn lock_test_store() -> std::sync::MutexGuard<'static, ()> {
    SECRET_STORE_TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretMetadata {
    pub id: String,
    pub namespace: String,
    pub secret_type: String,
    pub secret_ref: String,
}

fn metadata_for_api_key(id: String) -> SecretMetadata {
    let (namespace, secret_ref) = if let Some(rest) = id.strip_prefix("web-search:") {
        ("webSearch", format!("macro-secret://web-search/{rest}"))
    } else if let Some(rest) = id.strip_prefix("mcp-env:") {
        let reference_path = rest.replacen(':', "/", 1);
        ("mcp", format!("macro-secret://mcp-env/{reference_path}"))
    } else if let Some(rest) = id.strip_prefix("mcp-oauth:") {
        ("mcp", format!("macro-secret://mcp-oauth/{rest}"))
    } else if let Some(rest) = id.strip_prefix("mcp-oauth-client:") {
        ("mcp", format!("macro-secret://mcp-oauth-client/{rest}"))
    } else if let Some(rest) = id
        .strip_prefix("speech-provider:")
        .or_else(|| id.strip_prefix("speech:"))
    {
        ("speech", format!("macro-secret://speech/{rest}"))
    } else if id.starts_with("macro-installation:") {
        ("system", format!("macro-secret://system/{id}"))
    } else {
        ("providers", format!("macro-secret://providers/{id}"))
    };
    SecretMetadata {
        id,
        namespace: namespace.to_string(),
        secret_type: "apiKey".to_string(),
        secret_ref,
    }
}

pub fn list_secret_metadata() -> Result<Vec<SecretMetadata>, SecretError> {
    let mut entries = store::list_provider_secret_ids()?
        .into_iter()
        .map(metadata_for_api_key)
        .collect::<Vec<_>>();
    entries.extend(
        store::list_chatgpt_secret_ids()?
            .into_iter()
            .map(|id| SecretMetadata {
                secret_ref: format!("macro-secret://chatgpt/{id}"),
                id,
                namespace: "providers".to_string(),
                secret_type: "chatgptSession".to_string(),
            }),
    );
    entries.sort_by(|left, right| {
        (&left.namespace, &left.id, &left.secret_type).cmp(&(
            &right.namespace,
            &right.id,
            &right.secret_type,
        ))
    });
    Ok(entries)
}

pub fn delete_secret_metadata(id: &str, secret_type: &str) -> Result<(), SecretError> {
    match secret_type {
        "apiKey" => delete_api_key(id),
        "chatgptSession" => delete_provider_secret(id),
        _ => Ok(()),
    }
}

pub fn init(app_data_dir: &Path) -> Result<(), SecretError> {
    store::init_store(app_data_dir)?;
    api_keys::clear_cache();
    chatgpt::clear_cache();
    Ok(())
}
