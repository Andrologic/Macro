//! Argentic core: pure engine logic for AgSDL 0.3.
//!
//! D15 2.c ports the TypeScript evaluators here one sub-lot at a time; 2.c.1
//! brought exact JSON values, value schemas and work integers, 2.c.2 the
//! reader, the schema checker, flow graphs and static validation. 2.c.5a adds
//! descriptive routes and captured message resolution. 2.c.3 adds compilation,
//! contracts and explicit native data; numeric conversion stays at the boundary.
//! Nothing
//! outside tests calls this module before the 2.c.7 switch. The module must
//! not use the desktop shell, storage drivers, generated IPC types or IO; the
//! architecture guard counts forbidden names here, comments included. Besides
//! the standard library, the staged ports use the locked schema regex, serde
//! JSON data types, SHA-256 and the approved pure URL syntax parser.
pub(crate) mod calls_data;
pub(crate) mod clock;
pub(crate) mod compile;
pub(crate) mod contract;
pub(crate) mod error;
pub(crate) mod exact;
pub(crate) mod graph;
pub(crate) mod integers;
pub(crate) mod messages;
pub(crate) mod native;
pub(crate) mod reader;
pub(crate) mod route;
pub(crate) mod schema;
pub(crate) mod validate;
pub(crate) mod valueschema;
pub(crate) mod work;

extern crate self as argentic_core;

pub mod calculation;
mod native_json;

pub mod durable_json;
pub mod flow;

/// Exact bundled harness-module bytes. Descriptive support never grants an effect.
pub fn harness_module(name: &str) -> Option<&'static str> {
    reader::PINNED_MODULES
        .iter()
        .find(|(key, _)| *key == name)
        .map(|(_, text)| *text)
}
