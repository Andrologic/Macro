//! Product DTOs use an explicit allowlist. Internal journal payloads stay private.
use super::*;
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct PublicSnapshot {
    pub system_start_id: String,
    pub source: EngineSourceRevision,
    pub authored_source: String,
    pub versions: EngineVersions,
    pub associations: EngineAssociations,
}
impl From<EngineSnapshot> for PublicSnapshot {
    fn from(s: EngineSnapshot) -> Self {
        Self {
            system_start_id: s.system_start_id,
            source: s.source,
            authored_source: s.authored_source,
            versions: s.versions,
            associations: s.associations,
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct PublicStartReceipt {
    pub system_start_id: String,
    pub flow_invocation_id: String,
    pub snapshot: PublicSnapshot,
}
impl From<EngineStartReceipt> for PublicStartReceipt {
    fn from(receipt: EngineStartReceipt) -> Self {
        Self {
            system_start_id: receipt.system_start_id,
            flow_invocation_id: receipt.flow_invocation_id,
            snapshot: receipt.snapshot.into(),
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum PublicStopState {
    None,
    Requested { request_id: String },
    Uncertain { request_id: String },
    Confirmed { request_id: String },
}
impl From<EngineStopState> for PublicStopState {
    fn from(s: EngineStopState) -> Self {
        match s {
            EngineStopState::None => Self::None,
            EngineStopState::Requested { request_id } => Self::Requested { request_id },
            EngineStopState::Uncertain { request_id, .. } => Self::Uncertain { request_id },
            EngineStopState::Confirmed { request_id, .. } => Self::Confirmed { request_id },
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct PublicActivation {
    pub work: EngineWork,
    pub delivery_id: String,
    pub queue_sequence: String,
    pub work_state: String,
    pub stop_state: PublicStopState,
    pub terminal_kind: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct PublicAgent {
    pub agent_instance_id: String,
    pub agent_name: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct PublicProjection {
    pub system_start_id: String,
    pub source: EngineSourceRevision,
    pub cursor: String,
    pub agents: Vec<PublicAgent>,
    pub activations: Vec<PublicActivation>,
    pub system_stop: PublicStopState,
}
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct PublicEvent {
    pub system_start_id: String,
    pub sequence: String,
    pub work: Option<EngineWork>,
    pub kind: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct PublicEventPage {
    pub events: Vec<PublicEvent>,
    pub next_cursor: String,
    pub has_more: bool,
}
impl From<EngineEventPage> for PublicEventPage {
    fn from(page: EngineEventPage) -> Self {
        Self {
            events: page
                .events
                .into_iter()
                .map(|e| PublicEvent {
                    system_start_id: e.system_start_id,
                    sequence: e.sequence,
                    work: e.work,
                    kind: e.kind,
                })
                .collect(),
            next_cursor: page.next_cursor,
            has_more: page.has_more,
        }
    }
}
pub(crate) async fn projection(pool: &SqlitePool, id: &str) -> Result<PublicProjection> {
    let mut connection = pool.acquire().await?;
    let stored = load(&mut connection, id).await?;
    Ok(PublicProjection {
        system_start_id: id.into(),
        source: stored.snapshot.source,
        cursor: stored.state.cursor,
        agents: stored
            .state
            .agents
            .into_iter()
            .map(|(agent_name, a)| PublicAgent {
                agent_name,
                agent_instance_id: a.id,
            })
            .collect(),
        activations: stored
            .state
            .activations
            .into_values()
            .map(|a| PublicActivation {
                work: a.delivery.delivery.work,
                delivery_id: a.delivery.delivery.delivery_id,
                queue_sequence: a.delivery.queue_sequence,
                work_state: a.work_state,
                stop_state: a.stop_state.into(),
                terminal_kind: a.terminal.map(|t| {
                    match t {
                        EngineOutcome::Completed { .. } => "completed",
                        EngineOutcome::Failed { .. } => "failed",
                        EngineOutcome::Stopped { .. } => "stopped",
                    }
                    .into()
                }),
            })
            .collect(),
        system_stop: stored.state.stop.into(),
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stop_and_events_never_forward_private_evidence_or_journal_payloads() {
        let public: PublicStopState = EngineStopState::Confirmed {
            request_id: "stop".into(),
            evidence_json: "{\"private\":true}".into(),
        }
        .into();
        assert_eq!(
            serde_json::to_value(public).unwrap(),
            serde_json::json!({"kind":"confirmed","requestId":"stop"})
        );
        let public: PublicEventPage = EngineEventPage {
            events: vec![EngineEvent {
                system_start_id: "system".into(),
                sequence: "1".into(),
                work: None,
                kind: "terminal".into(),
                payload_json: "{\"memory\":\"private\"}".into(),
            }],
            next_cursor: "1".into(),
            has_more: false,
        }
        .into();
        let json = serde_json::to_string(&public).unwrap();
        assert!(!json.contains("private"));
        assert!(!json.contains("payload"));
    }
}
