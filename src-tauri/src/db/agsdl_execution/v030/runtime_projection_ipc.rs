use serde::{Deserialize, Serialize};
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

#[cfg(test)]
mod wire_tests {
    use super::*;
    use ts_rs::TS;
    #[test]
    fn projection_wire_fields_are_retained() {
        let ts = RuntimeProjection030::decl(&ts_rs::Config::default());
        assert!(ts.contains("flowInvocationId"));
        assert!(ts.contains("activations"));
        let frame = RuntimeFrame030::decl(&ts_rs::Config::default());
        assert!(frame.contains("activationId"));
        assert!(frame.contains("departedGroups"));
    }
}
