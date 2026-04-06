use super::auth::build_oauth_form_body;
use super::types::{
    db_error_to_string, extract_response_error, PersistChatGptSessionError, TokenClaims,
    TokenResponse, CHATGPT_CLIENT_ID, CHATGPT_TOKEN_URL, TOKEN_REFRESH_LEEWAY_SECONDS,
};
use crate::db::models::{ProviderAuthMetadata, ProviderConfig};
use crate::db::repository;
use crate::secrets::{self, ChatGptSecret};
use base64::engine::general_purpose::{URL_SAFE, URL_SAFE_NO_PAD};
use base64::Engine;
use chrono::{DateTime, TimeZone, Utc};
use reqwest::header::CONTENT_TYPE;
use serde_json::Value;
use sqlx::SqlitePool;
use tracing::{debug, error, info, warn};

pub async fn migrate_provider_secret(pool: &SqlitePool, provider_id: &str) -> Result<(), String> {
    let Some(secret) =
        secrets::migrate_legacy_chatgpt_secret(provider_id).map_err(|error| error.to_string())?
    else {
        return Ok(());
    };

    let existing = repository::get_provider_config(pool, provider_id)
        .await
        .map_err(db_error_to_string)?;
    let metadata = build_provider_auth_metadata(
        &secret,
        existing
            .as_ref()
            .and_then(|provider| provider.plan_type.clone()),
        existing
            .as_ref()
            .and_then(|provider| provider.account_label.clone()),
    )?;
    repository::update_provider_auth_metadata(pool, provider_id, &metadata)
        .await
        .map_err(db_error_to_string)?;
    Ok(())
}

pub(super) async fn ensure_fresh_secret(
    pool: &SqlitePool,
    provider_id: &str,
) -> Result<ChatGptSecret, String> {
    migrate_provider_secret(pool, provider_id).await?;

    let secret = secrets::get_chatgpt_secret(provider_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "ChatGPT is not linked. Use Connect with ChatGPT first.".to_string())?;

    let expires_at = secret
        .access_token_expires_at
        .as_deref()
        .and_then(parse_rfc3339_utc)
        .or_else(|| {
            build_token_claims(&secret.access_token, None)
                .ok()?
                .expires_at
        });
    let needs_refresh = expires_at
        .map(|value| value <= Utc::now() + chrono::Duration::seconds(TOKEN_REFRESH_LEEWAY_SECONDS))
        .unwrap_or(true);

    if !needs_refresh {
        return Ok(secret);
    }

    force_refresh_secret(pool, provider_id, &secret).await
}

pub(super) async fn force_refresh_secret(
    pool: &SqlitePool,
    provider_id: &str,
    secret: &ChatGptSecret,
) -> Result<ChatGptSecret, String> {
    info!(provider_id = %provider_id, "refreshing ChatGPT access token");
    let existing = repository::get_provider_config(pool, provider_id)
        .await
        .map_err(db_error_to_string)?;
    let refreshed = refresh_secret(secret).await?;
    let metadata = build_provider_auth_metadata(
        &refreshed,
        existing
            .as_ref()
            .and_then(|provider| provider.plan_type.clone()),
        existing
            .as_ref()
            .and_then(|provider| provider.account_label.clone()),
    )?;
    if let Err(error) = secrets::set_chatgpt_secret(provider_id, &refreshed) {
        error!(
            provider_id = %provider_id,
            phase = "refresh_persist",
            error = %error,
            "failed to persist refreshed ChatGPT secret"
        );
        return Err(error.to_string());
    }
    if let Err(error) =
        repository::update_provider_auth_metadata(pool, provider_id, &metadata).await
    {
        error!(
            provider_id = %provider_id,
            phase = "refresh_persist",
            error = %error,
            "failed to persist refreshed ChatGPT auth metadata"
        );
        return Err(db_error_to_string(error));
    }
    info!(
        provider_id = %provider_id,
        has_account_id = refreshed.account_id.is_some(),
        "ChatGPT token refresh completed"
    );
    Ok(refreshed)
}

async fn refresh_secret(secret: &ChatGptSecret) -> Result<ChatGptSecret, String> {
    let refresh_token = secret.refresh_token.trim();
    if refresh_token.is_empty() {
        return Err("Refresh token is missing. Reconnect with ChatGPT.".to_string());
    }

    let client = reqwest::Client::new();
    debug!("sending ChatGPT token refresh request");
    let response = client
        .post(CHATGPT_TOKEN_URL)
        .header(CONTENT_TYPE, "application/x-www-form-urlencoded")
        .body(build_oauth_form_body(&[
            ("client_id", CHATGPT_CLIENT_ID),
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
        ]))
        .send()
        .await
        .map_err(|error| format!("Failed to refresh ChatGPT token: {}", error))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        warn!(
            status = status.as_u16(),
            response_error = %extract_response_error(status.as_u16(), &body),
            "ChatGPT token refresh returned non-success status"
        );
        return Err(extract_response_error(status.as_u16(), &body));
    }

    let payload: TokenResponse = response
        .json()
        .await
        .map_err(|error| format!("Failed to parse token refresh response: {}", error))?;
    debug!(
        has_refresh_token = payload
            .refresh_token
            .as_deref()
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false),
        has_id_token = payload
            .id_token
            .as_deref()
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false),
        "parsed ChatGPT token refresh response"
    );

    let access_token = payload
        .access_token
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Token refresh did not return an access token.".to_string())?;
    let claims = build_token_claims(&access_token, payload.id_token.as_deref())?;

    Ok(ChatGptSecret {
        access_token,
        refresh_token: payload
            .refresh_token
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| secret.refresh_token.clone()),
        access_token_expires_at: resolve_token_expiry_rfc3339(
            claims.expires_at,
            payload.expires_in,
        ),
        account_id: secret.account_id.clone().or(claims.account_id),
        auth_source: secret.auth_source.clone(),
    })
}

pub(super) async fn persist_chatgpt_session(
    pool: &SqlitePool,
    provider_id: &str,
    secret: &ChatGptSecret,
    plan_type: Option<String>,
    account_label: Option<String>,
) -> Result<ProviderConfig, PersistChatGptSessionError> {
    let metadata = build_provider_auth_metadata(secret, plan_type, account_label)
        .map_err(PersistChatGptSessionError::Metadata)?;
    debug!(
        provider_id = %provider_id,
        phase = "secret_persist",
        has_account_id = secret.account_id.is_some(),
        "persisting ChatGPT session secret"
    );
    if let Err(error) = secrets::set_chatgpt_secret(provider_id, secret) {
        error!(
            provider_id = %provider_id,
            phase = "secret_persist",
            error = %error,
            "failed to persist ChatGPT session secret"
        );
        return Err(PersistChatGptSessionError::Secret(error.to_string()));
    }
    if let Err(error) =
        repository::update_provider_auth_metadata(pool, provider_id, &metadata).await
    {
        error!(
            provider_id = %provider_id,
            phase = "metadata_persist",
            error = %error,
            "failed to persist ChatGPT auth metadata"
        );
        return Err(PersistChatGptSessionError::Metadata(db_error_to_string(
            error,
        )));
    }

    repository::get_provider_config(pool, provider_id)
        .await
        .map_err(|error| PersistChatGptSessionError::Metadata(db_error_to_string(error)))?
        .ok_or_else(|| {
            PersistChatGptSessionError::Metadata(format!("Provider {provider_id} not found."))
        })
}

pub(super) fn build_provider_auth_metadata(
    secret: &ChatGptSecret,
    fallback_plan_type: Option<String>,
    fallback_account_label: Option<String>,
) -> Result<ProviderAuthMetadata, String> {
    let claims = build_token_claims(&secret.access_token, None)?;
    let token_expires_at = secret.access_token_expires_at.clone().or_else(|| {
        claims
            .expires_at
            .map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
    });
    let expires_at = token_expires_at.as_deref().and_then(parse_rfc3339_utc);
    let status = match expires_at {
        Some(expires_at) if expires_at <= Utc::now() => "expired",
        _ => "authenticated",
    };
    let account_label = claims
        .email
        .or(fallback_account_label)
        .or_else(|| secret.account_id.clone())
        .filter(|value| !value.trim().is_empty());

    Ok(ProviderAuthMetadata {
        auth_status: Some(status.to_string()),
        auth_source: Some(secret.auth_source.clone()),
        plan_type: claims.plan_type.or(fallback_plan_type),
        account_label,
        token_expires_at,
    })
}

pub(super) fn build_token_claims(
    access_token: &str,
    id_token: Option<&str>,
) -> Result<TokenClaims, String> {
    let access_payload = decode_jwt_payload(access_token)?;
    let id_payload = match id_token {
        Some(token) => Some(decode_jwt_payload(token)?),
        None => None,
    };
    let access_auth = access_payload.get("https://api.openai.com/auth");
    let id_auth = id_payload
        .as_ref()
        .and_then(|payload| payload.get("https://api.openai.com/auth"));
    let access_profile = access_payload.get("https://api.openai.com/profile");

    let expires_at = access_payload
        .get("exp")
        .and_then(Value::as_i64)
        .and_then(|timestamp| Utc.timestamp_opt(timestamp, 0).single());
    let plan_type = value_string(access_auth, "chatgpt_plan_type")
        .or_else(|| value_string(id_auth, "chatgpt_plan_type"));
    let account_id = value_string(access_auth, "chatgpt_account_id")
        .or_else(|| value_string(id_auth, "chatgpt_account_id"));
    let email = id_payload
        .as_ref()
        .and_then(|payload| value_string(Some(payload), "email"))
        .or_else(|| value_string(access_profile, "email"));

    Ok(TokenClaims {
        expires_at,
        plan_type,
        account_id,
        email,
    })
}

pub(super) fn decode_jwt_payload(token: &str) -> Result<Value, String> {
    let payload = token
        .split('.')
        .nth(1)
        .ok_or_else(|| "JWT payload is missing.".to_string())?;

    let decoded = URL_SAFE_NO_PAD
        .decode(payload)
        .or_else(|_| URL_SAFE.decode(payload))
        .map_err(|error| format!("Failed to decode JWT payload: {}", error))?;
    serde_json::from_slice::<Value>(&decoded)
        .map_err(|error| format!("Failed to parse JWT payload: {}", error))
}

fn value_string(value: Option<&Value>, key: &str) -> Option<String> {
    value
        .and_then(|payload| payload.get(key))
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|item| !item.trim().is_empty())
}

pub(super) fn resolve_token_expiry_rfc3339(
    claims_expiry: Option<DateTime<Utc>>,
    expires_in: Option<i64>,
) -> Option<String> {
    claims_expiry
        .or_else(|| expires_in.map(|seconds| Utc::now() + chrono::Duration::seconds(seconds)))
        .map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
}

fn parse_rfc3339_utc(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|date| date.with_timezone(&Utc))
}
