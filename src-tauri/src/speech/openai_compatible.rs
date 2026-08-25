use super::{read_provider_response, SpeechError, TranscriptionRequest, TranscriptionResult};
use crate::ai::macro_ai;
use crate::db::models::SpeechProviderConfig;
use reqwest::multipart::{Form, Part};
use serde::Deserialize;
use std::time::Duration;

const MAX_ATTEMPTS: usize = 3;
const DEFAULT_RETRY_SECONDS: u64 = 2;
const MAX_RETRY_SECONDS: u64 = 15;

#[derive(Debug, Deserialize)]
struct ProviderResponse {
    text: String,
    language: Option<String>,
    duration: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct ProviderErrorEnvelope {
    error: Option<ProviderErrorBody>,
}

#[derive(Debug, Deserialize)]
struct ProviderErrorBody {
    message: Option<String>,
}

pub(super) async fn transcribe(
    provider: &SpeechProviderConfig,
    api_key: Option<&str>,
    request: TranscriptionRequest,
) -> Result<TranscriptionResult, SpeechError> {
    let endpoint = format!(
        "{}/audio/transcriptions",
        provider.base_url.trim().trim_end_matches('/')
    );
    let timeout = if provider.id == macro_ai::SPEECH_PROVIDER_ID {
        // The gateway may wait up to ten minutes in its FIFO and then process
        // the audio for up to ten additional minutes.
        Duration::from_secs(20 * 60 + 30)
    } else {
        Duration::from_secs(90)
    };
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| SpeechError::Request(error.to_string()))?;

    for attempt in 0..MAX_ATTEMPTS {
        let audio = Part::bytes(request.audio.clone())
            .file_name(request.file_name.clone())
            .mime_str(&request.mime_type)
            .map_err(|error| SpeechError::Request(error.to_string()))?;
        let mut form = Form::new()
            .part("file", audio)
            .text("model", provider.model.clone())
            .text("response_format", "json");
        if let Some(language) = request.language.as_deref().filter(|value| *value != "auto") {
            form = form.text("language", language.to_string());
        }

        let mut request_builder = client.post(&endpoint).multipart(form);
        if let Some(api_key) = api_key.filter(|value| !value.trim().is_empty()) {
            request_builder = request_builder.bearer_auth(api_key);
        }
        let response = request_builder
            .send()
            .await
            .map_err(|error| SpeechError::Request(error.to_string()))?;
        let retry_after = response
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|value| value.to_str().ok())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let retry_seconds = retry_after
            .as_deref()
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(DEFAULT_RETRY_SECONDS)
            .clamp(1, MAX_RETRY_SECONDS);
        let (status, body) = read_provider_response(response).await?;

        if matches!(status.as_u16(), 429 | 503) && attempt + 1 < MAX_ATTEMPTS {
            tokio::time::sleep(Duration::from_secs(retry_seconds)).await;
            continue;
        }
        if !status.is_success() {
            if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
                let suffix = retry_after
                    .map(|value| format!(" Retry after {value}."))
                    .unwrap_or_default();
                return Err(SpeechError::Request(format!(
                    "The transcription service is saturated.{suffix}"
                )));
            }
            if status == reqwest::StatusCode::SERVICE_UNAVAILABLE {
                return Err(SpeechError::Request(
                    "The transcription service is temporarily unavailable.".to_string(),
                ));
            }
            let message = serde_json::from_slice::<ProviderErrorEnvelope>(&body)
                .ok()
                .and_then(|value| value.error)
                .and_then(|value| value.message)
                .unwrap_or_else(|| format!("HTTP {}", status.as_u16()));
            return Err(SpeechError::Request(message));
        }

        let parsed = serde_json::from_slice::<ProviderResponse>(&body)
            .map_err(|error| SpeechError::InvalidResponse(error.to_string()))?;
        return Ok(TranscriptionResult {
            text: parsed.text,
            language: parsed.language,
            duration_seconds: parsed.duration,
        });
    }

    unreachable!("the transcription retry loop always returns")
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::Bytes,
        extract::State,
        http::{HeaderMap, HeaderValue, StatusCode},
        routing::post,
        Json, Router,
    };
    use serde_json::json;
    use std::sync::{Arc, Mutex};

    #[derive(Clone, Default)]
    struct Capture(Arc<Mutex<Option<(HeaderMap, Vec<u8>)>>>);

    async fn handler(
        State(capture): State<Capture>,
        headers: HeaderMap,
        body: Bytes,
    ) -> Json<serde_json::Value> {
        *capture.0.lock().expect("capture lock") = Some((headers, body.to_vec()));
        Json(json!({ "text": "Bonjour Macro", "language": "fr", "duration": 1.25 }))
    }

    async fn saturated_handler() -> (StatusCode, HeaderMap, Json<serde_json::Value>) {
        let mut headers = HeaderMap::new();
        headers.insert("retry-after", HeaderValue::from_static("1"));
        (
            StatusCode::TOO_MANY_REQUESTS,
            headers,
            Json(json!({ "error": { "message": "queue full" } })),
        )
    }

    #[tokio::test]
    async fn sends_openai_compatible_multipart_audio_and_parses_the_result() {
        let capture = Capture::default();
        let app = Router::new()
            .route("/v1/audio/transcriptions", post(handler))
            .with_state(capture.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("test listener");
        let address = listener.local_addr().expect("listener address");
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.expect("test server");
        });
        let provider = SpeechProviderConfig {
            id: "test".to_string(),
            name: "Test".to_string(),
            provider_type: "openai-compatible".to_string(),
            base_url: format!("http://{address}/v1"),
            model: "whisper-test".to_string(),
            has_stored_api_key: true,
            is_enabled: true,
            is_local: false,
            created_at: "now".to_string(),
            updated_at: "now".to_string(),
        };

        let result = transcribe(
            &provider,
            Some("secret"),
            TranscriptionRequest {
                audio: b"audio-bytes".to_vec(),
                mime_type: "audio/webm".to_string(),
                file_name: "dictation.webm".to_string(),
                language: Some("fr".to_string()),
            },
        )
        .await
        .expect("transcription result");
        server.abort();

        assert_eq!(result.text, "Bonjour Macro");
        assert_eq!(result.language.as_deref(), Some("fr"));
        assert_eq!(result.duration_seconds, Some(1.25));
        let (headers, body) = capture
            .0
            .lock()
            .expect("capture lock")
            .take()
            .expect("request capture");
        assert_eq!(
            headers
                .get("authorization")
                .and_then(|value| value.to_str().ok()),
            Some("Bearer secret")
        );
        let body = String::from_utf8_lossy(&body);
        assert!(body.contains("whisper-test"));
        assert!(body.contains("dictation.webm"));
        assert!(body.contains("audio-bytes"));
        assert!(body.contains("\r\n\r\nfr\r\n"));
    }

    #[tokio::test]
    async fn preserves_retry_after_when_the_transcription_gateway_is_saturated() {
        let app = Router::new().route("/v1/audio/transcriptions", post(saturated_handler));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("test listener");
        let address = listener.local_addr().expect("listener address");
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.expect("test server");
        });
        let provider = SpeechProviderConfig {
            id: "test".to_string(),
            name: "Test".to_string(),
            provider_type: "openai-compatible".to_string(),
            base_url: format!("http://{address}/v1"),
            model: "whisper-test".to_string(),
            has_stored_api_key: true,
            is_enabled: true,
            is_local: false,
            created_at: "now".to_string(),
            updated_at: "now".to_string(),
        };

        let error = transcribe(
            &provider,
            Some("secret"),
            TranscriptionRequest {
                audio: b"audio-bytes".to_vec(),
                mime_type: "audio/wav".to_string(),
                file_name: "dictation.wav".to_string(),
                language: None,
            },
        )
        .await
        .expect_err("saturated gateway must fail");
        server.abort();

        assert!(error.to_string().contains("saturated"));
        assert!(error.to_string().contains("Retry after 1"));
    }
}
