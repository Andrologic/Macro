use super::{SpeechError, TranscriptionRequest, TranscriptionResult};
use crate::db::models::SpeechProviderConfig;
use serde::Deserialize;
use std::time::Duration;

#[derive(Debug, Deserialize)]
struct DeepgramResponse {
    metadata: Option<DeepgramMetadata>,
    results: DeepgramResults,
}

#[derive(Debug, Deserialize)]
struct DeepgramMetadata {
    duration: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct DeepgramResults {
    channels: Vec<DeepgramChannel>,
}

#[derive(Debug, Deserialize)]
struct DeepgramChannel {
    detected_language: Option<String>,
    alternatives: Vec<DeepgramAlternative>,
}

#[derive(Debug, Deserialize)]
struct DeepgramAlternative {
    transcript: String,
}

#[derive(Debug, Deserialize)]
struct DeepgramError {
    err_msg: Option<String>,
    message: Option<String>,
}

pub(super) async fn transcribe(
    provider: &SpeechProviderConfig,
    api_key: Option<&str>,
    request: TranscriptionRequest,
) -> Result<TranscriptionResult, SpeechError> {
    let endpoint = format!(
        "{}/v1/listen",
        provider.base_url.trim().trim_end_matches('/')
    );
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(90))
        .build()
        .map_err(|error| SpeechError::Request(error.to_string()))?;
    let mut request_builder = client
        .post(endpoint)
        .query(&[("model", provider.model.as_str()), ("smart_format", "true")])
        .header(reqwest::header::CONTENT_TYPE, request.mime_type)
        .body(request.audio);
    if let Some(language) = request.language.filter(|value| value != "auto") {
        request_builder = request_builder.query(&[("language", language)]);
    }
    if let Some(api_key) = api_key.filter(|value| !value.trim().is_empty()) {
        request_builder = request_builder.header(
            reqwest::header::AUTHORIZATION,
            format!("Token {}", api_key.trim()),
        );
    }

    let response = request_builder
        .send()
        .await
        .map_err(|error| SpeechError::Request(error.to_string()))?;
    let status = response.status();
    let body = response
        .bytes()
        .await
        .map_err(|error| SpeechError::Request(error.to_string()))?;

    if !status.is_success() {
        let message = serde_json::from_slice::<DeepgramError>(&body)
            .ok()
            .and_then(|value| value.err_msg.or(value.message))
            .unwrap_or_else(|| format!("HTTP {}", status.as_u16()));
        return Err(SpeechError::Request(message));
    }

    let parsed = serde_json::from_slice::<DeepgramResponse>(&body)
        .map_err(|error| SpeechError::InvalidResponse(error.to_string()))?;
    let channel = parsed
        .results
        .channels
        .into_iter()
        .next()
        .ok_or_else(|| SpeechError::InvalidResponse("missing channel".to_string()))?;
    let text = channel
        .alternatives
        .into_iter()
        .next()
        .map(|alternative| alternative.transcript)
        .ok_or_else(|| SpeechError::InvalidResponse("missing transcript".to_string()))?;

    Ok(TranscriptionResult {
        text,
        language: channel.detected_language,
        duration_seconds: parsed.metadata.and_then(|metadata| metadata.duration),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::Bytes,
        extract::State,
        http::{HeaderMap, Uri},
        routing::post,
        Json, Router,
    };
    use serde_json::json;
    use std::sync::{Arc, Mutex};

    #[derive(Clone, Default)]
    struct Capture(Arc<Mutex<Option<(HeaderMap, Uri, Vec<u8>)>>>);

    async fn handler(
        State(capture): State<Capture>,
        headers: HeaderMap,
        uri: Uri,
        body: Bytes,
    ) -> Json<serde_json::Value> {
        *capture.0.lock().expect("capture lock") = Some((headers, uri, body.to_vec()));
        Json(json!({
            "metadata": { "duration": 2.5 },
            "results": {
                "channels": [{
                    "detected_language": "fr",
                    "alternatives": [{ "transcript": "Texte Deepgram" }]
                }]
            }
        }))
    }

    #[tokio::test]
    async fn sends_raw_audio_with_deepgram_auth_and_parses_the_first_alternative() {
        let capture = Capture::default();
        let app = Router::new()
            .route("/v1/listen", post(handler))
            .with_state(capture.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("test listener");
        let address = listener.local_addr().expect("listener address");
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.expect("test server");
        });
        let provider = SpeechProviderConfig {
            id: "deepgram-test".to_string(),
            name: "Deepgram".to_string(),
            provider_type: "deepgram".to_string(),
            base_url: format!("http://{address}"),
            model: "nova-3".to_string(),
            has_stored_api_key: true,
            is_enabled: true,
            is_local: false,
            created_at: "now".to_string(),
            updated_at: "now".to_string(),
        };

        let result = transcribe(
            &provider,
            Some("deepgram-secret"),
            TranscriptionRequest {
                audio: b"raw-audio".to_vec(),
                mime_type: "audio/webm".to_string(),
                file_name: "ignored.webm".to_string(),
                language: Some("fr".to_string()),
            },
        )
        .await
        .expect("transcription result");
        server.abort();

        assert_eq!(result.text, "Texte Deepgram");
        assert_eq!(result.language.as_deref(), Some("fr"));
        assert_eq!(result.duration_seconds, Some(2.5));
        let (headers, uri, body) = capture
            .0
            .lock()
            .expect("capture lock")
            .take()
            .expect("request capture");
        assert_eq!(
            headers
                .get("authorization")
                .and_then(|value| value.to_str().ok()),
            Some("Token deepgram-secret")
        );
        assert_eq!(
            headers
                .get("content-type")
                .and_then(|value| value.to_str().ok()),
            Some("audio/webm")
        );
        let query = uri.query().expect("query string");
        assert!(query.contains("model=nova-3"));
        assert!(query.contains("smart_format=true"));
        assert!(query.contains("language=fr"));
        assert_eq!(body, b"raw-audio");
    }
}
