//! Argentic core: pure engine logic for AgSDL 0.3.
//!
//! D15 2.c ports the TypeScript evaluators here one sub-lot at a time; 2.c.1
//! brought exact JSON values, value schemas and work integers, 2.c.2 the
//! reader, the schema checker, flow graphs and static validation. Nothing
//! outside tests calls this module before the 2.c.7 switch. The module must
//! not use the desktop shell, storage drivers, generated IPC types or IO; the
//! architecture guard counts forbidden names here, comments included. Besides
//! the standard library, only the locked `regex` crate is used, for the
//! patterns of the pinned and code-defined schemas.
pub(crate) mod error;
pub(crate) mod exact;
pub(crate) mod graph;
pub(crate) mod integers;
pub(crate) mod reader;
pub(crate) mod schema;
pub(crate) mod validate;
pub(crate) mod valueschema;
