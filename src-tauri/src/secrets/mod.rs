mod api_keys;
mod chatgpt;
mod store;

#[cfg(test)]
mod tests;

pub use api_keys::{delete_api_key, get_api_key, set_api_key};
pub use chatgpt::{delete_provider_secret, get_chatgpt_secret, set_chatgpt_secret};
use std::path::Path;
pub use store::{ChatGptSecret, SecretError};

pub fn init(app_data_dir: &Path) -> Result<(), SecretError> {
    store::init_store(app_data_dir)?;
    api_keys::clear_cache();
    chatgpt::clear_cache();
    Ok(())
}
