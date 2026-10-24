//! Private owned transport. No IPC constructor or public F capability.
#![allow(dead_code)]
mod codec;
mod runtime;
pub(crate) use runtime::TransferRuntime;
