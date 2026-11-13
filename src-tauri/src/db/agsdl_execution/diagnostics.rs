//! Historical public diagnostics are projected from a fixed native event boundary.
use super::*;
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiagnosticIdentity {
    pub id: String,
    pub sequence: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiagnosticRequest {
    pub system_start_id: String,
    #[ts(as = "super::dto::ipc::EngineSourceRevision")]
    pub source: EngineSourceRevision,
    pub activation_id: Option<String>,
    pub through: String,
    #[serde(default)]
    pub selected: Option<Vec<DiagnosticIdentity>>,
    #[serde(default)]
    pub before: Option<String>,
    #[serde(default)]
    pub recent: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct PublicDiagnostic {
    pub id: String,
    pub sequence: String,
    #[ts(as = "Option<super::dto::ipc::EngineWork>")]
    pub work: Option<EngineWork>,
    pub code: String,
    pub pointer: String,
    pub message: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct PublicExecutionDiagnostic {
    #[ts(as = "super::dto::ipc::EngineSourceRevision")]
    pub source: EngineSourceRevision,
    pub system_start_id: String,
    #[ts(as = "Option<super::dto::ipc::EngineWork>")]
    pub activation: Option<EngineWork>,
    pub through: String,
    pub diagnostics: Vec<PublicDiagnostic>,
    pub incomplete: bool,
    pub next_before: Option<String>,
}
