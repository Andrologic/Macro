use keyring::Entry;
use std::sync::atomic::{AtomicBool, Ordering};

const SERVICE_NAME: &str = "macro";
static KEYRING_UNAVAILABLE: AtomicBool = AtomicBool::new(false);

fn is_unavailable_error(error: &keyring::Error) -> bool {
    let message = error.to_string().to_lowercase();
    message.contains("serviceunknown")
        || message.contains("not activatable")
        || message.contains("secret service")
        || message.contains("platform secure storage failure")
}

fn mark_unavailable_once() {
    if !KEYRING_UNAVAILABLE.swap(true, Ordering::Relaxed) {
        eprintln!("Keyring unavailable, API key persistence disabled for this session");
    }
}

pub fn get_api_key(provider_id: &str) -> Result<Option<String>, keyring::Error> {
    if KEYRING_UNAVAILABLE.load(Ordering::Relaxed) {
        return Ok(None);
    }

    let entry = Entry::new(SERVICE_NAME, provider_id)?;
    match entry.get_password() {
        Ok(password) => Ok(Some(password)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) if is_unavailable_error(&e) => {
            mark_unavailable_once();
            Ok(None)
        }
        Err(e) => Err(e),
    }
}

pub fn set_api_key(provider_id: &str, api_key: &str) -> Result<(), keyring::Error> {
    if KEYRING_UNAVAILABLE.load(Ordering::Relaxed) {
        return Ok(());
    }

    let entry = Entry::new(SERVICE_NAME, provider_id)?;
    match entry.set_password(api_key) {
        Ok(_) => Ok(()),
        Err(e) if is_unavailable_error(&e) => {
            mark_unavailable_once();
            Ok(())
        }
        Err(e) => Err(e),
    }
}

pub fn delete_api_key(provider_id: &str) -> Result<(), keyring::Error> {
    if KEYRING_UNAVAILABLE.load(Ordering::Relaxed) {
        return Ok(());
    }

    let entry = Entry::new(SERVICE_NAME, provider_id)?;
    match entry.delete_password() {
        Ok(_) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) if is_unavailable_error(&e) => {
            mark_unavailable_once();
            Ok(())
        }
        Err(e) => Err(e),
    }
}
