//! Argentic core: pure engine logic for AgSDL 0.3, standard library only.
//!
//! D15 2.c ports the TypeScript evaluators here one sub-lot at a time; 2.c.1
//! brings exact JSON values, value schemas and work integers. Nothing outside
//! tests calls this module before the 2.c.7 switch. The module must not use
//! the desktop shell, storage drivers, generated IPC types or IO; the
//! architecture guard counts forbidden names here, comments included.
pub(crate) mod error;
pub(crate) mod exact;
pub(crate) mod integers;
pub(crate) mod valueschema;
