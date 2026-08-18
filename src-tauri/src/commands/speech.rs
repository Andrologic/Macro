use super::{command_error, get_pool, provider_mutation_lock, CommandResult, DbPool};
use crate::db::{models::*, repository};
use crate::{ai::macro_ai, secrets, speech};
use serde::Deserialize;
use tauri::{ipc::InvokeBody, ipc::Request, State};

const SECRET_PREFIX: &str = "speech:";

fn secret_id(provider_id: &str) -> String {
    format!("{SECRET_PREFIX}{provider_id}")
}

fn is_managed_provider(provider_id: &str) -> bool {
    provider_id == macro_ai::SPEECH_PROVIDER_ID
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

async fn apply_api_key_change(
    pool: &sqlx::SqlitePool,
    provider_id: &str,
    api_key: Option<&str>,
    previous_api_key: Option<&str>,
) -> CommandResult<Option<bool>> {
    let Some(api_key) = api_key else {
        return Ok(None);
    };
    let has_key = !api_key.trim().is_empty();
    let key_id = secret_id(provider_id);
    let secret_result = if has_key {
        secrets::set_api_key(&key_id, api_key.trim())
    } else {
        secrets::delete_api_key(&key_id)
    };
    secret_result.map_err(|error| {
        command_error(format!("Failed to update speech provider API key: {error}"))
    })?;

    if let Err(error) =
        repository::set_speech_provider_has_stored_api_key(pool, provider_id, has_key).await
    {
        let _ = match previous_api_key {
            Some(previous) => secrets::set_api_key(&key_id, previous),
            None => secrets::delete_api_key(&key_id),
        };
        return Err(super::CommandError::from(error));
    }
    Ok(Some(has_key))
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
) -> CommandResult<Vec<SpeechProviderConfig>> {
    let pool = get_pool(&pool).await?;
    let mut providers = repository::list_speech_provider_configs(&pool)
        .await
        .map_err(super::CommandError::from)?;

    for provider in &mut providers {
        let has_key = if is_managed_provider(&provider.id) {
            macro_ai::access_token().map_err(command_error)?.is_some()
        } else {
            secrets::get_api_key(&secret_id(&provider.id))
                .map_err(|error| command_error(error.to_string()))?
                .is_some()
        };
        if has_key != provider.has_stored_api_key {
            repository::set_speech_provider_has_stored_api_key(&pool, &provider.id, has_key)
                .await
                .map_err(super::CommandError::from)?;
            provider.has_stored_api_key = has_key;
        }
    }

    Ok(providers)
}

#[tauri::command]
pub async fn speech_create_provider_config(
    pool: State<'_, DbPool>,
    name: String,
    provider_type: String,
    base_url: String,
    model: String,
    api_key: Option<String>,
    is_local: bool,
    is_enabled: bool,
) -> CommandResult<SpeechProviderConfig> {
    validate_provider_fields(&name, &provider_type, &base_url, &model, is_local)?;
    let pool = get_pool(&pool).await?;
    let lock = provider_mutation_lock("speech:create");
    let _guard = lock.lock().await;
    let mut created = repository::create_speech_provider_config(
        &pool,
        name.trim(),
        provider_type.trim(),
        base_url.trim(),
        model.trim(),
        is_local,
        is_enabled,
    )
    .await
    .map_err(super::CommandError::from)?;

    if let Some(api_key) = api_key.filter(|value| !value.trim().is_empty()) {
        if let Err(error) = apply_api_key_change(&pool, &created.id, Some(&api_key), None).await {
            let _ = repository::delete_speech_provider_config(&pool, &created.id).await;
            return Err(error);
        }
        created.has_stored_api_key = true;
    }

    Ok(created)
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
    params: UpdateSpeechProviderParams,
) -> CommandResult<()> {
    if is_managed_provider(&params.id) {
        return Err(command_error(
            "The managed Andrologic speech provider cannot be edited.",
        ));
    }
    let pool = get_pool(&pool).await?;
    let lock = provider_mutation_lock(&secret_id(&params.id));
    let _guard = lock.lock().await;
    let previous = repository::get_speech_provider_config(&pool, &params.id)
        .await
        .map_err(super::CommandError::from)?
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
    repository::update_speech_provider_config(
        &pool,
        UpdateSpeechProviderConfigInput {
            id: params.id.clone(),
            name: params.name.map(|value| value.trim().to_string()),
            provider_type: params.provider_type.map(|value| value.trim().to_string()),
            base_url: params.base_url.map(|value| value.trim().to_string()),
            model: params.model.map(|value| value.trim().to_string()),
            is_local: params.is_local,
            is_enabled: params.is_enabled,
        },
    )
    .await
    .map_err(super::CommandError::from)?;

    if let Err(error) = apply_api_key_change(
        &pool,
        &params.id,
        params.api_key.as_deref(),
        previous_api_key.as_deref(),
    )
    .await
    {
        let _ = repository::update_speech_provider_config(
            &pool,
            UpdateSpeechProviderConfigInput {
                id: previous.id,
                name: Some(previous.name),
                provider_type: Some(previous.provider_type),
                base_url: Some(previous.base_url),
                model: Some(previous.model),
                is_local: Some(previous.is_local),
                is_enabled: Some(previous.is_enabled),
            },
        )
        .await;
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
    id: String,
) -> CommandResult<()> {
    if id == "openai-speech" || is_managed_provider(&id) {
        return Err(command_error(
            "Default and managed speech providers cannot be deleted.",
        ));
    }
    let pool = get_pool(&pool).await?;
    let lock = provider_mutation_lock(&secret_id(&id));
    let _guard = lock.lock().await;
    repository::get_speech_provider_config(&pool, &id)
        .await
        .map_err(super::CommandError::from)?
        .ok_or_else(|| command_error(format!("Speech provider {id} not found.")))?;
    let previous_api_key = secrets::get_api_key(&secret_id(&id)).map_err(|error| {
        command_error(format!("Failed to access speech provider API key: {error}"))
    })?;
    secrets::delete_api_key(&secret_id(&id)).map_err(|error| {
        command_error(format!("Failed to delete speech provider API key: {error}"))
    })?;
    if let Err(error) = repository::delete_speech_provider_config(&pool, &id).await {
        if let Some(previous_api_key) = previous_api_key {
            let _ = secrets::set_api_key(&secret_id(&id), &previous_api_key);
        }
        return Err(super::CommandError::from(error));
    }
    Ok(())
}

#[tauri::command]
pub async fn speech_transcribe(
    pool: State<'_, DbPool>,
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
    let provider = repository::get_speech_provider_config(&pool, &provider_id)
        .await
        .map_err(super::CommandError::from)?
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
