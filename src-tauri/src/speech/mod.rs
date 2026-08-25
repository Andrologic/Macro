mod deepgram;
mod openai_compatible;

use crate::db::models::SpeechProviderConfig;
use futures::StreamExt;
use serde::{Deserialize, Serialize};

pub const MAX_AUDIO_BYTES: usize = 25 * 1024 * 1024;
const MAX_PROVIDER_RESPONSE_BYTES: usize = 1024 * 1024;

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
    #[error("Remote speech provider base URLs must use HTTPS.")]
    InsecureRemoteEndpoint,
    #[error("Speech provider response exceeds Macro's 1 MB limit.")]
    ResponseTooLarge,
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
    let endpoint = reqwest::Url::parse(provider.base_url.trim())
        .map_err(|error| SpeechError::Request(error.to_string()))?;
    if !endpoint.username().is_empty()
        || endpoint.password().is_some()
        || endpoint.query().is_some()
        || endpoint.fragment().is_some()
    {
        return Err(SpeechError::Request(
            "Speech provider base URL contains unsupported credentials, query, or fragment."
                .to_string(),
        ));
    }
    if !provider.is_local && endpoint.scheme() != "https" {
        return Err(SpeechError::InsecureRemoteEndpoint);
    }

    match provider.provider_type.as_str() {
        "openai" | "openai-compatible" => {
            openai_compatible::transcribe(provider, api_key, request).await
        }
        "deepgram" => deepgram::transcribe(provider, api_key, request).await,
        other => Err(SpeechError::UnsupportedProvider(other.to_string())),
    }
}

async fn read_provider_response(
    response: reqwest::Response,
) -> Result<(reqwest::StatusCode, Vec<u8>), SpeechError> {
    let status = response.status();
    if response
        .content_length()
        .is_some_and(|length| length > MAX_PROVIDER_RESPONSE_BYTES as u64)
    {
        return Err(SpeechError::ResponseTooLarge);
    }

    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| SpeechError::Request(error.to_string()))?;
        if body.len().saturating_add(chunk.len()) > MAX_PROVIDER_RESPONSE_BYTES {
            return Err(SpeechError::ResponseTooLarge);
        }
        body.extend_from_slice(&chunk);
    }
    Ok((status, body))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{routing::get, Router};

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

    #[tokio::test]
    async fn rejects_plain_http_for_remote_providers_before_sending_audio() {
        let mut remote_provider = provider();
        remote_provider.is_local = false;
        remote_provider.has_stored_api_key = true;

        let error = transcribe(
            &remote_provider,
            Some("secret"),
            TranscriptionRequest {
                audio: b"audio".to_vec(),
                mime_type: "audio/webm".to_string(),
                file_name: "audio.webm".to_string(),
                language: None,
            },
        )
        .await
        .expect_err("remote HTTP endpoint must fail");

        assert!(matches!(error, SpeechError::InsecureRemoteEndpoint));
    }

    #[tokio::test]
    async fn rejects_oversized_provider_responses() {
        let app = Router::new().route(
            "/oversized",
            get(|| async { vec![b'x'; MAX_PROVIDER_RESPONSE_BYTES + 1] }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("test listener");
        let address = listener.local_addr().expect("listener address");
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.expect("test server");
        });

        let response = reqwest::get(format!("http://{address}/oversized"))
            .await
            .expect("provider response");
        let error = read_provider_response(response)
            .await
            .expect_err("oversized response must fail");
        server.abort();

        assert!(matches!(error, SpeechError::ResponseTooLarge));
    }
}
