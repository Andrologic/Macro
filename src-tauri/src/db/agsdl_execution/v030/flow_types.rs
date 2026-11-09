use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

pub type Address030 = Vec<String>;
macro_rules! record {
    ($name:ident { $($(#[$attr:meta])* $field:ident : $ty:ty),* $(,)? }) => {
        #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
        #[serde(rename_all="camelCase", deny_unknown_fields)]
        pub struct $name { $($(#[$attr])* pub $field: $ty),* }
    };
}
record!(FlowPlan030 {format: String, versions: Versions030, source: Value, document_json: String,
    agents: Vec<Value>, entry: Option<Address030>, scopes: Vec<Scope030>, steps: Vec<Step030>,
    routes: Vec<Route030>, joins: Vec<Join030>, handlers: Vec<Handler030>,
    graphless_submission_contracts: BTreeMap<String,String>});
record!(Versions030 {
    snapshot: String,
    contract: String,
    compiler: String,
    runtime: String,
    registry: String,
    profile: String
});
record!(Scope030 {address:Address030,parent:Option<Address030>,composition:Option<String>,entry:Address030,outputs:Vec<String>,agents:BTreeMap<String,String>});
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Instance030 {
    Shared,
    Named { name: String },
    New,
}
record!(Step030 {address:Address030,scope:Address030,r#type:String,declaration_json:String,agent:Option<String>,instance:Option<Instance030>,delivery:Option<String>,max_visits_json:Option<String>,timeout_ms_json:Option<String>,submission_contract_json:Option<String>});
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Target030 {
    Step {
        address: Address030,
        message_json: Option<String>,
        each_path_json: Option<String>,
        concurrency_json: Option<String>,
        max_json: Option<String>,
    },
    Output {
        scope: Address030,
        name: String,
    },
}
record!(Route030 {source:Address030,kind:String,key:Option<String>,declaration_json:String,targets:Vec<Target030>,inherited:bool});
record!(Join030 {address:Address030,scope:Address030,origin:Address030,branches:Vec<Branch030>,mode:String,failures:String,max_failures_json:Option<String>,quorum_count_json:Option<String>,accept:Vec<String>,remaining:String});
record!(Branch030 {name:String,target:Address030,members:Vec<Address030>,fanout:bool});
record!(Handler030 {address:Address030,scope:Address030,local:bool,flow:bool,joins:Vec<HandlerJoin030>});
record!(HandlerJoin030 {
    join: Address030,
    branch: String
});

record!(FlowIdentity030 {
    system_start_id: String,
    flow_invocation_id: String,
    snapshot_id: String,
    epoch: String
});
record!(WorkRef030 {activation_id:String,start_effect_id:String,agent_instance_id:Option<String>});
record!(RouteRef030 {source:Address030,kind:String,key:Option<String>});
record!(Producer030 {activation_id:String,step:Option<Address030>,kind:String,input_json:String,message_json:Option<String>,item_json:Option<String>,output_json:String});
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Frame030 {
    Compose {
        activation_id: String,
    },
    Path {
        path_id: String,
        #[serde(default)]
        departed_groups: Vec<String>,
    },
}
record!(PrepareRef030 {identity:FlowIdentity030,prepare_id:String,activation_id:String,revision:String,route:RouteRef030,context:Vec<Frame030>});
record!(DeliveryOccurrence030 {
    native_receipt_id: String,
    target_ordinal: usize,
    item_index: String
});
record!(PreparedItem030 {message_json:Option<String>,item_json:Option<String>,occurrence:DeliveryOccurrence030});
record!(PreparedBatch030 {target_ordinal:usize,target:Target030,items:Vec<PreparedItem030>});
record!(Failure030 {
    code: String,
    message: String,
    details: Value
});
impl Failure030 {
    pub fn new(code: &str) -> Self {
        Self {
            code: code.into(),
            message: code.into(),
            details: Value::Array(vec![]),
        }
    }
}
/// Native broker receipt. Only the authenticated host may construct events containing this.
/// A string received from a model or IPC is not a termination or preparation witness.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PhysicalEvidence030 {
    pub native_receipt_id: String,
    pub descendants_joined: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub enum PreparedResult030 {
    Ready {
        batches: Vec<PreparedBatch030>,
    },
    Failed {
        target_ordinal: usize,
        error: Failure030,
    },
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub enum WorkResult030 {
    Completed {
        output_json: String,
        /// For agents and approvals this must equal output_json.choice. The
        /// reducer checks correlation; the native host authenticates the result.
        /// Calls use their outcome independently of any choice in their payload.
        route_key: Option<String>,
    },
    Failed {
        error: Failure030,
    },
}
/// Deliberately not Deserialize / ts-rs / IPC. The host constructs it from authenticated,
/// durably correlated provider, preparation, control and process-supervisor receipts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub enum FlowEventKind030 {
    Enter {
        message_json: String,
    },
    Deliver {
        agent: String,
        instance: Instance030,
        delivery: String,
        message_json: String,
        sender: String,
    },
    WorkResult {
        work: WorkRef030,
        result: WorkResult030,
        physical: Option<PhysicalEvidence030>,
    },
    Prepared {
        reference: PrepareRef030,
        native_receipt_id: String,
        result: PreparedResult030,
    },
    SteerConsumed {
        effect_id: String,
        work: WorkRef030,
        delivery_activation_id: String,
    },
    PhysicalEnded {
        work: WorkRef030,
        stop_effect_id: Option<String>,
        evidence: PhysicalEvidence030,
    },
    Stop,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowEvent030 {
    pub identity: FlowIdentity030,
    pub event_id: String,
    pub expected_revision: String,
    pub kind: FlowEventKind030,
}
record!(FlowReceipt030 {event_id:String,revision:String,effect_ids:Vec<String>});
record!(EventRecord030 {
    event_json: String,
    receipt: FlowReceipt030
});
record!(FlowEffect030 {
    id: String,
    identity: FlowIdentity030,
    revision: String,
    kind: FlowEffectKind030
});
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum FlowEffectKind030 {
    PrepareRoute {
        reference: PrepareRef030,
        producer: Producer030,
    },
    Start {
        work: WorkRef030,
        step: Option<Address030>,
        agent: Option<String>,
        input_json: String,
        message_json: Option<String>,
        item_json: Option<String>,
        occurrence: Option<DeliveryOccurrence030>,
        sender: Option<Producer030>,
    },
    Steer {
        work: WorkRef030,
        delivery_activation_id: String,
        message_json: String,
        occurrence: Option<DeliveryOccurrence030>,
        sender: Option<Producer030>,
    },
    StopWork {
        work: WorkRef030,
        include_descendants: bool,
    },
    Failure {
        activation_id: String,
        step: Option<Address030>,
        error: Failure030,
        counted: bool,
    },
    Return {
        activation_id: String,
        sender: String,
        output_json: String,
    },
    RunEnded {
        verdict: String,
    },
}
record!(Activation030 {id:String,step:Option<Address030>,agent:Option<String>,selector:Option<Instance030>,delivery:String,instance_id:Option<String>,sender:Option<String>,context:Vec<Frame030>,phase:String,physical:bool,physical_wait_groups:Vec<String>,start_effect_id:Option<String>,stop_effect_id:Option<String>,input_json:String,message_json:Option<String>,item_json:Option<String>,occurrence:Option<DeliveryOccurrence030>,producer:Option<Producer030>,result:Option<WorkResultRecord030>});
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum WorkResultRecord030 {
    Completed {
        output_json: String,
        route_key: Option<String>,
    },
    Failed {
        error: Failure030,
    },
}
record!(InstanceState030 {id:String,agent:String,selector:Instance030,current:Option<String>,queue:Vec<String>,discarded:bool});
record!(Preparation030 {
    reference: PrepareRef030,
    producer: Producer030,
    status: String
});
record!(Membership030 {group_id:String,branch:String,phase:String,result_json:Option<String>,producer:Option<Producer030>,accepted:bool,failed:bool});
record!(Path030 {id:String,memberships:Vec<Membership030>,batch_id:Option<String>,item_json:Option<String>,context:Vec<Frame030>,phase:String});
record!(Batch030 {id:String,target:Address030,items:Vec<PreparedItem030>,path_ids:Vec<String>,concurrency_json:Option<String>,context:Vec<Frame030>,producer:Producer030});
record!(GroupBranch030 {name:String,fanout:bool,path_ids:Vec<String>});
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Group030 {
    pub id: String,
    pub join: Address030,
    pub origin_activation_id: String,
    pub activation_id: String,
    pub context: Vec<Frame030>,
    pub branches: Vec<GroupBranch030>,
    pub decision: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decided_ordinal: Option<String>,
    pub output_json: Option<String>,
    pub error: Option<Failure030>,
    pub continuation: Option<Continuation030>,
    pub released: bool,
}
record!(RouteBarrier030 {activation_id:String,path_id:String,groups:Vec<String>,arrival_group:Option<String>,route:RouteRef030,producer:Producer030,parent_context:Vec<Frame030>});
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Continuation030 {
    Join,
    Route {
        activation_id: String,
        route: RouteRef030,
        producer: Producer030,
    },
}
record!(SteerRecord030 {effect_id:String,work:WorkRef030,delivery_activation_id:String,status:String,resolved_event_id:Option<String>,reason:Option<String>});
record!(FlowState030 {identity:FlowIdentity030,revision:String,plan_json:Option<String>,entered:bool,stopping:bool,verdict:Option<String>,unhandled_failure:bool,activations:Vec<Activation030>,instances:Vec<InstanceState030>,preparations:Vec<Preparation030>,preparation_receipts:BTreeMap<String,String>,paths:Vec<Path030>,batches:Vec<Batch030>,groups:Vec<Group030>,route_barriers:Vec<RouteBarrier030>,visits:BTreeMap<String,String>,events:BTreeMap<String,EventRecord030>,#[serde(default, skip_serializing_if = "Vec::is_empty")] steer_deliveries:Vec<SteerRecord030>});
impl FlowState030 {
    pub fn new(identity: FlowIdentity030) -> Self {
        Self {
            identity,
            revision: "0".into(),
            plan_json: None,
            entered: false,
            stopping: false,
            verdict: None,
            unhandled_failure: false,
            activations: vec![],
            steer_deliveries: vec![],
            instances: vec![],
            preparations: vec![],
            preparation_receipts: BTreeMap::new(),
            paths: vec![],
            batches: vec![],
            groups: vec![],
            route_barriers: vec![],
            visits: BTreeMap::new(),
            events: BTreeMap::new(),
        }
    }
    pub fn visits_at(&self, address: &[String]) -> &str {
        self.visits
            .get(&serde_json::to_string(address).unwrap())
            .map(String::as_str)
            .unwrap_or("0")
    }
}
record!(FlowTransition030 {state:FlowState030,receipt:FlowReceipt030,effects:Vec<FlowEffect030>});
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FlowInputError030 {
    Identity,
    Revision,
    Contradiction,
    ResultRouteMismatch,
    /// No transition is committed. The host must surface this non-retriable
    /// diagnostic, retain control of the run and offer Stop, not infer a vote.
    /// The v0.3.0 cancellation rule is unresolved in upstream issue 4.
    UnspecifiedSharedCancellation {
        closing_join: Address030,
        affected_joins: Vec<Address030>,
    },
    InvalidPlan(String),
    InvalidEvent(String),
    StaleReference,
    InvalidState(String),
}
impl std::fmt::Display for FlowInputError030 {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for FlowInputError030 {}
