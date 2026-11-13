//! Host HTTP transport. Admission runs before DNS and each pinned connection.
use std::{future::Future, net::IpAddr, pin::Pin};
use tokio_util::sync::CancellationToken;
use url::Url;
pub type FetchFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, String>> + Send + 'a>>;
pub type AdmitNetwork<'a> = dyn FnMut(Url, Option<IpAddr>) -> FetchFuture<'a, ()> + Send + 'a;
pub struct NetworkResource {
    pub url: String,
    pub content_type: Option<String>,
    pub body_base64: String,
}
pub trait ContentNetwork: Send + Sync {
    fn fetch<'a>(
        &'a self,
        url: Url,
        cancel: &'a CancellationToken,
        admit: &'a mut AdmitNetwork<'a>,
    ) -> FetchFuture<'a, NetworkResource>;
}
pub struct UnavailableNetwork;
impl ContentNetwork for UnavailableNetwork {
    fn fetch<'a>(
        &'a self,
        _: Url,
        _: &'a CancellationToken,
        _: &'a mut AdmitNetwork<'a>,
    ) -> FetchFuture<'a, NetworkResource> {
        Box::pin(async { Err("Native content network transport is unavailable".into()) })
    }
}
