use crate::agsdl_host_projection030::ipc::RuntimeProjectionScope030;
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeliveryRequest030 {
    pub scope: RuntimeProjectionScope030,
    pub delivery_id: String,
    pub agent_name: String,
    /// Absent selects the shared instance. A name selects an existing or new named instance.
    pub instance: Option<String>,
    pub delivery: String,
    pub message_json: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeliveryReceipt030 {
    pub scope: RuntimeProjectionScope030,
    pub delivery_id: String,
    pub event_id: String,
    pub revision: String,
}
