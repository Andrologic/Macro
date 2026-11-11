//! Public view of a captured 0.3 reducer state, including terminal call results.
//! Authorization, atomic reads and pagination remain the native host's responsibility.
use super::flow030::{FlowPlan030, FlowState030, Frame030, Instance030};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use ts_rs::TS;

macro_rules! dto {
    ($visibility:vis $name:ident { $($(#[$field_attr:meta])* $field:ident : $ty:ty),* $(,)? }) => {
        #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        $visibility struct $name { $($(#[$field_attr])* pub $field: $ty),* }
    };
}

dto!(pub(crate) RuntimeProjection030 { system_start_id:String, flow_invocation_id:String, snapshot_id:String, revision:String, stopping:bool, verdict:Option<String>, instances:Vec<RuntimeInstance030>, activations:Vec<RuntimeActivation030>, groups:Vec<RuntimeGroup030>, paths:Vec<RuntimePath030> });
dto!(pub RuntimeInstance030 { id:String, agent:String, selector_kind:String, selector_name:Option<String>, current_activation_id:Option<String>, queue_activation_ids:Vec<String>, discarded:bool });
dto!(pub RuntimeMessage030 { sequence:String, delivery:String, sender:String, message_json:String, statuses:Vec<String>, target_activation_id:Option<String> });
dto!(pub RuntimeActivation030 { id:String, step:Option<Vec<String>>, agent:Option<String>, instance_id:Option<String>, phase:String, physical:bool, physical_wait_group_ids:Vec<String>, stop_requested:bool, context:Vec<RuntimeFrame030>, path_ids:Vec<String>, compose_activation_ids:Vec<String>, nearest_fanout_index:Option<String>, #[serde(default, skip_serializing_if = "Option::is_none")] #[ts(optional)] call_result_json:Option<String>, #[serde(default, skip_serializing_if = "Option::is_none")] #[ts(optional)] message:Option<RuntimeMessage030>, #[serde(default, skip_serializing_if = "Option::is_none")] #[ts(optional)] work_text:Option<String> });
dto!(pub RuntimeGroup030 { id:String, join:Vec<String>, origin_activation_id:String, activation_id:String, decision:Option<String>, released:bool, context:Vec<RuntimeFrame030>, parent_path_ids:Vec<String>, branches:Vec<RuntimeBranch030> });
dto!(pub RuntimeBranch030 { name:String, fanout:bool, path_ids:Vec<String> });
dto!(pub RuntimePath030 { id:String, batch_id:Option<String>, phase:String, context:Vec<RuntimeFrame030>, nearest_fanout_index:Option<String>, memberships:Vec<RuntimeMembership030> });
dto!(pub RuntimeMembership030 {
    group_id: String,
    branch: String,
    phase: String,
    accepted: bool,
    failed: bool
});

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RuntimeFrame030 {
    Compose {
        activation_id: String,
    },
    Path {
        path_id: String,
        departed_groups: Vec<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ProjectionError030 {
    PlanMismatch,
    InvalidState,
}

fn path_ids(context: &[Frame030]) -> Vec<String> {
    context
        .iter()
        .filter_map(|frame| match frame {
            Frame030::Path { path_id, .. } => Some(path_id.clone()),
            _ => None,
        })
        .collect()
}

fn public_context(context: &[Frame030]) -> Vec<RuntimeFrame030> {
    context
        .iter()
        .map(|frame| match frame {
            Frame030::Compose { activation_id } => RuntimeFrame030::Compose {
                activation_id: activation_id.clone(),
            },
            Frame030::Path {
                path_id,
                departed_groups,
            } => RuntimeFrame030::Path {
                path_id: path_id.clone(),
                departed_groups: departed_groups.clone(),
            },
        })
        .collect()
}

fn index_for_context(
    context: &[Frame030],
    indexes: &BTreeMap<&str, Option<String>>,
) -> Result<Option<String>, ProjectionError030> {
    for frame in context.iter().rev() {
        if let Frame030::Path { path_id, .. } = frame {
            let index = indexes
                .get(path_id.as_str())
                .ok_or(ProjectionError030::InvalidState)?;
            if index.is_some() {
                return Ok(index.clone());
            }
        }
    }
    Ok(None)
}

pub(crate) fn project_runtime030(
    plan: &FlowPlan030,
    state: &FlowState030,
) -> Result<RuntimeProjection030, ProjectionError030> {
    if let Some(bound) = &state.plan_json {
        if serde_json::to_string(plan).map_err(|_| ProjectionError030::InvalidState)? != *bound {
            return Err(ProjectionError030::PlanMismatch);
        }
    }
    // Preserve the physical item position from its batch, including equal values.
    let mut indexes: BTreeMap<&str, Option<String>> = BTreeMap::new();
    let mut path_batches = BTreeMap::new();
    let mut batch_ids = std::collections::BTreeSet::new();
    for batch in &state.batches {
        if !batch_ids.insert(batch.id.as_str()) || batch.items.len() != batch.path_ids.len() {
            return Err(ProjectionError030::InvalidState);
        }
        for (position, (id, item)) in batch.path_ids.iter().zip(&batch.items).enumerate() {
            if item.occurrence.item_index != position.to_string()
                || indexes
                    .insert(id, item.item_json.as_ref().map(|_| position.to_string()))
                    .is_some()
            {
                return Err(ProjectionError030::InvalidState);
            }
            path_batches.insert(id.as_str(), (batch.id.as_str(), &item.item_json));
        }
    }
    let mut path_ids_seen = std::collections::BTreeSet::new();
    for path in &state.paths {
        if !path_ids_seen.insert(path.id.as_str()) {
            return Err(ProjectionError030::InvalidState);
        }
        if let Some(batch_id) = &path.batch_id {
            let (actual_batch, item_json) = path_batches
                .get(path.id.as_str())
                .ok_or(ProjectionError030::InvalidState)?;
            if *actual_batch != batch_id.as_str() || *item_json != &path.item_json {
                return Err(ProjectionError030::InvalidState);
            }
        } else if path.item_json.is_some() || indexes.insert(path.id.as_str(), None).is_some() {
            return Err(ProjectionError030::InvalidState);
        }
    }
    if indexes.len() != state.paths.len() {
        return Err(ProjectionError030::InvalidState);
    }
    let mut instances = state
        .instances
        .iter()
        .map(|instance| {
            let (kind, name) = match &instance.selector {
                Instance030::Shared => ("shared", None),
                Instance030::Named { name } => ("named", Some(name.clone())),
                Instance030::New => ("new", None),
            };
            RuntimeInstance030 {
                id: instance.id.clone(),
                agent: instance.agent.clone(),
                selector_kind: kind.into(),
                selector_name: name,
                current_activation_id: instance.current.clone(),
                queue_activation_ids: instance.queue.clone(),
                discarded: instance.discarded,
            }
        })
        .collect::<Vec<_>>();
    instances.sort_by(|a, b| a.id.cmp(&b.id));
    if instances.windows(2).any(|pair| pair[0].id == pair[1].id) {
        return Err(ProjectionError030::InvalidState);
    }
    let mut activations = state
        .activations
        .iter()
        .enumerate()
        .map(|(sequence, a)| {
            Ok(RuntimeActivation030 {
                id: a.id.clone(),
                step: a.step.clone(),
                agent: a.agent.clone(),
                instance_id: a.instance_id.clone(),
                phase: a.phase.clone(),
                physical: a.physical,
                physical_wait_group_ids: a.physical_wait_groups.clone(),
                stop_requested: a.stop_effect_id.is_some(),
                context: public_context(&a.context),
                path_ids: path_ids(&a.context),
                compose_activation_ids: a
                    .context
                    .iter()
                    .filter_map(|frame| match frame {
                        Frame030::Compose { activation_id } => Some(activation_id.clone()),
                        _ => None,
                    })
                    .collect(),
                nearest_fanout_index: index_for_context(&a.context, &indexes)?,
                message: a
                    .message_json
                    .as_ref()
                    .filter(|_| a.agent.is_some())
                    .map(|raw| {
                        let steer = state
                            .steer_deliveries
                            .iter()
                            .find(|s| s.delivery_activation_id == a.id);
                        let mut statuses = vec!["sent".into()];
                        if a.phase == "queued" {
                            statuses.push("queued".into());
                        }
                        if steer.is_some_and(|s| s.status == "fallback") {
                            statuses.push("fallback".into());
                        }
                        if a.start_effect_id.is_some()
                            || steer.is_some_and(|s| s.status == "consumed")
                        {
                            statuses.push("delivered".into());
                        }
                        if a.result.is_some() || steer.is_some_and(|s| s.status == "consumed") {
                            statuses.push("consumed".into());
                        }
                        RuntimeMessage030 {
                            sequence: sequence.to_string(),
                            delivery: a.delivery.clone(),
                            sender: a
                                .sender
                                .clone()
                                .or_else(|| {
                                    a.producer.as_ref().map(|p| {
                                        p.step
                                            .as_ref()
                                            .map(|s| s.join(" / "))
                                            .unwrap_or_else(|| p.kind.clone())
                                    })
                                })
                                .unwrap_or_else(|| "host".into()),
                            message_json: raw.clone(),
                            statuses,
                            target_activation_id: steer.map(|s| s.work.activation_id.clone()),
                        }
                    }),
                work_text: a
                    .result
                    .as_ref()
                    .filter(|_| a.agent.is_some())
                    .and_then(|r| match r {
                        super::flow030::WorkResultRecord030::Completed { output_json, .. } => {
                            serde_json::from_str::<serde_json::Value>(output_json).ok()
                        }
                        _ => None,
                    })
                    .and_then(|v| {
                        v.get("text")
                            .and_then(serde_json::Value::as_str)
                            .map(str::to_owned)
                    }),
                call_result_json: if a.agent.is_none()
                    && a.step.as_ref().is_some_and(|address| {
                        plan.steps
                            .iter()
                            .any(|step| step.address == *address && step.r#type == "call")
                    }) {
                    a.result
                        .as_ref()
                        .map(serde_json::to_string)
                        .transpose()
                        .map_err(|_| ProjectionError030::InvalidState)?
                } else {
                    None
                },
            })
        })
        .collect::<Result<Vec<_>, ProjectionError030>>()?;
    activations.sort_by(|a, b| a.id.cmp(&b.id));
    if activations.windows(2).any(|pair| pair[0].id == pair[1].id) {
        return Err(ProjectionError030::InvalidState);
    }
    let mut groups = state
        .groups
        .iter()
        .map(|g| {
            let branches = g
                .branches
                .iter()
                .map(|branch| RuntimeBranch030 {
                    name: branch.name.clone(),
                    fanout: branch.fanout,
                    path_ids: branch.path_ids.clone(),
                })
                .collect::<Vec<_>>();
            RuntimeGroup030 {
                id: g.id.clone(),
                join: g.join.clone(),
                origin_activation_id: g.origin_activation_id.clone(),
                activation_id: g.activation_id.clone(),
                decision: g.decision.clone(),
                released: g.released,
                context: public_context(&g.context),
                parent_path_ids: path_ids(&g.context),
                branches,
            }
        })
        .collect::<Vec<_>>();
    groups.sort_by(|a, b| a.id.cmp(&b.id));
    if groups.windows(2).any(|pair| pair[0].id == pair[1].id) {
        return Err(ProjectionError030::InvalidState);
    }
    let mut projected_paths = state
        .paths
        .iter()
        .map(|path| {
            let mut memberships = path
                .memberships
                .iter()
                .map(|m| RuntimeMembership030 {
                    group_id: m.group_id.clone(),
                    branch: m.branch.clone(),
                    phase: m.phase.clone(),
                    accepted: m.accepted,
                    failed: m.failed,
                })
                .collect::<Vec<_>>();
            memberships.sort_by(|a, b| (&a.group_id, &a.branch).cmp(&(&b.group_id, &b.branch)));
            Ok(RuntimePath030 {
                id: path.id.clone(),
                batch_id: path.batch_id.clone(),
                phase: path.phase.clone(),
                context: public_context(&path.context),
                nearest_fanout_index: index_for_context(&path.context, &indexes)?,
                memberships,
            })
        })
        .collect::<Result<Vec<_>, ProjectionError030>>()?;
    projected_paths.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(RuntimeProjection030 {
        system_start_id: state.identity.system_start_id.clone(),
        flow_invocation_id: state.identity.flow_invocation_id.clone(),
        snapshot_id: state.identity.snapshot_id.clone(),
        revision: state.revision.clone(),
        stopping: state.stopping,
        verdict: state.verdict.clone(),
        instances,
        activations,
        groups,
        paths: projected_paths,
    })
}

#[cfg(test)]
#[path = "runtime_projection_tests.rs"]
mod tests;
