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
use std::{
    net::SocketAddr,
    pin::Pin,
    sync::{
        atomic::{AtomicBool, AtomicU8, Ordering},
        Arc,
    },
    task::{Context, Poll},
    time::Duration,
};
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

// Rustls parses handshake messages before rejecting them in its current state,
// including after connection establishment. Reserve for each synchronous read
// poll, not only the initial handshake. Pending I/O releases this temporary turn;
// the steady connection reservation retains the deframer and application bytes.
struct TlsReadGate<I> {
    io: I,
    budget: TransitInstance,
    turn: tokio_util::sync::PollSemaphore,
    failed: Option<TransitCharge>,
}
impl<I: AsyncRead + Unpin> AsyncRead for TlsReadGate<I> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        let permit = match std::task::ready!(self.turn.poll_acquire(cx)) {
            Some(permit) => permit,
            None => return Poll::Ready(Err(std::io::Error::other("transport closed"))),
        };
        let charge = match self.budget.reserve(HANDSHAKE) {
            Ok(charge) => charge,
            Err(_) => return Poll::Ready(Err(std::io::Error::other("transit limit"))),
        };
        let result = Pin::new(&mut self.io).poll_read(cx, buf);
        if matches!(result, Poll::Ready(Err(_))) {
            // Retain malformed parser state until its actual TLS owner is gone.
            self.failed = Some(charge);
        }
        drop(permit);
        result
    }
}
impl<I: AsyncWrite + Unpin> AsyncWrite for TlsReadGate<I> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        Pin::new(&mut self.io).poll_write(cx, bytes)
    }
    fn is_write_vectored(&self) -> bool {
        self.io.is_write_vectored()
    }
    fn poll_write_vectored(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffers: &[std::io::IoSlice<'_>],
    ) -> Poll<std::io::Result<usize>> {
        Pin::new(&mut self.io).poll_write_vectored(cx, buffers)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.io).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.io).poll_shutdown(cx)
    }
}

// One request at a time per lane. The body marks its final frame; only a
// successful flush through the outer TLS stream completes that exact write.
#[derive(Default)]
struct WriteFence {
    #[cfg(test)]
    vectored_slices: std::sync::atomic::AtomicUsize,
    stage: AtomicU8, // 0 idle, 1 body pending, 2 final frame, 3 flushed, 4 receiving
    wrote: AtomicBool,
    reader: futures::task::AtomicWaker,
}
impl WriteFence {
    fn arm(&self) {
        self.wrote.store(false, Ordering::SeqCst);
        self.stage.store(1, Ordering::SeqCst);
    }
    fn end(&self) {
        self.stage.store(2, Ordering::SeqCst);
    }
    fn flushed(&self) -> bool {
        self.stage.load(Ordering::SeqCst) == 3
    }
}
struct WriteIo<I> {
    io: I,
    fence: Arc<WriteFence>,
}
impl<I: AsyncRead + Unpin> AsyncRead for WriteIo<I> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        // Do not admit an early response while the request still owns policy.
        self.fence.reader.register(cx.waker());
        if matches!(self.fence.stage.load(Ordering::SeqCst), 1 | 2 | 3) {
            return Poll::Pending;
        }
        Pin::new(&mut self.io).poll_read(cx, buf)
    }
}
impl<I: AsyncWrite + Unpin> AsyncWrite for WriteIo<I> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        let result = Pin::new(&mut self.io).poll_write(cx, bytes);
        if matches!(result, Poll::Ready(Ok(n)) if n > 0) {
            self.fence.wrote.store(true, Ordering::SeqCst);
        }
        result
    }
    fn is_write_vectored(&self) -> bool {
        self.io.is_write_vectored()
    }
    fn poll_write_vectored(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffers: &[std::io::IoSlice<'_>],
    ) -> Poll<std::io::Result<usize>> {
        #[cfg(test)]
        self.fence
            .vectored_slices
            .fetch_max(buffers.len(), Ordering::SeqCst);
        let result = Pin::new(&mut self.io).poll_write_vectored(cx, buffers);
        if matches!(result, Poll::Ready(Ok(n)) if n > 0) {
            self.fence.wrote.store(true, Ordering::SeqCst);
        }
        result
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        let result = Pin::new(&mut self.io).poll_flush(cx);
        if matches!(result, Poll::Ready(Ok(())))
            && self.fence.wrote.load(Ordering::SeqCst)
            && self
                .fence
                .stage
                .compare_exchange(2, 3, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
        {
            self.fence.reader.wake();
        }
        result
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.io).poll_shutdown(cx)
    }
}
struct RequestBody {
    inner: Full<Bytes>,
    fence: Arc<WriteFence>,
}
impl hyper::body::Body for RequestBody {
    type Data = Bytes;
    type Error = std::convert::Infallible;
    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<std::result::Result<hyper::body::Frame<Bytes>, Self::Error>>> {
        let result = Pin::new(&mut self.inner).poll_frame(cx);
        if self.inner.is_end_stream() {
            self.fence.end();
        }
        result
    }
    fn is_end_stream(&self) -> bool {
        let end = self.inner.is_end_stream();
        if end && self.fence.stage.load(Ordering::SeqCst) == 1 {
            self.fence.end();
        }
        end
    }
    fn size_hint(&self) -> hyper::body::SizeHint {
        self.inner.size_hint()
    }
}
type Reply = Pin<
    Box<
        dyn Future<
                Output = std::result::Result<hyper::Response<hyper::body::Incoming>, hyper::Error>,
            > + Send,
    >,
>;

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
        config.cert_decompressors.clear();
        config.cert_compressors.clear();
        config.cert_compression_cache = Arc::new(rustls::compress::CompressionCache::Disabled);
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
pub(crate) struct Response {
    pub status: u16,
    pub request_id: Option<String>,
    _headers: TransitCharge,
    body: Vec<u8>,
    _charge: TransitCharge,
    admitted_capacity: usize,
    _database: Arc<crate::core::db_state::ChatWorkLifetime>,
}
impl Response {
    pub(crate) fn into_codec_body(self) -> Result<super::codec::Bytes> {
        super::codec::Bytes::adopt(self.body, self._charge, self.admitted_capacity)
    }

    pub(crate) fn body(&self) -> &[u8] {
        &self.body
    }
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
pub(crate) struct Request {
    method: http::Method,
    path: String,
    body: Bytes,
    headers: http::HeaderMap,
    _charge: TransitCharge,
}
impl Request {
    pub(crate) fn from_admitted(
        budget: &TransitInstance,
        method: http::Method,
        path: &str,
        body: super::codec::Bytes,
    ) -> Result<Self> {
        let mut request = Self::new(budget, method, path, &[])?;
        if !(request.method == http::Method::POST || body.as_slice().is_empty()) {
            return Err("http_request_limit");
        }
        request.body = Bytes::from_owner(body);
        Ok(request)
    }

    pub(crate) fn new(
        budget: &TransitInstance,
        method: http::Method,
        path: &str,
        body: &[u8],
    ) -> Result<Self> {
        if !(method == http::Method::POST
            || method == http::Method::GET && path == "/pilot/v1/me" && body.is_empty())
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
            headers: http::HeaderMap::new(),
            path: path.into(),
            body: Bytes::from_owner(ChargedBody {
                data: body.to_vec(),
                _charge: body_charge,
            }),
            _charge: charge,
        })
    }
    pub(crate) fn authenticate(
        mut self,
        token: &str,
        instance_key: Option<&str>,
        request_id: uuid::Uuid,
    ) -> Result<Self> {
        if token.len() > 512 || instance_key.is_some_and(|key| key.len() > 512) {
            return Err("http_request_limit");
        }
        let mut bearer =
            http::HeaderValue::from_str(&format!("Bearer {token}")).map_err(|_| "http_request")?;
        bearer.set_sensitive(true);
        self.headers.insert(http::header::AUTHORIZATION, bearer);
        if let Some(key) = instance_key {
            let mut key = http::HeaderValue::from_str(key).map_err(|_| "http_request")?;
            key.set_sensitive(true);
            self.headers.insert("x-instance-key", key);
        }
        self.headers.insert(
            "x-request-id",
            http::HeaderValue::from_str(&request_id.to_string()).map_err(|_| "http_request")?,
        );
        Ok(self)
    }
}

struct Lane {
    sender: Option<SendRequest<RequestBody>>,
    fence: Arc<WriteFence>,
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
        // TLS parsing and the codec raw graph share one heavy-allocation turn.
        // This also serializes the two initial handshakes without raising quota.
        let handshake_turn = if tls.is_some() {
            Some(
                super::codec::RAW_TURN
                    .clone()
                    .acquire_owned()
                    .await
                    .map_err(|_| "http_closed")?,
            )
        } else {
            None
        };
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
                Box::new(TlsReadGate {
                    io: stream,
                    budget: budget.clone(),
                    turn: tokio_util::sync::PollSemaphore::new(super::codec::RAW_TURN.clone()),
                    failed: None,
                })
            }
            None if address.ip().is_loopback() => Box::new(stream),
            None => return Err("tls_required"),
        };
        let fence = Arc::new(WriteFence::default());
        let (sender, driver) = Builder::new()
            .max_headers(32)
            .max_buf_size(HEAD)
            .handshake(TokioIo::new(WriteIo {
                io,
                fence: fence.clone(),
            }))
            .await
            .map_err(|_| "http_handshake")?;
        drop(handshake);
        drop(handshake_turn);
        Ok(Self {
            sender: Some(sender),
            fence,
            driver: Some(Box::pin(driver)),
            tls,
            _charge: charge,
        })
    }
    async fn emit(&mut self, host: &str, request: Request) -> Result<Reply> {
        let sender = self.sender.as_mut().ok_or("http_closed")?;
        let driver = self.driver.as_mut().ok_or("http_closed")?;
        self.fence.arm();
        let Request {
            method,
            path,
            body,
            headers,
            _charge,
        } = request;
        let mut message = http::Request::builder()
            .method(method)
            .uri(&path)
            .header(http::header::HOST, host)
            .header(http::header::CONTENT_TYPE, "application/json")
            .body(RequestBody {
                inner: Full::new(body),
                fence: self.fence.clone(),
            })
            .map_err(|_| "http_request")?;
        message.headers_mut().extend(headers);
        let reply: Reply = Box::pin(sender.send_request(message));
        // Polling the driver may flush and then wait for headers. Return at that
        // flush, without polling the response future or waiting for the peer.
        let result = futures::future::poll_fn(|cx| {
            let progress = driver.as_mut().poll(cx);
            if let Poll::Ready(_) = progress {
                return Poll::Ready(Err("http_connection_closed"));
            }
            if self.fence.flushed() {
                Poll::Ready(Ok(()))
            } else {
                Poll::Pending
            }
        })
        .await;
        drop(_charge);
        if result.is_err() {
            self.driver.take();
        }
        result?;
        Ok(reply)
    }
    async fn receive(
        &mut self,
        budget: &TransitInstance,
        reply: Reply,
        limit: usize,
        database: &Arc<crate::core::db_state::ChatWorkLifetime>,
    ) -> Result<Response> {
        if limit > V2_BODY {
            return Err("http_body_limit");
        }
        let driver = self.driver.as_mut().ok_or("http_closed")?;
        // Reserve the raw reservoir before the driver can read even headers.
        let charge = budget.reserve(limit as u64).map_err(|_| "transit_limit")?;
        let headers = budget.reserve(HEAD as u64).map_err(|_| "transit_limit")?;
        self.fence.stage.store(4, Ordering::SeqCst);
        self.fence.reader.wake();
        let operation = async {
            let response = reply.await.map_err(|_| "http_response")?;
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
            let mut result = Response {
                _database: database.clone(),
                status: response.status().as_u16(),
                request_id: match response
                    .headers()
                    .get_all("x-request-id")
                    .iter()
                    .collect::<Vec<_>>()
                    .as_slice()
                {
                    [] => None,
                    [value] if value.as_bytes().len() <= 128 => {
                        Some(value.to_str().map_err(|_| "http_correlation")?.into())
                    }
                    _ => return Err("http_correlation"),
                },
                _headers: headers,
                body: Vec::with_capacity(limit),
                admitted_capacity: limit,
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
        let mut driver_finished = false;
        let result = tokio::select! {
            result = &mut operation => result,
            finished = driver => {
                driver_finished = true;
                match finished {
                    // Hyper may have queued the entire response before its
                    // normal Connection: close completion. Consume that queue.
                    Ok(()) => operation.await,
                    Err(_) => Err("http_connection_closed"),
                }
            },
        };
        if driver_finished {
            // A completed driver must never be polled again, even by close.
            self.driver.take();
        }
        result
    }
    async fn exchange(
        &mut self,
        budget: &TransitInstance,
        host: &str,
        request: Request,
        limit: usize,
        database: &Arc<crate::core::db_state::ChatWorkLifetime>,
    ) -> Result<Response> {
        let reply = self.emit(host, request).await?;
        self.receive(budget, reply, limit, database).await
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

// Only idle drivers live here. Runtime retirement synchronously destroys them;
// checked-out drivers stay in Prepared/Completed until cancellation or drop.
#[derive(Default)]
pub(crate) struct IdleLanes(std::sync::Mutex<IdleState>);
#[derive(Default)]
struct IdleState {
    closed: bool,
    lanes: [Option<Lane>; 2],
}
impl IdleLanes {
    fn take(&self, poll: bool) -> Result<Option<Lane>> {
        let mut state = self.0.lock().unwrap_or_else(|p| p.into_inner());
        if state.closed {
            return Err("http_closed");
        }
        Ok(state.lanes[usize::from(!poll)].take())
    }
    fn restore(&self, poll: bool, lane: Lane, cancel: &CancellationToken) -> Result<()> {
        let mut state = self.0.lock().unwrap_or_else(|p| p.into_inner());
        if state.closed || cancel.is_cancelled() {
            return Err("http_cancelled");
        }
        let slot = &mut state.lanes[usize::from(!poll)];
        if slot.is_some() {
            return Err("http_lane_busy");
        }
        *slot = Some(lane);
        Ok(())
    }
    pub(crate) fn retire(&self) {
        let mut state = self.0.lock().unwrap_or_else(|p| p.into_inner());
        state.closed = true;
        // Dropping the sole driver destroys socket/TLS before Lane's charge.
        state.lanes = [None, None];
    }
}

/// Native IO owner. Preparation and reception hold no policy/store guard.
/// Only Prepared::emit borrows an unforgeable emission lease.
pub(crate) struct HttpSession {
    #[cfg(test)]
    poll: Option<Lane>,
    #[cfg(test)]
    post: Option<Lane>,
    host: String,
    address: SocketAddr,
    tls: Option<Arc<TlsSettings>>,
    budget: TransitInstance,
    database: Arc<crate::core::db_state::ChatWorkLifetime>,
    _slot: Arc<tokio::sync::OwnedSemaphorePermit>,
    poll_slot: Arc<tokio::sync::Semaphore>,
    post_slot: Arc<tokio::sync::Semaphore>,
    owner: Arc<super::runtime::HttpOwnership>,
}
impl Drop for HttpSession {
    fn drop(&mut self) {
        self.owner.cancel.cancel();
        self.owner.idle.retire();
    }
}
impl HttpSession {
    #[cfg(test)]
    pub(crate) fn use_plain_loopback(&mut self) {
        self.tls = None;
    }
    pub(crate) fn new(
        owner: super::runtime::HttpOwnership,
        host: &str,
        address: SocketAddr,
    ) -> Result<Self> {
        if host.is_empty()
            || host.len() > 253
            || host
                .bytes()
                .any(|b| !b.is_ascii_alphanumeric() && b != b'.' && b != b'-')
        {
            return Err("tls_name");
        }
        if owner.cancel.is_cancelled() {
            return Err("http_cancelled");
        }
        let budget = owner.budget.clone();
        let slot = HTTP_SESSION
            .clone()
            .try_acquire_owned()
            .map_err(|_| "http_owner_busy")?;
        let tls = Some(TlsSettings::public_roots(&budget)?);
        Ok(Self {
            #[cfg(test)]
            poll: None,
            #[cfg(test)]
            post: None,
            host: host.into(),
            address,
            tls,
            budget,
            database: owner.database.clone(),
            _slot: Arc::new(slot),
            poll_slot: Arc::new(tokio::sync::Semaphore::new(1)),
            post_slot: Arc::new(tokio::sync::Semaphore::new(1)),
            owner: Arc::new(owner),
        })
    }
    pub(crate) async fn prepare(&mut self, poll: bool) -> Result<Prepared> {
        let slot = if poll {
            &self.poll_slot
        } else {
            &self.post_slot
        };
        let permit = slot
            .clone()
            .try_acquire_owned()
            .map_err(|_| "http_lane_busy")?;
        if self.owner.cancel.is_cancelled() {
            return Err("http_cancelled");
        }
        let lane = self.owner.idle.take(poll)?;
        let mut prepared = Prepared {
            lane,
            poll,
            host: if self.address.port() == 443 {
                self.host.clone()
            } else {
                format!("{}:{}", self.host, self.address.port())
            },
            _permit: permit,
            _slot: self._slot.clone(),
            owner: self.owner.clone(),
        };
        if prepared.lane.is_none() {
            let open = Lane::open(&self.budget, self.address, &self.host, self.tls.clone());
            prepared.lane = Some(tokio::select! {
                _ = self.owner.cancel.cancelled() => return Err("http_cancelled"),
                result = tokio::time::timeout(Duration::from_secs(30), open) => result.map_err(|_| "http_timeout")??,
            });
        }
        Ok(prepared)
    }
    #[cfg(test)]
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
        app_cancel: &CancellationToken,
        database: &Arc<crate::core::db_state::ChatWorkLifetime>,
    ) -> Result<Response> {
        // The exchange future owns the IO until successful completion. Dropping
        // it destroys the driver synchronously, even if the session stays idle.
        // Only a live, successfully used lane can return to the session.
        let mut owned = lane.take();
        let operation = async {
            lease.check().map_err(|_| "policy_revoked")?;
            if app_cancel.is_cancelled() || cancel.is_cancelled() {
                return Err("http_cancelled");
            }
            if owned.is_none() {
                owned = Some(Lane::open(budget, address, host, tls).await?);
            }
            lease.check().map_err(|_| "policy_revoked")?;
            owned
                .as_mut()
                .unwrap()
                .exchange(budget, host, request, limit, database)
                .await
        };
        let result = tokio::select! {
            _ = cancel.cancelled() => Err("http_cancelled"),
            _ = app_cancel.cancelled() => Err("http_cancelled"),
            _ = lease.revoked() => Err("policy_revoked"),
            result = tokio::time::timeout(Duration::from_secs(30), operation) => result.unwrap_or(Err("http_timeout")),
        };
        if result.is_ok()
            && owned.as_ref().is_some_and(|lane| {
                lane.driver.is_some()
                    && lane
                        .sender
                        .as_ref()
                        .is_some_and(|sender| !sender.is_closed())
            })
        {
            *lane = owned.take();
        } else if let Some(mut retired) = owned.take() {
            retired.close().await;
        }
        result
    }
    #[cfg(test)]
    pub(crate) fn lanes<'s, 'p>(
        &'s mut self,
        lease: &'p EmissionLease<'p>,
    ) -> (HttpPort<'s, 'p>, HttpPort<'s, 'p>) {
        let common = (
            &self.budget,
            lease,
            self.host.as_str(),
            self.address,
            &self.tls,
            &self.database,
            &self.owner.cancel,
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
    pub(crate) async fn close(&mut self) {
        self.owner.cancel.cancel();
        self.owner.idle.retire();
        #[cfg(test)]
        if let Some(mut lane) = self.poll.take() {
            lane.close().await;
        }
        #[cfg(test)]
        if let Some(mut lane) = self.post.take() {
            lane.close().await;
        }
    }
}

// These owners keep IO before permits/credits/completion in destruction order.
pub(crate) struct Prepared {
    lane: Option<Lane>,
    poll: bool,
    host: String,
    _permit: tokio::sync::OwnedSemaphorePermit,
    _slot: Arc<tokio::sync::OwnedSemaphorePermit>,
    owner: Arc<super::runtime::HttpOwnership>,
}
pub(crate) struct Pending {
    reply: Reply,
    prepared: Prepared,
}
/// A completed exchange still owns its response and connection. Dropping this
/// object retires the IO; only explicit restoration permits another exchange.
pub(crate) struct Completed {
    response: Response,
    prepared: Prepared,
}
impl Completed {
    pub(crate) fn into_response(self) -> Response {
        self.response
    }
    pub(crate) async fn restore(
        mut self,
        session: &mut HttpSession,
        poll: bool,
        observation: &crate::secrets::policy::PolicyObservation,
        cancel: &CancellationToken,
    ) -> Result<Response> {
        if !Arc::ptr_eq(&self.prepared.owner, &session.owner) || self.prepared.poll != poll {
            return Err("http_lane_owner");
        }
        if cancel.is_cancelled() || session.owner.cancel.is_cancelled() {
            return Err("http_cancelled");
        }
        observation
            .check_fresh()
            .await
            .map_err(|_| "policy_revoked")?;
        if cancel.is_cancelled() || session.owner.cancel.is_cancelled() {
            return Err("http_cancelled");
        }
        if self.prepared.lane.as_ref().is_some_and(|lane| {
            lane.driver.is_some()
                && lane
                    .sender
                    .as_ref()
                    .is_some_and(|sender| !sender.is_closed())
        }) {
            let lane = self.prepared.lane.take().ok_or("http_closed")?;
            session
                .owner
                .idle
                .restore(poll, lane, &session.owner.cancel)?;
        }
        Ok(self.response)
    }
}
impl Prepared {
    pub(crate) async fn emit(
        mut self,
        lease: &EmissionLease<'_>,
        request: Request,
        cancel: &CancellationToken,
    ) -> Result<Pending> {
        lease.check().map_err(|_| "policy_revoked")?;
        let operation = self
            .lane
            .as_mut()
            .ok_or("http_closed")?
            .emit(&self.host, request);
        let reply = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err("http_cancelled"),
            _ = self.owner.cancel.cancelled() => return Err("http_cancelled"),
            _ = lease.revoked() => return Err("policy_revoked"),
            result = tokio::time::timeout(Duration::from_secs(30), operation) => result.map_err(|_| "http_timeout")??,
        };
        lease.check().map_err(|_| "policy_revoked")?;
        Ok(Pending {
            reply,
            prepared: self,
        })
    }
}
impl Pending {
    pub(crate) async fn receive(
        self,
        limit: usize,
        observation: &crate::secrets::policy::PolicyObservation,
        cancel: &CancellationToken,
    ) -> Result<Response> {
        Ok(self
            .receive_owned(limit, observation, cancel)
            .await?
            .into_response())
    }
    pub(crate) async fn receive_owned(
        mut self,
        limit: usize,
        observation: &crate::secrets::policy::PolicyObservation,
        cancel: &CancellationToken,
    ) -> Result<Completed> {
        observation.check_local().map_err(|_| "policy_revoked")?;
        let operation = self.prepared.lane.as_mut().ok_or("http_closed")?.receive(
            &self.prepared.owner.budget,
            self.reply,
            limit,
            &self.prepared.owner.database,
        );
        let response = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err("http_cancelled"),
            _ = self.prepared.owner.cancel.cancelled() => return Err("http_cancelled"),
            _ = observation.revoked_locally() => return Err("policy_revoked"),
            result = tokio::time::timeout(Duration::from_secs(30), operation) => result.map_err(|_| "http_timeout")?.map_err(|error| if error == "http_body_limit" { "resource_limit" } else { error })?,
        };
        observation.check_local().map_err(|_| "policy_revoked")?;
        Ok(Completed {
            response,
            prepared: self.prepared,
        })
    }
}

#[cfg(test)]
pub(crate) struct HttpPort<'s, 'p> {
    lane: &'s mut Option<Lane>,
    common: (
        &'s TransitInstance,
        &'p EmissionLease<'p>,
        &'s str,
        SocketAddr,
        &'s Option<Arc<TlsSettings>>,
        &'s Arc<crate::core::db_state::ChatWorkLifetime>,
        &'s CancellationToken,
    ),
}
#[cfg(test)]
impl HttpPort<'_, '_> {
    pub(crate) async fn exchange(
        &mut self,
        request: Request,
        limit: usize,
        cancel: &CancellationToken,
    ) -> Result<Response> {
        let (budget, lease, host, address, tls, database, app_cancel) = self.common;
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
            app_cancel,
            database,
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connect_resources::TRANSIT_INSTANCE_LIMIT;
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
        tokio::spawn(async move {
            crate::secrets::blocking::run(move || {
                let directory = tempfile::tempdir().unwrap();
                let policy = PolicyOwner::for_test(directory.path());
                policy.initialize(directory.path()).unwrap();
                let snapshot = policy.capture_private(|| Ok(())).unwrap();
                let budget = super::super::TransferRuntime::default().budget().unwrap();
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
            .await
            .unwrap()
        })
    }
    fn plain<'a>(
        _lease: &'a EmissionLease<'a>,
        budget: TransitInstance,
        address: SocketAddr,
        database: &crate::core::db_state::DbReady,
    ) -> HttpSession {
        HttpSession {
            poll: None,
            post: None,
            host: "localhost".into(),
            address,
            tls: None,
            budget,
            database: Arc::new(database.retain_chat_work()),
            _slot: Arc::new(HTTP_SESSION.clone().try_acquire_owned().unwrap()),
            poll_slot: Arc::new(tokio::sync::Semaphore::new(1)),
            post_slot: Arc::new(tokio::sync::Semaphore::new(1)),
            owner: Arc::new(
                super::super::TransferRuntime::default()
                    .http_owner(database)
                    .unwrap(),
            ),
        }
    }
    #[tokio::test]
    async fn complete_close_responses_survive_driver_completion_without_post_retry() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            for index in 0..40 {
                let (mut stream, _) = listener.accept().await.unwrap();
                request(&mut stream).await.unwrap();
                let wire: &[u8] = if index % 2 == 0 {
                    b"HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: 2\r\n\r\n{}"
                } else {
                    b"HTTP/1.1 200 OK\r\nConnection: close\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\n\r\n"
                };
                stream.write_all(wire).await.unwrap();
                stream.shutdown().await.unwrap();
            }
        });
        scoped(move |lease, budget, database| {
            tokio::runtime::Handle::current().block_on(async {
                let mut session = plain(lease, budget.clone(), address, database);
                let cancel = CancellationToken::new();
                for _ in 0..40 {
                    let request = Request::new(&budget, http::Method::POST, "/ack", b"{}").unwrap();
                    let response = tokio::time::timeout(
                        Duration::from_secs(3),
                        session.lanes(lease).1.exchange(request, 98_304, &cancel),
                    )
                    .await
                    .unwrap()
                    .unwrap();
                    assert_eq!(response.status, 200);
                    assert_eq!(response.body, b"{}");
                    assert!(session.post.is_none());
                    assert!(budget.reserve(TRANSIT_INSTANCE_LIMIT).is_err());
                    drop(response);
                    assert!(budget.reserve(TRANSIT_INSTANCE_LIMIT).is_ok());
                }
                session.close().await;
            })
        })
        .await
        .unwrap();
        server.await.unwrap();
    }

    #[tokio::test]
    async fn dropping_exchange_destroys_new_and_reused_lanes_before_returning_credits() {
        for reuse in [false, true] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let started = Arc::new(tokio::sync::Notify::new());
            let sent = started.clone();
            let (closed, observed) = tokio::sync::oneshot::channel();
            let server = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.unwrap();
                if reuse {
                    request(&mut stream).await.unwrap();
                    stream
                        .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}")
                        .await
                        .unwrap();
                }
                request(&mut stream).await.unwrap();
                stream
                    .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 90000\r\n\r\n")
                    .await
                    .unwrap();
                sent.notify_one();
                let mut byte = [0];
                let result = tokio::time::timeout(Duration::from_secs(3), stream.read(&mut byte))
                    .await
                    .unwrap();
                assert!(
                    matches!(result, Ok(0))
                        || matches!(result, Err(ref e) if e.kind() == std::io::ErrorKind::ConnectionReset)
                );
                closed.send(()).unwrap();
                // Reuse of the port must establish a fresh socket, with no replay
                // of the abandoned POST on either connection.
                let (mut stream, _) = listener.accept().await.unwrap();
                assert_eq!(request(&mut stream).await, Some(false));
                stream
                    .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}")
                    .await
                    .unwrap();
                assert_eq!(stream.read(&mut byte).await.unwrap(), 0);
            });
            scoped(move |lease, budget, database| {
                tokio::runtime::Handle::current().block_on(async {
                    let runtime = super::super::TransferRuntime::default();
                    let mut session = plain(lease, budget.clone(), address, database);
                    session.owner = Arc::new(runtime.http_owner(database).unwrap());
                    let cancel = CancellationToken::new();
                    if reuse {
                        let request = Request::new(&budget, http::Method::POST, "/poll", b"{}").unwrap();
                        drop(session.lanes(lease).0.exchange(request, 98_304, &cancel).await.unwrap());
                        assert!(session.poll.is_some());
                    }
                    {
                        let (mut port, _) = session.lanes(lease);
                        let request = Request::new(&budget, http::Method::POST, "/poll", b"{}").unwrap();
                        let exchange = port.exchange(request, 98_304, &cancel);
                        tokio::pin!(exchange);
                        tokio::select! {
                            biased;
                            _ = started.notified() => (),
                            result = &mut exchange => panic!("unexpected completion: {:?}", result.err()),
                        }
                        assert!(budget.reserve(TRANSIT_INSTANCE_LIMIT).is_err());
                    }
                    assert!(session.poll.is_none());
                    // The owner stays alive and idle while the peer observes EOF.
                    // No close(), next exchange, timer or cancellation drives it.
                    tokio::time::timeout(Duration::from_secs(3), observed).await.unwrap().unwrap();
                    assert!(budget.reserve(TRANSIT_INSTANCE_LIMIT).is_ok());
                    assert!(!cancel.is_cancelled());
                    let request = Request::new(&budget, http::Method::POST, "/ack", b"{}").unwrap();
                    drop(session.lanes(lease).0.exchange(request, 98_304, &cancel).await.unwrap());
                    runtime.revoke();
                    let request = Request::new(&budget, http::Method::POST, "/ack", b"{}").unwrap();
                    assert_eq!(session.lanes(lease).0.exchange(request, 98_304, &cancel).await.err(), Some("http_cancelled"));
                    drop(session);
                    assert!(tokio::time::timeout(Duration::from_secs(3), runtime.shutdown()).await.unwrap());
                    assert!(budget.reserve(TRANSIT_INSTANCE_LIMIT).is_ok());
                })
            }).await.unwrap();
            server.await.unwrap();
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
                let (mut poll, mut post) = session.lanes(lease);
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
    async fn app_shutdown_cancels_and_waits_for_http_owner_after_caller_disappears() {
        let runtime = super::super::TransferRuntime::default();
        let owned = runtime.clone();
        let started = Arc::new(tokio::sync::Notify::new());
        let observed = started.clone();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            request(&mut stream).await.unwrap();
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 90000\r\n\r\n")
                .await
                .unwrap();
            observed.notify_one();
            let mut byte = [0];
            tokio::time::timeout(Duration::from_secs(3), stream.read(&mut byte))
                .await
                .unwrap()
        });
        let caller = scoped(move |lease, budget, database| {
            tokio::runtime::Handle::current().block_on(async {
                let mut session = plain(lease, budget.clone(), address, database);
                session.owner = Arc::new(owned.http_owner(database).unwrap());
                let cancel = CancellationToken::new();
                let request = Request::new(&budget, http::Method::POST, "/poll", b"{}").unwrap();
                let result = session
                    .lanes(lease)
                    .0
                    .exchange(request, 98_304, &cancel)
                    .await;
                assert_eq!(result.err(), Some("http_cancelled"));
                session.close().await;
                drop(session);
                assert!(budget.reserve(TRANSIT_INSTANCE_LIMIT).is_ok());
            })
        });
        started.notified().await;
        // The real blocking bridge retains the worker and policy scope after
        // this outer future is aborted. App shutdown joins physical ownership.
        caller.abort();
        assert!(
            tokio::time::timeout(Duration::from_secs(3), runtime.shutdown())
                .await
                .unwrap()
        );
        match server.await.unwrap() {
            Ok(0) => (),
            Err(error) if error.kind() == std::io::ErrorKind::ConnectionReset => (),
            other => panic!("socket still open: {other:?}"),
        }
        assert!(caller.await.unwrap_err().is_cancelled());
    }

    #[tokio::test]
    async fn fresh_policy_revocation_stops_real_http_before_settlement() {
        let directory = tempfile::tempdir().unwrap();
        let policy = Arc::new(PolicyOwner::for_test(directory.path()));
        policy.initialize(directory.path()).unwrap();
        let pool = crate::db::create_pool(&directory.path().join("policy-http.db"))
            .await
            .unwrap();
        let db = crate::core::db_state::DbPool::default();
        db.set_ready(pool).await.unwrap();
        let ready = db.wait_until_ready_context().await.unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let started = Arc::new(tokio::sync::Notify::new());
        let observed = started.clone();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            request(&mut stream).await.unwrap();
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 90000\r\n\r\n")
                .await
                .unwrap();
            observed.notify_one();
            let mut byte = [0];
            tokio::time::timeout(Duration::from_secs(3), stream.read(&mut byte))
                .await
                .unwrap()
        });
        let captured = Arc::new(policy.capture_private(|| Ok(())).unwrap());
        let worker_snapshot = captured.clone();
        let worker_policy = policy.clone();
        let handle = tokio::runtime::Handle::current();
        let worker = tokio::spawn(async move {
            crate::secrets::blocking::run(move || {
                let outcome = worker_policy.consume_private(
                    &worker_snapshot,
                    || Ok(()),
                    |lease, _| {
                        handle.block_on(async {
                            let runtime = super::super::TransferRuntime::default();
                            let budget = runtime.budget().unwrap();
                            let mut session = plain(lease, budget.clone(), address, &ready);
                            let cancel = CancellationToken::new();
                            let request =
                                Request::new(&budget, http::Method::POST, "/poll", b"{}").unwrap();
                            assert_eq!(
                                session
                                    .lanes(lease)
                                    .0
                                    .exchange(request, 98_304, &cancel)
                                    .await
                                    .err(),
                                Some("policy_revoked")
                            );
                            assert!(lease.check().is_err());
                            session.close().await;
                            drop(session);
                            assert!(budget.reserve(TRANSIT_INSTANCE_LIMIT).is_ok());
                        });
                        Ok(())
                    },
                );
                assert!(matches!(
                    outcome,
                    Err(crate::secrets::SecretError::PolicyUnavailable)
                ));
            })
            .await
            .unwrap();
        });
        started.notified().await;
        let ticket = policy.revoke_now();
        tokio::time::timeout(Duration::from_secs(3), worker)
            .await
            .unwrap()
            .unwrap();
        match server.await.unwrap() {
            Ok(0) => (),
            Err(error) if error.kind() == std::io::ErrorKind::ConnectionReset => (),
            other => panic!("socket still open: {other:?}"),
        }
        policy.settle(ticket).unwrap();
        assert!(policy
            .consume_private(&captured, || Ok(()), |_, _| Ok(()))
            .is_err());
    }

    #[tokio::test]
    async fn truncated_body_and_unbounded_headers_close_without_reuse() {
        for (wire, limit) in [
            (
                b"HTTP/1.1 200 OK\r\nContent-Length: 12\r\n\r\nshort".to_vec(),
                98_304,
            ),
            (
                b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nshort".to_vec(),
                98_304,
            ),
            (
                format!(
                    "HTTP/1.1 200 OK\r\nX-Large: {}\r\nContent-Length: 0\r\n\r\n",
                    "x".repeat(9000)
                )
                .into_bytes(),
                98_304,
            ),
            (
                b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\n1234\r\n0\r\n\r\n"
                    .to_vec(),
                2,
            ),
        ] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.unwrap();
                request(&mut stream).await.unwrap();
                let _ = stream.write_all(&wire).await;
                stream.shutdown().await.unwrap();
            });
            scoped(move |lease, budget, database| {
                tokio::runtime::Handle::current().block_on(async {
                    let mut session = plain(lease, budget.clone(), address, database);
                    let cancel = CancellationToken::new();
                    let request =
                        Request::new(&budget, http::Method::POST, "/poll", b"{}").unwrap();
                    assert!(session
                        .lanes(lease)
                        .0
                        .exchange(request, limit, &cancel)
                        .await
                        .is_err());
                    assert!(session.poll.is_none());
                    session.close().await;
                    assert!(budget.reserve(TRANSIT_INSTANCE_LIMIT).is_ok());
                })
            })
            .await
            .unwrap();
            server.await.unwrap();
        }
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
                let (mut poll, _) = session.lanes(lease);
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
        });
        scoped(move |lease, budget, database| {
            tokio::runtime::Handle::current().block_on(async {
                let request = Request::new(&budget, http::Method::POST, "/poll", b"{}").unwrap();
                let mut session = plain(lease, budget, address, database);
                let (mut poll, _) = session.lanes(lease);
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
        match server.await.unwrap() {
            Ok(0) => (),
            Err(error) if error.kind() == std::io::ErrorKind::ConnectionReset => (),
            other => panic!("socket still open: {other:?}"),
        }
    }
    fn synthetic_tls() -> (
        tokio_rustls::TlsAcceptor,
        rustls::pki_types::CertificateDer<'static>,
    ) {
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
        (acceptor, cert)
    }
    #[tokio::test]
    async fn real_tls_validates_the_synthetic_certificate_and_hostname() {
        let (acceptor, cert) = synthetic_tls();
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
                    let (_, mut post) = session.lanes(lease);
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
    #[tokio::test]
    async fn completed_flush_releases_policy_before_headers_and_rejects_revoked_reply() {
        let (acceptor, cert) = synthetic_tls();
        for tls in [false, true] {
            for body in [b"".as_slice(), b"{}".as_slice()] {
                let directory = tempfile::tempdir().unwrap();
                let policy = Arc::new(PolicyOwner::for_test(directory.path()));
                policy.initialize(directory.path()).unwrap();
                let snapshot = policy.capture_private(|| Ok(())).unwrap();
                let observation = policy.observe(&snapshot).unwrap();
                let pool = crate::db::create_pool(&directory.path().join("split.db"))
                    .await
                    .unwrap();
                let db = crate::core::db_state::DbPool::default();
                db.set_ready(pool).await.unwrap();
                let ready = db.wait_until_ready_context().await.unwrap();
                let runtime = super::super::TransferRuntime::default();
                let budget = runtime.budget().unwrap();
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                let address = listener.local_addr().unwrap();
                let (seen, received) = tokio::sync::oneshot::channel();
                let size = body.len();
                let acceptor = acceptor.clone();
                let server = tokio::spawn(async move {
                    let (stream, _) = listener.accept().await.unwrap();
                    let mut stream: Box<dyn Io> = if tls {
                        Box::new(acceptor.accept(stream).await.unwrap())
                    } else {
                        Box::new(stream)
                    };
                    let mut headers = Vec::new();
                    while !headers.ends_with(b"\r\n\r\n") {
                        assert!(headers.len() < HEAD);
                        headers.push(stream.read_u8().await.unwrap());
                    }
                    let mut body = vec![0; size];
                    stream.read_exact(&mut body).await.unwrap();
                    seen.send(()).unwrap();
                    // No headers for 25 seconds. The native mutation must complete
                    // while the peer is still withholding its entire response.
                    let mut byte = [0];
                    match tokio::time::timeout(Duration::from_secs(25), stream.read(&mut byte))
                        .await
                        .unwrap()
                    {
                        Ok(0) => (),
                        Err(error)
                            if matches!(
                                error.kind(),
                                std::io::ErrorKind::UnexpectedEof
                                    | std::io::ErrorKind::ConnectionReset
                            ) =>
                        {
                            ()
                        }
                        other => panic!("owner did not close: {other:?}"),
                    }
                });
                let mut session =
                    HttpSession::new(runtime.http_owner(&ready).unwrap(), "localhost", address)
                        .unwrap();
                session.tls = if tls {
                    Some(
                        TlsSettings::with_roots(&budget, || {
                            let mut roots = rustls::RootCertStore::empty();
                            roots.add(cert.clone()).unwrap();
                            roots
                        })
                        .unwrap(),
                    )
                } else {
                    None
                };
                let prepared = session.prepare(false).await.unwrap();
                let request =
                    Request::new(&budget, http::Method::POST, "/bootstrap-test", body).unwrap();
                let cancel = CancellationToken::new();
                let handle = tokio::runtime::Handle::current();
                let emitting_policy = policy.clone();
                let pending = crate::secrets::blocking::run(move || {
                    emitting_policy.consume_private(
                        &snapshot,
                        || Ok(()),
                        |lease, _| {
                            handle
                                .block_on(prepared.emit(lease, request, &cancel))
                                .map_err(|_| crate::secrets::SecretError::PolicyUnavailable)
                        },
                    )
                })
                .await
                .unwrap()
                .unwrap();
                tokio::time::timeout(Duration::from_secs(2), received)
                    .await
                    .unwrap()
                    .unwrap();
                let mutation = policy.clone();
                tokio::time::timeout(
                    Duration::from_secs(2),
                    crate::secrets::blocking::run(move || mutation.change(|| ())),
                )
                .await
                .unwrap()
                .unwrap()
                .unwrap();
                assert_eq!(
                    pending
                        .receive(98_304, &observation, &CancellationToken::new())
                        .await
                        .err(),
                    Some("policy_revoked")
                );
                server.await.unwrap();
                drop(session);
                assert!(budget.reserve(TRANSIT_INSTANCE_LIMIT).is_ok());
            }
        }
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn blocked_write_keeps_scope_until_revocation_or_caller_abort_destroys_io() {
        let (acceptor, cert) = synthetic_tls();
        for tls in [false, true] {
            for abort in [false, true] {
                let directory = tempfile::tempdir().unwrap();
                let policy = Arc::new(PolicyOwner::for_test(directory.path()));
                policy.initialize(directory.path()).unwrap();
                let snapshot = policy.capture_private(|| Ok(())).unwrap();
                let pool = crate::db::create_pool(&directory.path().join("pressure.db"))
                    .await
                    .unwrap();
                let db = crate::core::db_state::DbPool::default();
                db.set_ready(pool).await.unwrap();
                let ready = db.wait_until_ready_context().await.unwrap();
                let runtime = super::super::TransferRuntime::default();
                let budget = runtime.budget().unwrap();
                let socket = TcpSocket::new_v4().unwrap();
                socket.set_recv_buffer_size(4096).unwrap();
                socket.bind("127.0.0.1:0".parse().unwrap()).unwrap();
                let listener = socket.listen(1).unwrap();
                let address = listener.local_addr().unwrap();
                let (drain, draining) = tokio::sync::oneshot::channel();
                let acceptor = acceptor.clone();
                let server = tokio::spawn(async move {
                    let (stream, _) = listener.accept().await.unwrap();
                    let mut stream: Box<dyn Io> = if tls {
                        Box::new(acceptor.accept(stream).await.unwrap())
                    } else {
                        Box::new(stream)
                    };
                    // An early complete response must not release the write scope.
                    stream
                        .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
                        .await
                        .unwrap();
                    stream.flush().await.unwrap();
                    let _ = draining.await;
                    let mut bytes = [0; 8192];
                    let mut total = 0;
                    loop {
                        match tokio::time::timeout(Duration::from_secs(5), stream.read(&mut bytes))
                            .await
                            .unwrap()
                        {
                            Ok(0) => break,
                            Ok(n) => total += n,
                            Err(error)
                                if matches!(
                                    error.kind(),
                                    std::io::ErrorKind::UnexpectedEof
                                        | std::io::ErrorKind::ConnectionReset
                                ) =>
                            {
                                break
                            }
                            Err(error) => panic!("read failed: {error}"),
                        }
                    }
                    total
                });
                let mut session =
                    HttpSession::new(runtime.http_owner(&ready).unwrap(), "localhost", address)
                        .unwrap();
                session.tls = if tls {
                    Some(
                        TlsSettings::with_roots(&budget, || {
                            let mut roots = rustls::RootCertStore::empty();
                            roots.add(cert.clone()).unwrap();
                            roots
                        })
                        .unwrap(),
                    )
                } else {
                    None
                };
                let prepared = session.prepare(false).await.unwrap();
                let fence = prepared.lane.as_ref().unwrap().fence.clone();
                let source = budget.reserve(V2_BODY as u64).unwrap();
                let body = vec![42; V2_BODY];
                let request = Request::new(&budget, http::Method::POST, "/blocked", &body).unwrap();
                drop(body);
                drop(source);
                let (entered, entering) = tokio::sync::oneshot::channel();
                let emitting_policy = policy.clone();
                let mut emitting = tokio::spawn(async move {
                    let handle = tokio::runtime::Handle::current();
                    let cancel = CancellationToken::new();
                    let guard = cancel.clone().drop_guard();
                    let result = crate::secrets::blocking::run(move || {
                        emitting_policy.consume_private(
                            &snapshot,
                            || Ok(()),
                            |lease, _| {
                                entered.send(()).unwrap();
                                Ok(handle.block_on(prepared.emit(lease, request, &cancel)))
                            },
                        )
                    })
                    .await;
                    guard.disarm();
                    result
                });
                tokio::time::timeout(Duration::from_secs(2), entering)
                    .await
                    .unwrap()
                    .unwrap();
                let was_blocked = tokio::time::timeout(Duration::from_millis(40), &mut emitting)
                    .await
                    .is_err();
                if abort {
                    emitting.abort();
                }
                let mutation = policy.clone();
                let changed = tokio::time::timeout(
                    Duration::from_secs(2),
                    crate::secrets::blocking::run(move || mutation.change(|| ())),
                )
                .await;
                let _ = drain.send(());
                if was_blocked {
                    let _ = emitting.await;
                }
                crate::secrets::blocking::join_test_jobs().await;
                let received = server.await.unwrap();
                drop(session);
                assert!(
                    was_blocked,
                    "request unexpectedly flushed despite constrained receive window"
                );
                assert!(fence.vectored_slices.load(Ordering::SeqCst) >= 2);
                assert!(fence.wrote.load(Ordering::SeqCst));
                assert!(
                    !fence.flushed(),
                    "partial vectored write completed the fence"
                );
                changed.unwrap().unwrap().unwrap();
                assert!(
                    received < V2_BODY,
                    "an incomplete request was reported as fully emitted"
                );
                assert!(budget.reserve(TRANSIT_INSTANCE_LIMIT).is_ok());
            }
        }
    }

    async fn emit_private(
        policy: Arc<PolicyOwner>,
        prepared: Prepared,
        request: Request,
    ) -> Pending {
        let handle = tokio::runtime::Handle::current();
        crate::secrets::blocking::run(move || {
            let snapshot = policy.capture_private(|| Ok(())).unwrap();
            policy
                .consume_private(
                    &snapshot,
                    || Ok(()),
                    |lease, _| {
                        Ok(handle.block_on(prepared.emit(
                            lease,
                            request,
                            &CancellationToken::new(),
                        )))
                    },
                )
                .unwrap()
                .unwrap()
        })
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn completed_two_lanes_reuse_real_sockets_and_retire_idle_on_runtime_revoke() {
        let (acceptor, cert) = synthetic_tls();
        for (tls, revoke) in [(false, false), (false, true), (true, false), (true, true)] {
            let directory = tempfile::tempdir().unwrap();
            let policy = Arc::new(PolicyOwner::for_test(directory.path()));
            policy.initialize(directory.path()).unwrap();
            let snapshot = policy.capture_private(|| Ok(())).unwrap();
            let observation = policy.observe(&snapshot).unwrap();
            let pool = crate::db::create_pool(&directory.path().join("reuse.db"))
                .await
                .unwrap();
            let db = crate::core::db_state::DbPool::default();
            db.set_ready(pool).await.unwrap();
            let ready = db.wait_until_ready_context().await.unwrap();
            let runtime = super::super::TransferRuntime::default();
            let budget = runtime.budget().unwrap();
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let accepted = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let count = accepted.clone();
            let acceptor = acceptor.clone();
            let server = tokio::spawn(async move {
                let mut joins = tokio::task::JoinSet::new();
                for _ in 0..2 {
                    let (socket, _) = listener.accept().await.unwrap();
                    count.fetch_add(1, Ordering::SeqCst);
                    let acceptor = acceptor.clone();
                    joins.spawn(async move {
                        let mut socket: Box<dyn Io> = if tls {
                            Box::new(acceptor.accept(socket).await.unwrap())
                        } else { Box::new(socket) };
                        for _ in 0..2 {
                            let mut head = Vec::new();
                            while !head.ends_with(b"\r\n\r\n") {
                                assert!(head.len() < HEAD);
                                head.push(socket.read_u8().await.unwrap());
                            }
                            let mut body = [0; 2];
                            socket.read_exact(&mut body).await.unwrap();
                            assert_eq!(&body, b"{}");
                            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}").await.unwrap();
                            socket.flush().await.unwrap();
                        }
                        let mut byte = [0];
                        let end = tokio::time::timeout(Duration::from_secs(3), socket.read(&mut byte)).await.unwrap();
                        assert!(matches!(end, Ok(0)) || matches!(end, Err(ref error) if matches!(error.kind(), std::io::ErrorKind::UnexpectedEof | std::io::ErrorKind::ConnectionReset)));
                    });
                }
                while let Some(join) = joins.join_next().await {
                    join.unwrap();
                }
            });
            let mut session =
                HttpSession::new(runtime.http_owner(&ready).unwrap(), "localhost", address)
                    .unwrap();
            session.tls = if tls {
                Some(
                    TlsSettings::with_roots(&budget, || {
                        let mut roots = rustls::RootCertStore::empty();
                        roots.add(cert.clone()).unwrap();
                        roots
                    })
                    .unwrap(),
                )
            } else {
                None
            };
            let cancel = CancellationToken::new();
            for poll in [true, false, true, false] {
                let prepared = session.prepare(poll).await.unwrap();
                let fence = prepared.lane.as_ref().unwrap().fence.clone();
                let request = Request::from_admitted(
                    &budget,
                    http::Method::POST,
                    "/reuse",
                    super::super::codec::Bytes::copy(&budget, b"{}").unwrap(),
                )
                .unwrap();
                let pending = emit_private(policy.clone(), prepared, request).await;
                let completed = pending
                    .receive_owned(98_304, &observation, &cancel)
                    .await
                    .unwrap();
                assert!(
                    fence.vectored_slices.load(Ordering::SeqCst) >= 2,
                    "Hyper did not present headers and body as separate buffers"
                );
                let response = completed
                    .restore(&mut session, poll, &observation, &cancel)
                    .await
                    .unwrap();
                let pointer = response.body.as_ptr();
                let body = response.into_codec_body().unwrap();
                assert_eq!(body.as_slice(), b"{}");
                assert_eq!(body.as_slice().as_ptr(), pointer);
                drop(body);
            }
            assert_eq!(accepted.load(Ordering::SeqCst), 2);
            assert!(budget
                .reserve(TRANSIT_INSTANCE_LIMIT - if tls { CONFIG } else { 0 })
                .is_err());
            let shutting_down = runtime.shutdown();
            tokio::pin!(shutting_down);
            if revoke {
                runtime.revoke();
            } else {
                assert!(futures::poll!(&mut shutting_down).is_pending());
            }
            server.await.unwrap();
            // The session is still alive: idle IO must already be destroyed.
            drop(
                budget
                    .reserve(TRANSIT_INSTANCE_LIMIT - if tls { CONFIG } else { 0 })
                    .unwrap(),
            );
            assert!(session.prepare(false).await.is_err());
            drop(session);
            assert!(shutting_down.await);
            drop(budget.reserve(TRANSIT_INSTANCE_LIMIT).unwrap());
        }
    }

    #[tokio::test]
    async fn prepared_pending_completed_abandonment_and_restore_guards_close_socket() {
        for phase in 0..7 {
            let directory = tempfile::tempdir().unwrap();
            let policy = Arc::new(PolicyOwner::for_test(directory.path()));
            policy.initialize(directory.path()).unwrap();
            let snapshot = policy.capture_private(|| Ok(())).unwrap();
            let observation = policy.observe(&snapshot).unwrap();
            let pool = crate::db::create_pool(&directory.path().join("abandon.db"))
                .await
                .unwrap();
            let db = crate::core::db_state::DbPool::default();
            db.set_ready(pool).await.unwrap();
            let ready = db.wait_until_ready_context().await.unwrap();
            let runtime = super::super::TransferRuntime::default();
            let budget = runtime.budget().unwrap();
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                if phase != 0 {
                    request(&mut socket).await.unwrap();
                    if phase != 1 {
                        socket
                            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}")
                            .await
                            .unwrap();
                    }
                }
                let mut byte = [0];
                let end = tokio::time::timeout(Duration::from_secs(3), socket.read(&mut byte))
                    .await
                    .unwrap();
                assert!(
                    matches!(end, Ok(0))
                        || matches!(end, Err(ref error) if error.kind() == std::io::ErrorKind::ConnectionReset)
                );
            });
            let mut session =
                HttpSession::new(runtime.http_owner(&ready).unwrap(), "localhost", address)
                    .unwrap();
            session.tls = None;
            let prepared = session.prepare(false).await.unwrap();
            assert!(budget.reserve(TRANSIT_INSTANCE_LIMIT).is_err());
            if phase == 0 {
                drop(prepared);
            } else {
                let request = Request::new(&budget, http::Method::POST, "/ack", b"{}").unwrap();
                let pending = emit_private(policy.clone(), prepared, request).await;
                if phase == 1 {
                    drop(pending);
                } else {
                    let cancel = CancellationToken::new();
                    let completed = pending
                        .receive_owned(98_304, &observation, &cancel)
                        .await
                        .unwrap();
                    match phase {
                        2 => drop(completed),
                        3 => assert_eq!(
                            completed
                                .restore(&mut session, true, &observation, &cancel)
                                .await
                                .err(),
                            Some("http_lane_owner")
                        ),
                        4 => {
                            let foreign = super::super::TransferRuntime::default();
                            let previous = std::mem::replace(
                                &mut session.owner,
                                Arc::new(foreign.http_owner(&ready).unwrap()),
                            );
                            assert_eq!(
                                completed
                                    .restore(&mut session, false, &observation, &cancel)
                                    .await
                                    .err(),
                                Some("http_lane_owner")
                            );
                            session.owner = previous;
                            assert!(foreign.shutdown().await);
                        }
                        5 => {
                            cancel.cancel();
                            assert_eq!(
                                completed
                                    .restore(&mut session, false, &observation, &cancel)
                                    .await
                                    .err(),
                                Some("http_cancelled")
                            );
                        }
                        6 => {
                            runtime.revoke();
                            assert_eq!(
                                completed
                                    .restore(&mut session, false, &observation, &cancel)
                                    .await
                                    .err(),
                                Some("http_cancelled")
                            );
                        }
                        _ => unreachable!(),
                    }
                }
            }
            server.await.unwrap();
            drop(budget.reserve(TRANSIT_INSTANCE_LIMIT).unwrap());
            drop(session);
            assert!(runtime.shutdown().await);
        }
    }

    #[tokio::test]
    async fn completed_close_reply_is_valid_but_never_restored_and_truncation_refuses() {
        for truncated in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let policy = Arc::new(PolicyOwner::for_test(directory.path()));
            policy.initialize(directory.path()).unwrap();
            let snapshot = policy.capture_private(|| Ok(())).unwrap();
            let observation = policy.observe(&snapshot).unwrap();
            let pool = crate::db::create_pool(&directory.path().join("close.db"))
                .await
                .unwrap();
            let db = crate::core::db_state::DbPool::default();
            db.set_ready(pool).await.unwrap();
            let ready = db.wait_until_ready_context().await.unwrap();
            let runtime = super::super::TransferRuntime::default();
            let budget = runtime.budget().unwrap();
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                request(&mut socket).await.unwrap();
                let wire: &[u8] = if truncated {
                    b"HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: 5\r\n\r\n{}"
                } else {
                    b"HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: 2\r\n\r\n{}"
                };
                socket.write_all(wire).await.unwrap();
                socket.shutdown().await.unwrap();
                assert!(
                    tokio::time::timeout(Duration::from_millis(100), listener.accept())
                        .await
                        .is_err(),
                    "POST retried unexpectedly"
                );
            });
            let mut session =
                HttpSession::new(runtime.http_owner(&ready).unwrap(), "localhost", address)
                    .unwrap();
            session.tls = None;
            let prepared = session.prepare(false).await.unwrap();
            let request = Request::new(&budget, http::Method::POST, "/ack", b"{}").unwrap();
            let pending = emit_private(policy, prepared, request).await;
            let cancel = CancellationToken::new();
            let completed = pending.receive_owned(98_304, &observation, &cancel).await;
            if truncated {
                assert!(completed.is_err());
            } else {
                let response = completed
                    .unwrap()
                    .restore(&mut session, false, &observation, &cancel)
                    .await
                    .unwrap();
                assert_eq!(response.body(), b"{}");
                drop(response);
            }
            assert!(session.owner.idle.take(false).unwrap().is_none());
            server.await.unwrap();
            drop(session);
            assert!(runtime.shutdown().await);
            drop(budget.reserve(TRANSIT_INSTANCE_LIMIT).unwrap());
        }
    }
}
