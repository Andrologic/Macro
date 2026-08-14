use crate::db::models::{ProviderModelInput, UpdateProviderConfigInput};
use crate::db::repository;
use crate::secrets;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::time::Duration;

pub const PROVIDER_ID: &str = "macro-ai";
pub const PROVIDER_NAME: &str = "Andrologic";
pub const PROVIDER_BASE_URL: &str = "https://lmstudio.andrologic.ai/v1";
pub const DEFAULT_MODEL_ID: &str = "macro-ai";
pub const FAST_MODEL_NAME: &str = "Macro AI Fast";
pub const DEEP_MODEL_ID: &str = "macro-ai-deep";
pub const DEEP_MODEL_NAME: &str = "Macro AI Deep";
const INSTALLATION_IDENTITY_SECRET_ID: &str = "__macro_ai_installation_identity";
const BOOTSTRAP_URL: &str = "https://lmstudio.andrologic.ai/macro/v1/instances/bootstrap";
const CONTEXT_WINDOW_TOKENS: i32 = 200_000;
const OUTPUT_LIMIT_TOKENS: i32 = 16_384;
const INPUT_LIMIT_TOKENS: i32 = CONTEXT_WINDOW_TOKENS - OUTPUT_LIMIT_TOKENS;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct InstallationIdentity {
    installation_id: String,
    installation_proof: String,
}

#[derive(Debug, Serialize)]
struct BootstrapRequest<'a> {
    installation_id: &'a str,
    installation_proof: &'a str,
    client_version: &'a str,
    platform: &'a str,
}

#[derive(Debug, Deserialize)]
struct BootstrapResponse {
    access_token: String,
    model: String,
    context_window_tokens: i32,
}

#[derive(Debug, Deserialize)]
struct BootstrapError {
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MacroAiProvisioningStatus {
    pub provider_id: String,
    pub model_id: String,
    pub context_window_tokens: i32,
    pub activated_now: bool,
}

fn managed_models() -> Vec<ProviderModelInput> {
    let updated_at = chrono::Utc::now().to_rfc3339();

    [
        (
            DEFAULT_MODEL_ID,
            FAST_MODEL_NAME,
            "Modèle rapide inclus avec la bêta de Macro.",
        ),
        (
            DEEP_MODEL_ID,
            DEEP_MODEL_NAME,
            "Modèle approfondi inclus avec la bêta de Macro.",
        ),
    ]
    .into_iter()
    .map(|(model_id, name, description)| ProviderModelInput {
        model_id: model_id.to_string(),
        name: name.to_string(),
        description: Some(description.to_string()),
        owned_by: Some(PROVIDER_NAME.to_string()),
        pricing_prompt: Some("0".to_string()),
        pricing_completion: Some("0".to_string()),
        pricing_request: Some("0".to_string()),
        reasoning_efforts: None,
        default_reasoning_effort: None,
        context_window_tokens: Some(CONTEXT_WINDOW_TOKENS),
        input_limit_tokens: Some(INPUT_LIMIT_TOKENS),
        output_limit_tokens: Some(OUTPUT_LIMIT_TOKENS),
        context_window_source: Some("provider_metadata".to_string()),
        context_limits_updated_at: Some(updated_at.clone()),
    })
    .collect()
}

fn new_installation_identity() -> InstallationIdentity {
    InstallationIdentity {
        installation_id: format!("macro_{}", uuid::Uuid::new_v4().simple()),
        installation_proof: format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        ),
    }
}

fn load_or_create_installation_identity() -> Result<InstallationIdentity, String> {
    if let Some(serialized) = secrets::get_api_key(INSTALLATION_IDENTITY_SECRET_ID)
        .map_err(|error| format!("Failed to read the Macro AI installation identity: {error}"))?
    {
        return serde_json::from_str(&serialized).map_err(|error| {
            format!("Failed to parse the Macro AI installation identity: {error}")
        });
    }

    let identity = new_installation_identity();
    let serialized = serde_json::to_string(&identity).map_err(|error| {
        format!("Failed to serialize the Macro AI installation identity: {error}")
    })?;
    secrets::set_api_key(INSTALLATION_IDENTITY_SECRET_ID, &serialized)
        .map_err(|error| format!("Failed to store the Macro AI installation identity: {error}"))?;
    Ok(identity)
}

async fn ensure_managed_provider_and_model(pool: &SqlitePool) -> Result<(), String> {
    repository::update_provider_config(
        pool,
        UpdateProviderConfigInput {
            id: PROVIDER_ID.to_string(),
            name: Some(PROVIDER_NAME.to_string()),
            provider_type: Some("openai".to_string()),
            base_url: Some(PROVIDER_BASE_URL.to_string()),
            api_key: None,
            is_local: Some(false),
            is_enabled: Some(true),
        },
    )
    .await
    .map_err(|error| format!("Failed to configure the Macro AI provider: {error}"))?;

    repository::upsert_provider_models(
        pool,
        PROVIDER_ID,
        &managed_models(),
    )
    .await
    .map_err(|error| format!("Failed to configure the Macro AI model: {error}"))?;
    Ok(())
}

pub async fn provision(pool: &SqlitePool) -> Result<MacroAiProvisioningStatus, String> {
    ensure_managed_provider_and_model(pool).await?;

    if secrets::get_api_key(PROVIDER_ID)
        .map_err(|error| format!("Failed to read the Macro AI access token: {error}"))?
        .is_some()
    {
        repository::set_provider_has_stored_api_key(pool, PROVIDER_ID, true)
            .await
            .map_err(|error| error.to_string())?;
        return Ok(MacroAiProvisioningStatus {
            provider_id: PROVIDER_ID.to_string(),
            model_id: DEFAULT_MODEL_ID.to_string(),
            context_window_tokens: CONTEXT_WINDOW_TOKENS,
            activated_now: false,
        });
    }

    let identity = load_or_create_installation_identity()?;
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| format!("Failed to prepare Macro AI activation: {error}"))?;
    let response = client
        .post(BOOTSTRAP_URL)
        .json(&BootstrapRequest {
            installation_id: &identity.installation_id,
            installation_proof: &identity.installation_proof,
            client_version: env!("CARGO_PKG_VERSION"),
            platform: std::env::consts::OS,
        })
        .send()
        .await
        .map_err(|error| format!("Macro AI activation is currently unavailable: {error}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let error = response
            .json::<BootstrapError>()
            .await
            .ok()
            .and_then(|payload| payload.error)
            .unwrap_or_else(|| "the activation service returned an error".to_string());
        return Err(format!("Macro AI activation failed ({status}): {error}"));
    }

    let payload = response
        .json::<BootstrapResponse>()
        .await
        .map_err(|error| format!("Macro AI returned an invalid activation response: {error}"))?;
    if payload.access_token.trim().is_empty()
        || payload.model != DEFAULT_MODEL_ID
        || payload.context_window_tokens != CONTEXT_WINDOW_TOKENS
    {
        return Err("Macro AI returned inconsistent activation metadata.".to_string());
    }

    secrets::set_api_key(PROVIDER_ID, payload.access_token.trim())
        .map_err(|error| format!("Failed to store the Macro AI access token: {error}"))?;
    repository::set_provider_has_stored_api_key(pool, PROVIDER_ID, true)
        .await
        .map_err(|error| error.to_string())?;

    Ok(MacroAiProvisioningStatus {
        provider_id: PROVIDER_ID.to_string(),
        model_id: DEFAULT_MODEL_ID.to_string(),
        context_window_tokens: CONTEXT_WINDOW_TOKENS,
        activated_now: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installation_identity_has_stable_safe_shapes() {
        let identity = new_installation_identity();
        assert!(identity.installation_id.starts_with("macro_"));
        assert_eq!(identity.installation_id.len(), 38);
        assert_eq!(identity.installation_proof.len(), 64);
        assert!(identity
            .installation_proof
            .chars()
            .all(|character| character.is_ascii_hexdigit()));
    }

    #[test]
    fn managed_catalog_exposes_fast_and_deep_models_with_the_same_context() {
        let models = managed_models();

        assert_eq!(PROVIDER_NAME, "Andrologic");
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].model_id, DEFAULT_MODEL_ID);
        assert_eq!(models[0].name, FAST_MODEL_NAME);
        assert_eq!(models[1].model_id, DEEP_MODEL_ID);
        assert_eq!(models[1].name, DEEP_MODEL_NAME);
        assert!(models.iter().all(|model| {
            model.context_window_tokens == Some(CONTEXT_WINDOW_TOKENS)
                && model.input_limit_tokens == Some(INPUT_LIMIT_TOKENS)
                && model.output_limit_tokens == Some(OUTPUT_LIMIT_TOKENS)
        }));
    }
}
