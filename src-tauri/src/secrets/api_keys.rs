use super::store::{delete_provider_secret_entry, read_provider_secret, write_provider_secret};
use super::SecretError;
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

static API_KEY_CACHE: LazyLock<Mutex<HashMap<String, Option<String>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub(super) fn clear_cache() {
    API_KEY_CACHE.lock().expect("api key cache lock").clear();
}

pub fn get_api_key(provider_id: &str) -> Result<Option<String>, SecretError> {
    if let Some(cached) = API_KEY_CACHE
        .lock()
        .expect("api key cache lock")
        .get(provider_id)
        .cloned()
    {
        return Ok(cached);
    }

    let Some(secret) = read_provider_secret(provider_id)? else {
        API_KEY_CACHE
            .lock()
            .expect("api key cache lock")
            .insert(provider_id.to_string(), None);
        return Ok(None);
    };

    API_KEY_CACHE
        .lock()
        .expect("api key cache lock")
        .insert(provider_id.to_string(), Some(secret.clone()));

    Ok(Some(secret))
}

pub fn set_api_key(provider_id: &str, api_key: &str) -> Result<(), SecretError> {
    write_provider_secret(provider_id, api_key)?;
    API_KEY_CACHE
        .lock()
        .expect("api key cache lock")
        .insert(provider_id.to_string(), Some(api_key.to_string()));
    Ok(())
}

pub fn delete_api_key(provider_id: &str) -> Result<(), SecretError> {
    delete_provider_secret_entry(provider_id)?;
    API_KEY_CACHE
        .lock()
        .expect("api key cache lock")
        .insert(provider_id.to_string(), None);
    Ok(())
}
