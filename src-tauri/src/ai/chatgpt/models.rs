use super::codex_files::{load_cached_model_entries, resolve_codex_client_version};
use super::session::ensure_fresh_secret;
use super::types::{
    db_error_to_string, extract_response_error, ModelsCacheEntry, RemoteModelsResponse,
    DEFAULT_ORIGINATOR,
};
use crate::db::models::{AiModel, ProviderAuthMetadata, ProviderConfig, ProviderModelInput};
use crate::db::repository;
use crate::secrets::{self, ChatGptSecret};
use reqwest::header::{ACCEPT, AUTHORIZATION};
use sqlx::SqlitePool;
use tracing::{debug, error, info, warn};

pub async fn disconnect_auth(
    pool: &SqlitePool,
    provider_id: &str,
) -> Result<ProviderConfig, String> {
    secrets::delete_provider_secret(provider_id).map_err(|error| error.to_string())?;
    repository::update_provider_auth_metadata(
        pool,
        provider_id,
        &ProviderAuthMetadata {
            auth_status: Some("unauthenticated".to_string()),
            auth_source: None,
            plan_type: None,
            account_label: None,
            token_expires_at: None,
        },
    )
    .await
    .map_err(db_error_to_string)?;

    repository::get_provider_config(pool, provider_id)
        .await
        .map_err(db_error_to_string)?
        .ok_or_else(|| format!("Provider {provider_id} not found."))
}

pub async fn sync_models(pool: &SqlitePool, provider_id: &str) -> Result<Vec<AiModel>, String> {
    info!(provider_id = %provider_id, "syncing ChatGPT models");
    let provider = repository::get_provider_config(pool, provider_id)
        .await
        .map_err(db_error_to_string)?
        .ok_or_else(|| format!("Provider {provider_id} not found."))?;
    let secret = ensure_fresh_secret(pool, provider_id).await?;
    let client_version = resolve_codex_client_version()?;
    let client = reqwest::Client::new();

    let remote_models = fetch_remote_models(&client, &provider, &secret, &client_version).await;
    let entries = match remote_models {
        Ok(models) if !models.is_empty() => {
            info!(
                provider_id = %provider_id,
                model_count = models.len(),
                client_version = %client_version,
                "fetched ChatGPT models from remote"
            );
            models
        }
        Ok(_) => {
            warn!(
                provider_id = %provider_id,
                client_version = %client_version,
                "ChatGPT remote models response was empty, falling back to local Codex cache"
            );
            load_cached_model_entries()?
        }
        Err(remote_error) => match load_cached_model_entries() {
            Ok(models) => {
                warn!(
                    provider_id = %provider_id,
                    client_version = %client_version,
                    error = %remote_error,
                    "ChatGPT remote model fetch failed, using local Codex cache"
                );
                models
            }
            Err(cache_error) => {
                error!(
                    provider_id = %provider_id,
                    client_version = %client_version,
                    remote_error = %remote_error,
                    cache_error = %cache_error,
                    "ChatGPT model sync failed for both remote and local cache"
                );
                return Err(format!(
                    "{} Fallback to the local Codex cache also failed: {}",
                    remote_error, cache_error
                ));
            }
        },
    };

    let models = build_provider_models(&entries, provider.plan_type.as_deref());

    if !models.is_empty() {
        repository::upsert_provider_models(pool, provider_id, &models)
            .await
            .map_err(db_error_to_string)?;

        let keep_model_ids = models
            .iter()
            .map(|model| model.model_id.clone())
            .collect::<Vec<_>>();
        repository::prune_provider_models(pool, provider_id, &keep_model_ids)
            .await
            .map_err(db_error_to_string)?;
    }

    let persisted_models = repository::list_models_by_provider(pool, provider_id)
        .await
        .map_err(db_error_to_string)?;
    info!(
        provider_id = %provider_id,
        model_count = persisted_models.len(),
        "ChatGPT model sync completed"
    );
    Ok(persisted_models)
}

async fn fetch_remote_models(
    client: &reqwest::Client,
    provider: &ProviderConfig,
    secret: &ChatGptSecret,
    client_version: &str,
) -> Result<Vec<ModelsCacheEntry>, String> {
    let account_id = secret
        .account_id
        .clone()
        .ok_or_else(|| "ChatGPT account ID is missing. Reconnect with ChatGPT.".to_string())?;
    let mut url = reqwest::Url::parse(&format!(
        "{}/codex/models",
        provider.base_url.trim_end_matches('/')
    ))
    .map_err(|error| format!("Failed to build ChatGPT models URL: {}", error))?;
    url.query_pairs_mut()
        .append_pair("client_version", client_version);
    debug!(
        provider_id = %provider.id,
        client_version = %client_version,
        url = %url,
        "requesting ChatGPT models from remote endpoint"
    );

    let response = client
        .get(url)
        .header(ACCEPT, "application/json")
        .header(AUTHORIZATION, format!("Bearer {}", secret.access_token))
        .header("ChatGPT-Account-Id", account_id)
        .header("originator", DEFAULT_ORIGINATOR)
        .header(
            "session_id",
            format!("macro_models_{}", uuid::Uuid::new_v4()),
        )
        .send()
        .await
        .map_err(|error| format!("Failed to fetch ChatGPT models: {}", error))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        warn!(
            provider_id = %provider.id,
            status = status.as_u16(),
            response_error = %extract_response_error(status.as_u16(), &body),
            "ChatGPT models endpoint returned non-success status"
        );
        return Err(extract_response_error(status.as_u16(), &body));
    }

    let payload: RemoteModelsResponse = response
        .json()
        .await
        .map_err(|error| format!("Failed to parse ChatGPT models response: {}", error))?;
    debug!(
        provider_id = %provider.id,
        model_count = payload.models.len(),
        "parsed ChatGPT remote models response"
    );
    Ok(payload.models)
}

pub(super) fn build_provider_models(
    entries: &[ModelsCacheEntry],
    plan_type: Option<&str>,
) -> Vec<ProviderModelInput> {
    let visible_entries = entries
        .iter()
        .filter(|entry| !entry.slug.trim().is_empty())
        .filter(|entry| !matches!(entry.visibility.as_deref(), Some("hidden")))
        .collect::<Vec<_>>();

    let filtered_entries = if let Some(plan_type) = plan_type
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_ascii_lowercase)
    {
        let matching_entries = visible_entries
            .iter()
            .copied()
            .filter(|entry| model_supports_plan(entry, &plan_type))
            .collect::<Vec<_>>();

        if matching_entries.is_empty() {
            visible_entries
        } else {
            matching_entries
        }
    } else {
        visible_entries
    };

    filtered_entries
        .into_iter()
        .map(|entry| ProviderModelInput {
            model_id: entry.slug.clone(),
            name: entry
                .display_name
                .clone()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| entry.slug.clone()),
            description: entry.description.clone(),
            owned_by: None,
            pricing_prompt: None,
            pricing_completion: None,
            pricing_request: None,
        })
        .collect()
}

pub(super) fn model_supports_plan(entry: &ModelsCacheEntry, plan_type: &str) -> bool {
    entry
        .available_in_plans
        .as_ref()
        .map(|plans| {
            plans
                .iter()
                .any(|plan| plan.trim().eq_ignore_ascii_case(plan_type))
        })
        .unwrap_or(true)
}
