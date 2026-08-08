use super::store::{delete_chatgpt_secret, read_chatgpt_secret, write_chatgpt_secret};
use super::{ChatGptSecret, SecretError};
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

static CHATGPT_SECRET_CACHE: LazyLock<Mutex<HashMap<String, Option<ChatGptSecret>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub(super) fn clear_cache() {
    CHATGPT_SECRET_CACHE
        .lock()
        .expect("chatgpt secret cache lock")
        .clear();
}

pub fn get_chatgpt_secret(provider_id: &str) -> Result<Option<ChatGptSecret>, SecretError> {
    if let Some(cached) = CHATGPT_SECRET_CACHE
        .lock()
        .expect("chatgpt secret cache lock")
        .get(provider_id)
        .cloned()
    {
        return Ok(cached);
    }

    let secret = read_chatgpt_secret(provider_id)?;
    CHATGPT_SECRET_CACHE
        .lock()
        .expect("chatgpt secret cache lock")
        .insert(provider_id.to_string(), secret.clone());
    Ok(secret)
}

pub fn set_chatgpt_secret(provider_id: &str, secret: &ChatGptSecret) -> Result<(), SecretError> {
    write_chatgpt_secret(provider_id, secret)?;
    CHATGPT_SECRET_CACHE
        .lock()
        .expect("chatgpt secret cache lock")
        .insert(provider_id.to_string(), Some(secret.clone()));
    Ok(())
}

pub fn delete_provider_secret(provider_id: &str) -> Result<(), SecretError> {
    delete_chatgpt_secret(provider_id)?;
    CHATGPT_SECRET_CACHE
        .lock()
        .expect("chatgpt secret cache lock")
        .insert(provider_id.to_string(), None);
    Ok(())
}

#[cfg(test)]
pub(super) fn parse_serialized_chatgpt_secret(
    serialized: &str,
) -> Result<Option<ChatGptSecret>, SecretError> {
    use super::store::parse_chatgpt_secret;

    parse_chatgpt_secret(serialized)
}
