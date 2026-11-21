//! Shared DTOs for the existing pure TS work controller and native 0.3 broker.
//! These records add no persistence operations or admission authority.
use super::super::dto::ipc::EngineContext;
use serde::{Deserialize, Serialize};

macro_rules! record {
    ($name:ident { $($(#[$attr:meta])* $field:ident: $ty:ty),* $(,)? }) => {
        #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        pub struct $name { $( $(#[$attr])* pub $field: $ty),* }
    };
}
record!(NativeCall030 {
    provider_attempt_id: String,
    native_call_id: String
});
record!(ProtocolEvent030 {

    context: EngineContext, event_id: String, expected_revision: String,
    event_json: String, native_call: Option<NativeCall030>, control: bool,
});
record!(CheckRequest030 {
    check_id: String,
    invocation_json: String
});
record!(ProtocolDecision030 {
    state_json: String, receipt_json: String, check: Option<CheckRequest030>,
});
