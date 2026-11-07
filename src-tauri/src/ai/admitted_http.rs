//! HTTP bytes for the existing TypeScript codecs, owned until protocol result
//! and physical cleanup. No provider parser or portable capability lives here.
use super::{provider_work::ProviderWork, stream_tasks::StreamReservation};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::Arc};
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio_util::sync::CancellationToken;

// Matches the existing file/bridge transport granularity. This bounds each IPC
// body frame, not the upstream reqwest chunk allocation or the total transcript.
const BODY_FRAME_BYTES: usize = 64 * 1024;

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum HttpPart {
    Headers {
        status: u16,
        url: String,
        headers: Vec<(String, String)>,
    },
    Bytes {
        data: Vec<u8>,
    },
    End,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum HttpOutcome {
    Completed,
    Uncertain,
}

struct Entry {
    caller: String,
    receiver: Mutex<mpsc::Receiver<HttpPart>>,
    finish: Mutex<Option<oneshot::Sender<HttpOutcome>>>,
}

#[derive(Default)]
pub(crate) struct AdmittedHttp {
    entries: Mutex<HashMap<String, Arc<Entry>>>,
}

impl AdmittedHttp {
    pub(crate) async fn start(
        &self,
        caller: &str,
        id: String,
        reservation: StreamReservation,
        work: Arc<ProviderWork>,
        provider: String,
        client: reqwest::Client,
        request: reqwest::Request,
    ) -> Result<(), String> {
        let (sender, receiver) = mpsc::channel(1);
        let (finish, finished) = oneshot::channel();
        let entry = Arc::new(Entry {
            caller: caller.into(),
            receiver: Mutex::new(receiver),
            finish: Mutex::new(Some(finish)),
        });
        {
            let mut entries = self.entries.lock().await;
            if entries.contains_key(&id) {
                return Err("chat_admission_request_active".into());
            }
            entries.insert(id, entry);
        }
        let task_work = work.clone();
        reservation.spawn_with_work(work, move |cancel| async move {
            run(
                client, request, &provider, &task_work, sender, finished, cancel,
            )
            .await
        })
    }

    async fn entry(&self, caller: &str, id: &str) -> Result<Arc<Entry>, String> {
        self.entries
            .lock()
            .await
            .get(id)
            .filter(|e| e.caller == caller)
            .cloned()
            .ok_or_else(|| "chat_admission_http_handle_missing".into())
    }

    pub(crate) async fn read(&self, caller: &str, id: &str) -> Result<HttpPart, String> {
        let entry = self.entry(caller, id).await?;
        let part = entry.receiver.lock().await.recv().await;
        part.ok_or_else(|| "chat_admission_http_transport_ended".into())
    }

    pub(crate) async fn finish(
        &self,
        caller: &str,
        id: &str,
        outcome: HttpOutcome,
    ) -> Result<(), String> {
        let entry = self.entry(caller, id).await?;
        if let Some(finish) = entry.finish.lock().await.take() {
            // A task that already failed retains its durable uncertain result.
            let _ = finish.send(outcome);
        }
        Ok(())
    }

    pub(crate) async fn remove(&self, caller: &str, id: &str) {
        let mut entries = self.entries.lock().await;
        if entries.get(id).is_some_and(|e| e.caller == caller) {
            entries.remove(id);
        }
    }
}

async fn run(
    client: reqwest::Client,
    request: reqwest::Request,
    provider: &str,
    work: &ProviderWork,
    sender: mpsc::Sender<HttpPart>,
    mut finished: oneshot::Receiver<HttpOutcome>,
    cancel: CancellationToken,
) -> Result<(), String> {
    let attempt = work.attempt(provider, request.url().as_str()).await?;
    if cancel.is_cancelled() {
        return Err("HTTP cancelled before dispatch".into());
    }
    attempt.dispatched().await?;
    let mut response = tokio::select! {
        biased;
        _ = cancel.cancelled() => return Err("HTTP cancelled while awaiting headers".into()),
        _ = &mut finished => return Err("HTTP stopped before receiving headers".into()),
        response = client.execute(request) => response.map_err(|e| e.to_string())?,
    };
    let status = response.status();
    if !status.is_success() {
        attempt.http_rejection(status).await?;
    }
    let headers = response
        .headers()
        .iter()
        .map(|(name, value)| {
            Ok((
                name.as_str().to_owned(),
                value.to_str().map_err(|e| e.to_string())?.to_owned(),
            ))
        })
        .collect::<Result<Vec<_>, String>>()?;
    let headers = HttpPart::Headers {
        status: status.as_u16(),
        url: response.url().to_string(),
        headers,
    };
    tokio::select! {
        biased;
        _ = cancel.cancelled() => return Err("HTTP cancelled during delivery".into()),
        outcome = &mut finished => return protocol_result(outcome, status),
        sent = sender.send(headers) => sent.map_err(|_| "HTTP consumer closed".to_string())?,
    }
    loop {
        let chunk = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err("HTTP cancelled during body read".into()),
            outcome = &mut finished => return protocol_result(outcome, status),
            chunk = response.chunk() => chunk.map_err(|e| e.to_string())?,
        };
        let Some(chunk) = chunk else { break };
        for frame in chunk.chunks(BODY_FRAME_BYTES) {
            // Reserve before copying: a blocked consumer cannot accumulate a
            // second owned IPC frame. reqwest still owns the original chunk.
            let permit = tokio::select! {
                biased;
                _ = cancel.cancelled() => return Err("HTTP cancelled during delivery".into()),
                outcome = &mut finished => return protocol_result(outcome, status),
                permit = sender.reserve() => permit.map_err(|_| "HTTP consumer closed".to_string())?,
            };
            permit.send(HttpPart::Bytes {
                data: frame.to_vec(),
            });
        }
    }
    // Drop the response before waiting for the existing codec's terminal result.
    drop(response);
    tokio::select! {
        biased;
        _ = cancel.cancelled() => return Err("HTTP cancelled after body read".into()),
        outcome = &mut finished => return protocol_result(outcome, status),
        sent = sender.send(HttpPart::End) => sent.map_err(|_| "HTTP consumer closed".to_string())?,
    }
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err("HTTP cancelled before protocol result".into()),
        outcome = finished => protocol_result(outcome, status),
    }
}

fn protocol_result(
    outcome: Result<HttpOutcome, oneshot::error::RecvError>,
    status: reqwest::StatusCode,
) -> Result<(), String> {
    match outcome {
        Ok(HttpOutcome::Completed) if status.is_success() => Ok(()),
        _ => Err("HTTP protocol outcome is uncertain or rejected".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::{
        provider_work::tests::{fixture, HttpServer},
        AiState,
    };
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn phases(pool: &sqlx::SqlitePool) -> Vec<String> {
        sqlx::query_scalar(
            "SELECT phase FROM chat_admission_operations WHERE kind='provider' ORDER BY parent_id",
        )
        .fetch_all(pool)
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn eof_needs_the_existing_codec_result_before_the_journal_completes() {
        let (_dir, pool, _runtime, work) = fixture("http-eof").await;
        let server = HttpServer::start(vec![Some(
            "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
        )])
        .await;
        let state = AiState::default();
        let http = AdmittedHttp::default();
        let client = reqwest::Client::new();
        let request = client.post(&server.url).body("synthetic").build().unwrap();
        http.start(
            "window",
            "http-eof".into(),
            state.reserve_stream("http-eof".into()).unwrap(),
            work,
            "synthetic-provider".into(),
            client,
            request,
        )
        .await
        .unwrap();
        assert!(http.read("another-window", "http-eof").await.is_err());
        assert!(matches!(
            http.read("window", "http-eof").await.unwrap(),
            HttpPart::Headers { status: 200, .. }
        ));
        assert!(matches!(
            http.read("window", "http-eof").await.unwrap(),
            HttpPart::Bytes { .. }
        ));
        assert!(matches!(
            http.read("window", "http-eof").await.unwrap(),
            HttpPart::End
        ));
        assert_eq!(phases(&pool).await, ["dispatched", "dispatched"]);
        assert!(tokio::time::timeout(
            Duration::from_millis(30),
            state.join_stream_task("http-eof")
        )
        .await
        .is_err());
        http.finish("window", "http-eof", HttpOutcome::Completed)
            .await
            .unwrap();
        assert!(
            tokio::time::timeout(Duration::from_secs(5), state.join_stream_task("http-eof"))
                .await
                .unwrap()
                .unwrap()
                .is_ok()
        );
        assert_eq!(phases(&pool).await, ["completed", "completed"]);
        http.remove("window", "http-eof").await;
        assert!(http.read("window", "http-eof").await.is_err());
        assert_eq!(server.stop().await, 1);
    }

    #[tokio::test]
    async fn stopping_a_pending_body_read_drops_the_actual_connection_before_join() {
        let (_dir, pool, _runtime, work) = fixture("http-body").await;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            let mut buffer = [0u8; 1024];
            while !bytes.windows(4).any(|part| part == b"\r\n\r\n") {
                let n = socket.read(&mut buffer).await.unwrap();
                assert_ne!(n, 0);
                bytes.extend_from_slice(&buffer[..n]);
            }
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\nx")
                .await
                .unwrap();
            // No terminal body. The client must drop its real pending chunk future.
            loop {
                if socket.read(&mut buffer).await.unwrap() == 0 {
                    break;
                }
            }
        });
        let state = AiState::default();
        let http = AdmittedHttp::default();
        let client = reqwest::Client::new();
        let request = client.post(url).body("synthetic").build().unwrap();
        http.start(
            "window",
            "http-body".into(),
            state.reserve_stream("http-body".into()).unwrap(),
            work,
            "synthetic-provider".into(),
            client,
            request,
        )
        .await
        .unwrap();
        assert!(matches!(
            http.read("window", "http-body").await.unwrap(),
            HttpPart::Headers { .. }
        ));
        assert!(matches!(
            http.read("window", "http-body").await.unwrap(),
            HttpPart::Bytes { .. }
        ));
        http.finish("window", "http-body", HttpOutcome::Uncertain)
            .await
            .unwrap();
        let joined =
            tokio::time::timeout(Duration::from_secs(5), state.join_stream_task("http-body"))
                .await
                .unwrap();
        assert!(joined.unwrap().is_err());
        tokio::time::timeout(Duration::from_secs(5), server)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(phases(&pool).await, ["unknown", "unknown"]);
    }

    async fn large_body_frames(cancel_between_frames: bool) {
        let id = if cancel_between_frames {
            "http-frames-cancel"
        } else {
            "http-frames"
        };
        let (_dir, pool, _runtime, work) = fixture(id).await;
        let body: Vec<u8> = (0..BODY_FRAME_BYTES * 17 + 137)
            .map(|i| (i % 251) as u8)
            .collect();
        let expected = body.clone();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut buffer = [0u8; 1024];
            while !request.windows(4).any(|part| part == b"\r\n\r\n") {
                let n = socket.read(&mut buffer).await.unwrap();
                assert_ne!(n, 0);
                request.extend_from_slice(&buffer[..n]);
            }
            let header = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len() + usize::from(cancel_between_frames)
            );
            socket.write_all(header.as_bytes()).await.unwrap();
            // One large write, independent of the packet sizes chosen by TCP.
            let written = socket.write_all(&body).await;
            if cancel_between_frames {
                if written.is_ok() {
                    loop {
                        match socket.read(&mut buffer).await {
                            Ok(0) | Err(_) => break,
                            Ok(_) => {}
                        }
                    }
                }
            } else {
                written.unwrap();
            }
        });
        let state = AiState::default();
        let http = AdmittedHttp::default();
        let client = reqwest::Client::new();
        let request = client.get(url).build().unwrap();
        http.start(
            "window",
            id.into(),
            state.reserve_stream(id.into()).unwrap(),
            work,
            "synthetic-provider".into(),
            client,
            request,
        )
        .await
        .unwrap();
        assert!(matches!(
            http.read("window", id).await.unwrap(),
            HttpPart::Headers { status: 200, .. }
        ));
        let mut actual = Vec::new();
        let mut frames = 0;
        loop {
            match http.read("window", id).await.unwrap() {
                HttpPart::Bytes { data } => {
                    assert!(!data.is_empty());
                    assert!(data.len() <= BODY_FRAME_BYTES);
                    frames += 1;
                    actual.extend_from_slice(&data);
                    assert_eq!(actual, expected[..actual.len()]);
                    if cancel_between_frames {
                        break;
                    }
                }
                HttpPart::End => break,
                HttpPart::Headers { .. } => panic!("duplicate headers"),
            }
        }
        if cancel_between_frames {
            assert!(actual.len() < expected.len());
            http.finish("window", id, HttpOutcome::Uncertain)
                .await
                .unwrap();
        } else {
            assert_eq!(actual, expected);
            assert!(frames >= 18);
            http.finish("window", id, HttpOutcome::Completed)
                .await
                .unwrap();
        }
        if let Some(result) = state.join_stream_task(id).await {
            assert_eq!(result.is_err(), cancel_between_frames);
        }
        server.await.unwrap();
        let expected_phase = if cancel_between_frames {
            "unknown"
        } else {
            "completed"
        };
        assert_eq!(phases(&pool).await, [expected_phase, expected_phase]);
        http.remove("window", id).await;
    }

    #[tokio::test]
    async fn long_body_preserves_order_in_bounded_ipc_frames() {
        tokio::time::timeout(Duration::from_secs(10), large_body_frames(false))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn cancellation_between_frames_closes_the_actual_connection() {
        tokio::time::timeout(Duration::from_secs(10), large_body_frames(true))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn rejection_is_not_promoted_to_completion_by_a_consumer_receipt() {
        let (_dir, pool, _runtime, work) = fixture("http-reject").await;
        let server = HttpServer::start(vec![Some(
            "HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        )])
        .await;
        let state = AiState::default();
        let http = AdmittedHttp::default();
        let client = reqwest::Client::new();
        let request = client.post(&server.url).body("synthetic").build().unwrap();
        http.start(
            "window",
            "http-reject".into(),
            state.reserve_stream("http-reject".into()).unwrap(),
            work,
            "synthetic-provider".into(),
            client,
            request,
        )
        .await
        .unwrap();
        assert!(matches!(
            http.read("window", "http-reject").await.unwrap(),
            HttpPart::Headers { status: 401, .. }
        ));
        http.finish("window", "http-reject", HttpOutcome::Completed)
            .await
            .unwrap();
        assert!(state
            .join_stream_task("http-reject")
            .await
            .unwrap()
            .is_err());
        assert_eq!(phases(&pool).await, ["no_effect", "no_effect"]);
        assert_eq!(server.stop().await, 1);
    }
    #[tokio::test]
    async fn admitted_client_does_not_hide_a_redirect_emission() {
        let (_dir, pool, _runtime, work) = fixture("http-redirect").await;
        let server = HttpServer::start(vec![Some("HTTP/1.1 307 Temporary Redirect\r\nLocation: /redirected\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")]).await;
        let state = AiState::default();
        let http = AdmittedHttp::default();
        let client = work
            .configure_http_client(reqwest::Client::builder())
            .build()
            .unwrap();
        let request = client.post(&server.url).body("synthetic").build().unwrap();
        http.start(
            "window",
            "http-redirect".into(),
            state.reserve_stream("http-redirect".into()).unwrap(),
            work,
            "synthetic-provider".into(),
            client,
            request,
        )
        .await
        .unwrap();
        assert!(matches!(
            http.read("window", "http-redirect").await.unwrap(),
            HttpPart::Headers { status: 307, .. }
        ));
        http.finish("window", "http-redirect", HttpOutcome::Uncertain)
            .await
            .unwrap();
        if let Some(result) = state.join_stream_task("http-redirect").await {
            assert!(result.is_err());
        }
        assert_eq!(phases(&pool).await, ["unknown", "unknown"]);
        assert_eq!(server.stop().await, 1);
    }
}
