//! Versioned, content-free projection. Native host ownership authenticates the
//! read; a continuation never survives a flow revision or scope change.
use crate::agsdl_host::HostState;
use crate::db::agsdl_execution::{
    dto::EngineSourceRevision,
    failure,
    flow030::FlowPlan030,
    runtime_projection030::{
        self, RuntimeActivation030, RuntimeGroup030, RuntimeInstance030, RuntimePath030,
        RuntimeProjection030,
    },
    Result,
};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use ts_rs::TS;

const PAGE_SIZE: usize = 100;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeProjectionScope030 {
    pub system_start_id: String,
    pub source: EngineSourceRevision,
    pub snapshot_id: String,
}

/// The first page obtains the snapshot identity from the authenticated capture.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeProjectionQuery030 {
    pub system_start_id: String,
    pub source: EngineSourceRevision,
    pub snapshot_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeProjectionContinuation030 {
    pub scope: RuntimeProjectionScope030,
    pub revision: String,
    pub offset: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum RuntimeProjectionItem030 {
    Instance { value: RuntimeInstance030 },
    Activation { value: RuntimeActivation030 },
    Group { value: RuntimeGroup030 },
    Path { value: RuntimePath030 },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeProjectionPage030 {
    pub scope: RuntimeProjectionScope030,
    pub flow_invocation_id: String,
    pub revision: String,
    pub stopping: bool,
    pub verdict: Option<String>,
    pub total: String,
    pub items: Vec<RuntimeProjectionItem030>,
    pub next_page: Option<RuntimeProjectionContinuation030>,
}

fn page(
    scope: RuntimeProjectionScope030,
    continuation: Option<RuntimeProjectionContinuation030>,
    view: RuntimeProjection030,
) -> Result<RuntimeProjectionPage030> {
    if scope.system_start_id != view.system_start_id || scope.snapshot_id != view.snapshot_id {
        return Err(failure(
            "CORRELATION",
            "scope",
            "Projection scope differs from captured flow",
        ));
    }
    let offset = match continuation {
        Some(cursor) => {
            if cursor.scope != scope || cursor.revision != view.revision {
                return Err(failure(
                    "CONFLICT",
                    "continuation",
                    "Projection changed since the previous page",
                ));
            }
            cursor.offset as usize
        }
        None => 0,
    };
    // The pure projector sorts section IDs and preserves branch/path/FIFO order.
    let mut items: Vec<RuntimeProjectionItem030> = view
        .instances
        .into_iter()
        .map(|value| RuntimeProjectionItem030::Instance { value })
        .collect();
    items.extend(
        view.activations
            .into_iter()
            .map(|value| RuntimeProjectionItem030::Activation { value }),
    );
    items.extend(
        view.groups
            .into_iter()
            .map(|value| RuntimeProjectionItem030::Group { value }),
    );
    items.extend(
        view.paths
            .into_iter()
            .map(|value| RuntimeProjectionItem030::Path { value }),
    );
    if offset > items.len() {
        return Err(failure(
            "CONFLICT",
            "continuation",
            "Projection offset is invalid",
        ));
    }
    let total = items.len();
    let end = offset.saturating_add(PAGE_SIZE).min(total);
    let next_page = if end < total {
        Some(RuntimeProjectionContinuation030 {
            scope: scope.clone(),
            revision: view.revision.clone(),
            offset: u32::try_from(end)
                .map_err(|_| failure("INPUT_LIMIT", "continuation", "Projection is too large"))?,
        })
    } else {
        None
    };
    let items = items.into_iter().skip(offset).take(end - offset).collect();
    Ok(RuntimeProjectionPage030 {
        scope,
        flow_invocation_id: view.flow_invocation_id,
        revision: view.revision,
        stopping: view.stopping,
        verdict: view.verdict,
        total: total.to_string(),
        items,
        next_page,
    })
}

pub(crate) async fn read(
    host: &HostState,
    pool: &SqlitePool,
    query: RuntimeProjectionQuery030,
    continuation: Option<RuntimeProjectionContinuation030>,
) -> Result<RuntimeProjectionPage030> {
    let lease = host.start_lease().await?;
    let owner = lease.owner(&query.system_start_id)?;
    drop(lease);
    let inspection =
        crate::agsdl_host_flow030::inspect_run(host.flow030(), host, pool, &owner).await?;
    if inspection.capture.source != query.source
        || query
            .snapshot_id
            .as_ref()
            .is_some_and(|id| *id != inspection.capture.identity.snapshot_id)
    {
        return Err(failure(
            "CORRELATION",
            "scope",
            "Projection source or snapshot differs",
        ));
    }
    let scope = RuntimeProjectionScope030 {
        system_start_id: query.system_start_id,
        source: query.source,
        snapshot_id: inspection.capture.identity.snapshot_id.clone(),
    };
    let plan: FlowPlan030 = serde_json::from_str(&inspection.capture.compiled_plan_json)?;
    let projection = runtime_projection030::project_runtime030(&plan, &inspection.flow.state)
        .map_err(|_| {
            failure(
                "CORRELATION",
                "projection",
                "Captured flow projection is invalid",
            )
        })?;
    page(scope, continuation, projection)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::agsdl_execution::dto::EngineSourceOwner;

    #[test]
    fn continuation_is_bound_to_scope_and_revision() {
        let scope = RuntimeProjectionScope030 {
            system_start_id: "system".into(),
            snapshot_id: "snapshot".into(),
            source: EngineSourceRevision {
                owner: EngineSourceOwner {
                    project_id: "project".into(),
                    plan_id: "plan".into(),
                    branch: "develop".into(),
                },
                revision: "1".into(),
                source_sha256: "a".repeat(64),
            },
        };
        let instance = |id: usize| RuntimeInstance030 {
            id: format!("{id:03}"),
            agent: "worker".into(),
            selector_kind: "shared".into(),
            selector_name: None,
            current_activation_id: None,
            queue_activation_ids: vec![],
            discarded: false,
        };
        let view = RuntimeProjection030 {
            system_start_id: "system".into(),
            flow_invocation_id: "flow".into(),
            snapshot_id: "snapshot".into(),
            revision: "7".into(),
            stopping: false,
            verdict: None,
            instances: (0..101).map(instance).collect(),
            activations: vec![],
            groups: vec![],
            paths: vec![],
        };
        let first = page(scope.clone(), None, view.clone()).unwrap();
        assert_eq!(first.items.len(), 100);
        let next = first.next_page.unwrap();
        assert_eq!(
            page(scope.clone(), Some(next.clone()), view.clone())
                .unwrap()
                .items
                .len(),
            1
        );
        let mut changed = view.clone();
        changed.revision = "8".into();
        assert_eq!(
            page(scope.clone(), Some(next.clone()), changed)
                .unwrap_err()
                .code,
            "CONFLICT"
        );
        let mut other = next;
        other.scope.snapshot_id = "other".into();
        assert_eq!(page(scope, Some(other), view).unwrap_err().code, "CONFLICT");
    }
}
