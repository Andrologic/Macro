use keyring::Entry;

const SERVICE_NAME: &str = "macro";

pub fn get_api_key(provider_id: &str) -> Result<Option<String>, keyring::Error> {
    let entry = Entry::new(SERVICE_NAME, provider_id)?;
    match entry.get_password() {
        Ok(password) => Ok(Some(password)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e),
    }
}

pub fn set_api_key(provider_id: &str, api_key: &str) -> Result<(), keyring::Error> {
    let entry = Entry::new(SERVICE_NAME, provider_id)?;
    entry.set_password(api_key)
}

pub fn delete_api_key(provider_id: &str) -> Result<(), keyring::Error> {
    let entry = Entry::new(SERVICE_NAME, provider_id)?;
    match entry.delete_password() {
        Ok(_) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e),
    }
}