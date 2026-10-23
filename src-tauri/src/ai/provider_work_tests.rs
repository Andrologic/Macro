use super::*;
use crate::core::db_state::DbPool;
use crate::db::chat_admission::runtime::ChatAdmissionRuntime;
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub(crate) async fn fixture(
    request: &str,
) -> (
    tempfile::TempDir,
    SqlitePool,
    ChatAdmissionRuntime,
    Arc<ProviderWork>,
) {
    let dir = tempfile::TempDir::new().unwrap();
    let pool = crate::db::create_pool(&dir.path().join("synthetic.db"))
        .await
        .unwrap();
    sqlx::raw_sql("INSERT INTO conversations(id,title,scope_mode,created_at,updated_at) VALUES('chat','Synthetic','Chat','t','t'); INSERT INTO messages(id,conversation_id,role,content,turn_id,created_at) VALUES('user','chat','user','Synthetic request','turn','t');")
        .execute(&pool).await.unwrap();
    let owner = DbPool::default();
    owner.set_ready(pool.clone()).await.unwrap();
    let runtime = ChatAdmissionRuntime::default();
    let context = runtime
        .begin(owner, "window", "browser", "chat", "turn")
        .await
        .unwrap();
    let work = ProviderWork::admit(
        &pool,
        &runtime,
        "window",
        ProviderAdmission::GlobalChat { context },
        Some("chat"),
        request,
    )
    .await
    .unwrap();
    (dir, pool, runtime, Arc::new(work))
}

pub(crate) struct HttpServer {
    pub url: String,
    pub requests: Arc<AtomicUsize>,
    pub received: Arc<tokio::sync::Notify>,
    stop: tokio::sync::oneshot::Sender<()>,
    joined: tokio::task::JoinHandle<()>,
}

impl HttpServer {
    /// None closes after receiving the request; an empty string withholds headers.
    /// The listener stays available until stop, so an unwanted retry is counted.
    pub async fn start(responses: Vec<Option<&'static str>>) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(AtomicUsize::new(0));
        let received = Arc::new(tokio::sync::Notify::new());
        let (stop, mut stopped) = tokio::sync::oneshot::channel();
        let count = requests.clone();
        let observed = received.clone();
        let joined = tokio::spawn(async move {
            loop {
                let (mut socket, _) = tokio::select! {
                    _ = &mut stopped => return,
                    accepted = listener.accept() => accepted.unwrap(),
                };
                let mut bytes = Vec::new();
                let mut buffer = [0; 1024];
                let body_start = loop {
                    let n = tokio::select! {
                        _ = &mut stopped => return,
                        read = socket.read(&mut buffer) => read.unwrap(),
                    };
                    if n == 0 {
                        return;
                    }
                    bytes.extend_from_slice(&buffer[..n]);
                    if let Some(end) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
                        break end + 4;
                    }
                };
                let header = String::from_utf8_lossy(&bytes[..body_start]);
                let length: usize = header
                    .lines()
                    .find_map(|line| {
                        let (key, value) = line.split_once(':')?;
                        key.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse().unwrap())
                    })
                    .unwrap();
                while bytes.len() < body_start + length {
                    let n = tokio::select! {
                        _ = &mut stopped => return,
                        read = socket.read(&mut buffer) => read.unwrap(),
                    };
                    if n == 0 {
                        return;
                    }
                    bytes.extend_from_slice(&buffer[..n]);
                }
                let index = count.fetch_add(1, Ordering::SeqCst);
                observed.notify_one();
                match responses.get(index).copied().flatten() {
                    Some("") => {
                        tokio::select! {
                            _ = &mut stopped => return,
                            _ = socket.read(&mut buffer) => {},
                        }
                    }
                    Some(response) => {
                        socket.write_all(response.as_bytes()).await.unwrap();
                    }
                    None => {}
                }
            }
        });
        Self {
            url,
            requests,
            received,
            stop,
            joined,
        }
    }

    pub async fn stop(self) -> usize {
        let _ = self.stop.send(());
        tokio::time::timeout(std::time::Duration::from_secs(5), self.joined)
            .await
            .unwrap()
            .unwrap();
        self.requests.load(Ordering::SeqCst)
    }
}

#[tokio::test]
async fn global_chat_cannot_use_a_conversation_or_utility_declaration() {
    let (_dir, pool, runtime, _work) = fixture("request").await;
    assert!(ProviderWork::admit(
        &pool,
        &runtime,
        "window",
        ProviderAdmission::Conversation,
        Some("chat"),
        "other"
    )
    .await
    .is_err());
    assert!(ProviderWork::admit(
        &pool,
        &runtime,
        "window",
        ProviderAdmission::Utility,
        Some("chat"),
        "other"
    )
    .await
    .is_err());
    let forged = ChatAdmissionContext {
        handle: "absent".into(),
        runtime: "browser".into(),
    };
    assert!(ProviderWork::admit(
        &pool,
        &runtime,
        "window",
        ProviderAdmission::GlobalChat { context: forged },
        Some("chat"),
        "other"
    )
    .await
    .is_err());
    assert!(ProviderWork::admit(
        &pool,
        &runtime,
        "window",
        ProviderAdmission::Utility,
        None,
        "utility"
    )
    .await
    .is_ok());
}

#[tokio::test]
async fn admitted_http2_refused_stream_does_not_hide_a_second_emission() {
    let (_dir, pool, _runtime, work) = fixture("http2-nack").await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/synthetic", listener.local_addr().unwrap());
    let requests = Arc::new(AtomicUsize::new(0));
    let observed = requests.clone();
    let stop = tokio_util::sync::CancellationToken::new();
    let stopped = stop.clone();
    // A local protocol fixture only: accept the HTTP/2 preface, then reject
    // each HEADERS stream with REFUSED_STREAM, a reqwest protocol retry case.
    let server = tokio::spawn(async move {
        loop {
            let (mut socket, _) = tokio::select! {
                _ = stopped.cancelled() => return,
                accepted = listener.accept() => accepted.unwrap(),
            };
            let mut preface = [0; 24];
            tokio::select! {
                _ = stopped.cancelled() => return,
                result = socket.read_exact(&mut preface) => { result.unwrap(); }
            }
            assert_eq!(&preface, b"PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n");
            socket
                .write_all(&[0, 0, 0, 4, 0, 0, 0, 0, 0])
                .await
                .unwrap();
            loop {
                let mut header = [0; 9];
                let read = tokio::select! {
                    _ = stopped.cancelled() => return,
                    read = socket.read_exact(&mut header) => read,
                };
                if read.is_err() {
                    break;
                }
                let length =
                    ((header[0] as usize) << 16) | ((header[1] as usize) << 8) | header[2] as usize;
                let mut payload = vec![0; length];
                tokio::select! {
                    _ = stopped.cancelled() => return,
                    read = socket.read_exact(&mut payload) => { if read.is_err() { break; } }
                }
                if header[3] == 4 && header[4] & 1 == 0 {
                    socket
                        .write_all(&[0, 0, 0, 4, 1, 0, 0, 0, 0])
                        .await
                        .unwrap();
                }
                if header[3] == 1 {
                    observed.fetch_add(1, Ordering::SeqCst);
                    let mut reset = vec![0, 0, 4, 3, 0];
                    reset.extend_from_slice(&header[5..9]);
                    reset.extend_from_slice(&7u32.to_be_bytes());
                    socket.write_all(&reset).await.unwrap();
                }
            }
        }
    });
    let client = work
        .configure_http_client(reqwest::Client::builder().http2_prior_knowledge())
        .build()
        .unwrap();
    let request = client.post(&url).body("{}").build().unwrap();
    let attempt = work.attempt("synthetic-provider", &url).await.unwrap();
    attempt.dispatched().await.unwrap();
    let result = tokio::time::timeout(std::time::Duration::from_secs(2), client.execute(request))
        .await
        .unwrap();
    assert!(result.is_err());
    work.settle(&Err("Synthetic HTTP/2 refusal".into()))
        .await
        .unwrap();
    stop.cancel();
    server.await.unwrap();
    assert_eq!(requests.load(Ordering::SeqCst), 1);
    let unknown: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM chat_admission_operations WHERE kind='provider' AND phase='unknown'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(unknown, 2);
}
