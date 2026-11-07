use super::{policy::POLICY, ChatGptSecret, SecretError};
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

fn publish(provider_id: &str, secret: &Option<ChatGptSecret>) {
    CHATGPT_SECRET_CACHE
        .lock()
        .expect("chatgpt secret cache lock")
        .insert(provider_id.to_owned(), secret.clone());
}

pub fn get_chatgpt_secret(provider_id: &str) -> Result<Option<ChatGptSecret>, SecretError> {
    POLICY.cached(
        || {
            CHATGPT_SECRET_CACHE
                .lock()
                .expect("chatgpt secret cache lock")
                .get(provider_id)
                .cloned()
        },
        |data| data.chatgpt_sessions.get(provider_id).cloned(),
        |value| publish(provider_id, value),
    )
}

pub(crate) fn reload_chatgpt_secret(
    provider_id: &str,
) -> Result<Option<ChatGptSecret>, SecretError> {
    POLICY.cached(
        || None,
        |data| data.chatgpt_sessions.get(provider_id).cloned(),
        |value| publish(provider_id, value),
    )
}

pub fn set_chatgpt_secret(provider_id: &str, secret: &ChatGptSecret) -> Result<(), SecretError> {
    POLICY.mutation(|store, mut data| {
        data.chatgpt_sessions
            .insert(provider_id.to_owned(), secret.clone());
        store.write_file(&data)?;
        if !POLICY.available() {
            return Err(SecretError::PolicyUnavailable);
        }
        publish(provider_id, &Some(secret.clone()));
        Ok(())
    })
}

pub fn delete_provider_secret(provider_id: &str) -> Result<(), SecretError> {
    POLICY.mutation(|store, mut data| {
        data.chatgpt_sessions.remove(provider_id);
        store.write_file(&data)?;
        if !POLICY.available() {
            return Err(SecretError::PolicyUnavailable);
        }
        publish(provider_id, &None);
        Ok(())
    })
}

#[cfg(test)]
pub(super) fn parse_serialized_chatgpt_secret(
    serialized: &str,
) -> Result<Option<ChatGptSecret>, SecretError> {
    super::store::parse_chatgpt_secret(serialized)
}
