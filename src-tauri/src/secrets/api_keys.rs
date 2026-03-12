use super::chatgpt::delete_provider_secret;
use super::store::{read_secret, write_secret, SecretEnvelope};
use super::SecretError;
use serde_json::Value;

pub fn get_api_key(provider_id: &str) -> Result<Option<String>, keyring::Error> {
    let Some(secret) = read_secret(provider_id)? else {
        return Ok(None);
    };

    if serde_json::from_str::<SecretEnvelope<Value>>(&secret).is_ok() {
        return Ok(None);
    }

    Ok(Some(secret))
}

pub fn set_api_key(provider_id: &str, api_key: &str) -> Result<(), keyring::Error> {
    write_secret(provider_id, api_key)
}

pub fn delete_api_key(provider_id: &str) -> Result<(), keyring::Error> {
    delete_provider_secret(provider_id).map_err(|error| match error {
        SecretError::Keyring(inner) => inner,
        SecretError::Serde(_) => keyring::Error::NoEntry,
    })
}
