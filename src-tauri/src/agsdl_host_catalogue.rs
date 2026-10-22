//! Effective Macro model catalogue for the qualified inline execution profile.
use crate::config::{ConfigDocumentKind, ConfigManager};
use crate::db::agsdl_execution::{failure, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeModelEdition {
    pub identity: String,
    pub version: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeModelChoice {
    pub edition: NativeModelEdition,
    pub provider_id: String,
    pub model_id: String,
    pub provider_name: String,
    pub model_name: String,
}
pub(crate) fn edition(provider: &str, model: &str) -> Result<NativeModelEdition> {
    if provider.trim().is_empty() || model.trim().is_empty() {
        return Err(failure(
            "UNSUPPORTED",
            "model",
            "Empty native model identity",
        ));
    }
    Ok(NativeModelEdition {
        identity: format!(
            "macro/native-model/p/{}/m/{}",
            URL_SAFE_NO_PAD.encode(provider.as_bytes()),
            URL_SAFE_NO_PAD.encode(model.as_bytes())
        ),
        version: "1".into(),
    })
}
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UnavailableProvider {
    pub provider_id: String,
    pub code: String,
    pub message: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeModelCatalogue {
    pub revision: String,
    pub models: Vec<NativeModelChoice>,
    pub unavailable_providers: Vec<UnavailableProvider>,
}

fn qualified_transport(provider_type: &str) -> bool {
    matches!(provider_type, "openai" | "ollama" | "lmstudio")
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NativeProviderObservation {
    pub provider_id: String,
    pub provider_type: String,
    /// Endpoint identity only. Credentials and URLs never enter the execution snapshot.
    pub endpoint_digest: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ModelCapture {
    pub catalogue: NativeModelCatalogue,
    pub providers: Vec<NativeProviderObservation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex_account_digest: Option<String>,
}

pub(crate) async fn choices(
    manager: &ConfigManager,
    pool: &SqlitePool,
) -> Result<NativeModelCatalogue> {
    let mut catalogue = capture(manager, pool).await?.catalogue;
    let status = crate::agsdl_host_codex::profile_status(manager).await;
    if status.available {
        // Model discovery uses its own empty scope; execution requalifies the
        // actual captured workspace and account before admitting native work.
        let root = manager.root().join("native-discovery").join("codex");
        std::fs::create_dir_all(&root).map_err(|_| {
            failure(
                "STORAGE",
                "model",
                "Cannot create native model discovery scope",
            )
        })?;
        match crate::agsdl_host_codex::observe(manager, &serde_json::json!({"root":root}), true)
            .await
        {
            Ok(Some((_, models, _))) => {
                for model in models {
                    catalogue.models.push(NativeModelChoice {
                        edition: edition("codex-native", &model)?,
                        provider_id: "codex-native".into(),
                        model_id: model.clone(),
                        provider_name: "Codex".into(),
                        model_name: model,
                    });
                }
            }
            Ok(None) => catalogue.unavailable_providers.push(UnavailableProvider {
                provider_id: "codex-native".into(),
                code: "CODEX_PROFILE_UNQUALIFIED".into(),
                message: "Native Codex profile is unavailable".into(),
            }),
            Err(error) => catalogue.unavailable_providers.push(UnavailableProvider {
                provider_id: "codex-native".into(),
                code: error.code,
                message: error.message,
            }),
        }
    } else {
        catalogue.unavailable_providers.push(UnavailableProvider {
            provider_id: "codex-native".into(),
            code: status.code,
            message: "Native Codex prerequisites are unavailable".into(),
        });
    }
    catalogue
        .models
        .sort_by(|a, b| (&a.provider_id, &a.model_id).cmp(&(&b.provider_id, &b.model_id)));
    catalogue
        .unavailable_providers
        .sort_by(|a, b| a.provider_id.cmp(&b.provider_id));
    catalogue.revision = format!(
        "sha256:{:x}",
        Sha256::digest(serde_json::to_vec(&(
            &catalogue.models,
            &catalogue.unavailable_providers
        ))?)
    );
    Ok(catalogue)
}

pub(crate) async fn capture(manager: &ConfigManager, pool: &SqlitePool) -> Result<ModelCapture> {
    let document = manager
        .effective_user_document(ConfigDocumentKind::Providers)
        .await;
    if document
        .get("providers")
        .and_then(|providers| providers.get("codex-native"))
        .is_some_and(|provider| provider["deleted"] != true)
    {
        return Err(failure(
            "RESERVED_PROVIDER_ID",
            "model",
            "Provider ID codex-native is reserved for the isolated native Codex engine",
        ));
    }
    let providers = crate::commands::configured_provider_configs(manager, pool)
        .await
        .map_err(|_| {
            failure(
                "UNSUPPORTED",
                "model",
                "Effective provider catalogue unavailable",
            )
        })?;
    let mut transaction = pool.begin().await?;
    let mut models = Vec::new();
    let mut observations = Vec::new();
    let mut unavailable_providers = Vec::new();
    let mut identities = std::collections::BTreeSet::new();
    for provider in providers {
        // In particular, do not call ChatGPT available_models: it may recover auth state.
        if !qualified_transport(&provider.provider_type) {
            unavailable_providers.push(UnavailableProvider {
                provider_id: provider.id,
                code: "UNSUPPORTED".into(),
                message: "Provider transport is not qualified for the inline execution profile"
                    .into(),
            });
            continue;
        }
        if !provider.is_enabled {
            continue;
        }
        observations.push(NativeProviderObservation {
            provider_id: provider.id.clone(),
            provider_type: provider.provider_type.clone(),
            endpoint_digest: format!("sha256:{:x}", Sha256::digest(provider.base_url.as_bytes())),
        });
        let stored = crate::db::repository::list_models_by_provider_on_connection(
            &mut transaction,
            &provider.id,
        )
        .await
        .map_err(|_| failure("STORAGE", "model", "Stored model catalogue unavailable"))?;
        for model in
            crate::commands::apply_configured_model_definitions(&provider.id, stored, &document)
        {
            if !model.is_enabled {
                continue;
            }
            if !identities.insert((provider.id.clone(), model.model_id.clone())) {
                return Err(failure(
                    "UNSUPPORTED",
                    "model",
                    "Native model identity is ambiguous",
                ));
            }
            models.push(NativeModelChoice {
                edition: edition(&provider.id, &model.model_id)?,
                provider_id: provider.id.clone(),
                model_id: model.model_id,
                provider_name: provider.name.clone(),
                model_name: model.name,
            });
        }
    }
    transaction.commit().await?;
    if manager
        .effective_user_document(ConfigDocumentKind::Providers)
        .await
        != document
    {
        return Err(failure(
            "CAPTURE_CHANGED",
            "model",
            "Effective provider configuration changed during capture",
        ));
    }
    models.sort_by(|a, b| (&a.provider_id, &a.model_id).cmp(&(&b.provider_id, &b.model_id)));
    unavailable_providers.sort_by(|a, b| a.provider_id.cmp(&b.provider_id));
    let bytes = serde_json::to_vec(&(&models, &unavailable_providers))
        .map_err(|_| failure("UNSUPPORTED", "model", "Model catalogue cannot be encoded"))?;
    observations.sort_by(|a, b| a.provider_id.cmp(&b.provider_id));
    Ok(ModelCapture {
        codex_account_digest: None,
        providers: observations,
        catalogue: NativeModelCatalogue {
            revision: format!("sha256:{:x}", Sha256::digest(bytes)),
            models,
            unavailable_providers,
        },
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn http_provider_cannot_claim_the_native_codex_namespace_before_catalogue_or_secret_lookup(
    ) {
        let temp = tempfile::tempdir().unwrap();
        use crate::config::{
            ConfigChangeSource, ConfigPatchRequest, ConfigScope, JsonPatchOperation,
        };
        let manager = ConfigManager::initialize(temp.path().to_path_buf())
            .await
            .unwrap();
        let document = manager
            .get_document(ConfigDocumentKind::Providers, ConfigScope::User)
            .await
            .unwrap();
        manager.apply_patch(ConfigPatchRequest {kind:ConfigDocumentKind::Providers,scope:ConfigScope::User,expected_etag:document.etag,
            patch:vec![JsonPatchOperation {op:"add".into(),path:"/providers".into(),from:None,value:Some(serde_json::json!({"codex-native":{"name":"Synthetic HTTP collision","providerType":"openai","baseUrl":"https://synthetic.invalid","enabled":true}}))}],source:ConfigChangeSource::UserInterface}).await.unwrap();
        // No product schema or secret store is initialized: the namespace must
        // be refused before either one is consulted.
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        assert_eq!(
            capture(&manager, &pool).await.unwrap_err().code,
            "RESERVED_PROVIDER_ID"
        );
        assert_eq!(
            choices(&manager, &pool).await.unwrap_err().code,
            "RESERVED_PROVIDER_ID"
        );
    }
    #[test]
    fn effective_manual_models_use_the_same_overrides_as_chat() {
        let document = serde_json::json!({
            "manualModels": {
                "row-id": {"providerId":"p", "modelId":"native/model", "displayName":"Original"},
                "foreign": {"providerId":"other", "modelId":"foreign"}
            },
            "modelOverrides": {
                "native/model": {"displayName":"Fallback", "enabled":false},
                "p/native/model": {"displayName":"Configured", "enabled":true, "contextWindow":4096}
            }
        });
        let models = crate::commands::apply_configured_model_definitions("p", vec![], &document);
        assert_eq!(models.len(), 1);
        let model = &models[0];
        assert_eq!(model.id, "config:row-id");
        assert_eq!(model.model_id, "native/model");
        assert_eq!(model.name, "Configured");
        assert!(model.is_enabled);
        assert_eq!(model.context_window_tokens, Some(4096));
        assert!(model.is_manual);
    }
    #[test]
    fn catalogue_transport_profile_has_no_unknown_fallback() {
        for unsupported in ["chatgpt", "copilot", "anthropic", "", "OpenAI"] {
            assert!(!qualified_transport(unsupported));
        }
        for qualified in ["openai", "ollama", "lmstudio"] {
            assert!(qualified_transport(qualified));
        }
    }
    #[test]
    fn edition_keeps_pair_identity_and_utf8_without_delimiter_ambiguity() {
        let a = edition("provider/a", "modèle /β").unwrap();
        assert_ne!(a, edition("provider", "a/modèle /β").unwrap());
        assert_ne!(a, edition("Provider/a", "modèle /β").unwrap());
        assert_eq!(a.version, "1");
        let fields: Vec<_> = a.identity.split('/').collect();
        assert_eq!(fields.len(), 6);
        assert_eq!(
            String::from_utf8(URL_SAFE_NO_PAD.decode(fields[3]).unwrap()).unwrap(),
            "provider/a"
        );
        assert_eq!(
            String::from_utf8(URL_SAFE_NO_PAD.decode(fields[5]).unwrap()).unwrap(),
            "modèle /β"
        );
    }
}
