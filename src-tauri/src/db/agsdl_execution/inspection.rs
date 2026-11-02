//! One SQLite snapshot for the resident scheduler. No public projection uses this DTO.
use super::*;
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostAgentState {
    pub agent_name: String,
    pub agent_instance_id: String,
    pub memory: Option<EngineMemory>,
}
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostInspection {
    pub snapshot: EngineSnapshot,
    pub snapshot_digest: String,
    pub private_capture_json: String,
    pub projection: EngineProjection,
    pub agents: Vec<HostAgentState>,
    pub effects: Vec<PersistedEffect>,
    pub response_closures_json: Vec<String>,
    pub prepared_terminals_json: Vec<String>,
}
pub(crate) async fn read(pool: &SqlitePool, runtime: &EngineOwner) -> Result<HostInspection> {
    let mut connection = pool.acquire().await?;
    let mut tx = connection.begin().await?;
    let stored = load(&mut tx, &runtime.system_start_id).await?;
    owner(&stored.state, runtime, &runtime.system_start_id)?;
    let rows = sqlx::query("SELECT record_json,status,settlement_json,result_json FROM engine_effects WHERE system_id=? ORDER BY activation_id,effect_key")
        .bind(&runtime.system_start_id).fetch_all(&mut *tx).await?;
    let effects = rows
        .into_iter()
        .map(|row| {
            Ok(PersistedEffect {
                registered: serde_json::from_str(row.get("record_json"))?,
                status: row.get("status"),
                settlement: row
                    .get::<Option<&str>, _>("settlement_json")
                    .map(serde_json::from_str)
                    .transpose()?,
                result_json: row.get("result_json"),
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let response_closures_json = sqlx::query_scalar("SELECT receipt_json FROM engine_response_closures WHERE system_id=? ORDER BY activation_id")
        .bind(&runtime.system_start_id).fetch_all(&mut *tx).await?;
    let prepared_terminals_json = sqlx::query_scalar("SELECT witness_json FROM engine_prepared_terminals WHERE system_id=? ORDER BY activation_id")
        .bind(&runtime.system_start_id).fetch_all(&mut *tx).await?;
    let snapshot_digest = prepared::snapshot_digest(&stored.snapshot)?;
    let private_capture_json = encode(&stored.capture.ok_or_else(|| {
        failure(
            "VERSION_UNAVAILABLE",
            "registry",
            "Private capture is unavailable",
        )
    })?)?;
    let result = HostInspection {
        snapshot: stored.snapshot,
        snapshot_digest,
        private_capture_json,
        projection: EngineProjection {
            system_start_id: runtime.system_start_id.clone(),
            cursor: stored.state.cursor,
            activations: stored.state.activations.into_values().collect(),
            system_stop: stored.state.stop,
        },
        agents: stored
            .state
            .agents
            .into_iter()
            .map(|(agent_name, agent)| HostAgentState {
                agent_name,
                agent_instance_id: agent.id,
                memory: agent.memory,
            })
            .collect(),
        effects,
        response_closures_json,
        prepared_terminals_json,
    };
    tx.commit().await?;
    Ok(result)
}
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum HostAdmission {
    Admitted {
        activation: EngineActivation,
        memory: Option<EngineMemory>,
    },
    Waiting {
        reason: String,
    },
    Rejected {
        code: String,
    },
}
impl From<Admission> for HostAdmission {
    fn from(value: Admission) -> Self {
        match value {
            Admission::Admitted(activation, memory) => Self::Admitted { activation, memory },
            Admission::Waiting(reason) => Self::Waiting {
                reason: reason.into(),
            },
            Admission::Rejected(code) => Self::Rejected { code: code.into() },
        }
    }
}
