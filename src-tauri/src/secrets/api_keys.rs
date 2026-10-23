use super::{policy::POLICY, SecretError};
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

static API_KEY_CACHE: LazyLock<Mutex<HashMap<String, Option<String>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub(super) fn clear_cache() {
    API_KEY_CACHE.lock().expect("api key cache lock").clear();
}

pub fn get_api_key(provider_id: &str) -> Result<Option<String>, SecretError> {
    POLICY.cached(
        || {
            API_KEY_CACHE
                .lock()
                .expect("api key cache lock")
                .get(provider_id)
                .cloned()
        },
        |data| data.api_keys.get(provider_id).cloned(),
        |value| {
            API_KEY_CACHE
                .lock()
                .expect("api key cache lock")
                .insert(provider_id.to_owned(), value.clone());
        },
    )
}

pub fn set_api_key(provider_id: &str, api_key: &str) -> Result<(), SecretError> {
    POLICY.mutation(|store, mut data| {
        data.api_keys
            .insert(provider_id.to_owned(), api_key.to_owned());
        store.write_file(&data)?;
        if !POLICY.available() {
            return Err(SecretError::PolicyUnavailable);
        }
        API_KEY_CACHE
            .lock()
            .expect("api key cache lock")
            .insert(provider_id.to_owned(), Some(api_key.to_owned()));
        Ok(())
    })
}

pub fn delete_api_key(provider_id: &str) -> Result<(), SecretError> {
    POLICY.mutation(|store, mut data| {
        data.api_keys.remove(provider_id);
        store.write_file(&data)?;
        if !POLICY.available() {
            return Err(SecretError::PolicyUnavailable);
        }
        API_KEY_CACHE
            .lock()
            .expect("api key cache lock")
            .insert(provider_id.to_owned(), None);
        Ok(())
    })
}
