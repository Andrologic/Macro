//! Real 04 mailbox/controller with an explicitly synthetic native admission.
//! This does not attest a provider, policy grant, or operating-system process.
use super::*;
use crate::agsdl_host_work::{
    captured_work_contract030, CapturedWorkPlan030, HostWorkCompletion030, HostWorkOutput030,
};
use crate::db::agsdl_execution::{
    dto::{EngineContext, EngineWork},
    flow030::{
        Activation030, FlowEffect030, FlowEffectKind030, FlowIdentity030, FlowPlan030,
        FlowState030, Instance030, WorkRef030,
    },
    flow_work_protocol030,
    start030::StartCapture030,
    work_protocol030::ProtocolEvent030,
};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

#[tokio::test(flavor = "current_thread")]
async fn real_controller_commit_lost_ack_requires_exact_native_readback() {
    let tmp = tempfile::TempDir::new().unwrap();
    let pool = crate::db::create_pool(&tmp.path().join("work.db"))
        .await
        .unwrap();
    let id = FlowIdentity030 {
        system_start_id: "system".into(),
        flow_invocation_id: "flow".into(),
        snapshot_id: "snapshot".into(),
        epoch: "capture".into(),
    };
    let plan_json = include_str!("../tests/fixtures/agsdl030_compiled_plan.json");
    let plan: FlowPlan030 = serde_json::from_str(plan_json).unwrap();
    let capture = StartCapture030 {
        identity: id.clone(),
        source: serde_json::from_value(plan.source.clone()).unwrap(),
        versions: serde_json::from_value(serde_json::to_value(&plan.versions).unwrap()).unwrap(),
        authored_source: "{}".into(),
        compiled_plan_json: plan_json.into(),
        registry_json: "{}".into(),
        private_capture_json: "{}".into(),
    };
    let capture_raw = serde_json::to_string(&capture).unwrap();
    let capture_sha = format!("{:x}", Sha256::digest(capture_raw.as_bytes()));
    let owner = EngineOwner {
        system_start_id: "system".into(),
        owner_epoch: "owner".into(),
    };
    let work = EngineWork {
        system_start_id: "system".into(),
        flow_invocation_id: "flow".into(),
        activation_id: "work".into(),
        step: Some(vec!["left".into()]),
        agent_instance_id: Some("instance".into()),
    };
    let context = EngineContext {
        owner: owner.clone(),
        work: work.clone(),
        permissions_json: "[]".into(),
        scope_json: "{}".into(),
        registry_version: capture.versions.registry.clone(),
    };
    let mut state = FlowState030::new(id.clone());
    state.revision = "1".into();
    state.activations.push(Activation030 {
        id: "work".into(),
        step: Some(vec!["left".into()]),
        agent: Some("worker".into()),
        selector: Some(Instance030::Shared),
        delivery: "queue".into(),
        instance_id: Some("instance".into()),
        sender: None,
        context: vec![],
        phase: "running".into(),
        physical: true,
        physical_wait_groups: vec![],
        start_effect_id: Some("start".into()),
        stop_effect_id: None,
        input_json: "{}".into(),
        message_json: None,
        item_json: None,
        occurrence: None,
        producer: None,
        result: None,
    });
    let reference = WorkRef030 {
        activation_id: "work".into(),
        start_effect_id: "start".into(),
        agent_instance_id: Some("instance".into()),
    };
    let effect = FlowEffect030 {
        id: "start".into(),
        identity: id.clone(),
        revision: "1".into(),
        kind: FlowEffectKind030::Start {
            work: reference,
            step: Some(vec!["left".into()]),
            agent: Some("worker".into()),
            input_json: "{}".into(),
            message_json: None,
            item_json: None,
            occurrence: None,
            sender: None,
        },
    };
    let contract = captured_work_contract030(
        &CapturedWorkPlan030 {
            system_start_id: "system",
            source: &capture.source,
            versions: &capture.versions,
            compiled_plan_json: plan_json,
        },
        &work,
        "worker",
    )
    .unwrap();
    let options =
        r#"{"checkTimeoutMs":"1000","maxCheckOutputBytes":1024,"enforcedPlanLock":false}"#;
    let event_json = serde_json::json!({"owner":{"systemStartId":"system","activationId":"work","agentInstanceId":"instance","ownerEpoch":"owner"},"eventId":"event","event":{"kind":"visibleText","messageId":"message","textParts":["hello"]}}).to_string();
    let input = ProtocolEvent030 {
        context: context.clone(),
        event_id: "event".into(),
        expected_revision: "0".into(),
        event_json,
        native_call: None,
        control: false,
    };
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("INSERT INTO engine_flow030_runs VALUES (?,?,?,?,?,?,?)")
        .bind("system")
        .bind("flow")
        .bind("snapshot")
        .bind("capture")
        .bind(plan.source.to_string())
        .bind(plan_json)
        .bind(serde_json::to_string(&state).unwrap())
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("INSERT INTO engine_start030_requests VALUES (?,?,?,?,?,?,?,?)")
        .bind("request")
        .bind("{}")
        .bind("system")
        .bind("flow")
        .bind("snapshot")
        .bind("capture")
        .bind(&capture_raw)
        .bind("{}")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("INSERT INTO engine_flow030_owners VALUES (?,?,?,?,?,?,?,?)")
        .bind("system")
        .bind("flow")
        .bind("snapshot")
        .bind("capture")
        .bind("owner")
        .bind("generation")
        .bind("live")
        .bind(&capture_sha)
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("INSERT INTO engine_flow030_events VALUES (?,?,?,?,?,NULL)")
        .bind("system")
        .bind("flow")
        .bind("seed")
        .bind("{}")
        .bind("{}")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("INSERT INTO engine_flow030_outbox VALUES (?,?,?,?,?,?,?,?)")
        .bind("system")
        .bind("flow")
        .bind("start")
        .bind("seed")
        .bind(serde_json::to_string(&effect).unwrap())
        .bind("owner")
        .bind("settled")
        .bind("{}")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("INSERT INTO engine_flow030_handoffs VALUES (?,?,?,?,?,?)")
        .bind("system")
        .bind("flow")
        .bind("start")
        .bind("owner")
        .bind("generation")
        .bind("{}")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("INSERT INTO engine_flow030_work_admissions VALUES (?,?,?,?,?,?,?,?,?,?,?)")
        .bind("system")
        .bind("flow")
        .bind("work")
        .bind("start")
        .bind("owner")
        .bind("generation")
        .bind(&capture_sha)
        .bind(serde_json::to_string(&context).unwrap())
        .bind(&contract)
        .bind(options)
        .bind("{}")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("INSERT INTO engine_flow030_work_authorizations VALUES (?,?,?,?,?,?,?)")
        .bind("system")
        .bind("flow")
        .bind("event")
        .bind("work")
        .bind(serde_json::to_string(&input).unwrap())
        .bind(None::<String>)
        .bind(None::<String>)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let incarnation = Arc::new(Incarnation {
        generation: "generation".into(),
        compiler: Default::default(),
        work_protocol: Default::default(),
        route030: Default::default(),
        lifecycle: Arc::new(tokio::sync::RwLock::new(())),
        handoff: Mutex::new(()),
        live: AtomicBool::new(true),
        ready: AtomicBool::new(true),
        retired: Default::default(),
        loads: AtomicUsize::new(0),
        owners: Mutex::new(BTreeMap::from([("system".into(), owner)])),
        qa_request: Mutex::new(None),
    });
    let host = Arc::new(HostState(
        Mutex::new(Some(OwnedHost {
            incarnation: incarnation.clone(),
            resource: 0,
        })),
        Arc::new(tokio::sync::Mutex::new(())),
        Default::default(),
        Default::default(),
    ));
    let hook = host.flow030().install_work_commit_hook(&id, "event");
    let worker = tokio::spawn(async move {
        let job = incarnation.work_protocol.next().await.unwrap();
        let script = r#"import {evaluateHostWork030} from './src/services/agsdlExecution/hostWorkTransition030'; import {connectValueSchemaValidator030} from './src/services/agsdlExecution/valueSchemaPort030'; import {NumberToken,parse} from './src/vendor/agsdl/v0.3/json.mjs'; import {validate} from './src/vendor/agsdl/v0.3/valueschema.mjs'; const j=JSON.parse(await Bun.stdin.text()); const i=j.input; const v=connectValueSchemaValidator030({NumberToken,parse,validate}); process.stdout.write(JSON.stringify(evaluateHostWork030(i.context,i.eventId,i.expectedRevision,i.contractJson,i.stateJson,i.eventJson,i.optionsJson,v)));"#;
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap();
        let mut child = tokio::process::Command::new("bun")
            .args(["-e", script])
            .current_dir(root)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(&serde_json::to_vec(&job).unwrap())
            .await
            .unwrap();
        let output = child.wait_with_output().await.unwrap();
        assert!(
            output.status.success(),
            "controller: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let result: HostWorkOutput030 = serde_json::from_slice(&output.stdout).unwrap();
        incarnation
            .work_protocol
            .complete(
                &job.generation,
                HostWorkCompletion030 {
                    ticket: job.ticket,
                    generation: job.generation.clone(),
                    input_digest: job.input_digest,
                    output: result,
                },
            )
            .unwrap();
    });
    let host_task = host.clone();
    let pool_task = pool.clone();
    let id_task = id.clone();
    let task = tokio::spawn(async move {
        flow_work_protocol030::transition(
            &host_task,
            &pool_task,
            &id_task,
            &input,
            &tokio_util::sync::CancellationToken::new(),
        )
        .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(20), hook.reached())
        .await
        .expect("controller did not reach the work commit hook");
    worker.await.unwrap();
    task.abort();
    assert!(matches!(task.await, Err(error) if error.is_cancelled()));
    assert!(host.flow030().available(&id).is_err());
    assert!(
        flow_work_protocol030::inspect_work_commit(&host, &pool, &id, "event")
            .await
            .unwrap()
            .is_some()
    );
    assert!(host.flow030().available(&id).is_ok());
    let decisions: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM engine_flow030_work_events WHERE decision_json IS NOT NULL",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let checks: i64 = sqlx::query_scalar("SELECT count(*) FROM engine_flow030_work_checks")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(decisions, 1);
    assert_eq!(checks, 0);
}
