//! Two explicit HTTP/1 lanes. This private owner cannot establish relay authority
//! or replace the v2 producer by itself. No redirects, proxies, pool or retries.
use crate::{
    connect_resources::{TransitCharge, TransitInstance},
    secrets::policy::EmissionLease,
};
use bytes::Bytes;
use futures::Future;
use http_body_util::{BodyExt, Full};
use hyper::client::conn::http1::{Builder, SendRequest};
use hyper_util::rt::TokioIo;
use std::{net::SocketAddr, pin::Pin, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncRead, AsyncWrite},
    net::TcpSocket,
};
use tokio_rustls::{rustls, TlsConnector};
use tokio_util::sync::CancellationToken;

type Result<T> = std::result::Result<T, &'static str>;
const CONNECTION: u64 = 1024 * 1024;
const HANDSHAKE: u64 = 16 * 1024 * 1024;
const CONFIG: u64 = 256 * 1024;
const HEAD: usize = 8192;
static HTTP_SESSION: std::sync::LazyLock<Arc<tokio::sync::Semaphore>> =
    std::sync::LazyLock::new(|| Arc::new(tokio::sync::Semaphore::new(1)));
const V2_BODY: usize = 1024 * 1024; // Existing NativeClient wire limit, not a history limit.
trait Io: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Io for T {}
type Driver = Pin<Box<dyn Future<Output = std::result::Result<(), hyper::Error>> + Send>>;

struct TlsSettings {
    config: Arc<rustls::ClientConfig>,
    _charge: TransitCharge,
}
impl TlsSettings {
    fn public_roots(budget: &TransitInstance) -> Result<Arc<Self>> {
        Self::with_roots(budget, || rustls::RootCertStore {
            roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
        })
    }
    fn with_roots(
        budget: &TransitInstance,
        create: impl FnOnce() -> rustls::RootCertStore,
    ) -> Result<Arc<Self>> {
        let charge = budget.reserve(CONFIG).map_err(|_| "transit_limit")?;
        let roots = create();
        if roots.roots.len() > 256 {
            return Err("tls_roots_limit");
        }
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let verifier = rustls::client::WebPkiServerVerifier::builder_with_provider(
            Arc::new(roots),
            provider.clone(),
        )
        .build()
        .map_err(|_| "tls_config")?;
        let mut config = rustls::ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .map_err(|_| "tls_config")?
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(BoundedVerifier(verifier)))
            .with_no_client_auth();
        config.alpn_protocols = vec![b"http/1.1".to_vec()];
        config.enable_early_data = false;
        config.resumption = rustls::client::Resumption::disabled();
        config.max_fragment_size = Some(4096);
        Ok(Arc::new(Self {
            config: Arc::new(config),
            _charge: charge,
        }))
    }
}

// Bound verifier work before passing a chain to WebPKI. Parsing before this
// hook remains charged to HANDSHAKE, not the smaller steady connection lease.
#[derive(Debug)]
struct BoundedVerifier(Arc<dyn rustls::client::danger::ServerCertVerifier>);
impl rustls::client::danger::ServerCertVerifier for BoundedVerifier {
    fn verify_server_cert(
        &self,
        end: &rustls::pki_types::CertificateDer<'_>,
        intermediates: &[rustls::pki_types::CertificateDer<'_>],
        name: &rustls::pki_types::ServerName<'_>,
        ocsp: &[u8],
        now: rustls::pki_types::UnixTime,
    ) -> std::result::Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        if intermediates.len() > 7
            || end.len() + intermediates.iter().map(|c| c.len()).sum::<usize>() > 65_535
            || ocsp.len() > 65_535
        {
            return Err(rustls::Error::General("certificate resource limit".into()));
        }
        self.0
            .verify_server_cert(end, intermediates, name, ocsp, now)
    }
    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        signature: &rustls::DigitallySignedStruct,
    ) -> std::result::Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        self.0.verify_tls12_signature(message, cert, signature)
    }
    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        signature: &rustls::DigitallySignedStruct,
    ) -> std::result::Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        self.0.verify_tls13_signature(message, cert, signature)
    }
    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.0.supported_verify_schemes()
    }
}

/// Raw response copies remain charged after a caller has consumed the frame.
/// No parser, callback or asynchronous network effect borrows these bytes here.
pub(super) struct Response {
    _database: Arc<crate::core::db_state::ChatWorkLifetime>,
    pub status: u16,
    pub body: Vec<u8>,
    _charge: TransitCharge,
}
struct ChargedBody {
    data: Vec<u8>,
    _charge: TransitCharge,
}
impl AsRef<[u8]> for ChargedBody {
    fn as_ref(&self) -> &[u8] {
        &self.data
    }
}
pub(super) struct Request {
    method: http::Method,
    path: String,
    body: Bytes,
    _charge: TransitCharge,
}
impl Request {
    pub(super) fn new(
        budget: &TransitInstance,
        method: http::Method,
        path: &str,
        body: &[u8],
    ) -> Result<Self> {
        if !matches!(method, http::Method::POST)
            || !path.starts_with('/')
            || path.starts_with("//")
            || path.len() > 2048
            || body.len() > V2_BODY
        {
            return Err("http_request_limit");
        }
        let charge = budget.reserve(HEAD as u64).map_err(|_| "transit_limit")?;
        let body_charge = budget
            .reserve(body.len() as u64)
            .map_err(|_| "transit_limit")?;
        Ok(Self {
            method,
            path: path.into(),
            body: Bytes::from_owner(ChargedBody {
                data: body.to_vec(),
                _charge: body_charge,
            }),
            _charge: charge,
        })
    }
}

struct Lane {
    sender: Option<SendRequest<Full<Bytes>>>,
    driver: Option<Driver>,
    // Socket/TLS/HTTP ownership is destroyed before their physical reservations.
    tls: Option<Arc<TlsSettings>>,
    _charge: TransitCharge,
}
impl Lane {
    async fn open(
        budget: &TransitInstance,
        address: SocketAddr,
        host: &str,
        tls: Option<Arc<TlsSettings>>,
    ) -> Result<Self> {
        let charge = budget.reserve(CONNECTION).map_err(|_| "transit_limit")?;
        let handshake = if tls.is_some() {
            Some(budget.reserve(HANDSHAKE).map_err(|_| "transit_limit")?)
        } else {
            None
        };
        let socket = if address.is_ipv4() {
            TcpSocket::new_v4()
        } else {
            TcpSocket::new_v6()
        }
        .map_err(|_| "http_socket")?;
        socket
            .set_recv_buffer_size(65_536)
            .map_err(|_| "http_socket")?;
        socket
            .set_send_buffer_size(65_536)
            .map_err(|_| "http_socket")?;
        if socket.recv_buffer_size().map_err(|_| "http_socket")? > 131_072
            || socket.send_buffer_size().map_err(|_| "http_socket")? > 131_072
        {
            return Err("http_socket_limit");
        }
        let stream = socket.connect(address).await.map_err(|_| "http_connect")?;
        let io: Box<dyn Io> = match &tls {
            Some(settings) => {
                let name = rustls::pki_types::ServerName::try_from(host.to_owned())
                    .map_err(|_| "tls_name")?;
                let stream = TlsConnector::from(settings.config.clone())
                    .connect_with(name, stream, |connection| {
                        connection.set_buffer_limit(Some(16_384))
                    })
                    .await
                    .map_err(|_| "tls_handshake")?;
                let certificates = stream
                    .get_ref()
                    .1
                    .peer_certificates()
                    .ok_or("tls_certificate")?;
                if certificates.len() > 8
                    || certificates.iter().map(|c| c.len()).sum::<usize>() > 65_535
                {
                    return Err("tls_certificate_limit");
                }
                Box::new(stream)
            }
            None if address.ip().is_loopback() => Box::new(stream),
            None => return Err("tls_required"),
        };
        let (sender, driver) = Builder::new()
            .max_headers(32)
            .max_buf_size(HEAD)
            .handshake(TokioIo::new(io))
            .await
            .map_err(|_| "http_handshake")?;
        drop(handshake);
        Ok(Self {
            sender: Some(sender),
            driver: Some(Box::pin(driver)),
            tls,
            _charge: charge,
        })
    }
    async fn exchange(
        &mut self,
        budget: &TransitInstance,
        host: &str,
        request: Request,
        limit: usize,
        database: &Arc<crate::core::db_state::ChatWorkLifetime>,
    ) -> Result<Response> {
        if limit > V2_BODY {
            return Err("http_body_limit");
        }
        let sender = self.sender.as_mut().ok_or("http_closed")?;
        let driver = self.driver.as_mut().ok_or("http_closed")?;
        let message = http::Request::builder()
            .method(request.method.clone())
            .uri(&request.path)
            .header(http::header::HOST, host)
            .header(http::header::CONTENT_TYPE, "application/json")
            .body(Full::new(request.body.clone()))
            .map_err(|_| "http_request")?;
        let operation = async {
            let response = sender
                .send_request(message)
                .await
                .map_err(|_| "http_response")?;
            if response.headers().len() > 32
                || response
                    .headers()
                    .iter()
                    .map(|(n, v)| n.as_str().len() + v.as_bytes().len())
                    .sum::<usize>()
                    > HEAD
            {
                return Err("http_headers_limit");
            }
            if response
                .headers()
                .get(http::header::CONTENT_ENCODING)
                .is_some()
            {
                return Err("http_encoding");
            }
            if let Some(value) = response.headers().get(http::header::CONTENT_LENGTH) {
                let length: u64 = value
                    .to_str()
                    .map_err(|_| "http_length")?
                    .parse()
                    .map_err(|_| "http_length")?;
                if length > limit as u64 {
                    return Err("http_body_limit");
                }
            }
            // Admission precedes allocation and the first body poll. Refusal
            // closes this lane; no unadmitted body is drained to reuse a socket.
            let charge = budget.reserve(limit as u64).map_err(|_| "transit_limit")?;
            let mut result = Response {
                _database: database.clone(),
                status: response.status().as_u16(),
                body: Vec::with_capacity(limit),
                _charge: charge,
            };
            let mut body = response.into_body();
            while let Some(frame) = body.frame().await {
                let frame = frame.map_err(|_| "http_body")?;
                if let Some(data) = frame.data_ref() {
                    if data.len() > limit - result.body.len() {
                        return Err("http_body_limit");
                    }
                    result.body.extend_from_slice(data);
                } else if frame.trailers_ref().is_some() {
                    return Err("http_trailers");
                }
            }
            Ok(result)
        };
        tokio::pin!(operation);
        // No detached Hyper task. This select owns and polls the connection and
        // response together. All callbacks and body frames leave this scope.
        let result = tokio::select! {
            result = &mut operation => result,
            _ = driver => Err("http_connection_closed"),
        };
        drop(request);
        result
    }
    async fn close(&mut self) {
        self.sender.take();
        if let Some(mut driver) = self.driver.take() {
            let _ = tokio::time::timeout(Duration::from_secs(1), &mut driver).await;
            // After driving shutdown, dropping the sole future destroys its IO.
            // There is no spawned connection task or external callback owner.
            drop(driver);
        }
    }
}

/// Construct only inside the real synchronous policy owner's consume scope,
/// hosted by the existing joined blocking bridge. The lease is unforgeable and
/// borrowed until both lanes have closed. No IPC DTO can construct this owner.
pub(super) struct HttpSession<'a> {
    poll: Option<Lane>,
    post: Option<Lane>,
    host: String,
    address: SocketAddr,
    tls: Option<Arc<TlsSettings>>,
    budget: TransitInstance,
    lease: &'a EmissionLease<'a>,
    database: Arc<crate::core::db_state::ChatWorkLifetime>,
    _slot: tokio::sync::OwnedSemaphorePermit,
}
impl<'a> HttpSession<'a> {
    pub(super) fn new(
        budget: TransitInstance,
        lease: &'a EmissionLease<'a>,
        host: &str,
        address: SocketAddr,
        database: &crate::core::db_state::DbReady,
    ) -> Result<Self> {
        if host.is_empty()
            || host.len() > 253
            || host
                .bytes()
                .any(|b| !b.is_ascii_alphanumeric() && b != b'.' && b != b'-')
        {
            return Err("tls_name");
        }
        lease.check().map_err(|_| "policy_revoked")?;
        let slot = HTTP_SESSION
            .clone()
            .try_acquire_owned()
            .map_err(|_| "http_owner_busy")?;
        let tls = Some(TlsSettings::public_roots(&budget)?);
        Ok(Self {
            poll: None,
            post: None,
            host: host.into(),
            address,
            tls,
            budget,
            lease,
            database: Arc::new(database.retain_chat_work()),
            _slot: slot,
        })
    }
    async fn exchange_lane(
        lane: &mut Option<Lane>,
        budget: &TransitInstance,
        lease: &EmissionLease<'_>,
        host: &str,
        address: SocketAddr,
        tls: Option<Arc<TlsSettings>>,
        request: Request,
        limit: usize,
        cancel: &CancellationToken,
        database: &Arc<crate::core::db_state::ChatWorkLifetime>,
    ) -> Result<Response> {
        let operation = async {
            lease.check().map_err(|_| "policy_revoked")?;
            if lane.is_none() {
                *lane = Some(Lane::open(budget, address, host, tls).await?);
            }
            lease.check().map_err(|_| "policy_revoked")?;
            lane.as_mut()
                .unwrap()
                .exchange(budget, host, request, limit, database)
                .await
        };
        let result = tokio::select! {
            _ = cancel.cancelled() => Err("http_cancelled"),
            _ = lease.revoked() => Err("policy_revoked"),
            result = tokio::time::timeout(Duration::from_secs(30), operation) => result.unwrap_or(Err("http_timeout")),
        };
        if result.is_err() {
            if let Some(mut failed) = lane.take() {
                failed.close().await;
            }
        }
        result
    }
    pub(super) fn lanes(&mut self) -> (HttpPort<'_, 'a>, HttpPort<'_, 'a>) {
        let common = (
            &self.budget,
            self.lease,
            self.host.as_str(),
            self.address,
            &self.tls,
            &self.database,
        );
        (
            HttpPort {
                lane: &mut self.poll,
                common,
            },
            HttpPort {
                lane: &mut self.post,
                common,
            },
        )
    }
    pub(super) async fn close(&mut self) {
        if let Some(mut lane) = self.poll.take() {
            lane.close().await;
        }
        if let Some(mut lane) = self.post.take() {
            lane.close().await;
        }
    }
}

pub(super) struct HttpPort<'s, 'p> {
    lane: &'s mut Option<Lane>,
    common: (
        &'s TransitInstance,
        &'p EmissionLease<'p>,
        &'s str,
        SocketAddr,
        &'s Option<Arc<TlsSettings>>,
        &'s Arc<crate::core::db_state::ChatWorkLifetime>,
    ),
}
impl HttpPort<'_, '_> {
    pub(super) async fn exchange(
        &mut self,
        request: Request,
        limit: usize,
        cancel: &CancellationToken,
    ) -> Result<Response> {
        let (budget, lease, host, address, tls, database) = self.common;
        HttpSession::exchange_lane(
            self.lane,
            budget,
            lease,
            host,
            address,
            tls.clone(),
            request,
            limit,
            cancel,
            database,
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connect_resources::{TRANSIT_INSTANCE_LIMIT, TRANSIT_OWNER};
    use crate::secrets::policy::PolicyOwner;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    async fn request(stream: &mut tokio::net::TcpStream) -> Option<bool> {
        let mut bytes = [0u8; HEAD];
        let mut length = 0;
        while length < HEAD {
            if stream.read(&mut bytes[length..length + 1]).await.ok()? == 0 {
                return None;
            }
            length += 1;
            if bytes[..length].ends_with(b"\r\n\r\n") {
                break;
            }
        }
        let mut body = [0; 2];
        stream.read_exact(&mut body).await.ok()?;
        Some(bytes[..length].starts_with(b"POST /poll "))
    }
    fn scoped<T: Send + 'static>(
        effect: impl FnOnce(&EmissionLease<'_>, TransitInstance, &crate::core::db_state::DbReady) -> T
            + Send
            + 'static,
    ) -> tokio::task::JoinHandle<T> {
        let handle = tokio::runtime::Handle::current();
        tokio::task::spawn_blocking(move || {
            let directory = tempfile::tempdir().unwrap();
            let policy = PolicyOwner::for_test(directory.path());
            policy.initialize(directory.path()).unwrap();
            let snapshot = policy.capture_private(|| Ok(())).unwrap();
            let budget = TRANSIT_OWNER.instance(uuid::Uuid::new_v4()).unwrap();
            let _enter = handle.enter();
            let ready = handle.block_on(async {
                let pool = crate::db::create_pool(&directory.path().join("http.db"))
                    .await
                    .unwrap();
                let owner = crate::core::db_state::DbPool::default();
                owner.set_ready(pool).await.unwrap();
                owner.wait_until_ready_context().await.unwrap()
            });
            policy
                .consume_private(
                    &snapshot,
                    || Ok(()),
                    |lease, _| Ok(effect(lease, budget, &ready)),
                )
                .unwrap()
        })
    }
    fn plain<'a>(
        lease: &'a EmissionLease<'a>,
        budget: TransitInstance,
        address: SocketAddr,
        database: &crate::core::db_state::DbReady,
    ) -> HttpSession<'a> {
        HttpSession {
            poll: None,
            post: None,
            host: "localhost".into(),
            address,
            tls: None,
            budget,
            lease,
            database: Arc::new(database.retain_chat_work()),
            _slot: HTTP_SESSION.clone().try_acquire_owned().unwrap(),
        }
    }
    #[tokio::test]
    async fn real_poll_and_post_progress_independently_and_reuse_two_connections() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let posted = Arc::new(tokio::sync::Notify::new());
        let server = tokio::spawn(async move {
            let mut peers = tokio::task::JoinSet::new();
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().await.unwrap();
                let posted = posted.clone();
                peers.spawn(async move {
                    let mut count = 0;
                    while let Some(poll) = request(&mut stream).await {
                        count += 1;
                        stream
                            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n")
                            .await
                            .unwrap();
                        if poll {
                            posted.notified().await;
                        } else {
                            posted.notify_one();
                        }
                        stream.write_all(b"{}").await.unwrap();
                    }
                    count
                });
            }
            let mut counts = Vec::new();
            while let Some(result) = peers.join_next().await {
                counts.push(result.unwrap());
            }
            counts.sort();
            counts
        });
        scoped(move |lease, budget, database| {
            tokio::runtime::Handle::current().block_on(async {
                let poll_request =
                    Request::new(&budget, http::Method::POST, "/poll", b"{}").unwrap();
                let post_request =
                    Request::new(&budget, http::Method::POST, "/ack", b"{}").unwrap();
                let mut session = plain(lease, budget, address, database);
                let cancel = CancellationToken::new();
                let (mut poll, mut post) = session.lanes();
                let (a, b) = tokio::join!(
                    poll.exchange(poll_request, 98_304, &cancel),
                    post.exchange(post_request, 98_304, &cancel)
                );
                let a = a.unwrap();
                let b = b.unwrap();
                assert_eq!(a.body, b"{}");
                assert_eq!(b.status, 200);
                let next = Request::new(post.common.0, http::Method::POST, "/ack", b"{}").unwrap();
                let c = post.exchange(next, 98_304, &cancel).await.unwrap();
                drop((poll, post));
                session.close().await;
                assert!(session.budget.reserve(TRANSIT_INSTANCE_LIMIT).is_err());
                drop((a, b, c));
                assert!(session.budget.reserve(TRANSIT_INSTANCE_LIMIT).is_ok());
            })
        })
        .await
        .unwrap();
        assert_eq!(server.await.unwrap(), vec![1, 2]);
    }
    #[tokio::test]
    async fn body_refusal_does_not_drain_and_returns_connection_only_after_close() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            request(&mut stream).await.unwrap();
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 90000\r\n\r\n")
                .await
                .unwrap();
            // No payload sent: refusing admission must not wait to drain it.
            let mut byte = [0];
            tokio::time::timeout(Duration::from_secs(3), stream.read(&mut byte))
                .await
                .unwrap()
                .unwrap()
        });
        scoped(move |lease, budget, database| {
            tokio::runtime::Handle::current().block_on(async {
                let request = Request::new(&budget, http::Method::POST, "/poll", b"{}").unwrap();
                let held = budget
                    .reserve(TRANSIT_INSTANCE_LIMIT - CONNECTION - HEAD as u64 - 2)
                    .unwrap();
                let mut session = plain(lease, budget, address, database);
                let cancel = CancellationToken::new();
                let (mut poll, _) = session.lanes();
                assert!(matches!(
                    poll.exchange(request, 98_304, &cancel).await,
                    Err("transit_limit")
                ));
                session.close().await;
                drop(held);
                assert!(session.budget.reserve(TRANSIT_INSTANCE_LIMIT).is_ok());
            })
        })
        .await
        .unwrap();
        assert_eq!(server.await.unwrap(), 0);
    }
    #[tokio::test]
    async fn cancellation_during_slow_headers_closes_the_owned_socket() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let cancel = CancellationToken::new();
        let stop = cancel.clone();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            request(&mut stream).await.unwrap();
            stream.write_all(b"HTTP/1.1 200").await.unwrap();
            stop.cancel();
            let mut byte = [0];
            tokio::time::timeout(Duration::from_secs(3), stream.read(&mut byte))
                .await
                .unwrap()
                .unwrap()
        });
        scoped(move |lease, budget, database| {
            tokio::runtime::Handle::current().block_on(async {
                let request = Request::new(&budget, http::Method::POST, "/poll", b"{}").unwrap();
                let mut session = plain(lease, budget, address, database);
                let (mut poll, _) = session.lanes();
                assert!(matches!(
                    poll.exchange(request, 98_304, &cancel).await,
                    Err("http_cancelled")
                ));
                session.close().await;
                assert!(session.budget.reserve(TRANSIT_INSTANCE_LIMIT).is_ok());
            })
        })
        .await
        .unwrap();
        assert_eq!(server.await.unwrap(), 0);
    }
    #[tokio::test]
    async fn real_tls_validates_the_synthetic_certificate_and_hostname() {
        let directory = tempfile::tempdir().unwrap();
        let key = directory.path().join("key.pem");
        let pem = directory.path().join("cert.pem");
        let cert_path = directory.path().join("cert.der");
        let key_path = directory.path().join("key.der");
        let config_path = directory.path().join("openssl.cnf");
        std::fs::write(&config_path, "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost\nbasicConstraints=critical,CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n").unwrap();
        for args in [
            vec![
                "req",
                "-x509",
                "-newkey",
                "rsa:2048",
                "-nodes",
                "-days",
                "1",
                "-config",
                config_path.to_str().unwrap(),
                "-keyout",
                key.to_str().unwrap(),
                "-out",
                pem.to_str().unwrap(),
            ],
            vec![
                "x509",
                "-in",
                pem.to_str().unwrap(),
                "-outform",
                "DER",
                "-out",
                cert_path.to_str().unwrap(),
            ],
            vec![
                "pkcs8",
                "-topk8",
                "-nocrypt",
                "-in",
                key.to_str().unwrap(),
                "-outform",
                "DER",
                "-out",
                key_path.to_str().unwrap(),
            ],
        ] {
            let output = std::process::Command::new("openssl")
                .args(args)
                .env_clear()
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "synthetic certificate generation failed"
            );
        }
        let cert = rustls::pki_types::CertificateDer::from(std::fs::read(cert_path).unwrap());
        let key = rustls::pki_types::PrivatePkcs8KeyDer::from(std::fs::read(key_path).unwrap());
        let config = rustls::ServerConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(vec![cert.clone()], key.into())
        .unwrap();
        let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            for _ in 0..2 {
                let (tcp, _) = listener.accept().await.unwrap();
                if let Ok(mut stream) = acceptor.accept(tcp).await {
                    let mut data = [0u8; HEAD];
                    let mut len = 0;
                    while len < HEAD {
                        match stream.read(&mut data[len..len + 1]).await {
                            Ok(1) => len += 1,
                            _ => break,
                        }
                        if data[..len].ends_with(b"\r\n\r\n") {
                            break;
                        }
                    }
                    if len > 0 && data[..len].ends_with(b"\r\n\r\n") {
                        let mut body = [0; 2];
                        stream.read_exact(&mut body).await.unwrap();
                        stream
                            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}")
                            .await
                            .unwrap();
                        let mut byte = [0];
                        let _ = stream.read(&mut byte).await;
                    }
                }
            }
        });
        scoped(move |lease, budget, database| {
            tokio::runtime::Handle::current().block_on(async {
                for host in ["localhost", "wrong.invalid"] {
                    let request = Request::new(&budget, http::Method::POST, "/ack", b"{}").unwrap();
                    let roots = TlsSettings::with_roots(&budget, || {
                        let mut roots = rustls::RootCertStore::empty();
                        roots.add(cert.clone()).unwrap();
                        roots
                    })
                    .unwrap();
                    let mut session = plain(lease, budget.clone(), address, database);
                    session.tls = Some(roots);
                    session.host = host.into();
                    let cancel = CancellationToken::new();
                    let (_, mut post) = session.lanes();
                    let result = post.exchange(request, 98_304, &cancel).await;
                    if host == "localhost" {
                        assert_eq!(result.unwrap().body, b"{}");
                    } else {
                        assert!(matches!(result, Err("tls_handshake")));
                    }
                    session.close().await;
                    drop(session);
                }
            })
        })
        .await
        .unwrap();
        server.await.unwrap();
    }
}
