use super::{command_error, get_pool, provider_mutation_lock, CommandResult, DbPool};
use crate::config::{
    ConfigChangeSource, ConfigDocumentKind, ConfigManager, ConfigPatchRequest, ConfigScope,
    JsonPatchOperation,
};
use crate::db::models::*;
use crate::{ai::macro_ai, secrets, speech};
use serde::Deserialize;
use serde_json::Value;
use tauri::{ipc::InvokeBody, ipc::Request, State};

const SECRET_PREFIX: &str = "speech:";

fn secret_id(provider_id: &str) -> String {
    format!("{SECRET_PREFIX}{provider_id}")
}

fn is_managed_provider(provider_id: &str) -> bool {
    provider_id == macro_ai::SPEECH_PROVIDER_ID
}

async fn configured_speech_providers(
    manager: &ConfigManager,
) -> CommandResult<Vec<SpeechProviderConfig>> {
    let document = manager
        .effective_user_document(ConfigDocumentKind::Providers)
        .await;
    let definitions = document
        .get("speechProviders")
        .and_then(Value::as_object)
        .ok_or_else(|| command_error("providers.json ne contient pas de registre vocal valide."))?;
    let now = chrono::Utc::now().to_rfc3339();
    let mut providers = Vec::with_capacity(definitions.len());
    for (id, definition) in definitions {
        let has_stored_api_key = if is_managed_provider(id) {
            macro_ai::access_token().map_err(command_error)?.is_some()
        } else {
            secrets::get_api_key(&secret_id(id))
                .map_err(|error| command_error(error.to_string()))?
                .is_some()
        };
        providers.push(SpeechProviderConfig {
            id: id.clone(),
            name: definition
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(id)
                .to_string(),
            provider_type: definition
                .get("providerType")
                .and_then(Value::as_str)
                .unwrap_or("openai-compatible")
                .to_string(),
            base_url: definition
                .get("baseUrl")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            model: definition
                .get("model")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            has_stored_api_key,
            is_enabled: definition
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            is_local: definition
                .get("isLocal")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            created_at: now.clone(),
            updated_at: now.clone(),
        });
    }
    providers.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(providers)
}

async fn patch_speech_providers(
    manager: &ConfigManager,
    providers: serde_json::Map<String, Value>,
) -> CommandResult<()> {
    let document = manager
        .get_document(ConfigDocumentKind::Providers, ConfigScope::User)
        .await
        .map_err(|error| command_error(error.message))?;
    manager
        .apply_patch(ConfigPatchRequest {
            kind: ConfigDocumentKind::Providers,
            scope: ConfigScope::User,
            expected_etag: document.etag,
            patch: vec![JsonPatchOperation {
                op: "add".to_string(),
                path: "/speechProviders".to_string(),
                from: None,
                value: Some(Value::Object(providers)),
            }],
            source: ConfigChangeSource::UserInterface,
        })
        .await
        .map_err(|error| command_error(error.message))?;
    Ok(())
}

fn validate_provider_fields(
    name: &str,
    provider_type: &str,
    base_url: &str,
    model: &str,
    is_local: bool,
) -> CommandResult<()> {
    if name.trim().is_empty() || base_url.trim().is_empty() || model.trim().is_empty() {
        return Err(command_error(
            "Speech provider name, base URL, and model are required.",
        ));
    }
    if !matches!(
        provider_type.trim(),
        "openai" | "openai-compatible" | "deepgram"
    ) {
        return Err(command_error(format!(
            "Unsupported speech provider type: {}",
            provider_type.trim()
        )));
    }
    let parsed = reqwest::Url::parse(base_url.trim())
        .map_err(|_| command_error("Speech provider base URL must be a valid URL."))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(command_error(
            "Speech provider base URL must use HTTP or HTTPS.",
        ));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(command_error(
            "Speech provider base URLs must not contain credentials.",
        ));
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err(command_error(
            "Speech provider base URLs must not contain a query or fragment.",
        ));
    }
    if !is_local && parsed.scheme() != "https" {
        return Err(command_error(
            "Remote speech provider base URLs must use HTTPS.",
        ));
    }
    Ok(())
}

fn header(request: &Request<'_>, name: &str) -> CommandResult<String> {
    request
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| command_error(format!("Missing speech request header: {name}")))
}

#[tauri::command]
pub async fn speech_list_provider_configs(
    pool: State<'_, DbPool>,
    config_manager: State<'_, ConfigManager>,
) -> CommandResult<Vec<SpeechProviderConfig>> {
    let _pool = get_pool(&pool).await?;
    configured_speech_providers(config_manager.inner()).await
}

#[tauri::command]
pub async fn speech_create_provider_config(
    pool: State<'_, DbPool>,
    config_manager: State<'_, ConfigManager>,
    name: String,
    provider_type: String,
    base_url: String,
    model: String,
    api_key: Option<String>,
    is_local: bool,
    is_enabled: bool,
) -> CommandResult<SpeechProviderConfig> {
    validate_provider_fields(&name, &provider_type, &base_url, &model, is_local)?;
    let _pool = get_pool(&pool).await?;
    let lock = provider_mutation_lock("speech:create");
    let _guard = lock.lock().await;
    let id = format!("speech-{}", uuid::Uuid::new_v4().simple());
    let document = config_manager
        .effective_user_document(ConfigDocumentKind::Providers)
        .await;
    let mut providers = document
        .get("speechProviders")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    providers.insert(
        id.clone(),
        serde_json::json!({
            "providerType": provider_type.trim(),
            "name": name.trim(),
            "baseUrl": base_url.trim(),
            "model": model.trim(),
            "enabled": is_enabled,
            "isLocal": is_local
        }),
    );
    patch_speech_providers(config_manager.inner(), providers.clone()).await?;

    if let Some(api_key) = api_key.filter(|value| !value.trim().is_empty()) {
        if let Err(error) = secrets::set_api_key(&secret_id(&id), api_key.trim()) {
            providers.remove(&id);
            if let Err(patch_error) =
                patch_speech_providers(config_manager.inner(), providers).await
            {
                tracing::error!(
                    "Failed to roll back speech provider {} after API key persistence error: {patch_error:?}",
                    id
                );
            }
            return Err(command_error(format!(
                "Failed to persist speech provider API key: {error}"
            )));
        }
    }
    configured_speech_providers(config_manager.inner())
        .await?
        .into_iter()
        .find(|provider| provider.id == id)
        .ok_or_else(|| command_error("Le fournisseur vocal créé est introuvable."))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSpeechProviderParams {
    id: String,
    name: Option<String>,
    provider_type: Option<String>,
    base_url: Option<String>,
    model: Option<String>,
    api_key: Option<String>,
    is_local: Option<bool>,
    is_enabled: Option<bool>,
}

#[tauri::command]
pub async fn speech_update_provider_config(
    pool: State<'_, DbPool>,
    config_manager: State<'_, ConfigManager>,
    params: UpdateSpeechProviderParams,
) -> CommandResult<()> {
    if is_managed_provider(&params.id) {
        return Err(command_error(
            "The managed Andrologic speech provider cannot be edited.",
        ));
    }
    let _pool = get_pool(&pool).await?;
    let lock = provider_mutation_lock(&secret_id(&params.id));
    let _guard = lock.lock().await;
    let previous = configured_speech_providers(config_manager.inner())
        .await?
        .into_iter()
        .find(|provider| provider.id == params.id)
        .ok_or_else(|| command_error(format!("Speech provider {} not found.", params.id)))?;
    let next_name = params.name.as_deref().unwrap_or(&previous.name);
    let next_type = params
        .provider_type
        .as_deref()
        .unwrap_or(&previous.provider_type);
    let next_base_url = params.base_url.as_deref().unwrap_or(&previous.base_url);
    let next_model = params.model.as_deref().unwrap_or(&previous.model);
    let next_is_local = params.is_local.unwrap_or(previous.is_local);
    validate_provider_fields(
        next_name,
        next_type,
        next_base_url,
        next_model,
        next_is_local,
    )?;
    let previous_api_key = if params.api_key.is_some() {
        secrets::get_api_key(&secret_id(&params.id)).map_err(|error| {
            command_error(format!("Failed to access speech provider API key: {error}"))
        })?
    } else {
        None
    };
    if let Some(api_key) = params.api_key.as_deref() {
        if api_key.trim().is_empty() {
            secrets::delete_api_key(&secret_id(&params.id))
        } else {
            secrets::set_api_key(&secret_id(&params.id), api_key.trim())
        }
        .map_err(|error| command_error(format!("Failed to update speech secret: {error}")))?;
    }

    let document = config_manager
        .effective_user_document(ConfigDocumentKind::Providers)
        .await;
    let mut providers = document
        .get("speechProviders")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    providers.insert(
        params.id.clone(),
        serde_json::json!({
            "providerType": next_type.trim(),
            "name": next_name.trim(),
            "baseUrl": next_base_url.trim(),
            "model": next_model.trim(),
            "enabled": params.is_enabled.unwrap_or(previous.is_enabled),
            "isLocal": next_is_local
        }),
    );
    if let Err(error) = patch_speech_providers(config_manager.inner(), providers).await {
        if params.api_key.is_some() {
            let _ = match previous_api_key {
                Some(previous) => secrets::set_api_key(&secret_id(&params.id), &previous),
                None => secrets::delete_api_key(&secret_id(&params.id)),
            };
        }
        return Err(error);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{is_managed_provider, validate_provider_fields};
    use crate::ai::macro_ai;

    #[test]
    fn rejects_plain_http_for_remote_speech_providers() {
        let error = validate_provider_fields(
            "Remote",
            "openai-compatible",
            "http://speech.example.com/v1",
            "whisper-1",
            false,
        )
        .expect_err("remote HTTP endpoint must fail");

        assert!(error.message.contains("HTTPS"));
    }

    #[test]
    fn permits_plain_http_for_explicit_local_speech_providers() {
        validate_provider_fields(
            "Local",
            "openai-compatible",
            "http://127.0.0.1:8080/v1",
            "whisper-1",
            true,
        )
        .expect("local HTTP endpoint should be supported");
    }

    #[test]
    fn rejects_credentials_embedded_in_speech_provider_urls() {
        let error = validate_provider_fields(
            "Provider",
            "openai-compatible",
            "https://user:password@speech.example.com/v1",
            "whisper-1",
            false,
        )
        .expect_err("URL credentials must fail");

        assert!(error.message.contains("credentials"));
    }

    #[test]
    fn recognizes_only_the_managed_andrologic_speech_provider() {
        assert!(is_managed_provider(macro_ai::SPEECH_PROVIDER_ID));
        assert!(!is_managed_provider(macro_ai::PROVIDER_ID));
        assert!(!is_managed_provider("openai-speech"));
    }
}

#[tauri::command]
pub async fn speech_delete_provider_config(
    pool: State<'_, DbPool>,
    config_manager: State<'_, ConfigManager>,
    id: String,
) -> CommandResult<()> {
    if id == "openai-speech" || is_managed_provider(&id) {
        return Err(command_error(
            "Default and managed speech providers cannot be deleted.",
        ));
    }
    let _pool = get_pool(&pool).await?;
    let lock = provider_mutation_lock(&secret_id(&id));
    let _guard = lock.lock().await;
    configured_speech_providers(config_manager.inner())
        .await?
        .into_iter()
        .find(|provider| provider.id == id)
        .ok_or_else(|| command_error(format!("Speech provider {id} not found.")))?;
    let document = config_manager
        .effective_user_document(ConfigDocumentKind::Providers)
        .await;
    let mut providers = document
        .get("speechProviders")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    providers.remove(&id);
    let previous_secret = secrets::get_api_key(&secret_id(&id)).map_err(|error| {
        command_error(format!("Failed to access speech provider API key: {error}"))
    })?;
    secrets::delete_api_key(&secret_id(&id))
        .map_err(|error| command_error(format!("Failed to delete speech secret: {error}")))?;
    if let Err(error) = patch_speech_providers(config_manager.inner(), providers).await {
        if let Some(previous_secret) = previous_secret.as_deref() {
            if let Err(restore_error) = secrets::set_api_key(&secret_id(&id), previous_secret) {
                tracing::error!(
                    "Failed to restore speech secret for {id} after failed config update: {restore_error}"
                );
            }
        }
        return Err(error);
    }
    Ok(())
}

#[tauri::command]
pub async fn speech_transcribe(
    pool: State<'_, DbPool>,
    config_manager: State<'_, ConfigManager>,
    request: Request<'_>,
) -> CommandResult<speech::TranscriptionResult> {
    let provider_id = header(&request, "x-macro-speech-provider-id")?;
    let mime_type = header(&request, "x-macro-speech-mime-type")?;
    let file_name = header(&request, "x-macro-speech-file-name")?;
    let language = request
        .headers()
        .get("x-macro-speech-language")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "auto")
        .map(str::to_string);
    let audio = match request.body() {
        InvokeBody::Raw(bytes) => bytes.clone(),
        InvokeBody::Json(_) => {
            return Err(command_error(
                "Speech transcription requires a binary audio body.",
            ))
        }
    };

    let pool = get_pool(&pool).await?;
    let provider = configured_speech_providers(config_manager.inner())
        .await?
        .into_iter()
        .find(|provider| provider.id == provider_id)
        .ok_or_else(|| command_error(format!("Speech provider {provider_id} not found.")))?;
    let api_key = if is_managed_provider(&provider_id) {
        Some(
            macro_ai::ensure_access_token(&pool)
                .await
                .map_err(command_error)?,
        )
    } else {
        secrets::get_api_key(&secret_id(&provider_id)).map_err(|error| {
            command_error(format!("Failed to access speech provider API key: {error}"))
        })?
    };

    speech::transcribe(
        &provider,
        api_key.as_deref(),
        speech::TranscriptionRequest {
            audio,
            mime_type,
            file_name,
            language,
        },
    )
    .await
    .map_err(|error| command_error(error.to_string()))
}
