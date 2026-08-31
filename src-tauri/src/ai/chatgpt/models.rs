use super::codex_files::{load_cached_model_entries, resolve_codex_client_version};
use super::lock_auth_mutation;
use super::session::ensure_fresh_secret;
use super::types::{
    db_error_to_string, extract_response_error, ModelsCacheEntry, RemoteModelsResponse,
    DEFAULT_ORIGINATOR,
};
use crate::ai::reasoning_catalog::resolve_reasoning_capability;
use crate::db::models::{AiModel, ProviderAuthMetadata, ProviderConfig, ProviderModelInput};
use crate::db::repository;
use crate::secrets::{self, ChatGptSecret};
use reqwest::header::{ACCEPT, AUTHORIZATION};
use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};
use tracing::{debug, error, info, warn};

const DISCONNECT_JOURNAL_PREFIX: &str = "chatgpt.auth_disconnect:";

fn sqlx_error_to_string(error: sqlx::Error) -> String {
    error.to_string()
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DurableDisconnectIntent {
    provider_id: String,
    created_at: String,
}

fn disconnect_journal_key(provider_id: &str) -> String {
    format!("{DISCONNECT_JOURNAL_PREFIX}{provider_id}")
}

fn disconnected_metadata() -> ProviderAuthMetadata {
    ProviderAuthMetadata {
        auth_status: Some("unauthenticated".to_string()),
        auth_source: None,
        plan_type: None,
        account_label: None,
        token_expires_at: None,
    }
}

async fn prepare_disconnect(
    pool: &SqlitePool,
    provider_id: &str,
    metadata: &ProviderAuthMetadata,
) -> Result<(), String> {
    let intent = serde_json::to_string(&DurableDisconnectIntent {
        provider_id: provider_id.to_string(),
        created_at: chrono::Utc::now().to_rfc3339(),
    })
    .map_err(|error| error.to_string())?;
    let journal_key = disconnect_journal_key(provider_id);
    let now = chrono::Utc::now().to_rfc3339();
    let mut transaction = pool.begin().await.map_err(sqlx_error_to_string)?;
    sqlx::query(
        r#"
        INSERT INTO app_settings (key, value_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
        "#,
    )
    .bind(&journal_key)
    .bind(intent)
    .bind(&now)
    .execute(&mut *transaction)
    .await
    .map_err(sqlx_error_to_string)?;
    let updated = sqlx::query(
        r#"
        UPDATE provider_configs
        SET auth_status = ?, auth_source = ?, plan_type = ?, account_label = ?,
            token_expires_at = ?, updated_at = ?
        WHERE id = ?
        "#,
    )
    .bind(&metadata.auth_status)
    .bind(&metadata.auth_source)
    .bind(&metadata.plan_type)
    .bind(&metadata.account_label)
    .bind(&metadata.token_expires_at)
    .bind(&now)
    .bind(provider_id)
    .execute(&mut *transaction)
    .await
    .map_err(sqlx_error_to_string)?;
    if updated.rows_affected() != 1 {
        return Err(format!("Provider {provider_id} not found."));
    }
    transaction.commit().await.map_err(sqlx_error_to_string)
}

async fn rollback_prepared_disconnect(
    pool: &SqlitePool,
    provider_id: &str,
    expected: &ProviderAuthMetadata,
    previous: &ProviderAuthMetadata,
) -> Result<bool, String> {
    let mut transaction = pool.begin().await.map_err(sqlx_error_to_string)?;
    let now = chrono::Utc::now().to_rfc3339();
    let restored = sqlx::query(
        r#"
        UPDATE provider_configs
        SET auth_status = ?, auth_source = ?, plan_type = ?, account_label = ?,
            token_expires_at = ?, updated_at = ?
        WHERE id = ?
          AND auth_status IS ? AND auth_source IS ? AND plan_type IS ?
          AND account_label IS ? AND token_expires_at IS ?
        "#,
    )
    .bind(&previous.auth_status)
    .bind(&previous.auth_source)
    .bind(&previous.plan_type)
    .bind(&previous.account_label)
    .bind(&previous.token_expires_at)
    .bind(&now)
    .bind(provider_id)
    .bind(&expected.auth_status)
    .bind(&expected.auth_source)
    .bind(&expected.plan_type)
    .bind(&expected.account_label)
    .bind(&expected.token_expires_at)
    .execute(&mut *transaction)
    .await
    .map_err(sqlx_error_to_string)?;
    if restored.rows_affected() == 1 {
        sqlx::query("DELETE FROM app_settings WHERE key = ?")
            .bind(disconnect_journal_key(provider_id))
            .execute(&mut *transaction)
            .await
            .map_err(sqlx_error_to_string)?;
    }
    transaction.commit().await.map_err(sqlx_error_to_string)?;
    Ok(restored.rows_affected() == 1)
}

async fn finish_disconnect(pool: &SqlitePool, provider_id: &str) -> Result<(), String> {
    sqlx::query("DELETE FROM app_settings WHERE key = ?")
        .bind(disconnect_journal_key(provider_id))
        .execute(pool)
        .await
        .map_err(sqlx_error_to_string)?;
    Ok(())
}

pub(super) async fn recover_pending_disconnect_locked(
    pool: &SqlitePool,
    provider_id: &str,
) -> Result<(), String> {
    let journal_key = disconnect_journal_key(provider_id);
    let Some(setting) = repository::get_app_setting(pool, &journal_key)
        .await
        .map_err(db_error_to_string)?
    else {
        return Ok(());
    };
    let intent: DurableDisconnectIntent = serde_json::from_str(&setting.value_json)
        .map_err(|error| format!("Le journal de déconnexion ChatGPT est invalide : {error}"))?;
    if intent.provider_id != provider_id {
        return Err("Le journal de déconnexion ChatGPT cible un autre fournisseur.".to_string());
    }

    if let Err(delete_error) = secrets::delete_provider_secret(provider_id) {
        match secrets::reload_chatgpt_secret(provider_id) {
            Ok(None) => {
                warn!(
                    provider_id = %provider_id,
                    error = %delete_error,
                    "ChatGPT secret deletion reported an error after the canonical secret was removed"
                );
            }
            Ok(Some(_)) => return Err(delete_error.to_string()),
            Err(read_error) => {
                return Err(format!(
                    "{delete_error} Impossible de vérifier l’état canonique du secret après l’échec : {read_error}"
                ));
            }
        }
    }
    let mut transaction = pool.begin().await.map_err(sqlx_error_to_string)?;
    let metadata = disconnected_metadata();
    let now = chrono::Utc::now().to_rfc3339();
    sqlx::query(
        r#"
        UPDATE provider_configs
        SET auth_status = ?, auth_source = ?, plan_type = ?, account_label = ?,
            token_expires_at = ?, updated_at = ?
        WHERE id = ?
        "#,
    )
    .bind(&metadata.auth_status)
    .bind(&metadata.auth_source)
    .bind(&metadata.plan_type)
    .bind(&metadata.account_label)
    .bind(&metadata.token_expires_at)
    .bind(&now)
    .bind(provider_id)
    .execute(&mut *transaction)
    .await
    .map_err(sqlx_error_to_string)?;
    sqlx::query("DELETE FROM app_settings WHERE key = ?")
        .bind(&journal_key)
        .execute(&mut *transaction)
        .await
        .map_err(sqlx_error_to_string)?;
    transaction.commit().await.map_err(sqlx_error_to_string)
}

pub(crate) async fn recover_auth_mutations(pool: &SqlitePool) -> Result<(), String> {
    let rows = sqlx::query("SELECT value_json FROM app_settings WHERE key LIKE ?")
        .bind(format!("{DISCONNECT_JOURNAL_PREFIX}%"))
        .fetch_all(pool)
        .await
        .map_err(sqlx_error_to_string)?;
    for row in rows {
        let value_json: String = row.get("value_json");
        let intent: DurableDisconnectIntent = serde_json::from_str(&value_json)
            .map_err(|error| format!("Le journal de déconnexion ChatGPT est invalide : {error}"))?;
        let _auth_guard = lock_auth_mutation(&intent.provider_id).await?;
        recover_pending_disconnect_locked(pool, &intent.provider_id).await?;
    }
    Ok(())
}

pub async fn disconnect_auth(
    pool: &SqlitePool,
    provider_id: &str,
) -> Result<ProviderConfig, String> {
    disconnect_auth_with_secret_delete(pool, provider_id, |provider_id| {
        secrets::delete_provider_secret(provider_id).map_err(|error| error.to_string())
    })
    .await
}

async fn disconnect_auth_with_secret_delete<F>(
    pool: &SqlitePool,
    provider_id: &str,
    delete_secret: F,
) -> Result<ProviderConfig, String>
where
    F: FnOnce(&str) -> Result<(), String>,
{
    let _auth_guard = lock_auth_mutation(provider_id).await?;
    recover_pending_disconnect_locked(pool, provider_id).await?;
    let provider = repository::get_provider_config(pool, provider_id)
        .await
        .map_err(db_error_to_string)?
        .ok_or_else(|| format!("Provider {provider_id} not found."))?;
    let previous_secret = secrets::reload_chatgpt_secret(provider_id)
        .map_err(|error| format!("Impossible de lire le secret ChatGPT canonique : {error}"))?;
    let previous_metadata = ProviderAuthMetadata {
        auth_status: provider.auth_status,
        auth_source: provider.auth_source,
        plan_type: provider.plan_type,
        account_label: provider.account_label,
        token_expires_at: provider.token_expires_at,
    };
    let disconnected_metadata = disconnected_metadata();
    prepare_disconnect(pool, provider_id, &disconnected_metadata).await?;
    if let Err(secret_error) = delete_secret(provider_id) {
        match secrets::reload_chatgpt_secret(provider_id) {
            Ok(None) => {
                warn!(
                    provider_id = %provider_id,
                    error = %secret_error,
                    "ChatGPT secret deletion reported an error after the canonical secret was removed"
                );
                finish_disconnect(pool, provider_id).await?;
                return repository::get_provider_config(pool, provider_id)
                    .await
                    .map_err(db_error_to_string)?
                    .ok_or_else(|| format!("Provider {provider_id} not found."));
            }
            Ok(Some(current_secret)) if previous_secret.as_ref() == Some(&current_secret) => {}
            Ok(Some(_)) => {
                return Err(format!(
                    "{secret_error} Le secret ChatGPT a changé pendant la suppression. La déconnexion reste en attente et les métadonnées authentifiées n’ont pas été restaurées."
                ));
            }
            Err(read_error) => {
                return Err(format!(
                    "{secret_error} Impossible de vérifier l’état canonique du secret après l’échec : {read_error}. La déconnexion reste en attente."
                ));
            }
        }
        return match rollback_prepared_disconnect(
            pool,
            provider_id,
            &disconnected_metadata,
            &previous_metadata,
        )
        .await
        {
            Ok(true) => Err(secret_error),
            Ok(false) => Err(format!(
                "{secret_error} Les métadonnées d’authentification ont changé pendant la compensation et n’ont pas été écrasées."
            )),
            Err(rollback_error) => Err(format!(
                "{secret_error} La restauration des métadonnées d’authentification a aussi échoué : {}",
                rollback_error
            )),
        };
    }
    finish_disconnect(pool, provider_id).await?;

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
                    "ChatGPT remote model fetch failed, using local Codex cache"
                );
                models
            }
            Err(cache_error) => {
                error!(
                    provider_id = %provider_id,
                    client_version = %client_version,
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

    repository::replace_discovered_provider_models(pool, provider_id, &models)
        .await
        .map_err(db_error_to_string)?;

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
        .map(|entry| {
            let supported_reasoning_efforts =
                entry.supported_reasoning_levels.as_ref().map(|levels| {
                    levels
                        .iter()
                        .map(|level| level.effort.clone())
                        .collect::<Vec<_>>()
                });
            let reasoning = resolve_reasoning_capability(
                Some("chatgpt"),
                Some(&entry.slug),
                None,
                supported_reasoning_efforts.as_deref(),
                entry.default_reasoning_level.as_deref(),
            );

            ProviderModelInput {
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
                reasoning_efforts: if reasoning.reasoning_efforts.is_empty() {
                    None
                } else {
                    Some(reasoning.reasoning_efforts)
                },
                context_window_tokens: None,
                input_limit_tokens: None,
                output_limit_tokens: None,
                context_window_source: None,
                context_limits_updated_at: None,
                default_reasoning_effort: reasoning.default_reasoning_effort,
            }
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

#[cfg(test)]
mod tests {
    use super::{
        disconnect_auth_with_secret_delete, disconnect_journal_key, disconnected_metadata,
        prepare_disconnect, recover_auth_mutations,
    };
    use crate::ai::chatgpt::lock_auth_mutation;
    use crate::ai::chatgpt::session::{
        ensure_fresh_secret, install_persist_after_secret_hook, persist_chatgpt_session,
    };
    use crate::core::process::background_command;
    use crate::secrets::ChatGptSecret;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine;
    use sqlx::{sqlite::SqlitePoolOptions, Row, SqlitePool};
    use std::sync::{Arc, Mutex};

    fn test_access_token() -> String {
        let payload = URL_SAFE_NO_PAD.encode(
            serde_json::json!({
                "exp": 4_102_444_800_i64,
                "https://api.openai.com/auth": {
                    "chatgpt_account_id": "acct-new",
                    "chatgpt_plan_type": "plus"
                },
                "https://api.openai.com/profile": {
                    "email": "new@example.com"
                }
            })
            .to_string(),
        );
        format!("header.{payload}.signature")
    }

    fn test_secret() -> ChatGptSecret {
        ChatGptSecret {
            access_token: test_access_token(),
            refresh_token: "refresh-old".to_string(),
            access_token_expires_at: Some("2100-01-01T00:00:00Z".to_string()),
            account_id: Some("acct-old".to_string()),
            auth_source: "browser".to_string(),
        }
    }

    async fn provider_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("provider pool");
        sqlx::query(
            r#"
            CREATE TABLE provider_configs (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                provider_type TEXT NOT NULL,
                base_url TEXT NOT NULL,
                has_stored_api_key INTEGER NOT NULL,
                is_enabled INTEGER NOT NULL,
                is_local INTEGER NOT NULL,
                auth_status TEXT,
                auth_source TEXT,
                plan_type TEXT,
                account_label TEXT,
                token_expires_at TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            "#,
        )
        .execute(&pool)
        .await
        .expect("provider schema");
        sqlx::query(
            r#"
            CREATE TABLE app_settings (
                key TEXT PRIMARY KEY,
                value_json TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            "#,
        )
        .execute(&pool)
        .await
        .expect("app settings schema");
        sqlx::query(
            r#"
            INSERT INTO provider_configs (
                id, name, provider_type, base_url, has_stored_api_key, is_enabled, is_local,
                auth_status, auth_source, plan_type, account_label, token_expires_at,
                created_at, updated_at
            ) VALUES (?, ?, ?, ?, 0, 1, 0, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind("chatgpt")
        .bind("ChatGPT")
        .bind("chatgpt")
        .bind("https://chatgpt.com/backend-api")
        .bind("authenticated")
        .bind("browser")
        .bind("plus")
        .bind("user@example.com")
        .bind("2026-09-01T00:00:00Z")
        .bind("2026-08-30T00:00:00Z")
        .bind("2026-08-30T00:00:00Z")
        .execute(&pool)
        .await
        .expect("provider row");
        pool
    }

    #[tokio::test]
    async fn disconnect_keeps_the_secret_when_the_sql_update_fails() {
        let _store_guard = crate::secrets::lock_test_store();
        let temp = tempfile::tempdir().expect("secret tempdir");
        crate::secrets::init(temp.path()).expect("initialize secret store");
        let pool = provider_pool().await;
        let secret = test_secret();
        crate::secrets::set_chatgpt_secret("chatgpt", &secret).expect("persist secret");
        sqlx::query(
            r#"
            CREATE TRIGGER reject_provider_disconnect
            BEFORE UPDATE ON provider_configs
            BEGIN
                SELECT RAISE(FAIL, 'injected provider update failure');
            END
            "#,
        )
        .execute(&pool)
        .await
        .expect("failure trigger");
        let deleted = Arc::new(Mutex::new(false));
        let deleted_for_call = deleted.clone();

        disconnect_auth_with_secret_delete(&pool, "chatgpt", move |_| {
            *deleted_for_call.lock().expect("delete flag") = true;
            Ok(())
        })
        .await
        .expect_err("SQL update must fail");

        assert!(!*deleted.lock().expect("delete flag"));
        assert!(
            crate::db::repository::get_app_setting(&pool, &disconnect_journal_key("chatgpt"))
                .await
                .expect("journal query")
                .is_none()
        );
        assert_eq!(
            crate::secrets::reload_chatgpt_secret("chatgpt").expect("reload secret"),
            Some(secret)
        );
    }

    #[tokio::test]
    async fn disconnect_restores_sql_metadata_when_secret_deletion_fails() {
        let _store_guard = crate::secrets::lock_test_store();
        let temp = tempfile::tempdir().expect("secret tempdir");
        crate::secrets::init(temp.path()).expect("initialize secret store");
        let pool = provider_pool().await;
        let secret = test_secret();
        crate::secrets::set_chatgpt_secret("chatgpt", &secret).expect("persist secret");

        disconnect_auth_with_secret_delete(&pool, "chatgpt", |_| {
            Err("injected secret deletion failure".to_string())
        })
        .await
        .expect_err("secret deletion must fail");

        let row = sqlx::query(
            "SELECT auth_status, auth_source, plan_type, account_label FROM provider_configs WHERE id = ?",
        )
        .bind("chatgpt")
        .fetch_one(&pool)
        .await
        .expect("restored provider");
        assert_eq!(
            row.get::<Option<String>, _>("auth_status").as_deref(),
            Some("authenticated")
        );
        assert_eq!(
            row.get::<Option<String>, _>("auth_source").as_deref(),
            Some("browser")
        );
        assert_eq!(
            row.get::<Option<String>, _>("plan_type").as_deref(),
            Some("plus")
        );
        assert_eq!(
            row.get::<Option<String>, _>("account_label").as_deref(),
            Some("user@example.com")
        );
        assert_eq!(
            crate::secrets::reload_chatgpt_secret("chatgpt").expect("reload secret"),
            Some(secret)
        );
    }

    #[tokio::test]
    async fn a_later_ambiguous_disconnect_cannot_restore_metadata_after_success() {
        let _store_guard = crate::secrets::lock_test_store();
        let temp = tempfile::tempdir().expect("secret tempdir");
        crate::secrets::init(temp.path()).expect("initialize secret store");
        let pool = provider_pool().await;
        crate::secrets::set_chatgpt_secret("chatgpt", &test_secret()).expect("persist secret");
        let success = disconnect_auth_with_secret_delete(&pool, "chatgpt", |provider_id| {
            crate::secrets::delete_provider_secret(provider_id).map_err(|error| error.to_string())
        });
        let failure = disconnect_auth_with_secret_delete(&pool, "chatgpt", |_| {
            Err("injected concurrent secret deletion failure".to_string())
        });
        let (success, failure) = tokio::join!(success, failure);
        assert!(success.is_ok());
        assert!(failure.is_ok());

        let provider = crate::db::repository::get_provider_config(&pool, "chatgpt")
            .await
            .expect("provider query")
            .expect("provider");
        assert_eq!(provider.auth_status.as_deref(), Some("unauthenticated"));
        assert!(provider.auth_source.is_none());
    }

    #[tokio::test]
    async fn ambiguous_secret_delete_finishes_disconnect_when_canonical_secret_is_absent() {
        let _store_guard = crate::secrets::lock_test_store();
        let temp = tempfile::tempdir().expect("secret tempdir");
        crate::secrets::init(temp.path()).expect("initialize secret store");
        let pool = provider_pool().await;
        crate::secrets::set_chatgpt_secret("chatgpt", &test_secret()).expect("persist secret");

        let provider = disconnect_auth_with_secret_delete(&pool, "chatgpt", |provider_id| {
            crate::secrets::delete_provider_secret(provider_id)
                .map_err(|error| error.to_string())?;
            Err("injected error after durable secret deletion".to_string())
        })
        .await
        .expect("canonical absence must finish the disconnect");

        assert_eq!(provider.auth_status.as_deref(), Some("unauthenticated"));
        assert!(provider.auth_source.is_none());
        assert!(crate::secrets::reload_chatgpt_secret("chatgpt")
            .expect("reload canonical secret")
            .is_none());
        assert!(
            crate::db::repository::get_app_setting(&pool, &disconnect_journal_key("chatgpt"))
                .await
                .expect("journal query")
                .is_none()
        );
    }

    #[tokio::test]
    async fn connect_and_disconnect_share_the_entire_auth_persistence_lock() {
        let _store_guard = crate::secrets::lock_test_store();
        let temp = tempfile::tempdir().expect("secret tempdir");
        crate::secrets::init(temp.path()).expect("initialize secret store");
        let pool = provider_pool().await;
        let reached = Arc::new(tokio::sync::Barrier::new(2));
        let release = Arc::new(tokio::sync::Barrier::new(2));
        install_persist_after_secret_hook("chatgpt".to_string(), reached.clone(), release.clone());
        let secret = ChatGptSecret {
            access_token: test_access_token(),
            refresh_token: "refresh-new".to_string(),
            access_token_expires_at: Some("2100-01-01T00:00:00Z".to_string()),
            account_id: Some("acct-new".to_string()),
            auth_source: "browser".to_string(),
        };

        let connect_pool = pool.clone();
        let mut connect = tokio::spawn(async move {
            persist_chatgpt_session(
                &connect_pool,
                "chatgpt",
                &secret,
                Some("plus".to_string()),
                Some("new@example.com".to_string()),
            )
            .await
        });
        tokio::select! {
            _ = reached.wait() => {}
            result = &mut connect => panic!("connect finished before the secret hook: {result:?}"),
            _ = tokio::time::sleep(std::time::Duration::from_secs(5)) => panic!("connect did not reach the secret hook"),
        }

        let disconnect_pool = pool.clone();
        let mut disconnect = tokio::spawn(async move {
            disconnect_auth_with_secret_delete(&disconnect_pool, "chatgpt", |provider_id| {
                crate::secrets::delete_provider_secret(provider_id)
                    .map_err(|error| error.to_string())
            })
            .await
        });
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(150), &mut disconnect)
                .await
                .is_err(),
            "disconnect must wait while the connection is between secret and SQL persistence"
        );
        release.wait().await;

        connect
            .await
            .expect("connect task")
            .expect("connect session");
        disconnect
            .await
            .expect("disconnect task")
            .expect("disconnect session");

        assert!(crate::secrets::get_chatgpt_secret("chatgpt")
            .expect("read final secret")
            .is_none());
        let provider = crate::db::repository::get_provider_config(&pool, "chatgpt")
            .await
            .expect("provider query")
            .expect("provider");
        assert_eq!(provider.auth_status.as_deref(), Some("unauthenticated"));
        assert!(provider.auth_source.is_none());
    }

    #[tokio::test]
    async fn auth_mutation_lock_child() {
        let Ok(directory) = std::env::var("MACRO_TEST_CHATGPT_AUTH_LOCK_DIRECTORY") else {
            return;
        };
        let directory = std::path::PathBuf::from(directory);
        crate::secrets::init(&directory).expect("initialize child secret store");
        std::fs::write(directory.join("child-started"), b"started").expect("signal child start");
        let _guard = lock_auth_mutation("chatgpt")
            .await
            .expect("child auth mutation lock");
        std::fs::write(directory.join("child-acquired"), b"acquired")
            .expect("signal child acquisition");
    }

    #[tokio::test]
    async fn auth_mutation_lock_serializes_an_independent_process() {
        let _store_guard = crate::secrets::lock_test_store();
        let temp = tempfile::tempdir().expect("secret tempdir");
        crate::secrets::init(temp.path()).expect("initialize parent secret store");
        let guard = lock_auth_mutation("chatgpt")
            .await
            .expect("parent auth mutation lock");
        let mut child =
            background_command(std::env::current_exe().expect("current test executable"))
                .args([
                    "--exact",
                    "ai::chatgpt::models::tests::auth_mutation_lock_child",
                    "--nocapture",
                ])
                .env("MACRO_TEST_CHATGPT_AUTH_LOCK_DIRECTORY", temp.path())
                .spawn()
                .expect("spawn independent auth client");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !temp.path().join("child-started").exists() && std::time::Instant::now() < deadline {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(temp.path().join("child-started").exists());
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        assert!(!temp.path().join("child-acquired").exists());

        drop(guard);
        let status = child.wait().expect("wait for independent auth client");
        assert!(status.success());
        assert!(temp.path().join("child-acquired").exists());
    }

    #[tokio::test]
    async fn pending_disconnect_is_recovered_before_a_secret_can_restore_authentication() {
        let _store_guard = crate::secrets::lock_test_store();
        let temp = tempfile::tempdir().expect("secret tempdir");
        crate::secrets::init(temp.path()).expect("initialize secret store");
        let pool = provider_pool().await;
        let secret = ChatGptSecret {
            access_token: test_access_token(),
            refresh_token: "refresh-old".to_string(),
            access_token_expires_at: Some("2100-01-01T00:00:00Z".to_string()),
            account_id: Some("acct-old".to_string()),
            auth_source: "browser".to_string(),
        };
        crate::secrets::set_chatgpt_secret("chatgpt", &secret).expect("persist residual secret");
        prepare_disconnect(&pool, "chatgpt", &disconnected_metadata())
            .await
            .expect("prepare durable disconnect");

        let error = ensure_fresh_secret(&pool, "chatgpt")
            .await
            .expect_err("pending disconnect must hide and remove the residual secret");

        assert!(error.contains("not linked"));
        assert!(crate::secrets::get_chatgpt_secret("chatgpt")
            .expect("read secret")
            .is_none());
        assert!(
            crate::db::repository::get_app_setting(&pool, &disconnect_journal_key("chatgpt"))
                .await
                .expect("journal query")
                .is_none()
        );
        let provider = crate::db::repository::get_provider_config(&pool, "chatgpt")
            .await
            .expect("provider query")
            .expect("provider");
        assert_eq!(provider.auth_status.as_deref(), Some("unauthenticated"));
    }

    #[tokio::test]
    async fn startup_recovery_closes_a_disconnect_after_the_secret_was_deleted() {
        let _store_guard = crate::secrets::lock_test_store();
        let temp = tempfile::tempdir().expect("secret tempdir");
        crate::secrets::init(temp.path()).expect("initialize secret store");
        let pool = provider_pool().await;
        let secret = ChatGptSecret {
            access_token: test_access_token(),
            refresh_token: "refresh-old".to_string(),
            access_token_expires_at: Some("2100-01-01T00:00:00Z".to_string()),
            account_id: Some("acct-old".to_string()),
            auth_source: "browser".to_string(),
        };
        crate::secrets::set_chatgpt_secret("chatgpt", &secret).expect("persist secret");
        prepare_disconnect(&pool, "chatgpt", &disconnected_metadata())
            .await
            .expect("prepare durable disconnect");
        crate::secrets::delete_provider_secret("chatgpt")
            .expect("simulate durable secret deletion");

        recover_auth_mutations(&pool)
            .await
            .expect("finish startup recovery");

        assert!(
            crate::db::repository::get_app_setting(&pool, &disconnect_journal_key("chatgpt"))
                .await
                .expect("journal query")
                .is_none()
        );
        let provider = crate::db::repository::get_provider_config(&pool, "chatgpt")
            .await
            .expect("provider query")
            .expect("provider");
        assert_eq!(provider.auth_status.as_deref(), Some("unauthenticated"));
        assert!(provider.auth_source.is_none());
    }
}
