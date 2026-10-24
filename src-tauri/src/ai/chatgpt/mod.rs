mod auth;
mod codex_files;
mod models;
mod session;
mod stream;
pub(crate) mod types;

#[cfg(test)]
mod tests;

pub use auth::{cancel_auth, start_browser_auth};
pub(crate) use models::{available_models, persist_model_enrichments, recover_auth_mutations};
pub use models::{disconnect_auth, sync_models};
pub(crate) use stream::stream_chat;
/// Pure construction for private transfer preparation. The native caller owns
/// admission for the request, builder allocations and subsequent serialization.
/// This does not attest policy, archive provenance or permission to send.
pub(crate) fn build_transfer_request(
    request: &AiChatRequest,
) -> Result<impl serde::Serialize, String> {
    stream::build_responses_request(request)
}
#[cfg(test)]
pub(crate) fn portable_history_proof_request(
    request: &AiChatRequest,
) -> Result<serde_json::Value, String> {
    serde_json::to_value(stream::build_responses_request(request)?)
        .map_err(|_| "serialization_failed".into())
}
// Retain the historical public path while shared consumers use ai::types.
#[allow(unused_imports)]
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
    crate::secrets::blocking::run(move || {
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
        Ok::<_, String>(AuthMutationGuard {
            _process_guard: process_guard,
            _file_guard: file,
        })
    })
    .await
    .map_err(|error| format!("L’acquisition du verrou d’authentification a échoué : {error}"))?
}
