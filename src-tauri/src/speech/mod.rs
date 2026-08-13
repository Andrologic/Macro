mod deepgram;
mod openai_compatible;

use crate::db::models::SpeechProviderConfig;
use serde::{Deserialize, Serialize};

pub const MAX_AUDIO_BYTES: usize = 25 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct TranscriptionRequest {
    pub audio: Vec<u8>,
    pub mime_type: String,
    pub file_name: String,
    pub language: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionResult {
    pub text: String,
    pub language: Option<String>,
    pub duration_seconds: Option<f64>,
}

#[derive(Debug, thiserror::Error)]
pub enum SpeechError {
    #[error("Speech provider is disabled.")]
    ProviderDisabled,
    #[error("The speech provider requires an API key.")]
    MissingApiKey,
    #[error("The recorded audio is empty.")]
    EmptyAudio,
    #[error("The recorded audio exceeds Macro's 25 MB limit.")]
    AudioTooLarge,
    #[error("Unsupported speech provider type: {0}")]
    UnsupportedProvider(String),
    #[error("Speech provider request failed: {0}")]
    Request(String),
    #[error("Speech provider returned an invalid response: {0}")]
    InvalidResponse(String),
}

pub async fn transcribe(
    provider: &SpeechProviderConfig,
    api_key: Option<&str>,
    request: TranscriptionRequest,
) -> Result<TranscriptionResult, SpeechError> {
    if !provider.is_enabled {
        return Err(SpeechError::ProviderDisabled);
    }
    if request.audio.is_empty() {
        return Err(SpeechError::EmptyAudio);
    }
    if request.audio.len() > MAX_AUDIO_BYTES {
        return Err(SpeechError::AudioTooLarge);
    }
    if !provider.is_local && api_key.is_none_or(|value| value.trim().is_empty()) {
        return Err(SpeechError::MissingApiKey);
    }

    match provider.provider_type.as_str() {
        "openai" | "openai-compatible" => {
            openai_compatible::transcribe(provider, api_key, request).await
        }
        "deepgram" => deepgram::transcribe(provider, api_key, request).await,
        other => Err(SpeechError::UnsupportedProvider(other.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn provider() -> SpeechProviderConfig {
        SpeechProviderConfig {
            id: "provider".to_string(),
            name: "Provider".to_string(),
            provider_type: "openai-compatible".to_string(),
            base_url: "http://localhost:8080/v1".to_string(),
            model: "whisper-1".to_string(),
            has_stored_api_key: false,
            is_enabled: true,
            is_local: true,
            created_at: "now".to_string(),
            updated_at: "now".to_string(),
        }
    }

    #[test]
    fn serializes_provider_contract_with_frontend_camel_case_keys() {
        let value = serde_json::to_value(provider()).expect("provider json");
        assert_eq!(value["providerType"], "openai-compatible");
        assert_eq!(value["hasStoredApiKey"], false);
        assert_eq!(value["isLocal"], true);
        assert!(value.get("provider_type").is_none());
    }

    #[tokio::test]
    async fn rejects_empty_audio_before_contacting_a_provider() {
        let error = transcribe(
            &provider(),
            None,
            TranscriptionRequest {
                audio: Vec::new(),
                mime_type: "audio/webm".to_string(),
                file_name: "empty.webm".to_string(),
                language: None,
            },
        )
        .await
        .expect_err("empty audio must fail");
        assert!(matches!(error, SpeechError::EmptyAudio));
    }
}
