//! Private owned transport. No IPC constructor or public F capability.
#![allow(dead_code)]
pub(crate) mod codec;
pub(crate) mod http;
pub(crate) mod runtime;
pub(super) mod transfer_worker;
pub(crate) use runtime::TransferRuntime;

// These tests exercise the real process-wide transit budget and HTTP/codec
// permits, including assertions about the last remaining credit.
#[cfg(test)]
static PROCESS_RESOURCES_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
