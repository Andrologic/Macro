mod auth;
mod codex_files;
mod models;
mod session;
mod stream;
pub(crate) mod types;

#[cfg(test)]
mod tests;

pub use auth::{cancel_auth, start_browser_auth};
pub(crate) use models::recover_auth_mutations;
pub use models::{disconnect_auth, sync_models};
pub use stream::{cancel_stream, stream_chat};
pub use types::AiChatRequest;

pub(crate) static AUTH_MUTATION_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

pub(crate) struct AuthMutationGuard {
    _process_guard: tokio::sync::MutexGuard<'static, ()>,
    _file_guard: std::fs::File,
}

pub(crate) async fn lock_auth_mutation(provider_id: &str) -> Result<AuthMutationGuard, String> {
    use fs2::FileExt;
    use std::fs::OpenOptions;

    let process_guard = AUTH_MUTATION_LOCK.lock().await;
    let lock_path =
        crate::secrets::chatgpt_auth_lock_path(provider_id).map_err(|error| error.to_string())?;
    let file_guard = tokio::task::spawn_blocking(move || {
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .open(&lock_path)
            .map_err(|error| {
                format!(
                    "Impossible d’ouvrir le verrou d’authentification {} : {error}",
                    lock_path.display()
                )
            })?;
        file.lock_exclusive().map_err(|error| {
            format!(
                "Impossible de verrouiller l’authentification {} : {error}",
                lock_path.display()
            )
        })?;
        Ok::<_, String>(file)
    })
    .await
    .map_err(|error| format!("L’acquisition du verrou d’authentification a échoué : {error}"))??;

    Ok(AuthMutationGuard {
        _process_guard: process_guard,
        _file_guard: file_guard,
    })
}
