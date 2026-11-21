//! Native engine types; generator mirrors are owned by Macro.
pub use argentic_runtime::persistence::dto::*;
#[path = "dto_ipc.rs"]
pub(crate) mod ipc;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Admission {
    Admitted(EngineActivation, Option<EngineMemory>),
    Waiting(&'static str),
    Rejected(&'static str),
}
