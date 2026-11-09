use super::*;
use std::path::PathBuf;

async fn fixture() -> (tempfile::TempDir, PathBuf, FlowEvent030) {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("journal.sqlite");
    let mut db = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true),
    )
    .await
    .unwrap();
    sqlx::raw_sql("CREATE TABLE engine_systems(system_id TEXT PRIMARY KEY,request_id TEXT);")
        .execute(&mut db)
        .await
        .unwrap();
    for schema in [
        include_str!("../../migrations/030_execution_flow.sql"),
        include_str!("../../migrations/033_execution_flow_owner030.sql"),
        include_str!("../../migrations/034_execution_flow_preparations030.sql"),
        include_str!("../../migrations/035_execution_flow_no_admission030.sql"),
        include_str!("../../migrations/036_execution_flow_work_protocol030.sql"),
    ] {
        sqlx::raw_sql(schema).execute(&mut db).await.unwrap();
    }
    let mut plan: FlowPlan030 = parse(
        "fixture",
        include_str!("../../../../tests/fixtures/agsdl030_compiled_plan.json"),
    )
    .unwrap();
    // A single agent Start with an empty normal continuation is enough for the reader tests.
    plan.entry = Some(vec!["left".into()]);
    plan.routes
        .iter_mut()
        .find(|route| route.source == ["left"])
        .unwrap()
        .targets
        .clear();
    let identity = FlowIdentity030 {
        system_start_id: "system".into(),
        flow_invocation_id: "invocation".into(),
        snapshot_id: "snapshot".into(),
        epoch: "capture".into(),
    };
    let event = FlowEvent030 {
        identity: identity.clone(),
        event_id: "start:enter".into(),
        expected_revision: "0".into(),
        kind: FlowEventKind030::Enter {
            message_json: "{}".into(),
        },
    };
    let transition = reduce(&plan, &FlowState030::new(identity.clone()), &event).unwrap();
    sqlx::query(
        "INSERT INTO engine_flow030_runs VALUES('system','invocation','snapshot','capture',?,?,?)",
    )
    .bind(json!(plan.source).to_string())
    .bind(json!(plan).to_string())
    .bind(json!(transition.state).to_string())
    .execute(&mut db)
    .await
    .unwrap();
    sqlx::query("INSERT INTO engine_start030_requests VALUES('request',?,'system','invocation','snapshot','capture',?,?)")
        .bind(json!({"source":plan.source,"entry":{"messageJson":"{}"}}).to_string())
        .bind(json!({"identity":identity,"source":plan.source,"compiledPlanJson":json!(plan).to_string()}).to_string())
        .bind(json!({"identity":identity,"enter":transition.receipt}).to_string()).execute(&mut db).await.unwrap();
    sqlx::query("INSERT INTO engine_flow030_owners VALUES('system','invocation','snapshot','capture','owner','generation','live',?)")
        .bind("a".repeat(64)).execute(&mut db).await.unwrap();
    sqlx::query(
        "INSERT INTO engine_flow030_events VALUES('system','invocation','start:enter',?,?,NULL)",
    )
    .bind(json!(event).to_string())
    .bind(json!(transition.receipt).to_string())
    .execute(&mut db)
    .await
    .unwrap();
    for effect in transition.effects {
        sqlx::query("INSERT INTO engine_flow030_outbox VALUES('system','invocation',?,'start:enter',?,'owner','pending',NULL)")
            .bind(&effect.id).bind(json!(effect).to_string()).execute(&mut db).await.unwrap();
    }
    db.close().await.unwrap();
    (directory, path, event)
}

async fn mutate(path: &Path, sql: &'static str) {
    // Model a tampered file, including rows detached despite schema constraints.
    let mut db = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(path)
            .foreign_keys(false),
    )
    .await
    .unwrap();
    sqlx::raw_sql(sql).execute(&mut db).await.unwrap();
    db.close().await.unwrap();
}

fn agent_handoff(effect: &FlowEffect030) -> Value {
    let FlowEffectKind030::Start {
        work,
        step,
        agent: Some(agent),
        ..
    } = &effect.kind
    else {
        panic!("agent Start fixture")
    };
    json!({"kind":"nativeOwnedHandoff030","identity":effect.identity,"effectId":effect.id,"ownerEpoch":"owner","generation":"generation","requestId":format!("flow030:system:{}",effect.id),
        "workAttempt":{"identity":effect.identity,"owner":{"systemStartId":"system","ownerEpoch":"owner"},"generation":"generation","work":{"systemStartId":"system","flowInvocationId":"invocation","activationId":work.activation_id,"step":step,"agentInstanceId":work.agent_instance_id},"startEffectId":effect.id,"agent":agent,"providerAttemptId":"provider-attempt"}})
}

async fn settled_agent(path: &Path) -> FlowEffect030 {
    let mut db = SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(path))
        .await
        .unwrap();
    let raw: String = sqlx::query_scalar("SELECT effect_json FROM engine_flow030_outbox")
        .fetch_one(&mut db)
        .await
        .unwrap();
    let effect: FlowEffect030 = parse("effect", &raw).unwrap();
    let receipt = agent_handoff(&effect).to_string();
    sqlx::query("INSERT INTO engine_flow030_handoffs VALUES('system','invocation',?,'owner','generation',?)").bind(&effect.id).bind(&receipt).execute(&mut db).await.unwrap();
    sqlx::query("UPDATE engine_flow030_outbox SET status='settled',settlement_json=?")
        .bind(receipt)
        .execute(&mut db)
        .await
        .unwrap();
    db.close().await.unwrap();
    effect
}

#[tokio::test]
async fn agent_handoff_requires_attempt_even_without_work_authorizations() {
    let (_directory, path, _) = fixture().await;
    settled_agent(&path).await;
    assert!(verify_path030(&path, "system", "invocation").await.ok);
    mutate(&path, "DROP TRIGGER engine_flow030_handoff_immutable; UPDATE engine_flow030_outbox SET settlement_json=json_remove(settlement_json,'$.workAttempt'); UPDATE engine_flow030_handoffs SET receipt_json=json_remove(receipt_json,'$.workAttempt')").await;
    let verdict = verify_path030(&path, "system", "invocation").await;
    assert_eq!(verdict.divergence.unwrap().field, "handoff.workAttempt");
}

#[tokio::test]
async fn retained_authorizations_and_attempts_require_settled_start_and_handoff() {
    for status in ["pending", "uncertain", "settled"] {
        for provider_attempt in [None, Some("provider-attempt")] {
            let (_directory, path, _) = fixture().await;
            let effect = settled_agent(&path).await;
            let FlowEffectKind030::Start { work, .. } = &effect.kind else {
                unreachable!()
            };
            let mut db = SqliteConnection::connect_with(
                &SqliteConnectOptions::new()
                    .filename(&path)
                    .foreign_keys(false),
            )
            .await
            .unwrap();
            sqlx::query("INSERT INTO engine_flow030_work_authorizations VALUES('system','invocation','authorization',?,'{}',?,?)")
                .bind(&work.activation_id).bind(provider_attempt).bind(provider_attempt.map(|_| "native-call"))
                .execute(&mut db).await.unwrap();
            sqlx::raw_sql(
                "DROP TRIGGER engine_flow030_handoff_retained; DELETE FROM engine_flow030_handoffs",
            )
            .execute(&mut db)
            .await
            .unwrap();
            if status != "settled" {
                sqlx::query("UPDATE engine_flow030_outbox SET status=?,settlement_json=NULL")
                    .bind(status)
                    .execute(&mut db)
                    .await
                    .unwrap();
            }
            db.close().await.unwrap();
            let verdict = verify_path030(&path, "system", "invocation").await;
            assert_eq!(
                verdict.divergence.unwrap().field,
                "start.workEvidence",
                "{status} {provider_attempt:?}"
            );
        }
    }
}

#[tokio::test]
async fn work_result_alone_requires_a_settled_start_and_handoff() {
    let (_directory, path, _) = fixture().await;
    let effect = settled_agent(&path).await;
    let FlowEffectKind030::Start { work, .. } = effect.kind else {
        unreachable!()
    };
    let mut db = SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&path))
        .await
        .unwrap();
    let plan: FlowPlan030 = parse(
        "plan",
        &sqlx::query_scalar::<_, String>("SELECT plan_json FROM engine_flow030_runs")
            .fetch_one(&mut db)
            .await
            .unwrap(),
    )
    .unwrap();
    let state: FlowState030 = parse(
        "state",
        &sqlx::query_scalar::<_, String>("SELECT state_json FROM engine_flow030_runs")
            .fetch_one(&mut db)
            .await
            .unwrap(),
    )
    .unwrap();
    let event = FlowEvent030 {
        identity: state.identity.clone(),
        event_id: "result".into(),
        expected_revision: state.revision.clone(),
        kind: FlowEventKind030::WorkResult {
            work,
            result: WorkResult030::Completed {
                output_json: "{}".into(),
                route_key: None,
            },
            physical: Some(PhysicalEvidence030 {
                native_receipt_id: "physical-end".into(),
                descendants_joined: true,
            }),
        },
    };
    let transition = reduce(&plan, &state, &event).unwrap();
    sqlx::query("UPDATE engine_flow030_runs SET state_json=?")
        .bind(json!(transition.state).to_string())
        .execute(&mut db)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO engine_flow030_events VALUES('system','invocation','result',?,?,NULL)",
    )
    .bind(json!(event).to_string())
    .bind(json!(transition.receipt).to_string())
    .execute(&mut db)
    .await
    .unwrap();
    for effect in transition.effects {
        sqlx::query("INSERT INTO engine_flow030_outbox VALUES('system','invocation',?,'result',?,'owner','pending',NULL)").bind(&effect.id).bind(json!(effect).to_string()).execute(&mut db).await.unwrap();
    }
    db.close().await.unwrap();
    assert!(verify_path030(&path, "system", "invocation").await.ok);
    mutate(&path,"DROP TRIGGER engine_flow030_handoff_retained; DELETE FROM engine_flow030_handoffs; UPDATE engine_flow030_outbox SET status='pending',settlement_json=NULL WHERE event_id='start:enter'").await;
    assert_eq!(
        verify_path030(&path, "system", "invocation")
            .await
            .divergence
            .unwrap()
            .field,
        "start.workEvidence"
    );
}

#[tokio::test]
async fn minimal_pending_uncertain_and_handoff_settled_are_consistent() {
    let (_directory, path, _) = fixture().await;
    assert!(verify_path030(&path, "system", "invocation").await.ok);
    mutate(&path, "UPDATE engine_flow030_outbox SET status='uncertain'").await;
    assert!(verify_path030(&path, "system", "invocation").await.ok);
    let mut db = SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&path))
        .await
        .unwrap();
    let effect: FlowEffect030 = parse(
        "effect",
        &sqlx::query_scalar::<_, String>("SELECT effect_json FROM engine_flow030_outbox")
            .fetch_one(&mut db)
            .await
            .unwrap(),
    )
    .unwrap();
    let receipt = agent_handoff(&effect).to_string();
    sqlx::query("INSERT INTO engine_flow030_handoffs VALUES('system','invocation',?,'owner','generation',?)").bind(&effect.id).bind(&receipt).execute(&mut db).await.unwrap();
    sqlx::query("UPDATE engine_flow030_outbox SET status='settled',settlement_json=?")
        .bind(receipt)
        .execute(&mut db)
        .await
        .unwrap();
    db.close().await.unwrap();
    assert!(verify_path030(&path, "system", "invocation").await.ok);
    mutate(
        &path,
        "UPDATE engine_flow030_outbox SET status='pending',settlement_json=NULL",
    )
    .await;
    let verdict = verify_path030(&path, "system", "invocation").await;
    assert_eq!(verdict.divergence.unwrap().field, "outbox.status");
}

#[tokio::test]
async fn rejects_corrupt_state_receipt_events_effects_and_settlements() {
    for sql in [
        "UPDATE engine_flow030_runs SET state_json=json_set(state_json,'$.revision','99')",
        "UPDATE engine_flow030_runs SET state_json=json_set(state_json,'$.entered',json('false'))",
        "UPDATE engine_flow030_runs SET state_json=json_set(state_json,'$.paths',json('[{}]'))",
        "UPDATE engine_flow030_events SET receipt_json=json_set(receipt_json,'$.effectIds',json('[]'))",
        "UPDATE engine_flow030_events SET event_json=json_set(event_json,'$.expectedRevision','99')",
        "UPDATE engine_flow030_events SET event_json=json_set(event_json,'$.kind.Enter.message_json','{\"forged\":true}')",
        "UPDATE engine_flow030_events SET receipt_json=NULL,diagnostic_json='{}'",
        "DELETE FROM engine_flow030_events",
        "DELETE FROM engine_flow030_outbox",
        "UPDATE engine_flow030_outbox SET event_id='orphan'",
        "UPDATE engine_flow030_outbox SET effect_json=json_set(effect_json,'$.revision','99')",
        "UPDATE engine_flow030_outbox SET status='settled',settlement_json='{}'",
        "UPDATE engine_flow030_outbox SET status='revoked'",
        "UPDATE engine_flow030_outbox SET owner_epoch='foreign'",
        "INSERT INTO engine_flow030_outbox SELECT system_id,invocation_id,'orphan','missing',effect_json,owner_epoch,status,settlement_json FROM engine_flow030_outbox",
        "PRAGMA ignore_check_constraints=ON; UPDATE engine_flow030_outbox SET status='uncertain',settlement_json='{}'",
    ] {
        let (_directory, path, _) = fixture().await;
        mutate(&path, sql).await;
        let verdict = verify_path030(&path, "system", "invocation").await;
        assert!(!verdict.ok, "accepted mutation: {sql}");
        assert!(verdict.divergence.is_some());
    }
}

#[tokio::test]
async fn reader_keeps_wal_events_and_never_writes_database() {
    let (_directory, path, _) = fixture().await;
    let mut db = SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&path))
        .await
        .unwrap();
    sqlx::raw_sql(
        "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE wal_probe(value TEXT)",
    )
    .execute(&mut db)
    .await
    .unwrap();
    for valid in [true, false] {
        if !valid {
            sqlx::query(
                "UPDATE engine_flow030_runs SET state_json=json_set(state_json,'$.revision','99')",
            )
            .execute(&mut db)
            .await
            .unwrap();
        }
        for with_shm in [true, false] {
            let copy = path.with_file_name(format!("wal-{valid}-{with_shm}.sqlite"));
            copy_sqlite(&path, &copy);
            if !with_shm {
                std::fs::remove_file(companion(&copy, "-shm")).unwrap();
            }
            let fingerprints = |path: &Path| {
                ["", "-wal", "-shm"].map(|suffix| {
                    let file = companion(path, suffix);
                    match std::fs::read(file) {
                        Ok(bytes) => Some(bytes),
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                        Err(error) => panic!("snapshot: {error}"),
                    }
                })
            };
            let before = fingerprints(&copy);
            assert!(before[1].as_ref().is_some_and(|wal| !wal.is_empty()));
            assert_eq!(
                verify_path030(&copy, "system", "invocation").await.ok,
                valid
            );
            assert_eq!(fingerprints(&copy), before, "valid={valid} shm={with_shm}");
        }
    }
    db.close().await.unwrap();
}

#[tokio::test]
async fn unexpected_sqlite_storage_types_return_negative_json() {
    for mutation in [
        "DROP TRIGGER engine_flow030_capture_immutable; UPDATE engine_flow030_runs SET snapshot_id=cast(snapshot_id AS BLOB)",
        "DROP TABLE engine_flow030_runs; CREATE TABLE engine_flow030_runs(system_id TEXT,invocation_id TEXT,snapshot_id INTEGER,epoch TEXT,source_json TEXT,plan_json TEXT,state_json TEXT); INSERT INTO engine_flow030_runs VALUES('system','invocation',1,'capture','{}','{}','{}')",
        "UPDATE engine_flow030_events SET event_id=cast(event_id AS BLOB)",
        "UPDATE engine_flow030_outbox SET owner_epoch=cast(owner_epoch AS BLOB)",
    ] {
        let (_directory,path,_) = fixture().await;
        mutate(&path,mutation).await;
        let verdict = verify_path030(&path,"system","invocation").await;
        assert!(!verdict.ok,"accepted {mutation}");
        assert_eq!(json!(verdict)["divergence"]["field"],"database");
    }
}

#[tokio::test]
async fn initial_enter_identity_cannot_be_renamed_coherently() {
    let (_directory, path, _) = fixture().await;
    // Rename every affected core occurrence, including receipt and generated IDs.
    mutate(&path,"DROP TRIGGER engine_start030_immutable; UPDATE engine_flow030_runs SET state_json=replace(state_json,'start:enter','forged:enter'); UPDATE engine_flow030_events SET event_id='forged:enter',event_json=replace(event_json,'start:enter','forged:enter'),receipt_json=replace(receipt_json,'start:enter','forged:enter'); UPDATE engine_flow030_outbox SET event_id='forged:enter',effect_id=replace(effect_id,'start:enter','forged:enter'),effect_json=replace(effect_json,'start:enter','forged:enter'); UPDATE engine_start030_requests SET receipt_json=replace(receipt_json,'start:enter','forged:enter')").await;
    let verdict = verify_path030(&path, "system", "invocation").await;
    assert_eq!(verdict.divergence.unwrap().field, "start.enter.eventId");
}

#[tokio::test]
async fn missing_database_is_not_created() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("absent.sqlite");
    assert!(!verify_path030(&path, "system", "invocation").await.ok);
    assert!(!path.exists());
}

#[test]
fn forensic_event_reader_covers_all_native_variants_and_rejects_unknown_fields() {
    let identity = FlowIdentity030 {
        system_start_id: "s".into(),
        flow_invocation_id: "i".into(),
        snapshot_id: "c".into(),
        epoch: "e".into(),
    };
    let work = WorkRef030 {
        activation_id: "a".into(),
        start_effect_id: "f".into(),
        agent_instance_id: None,
    };
    let evidence = PhysicalEvidence030 {
        native_receipt_id: "receipt".into(),
        descendants_joined: true,
    };
    let reference = PrepareRef030 {
        identity: identity.clone(),
        prepare_id: "p".into(),
        activation_id: "a".into(),
        revision: "1".into(),
        route: RouteRef030 {
            source: vec!["step".into()],
            kind: "normal".into(),
            key: None,
        },
        context: vec![],
    };
    for kind in [
        FlowEventKind030::Enter {
            message_json: "{}".into(),
        },
        FlowEventKind030::Deliver {
            agent: "agent".into(),
            instance: Instance030::Shared,
            delivery: "queue".into(),
            message_json: "{}".into(),
            sender: "sender".into(),
        },
        FlowEventKind030::WorkResult {
            work: work.clone(),
            result: WorkResult030::Completed {
                output_json: "{}".into(),
                route_key: None,
            },
            physical: Some(evidence.clone()),
        },
        FlowEventKind030::WorkResult {
            work: work.clone(),
            result: WorkResult030::Failed {
                error: Failure030::new("FAILED"),
            },
            physical: None,
        },
        FlowEventKind030::Prepared {
            reference: reference.clone(),
            native_receipt_id: "receipt".into(),
            result: PreparedResult030::Ready { batches: vec![] },
        },
        FlowEventKind030::Prepared {
            reference,
            native_receipt_id: "receipt".into(),
            result: PreparedResult030::Failed {
                target_ordinal: 0,
                error: Failure030::new("FAILED"),
            },
        },
        FlowEventKind030::PhysicalEnded {
            work,
            stop_effect_id: None,
            evidence,
        },
        FlowEventKind030::Stop,
    ] {
        let event = FlowEvent030 {
            identity: identity.clone(),
            event_id: "event".into(),
            expected_revision: "0".into(),
            kind,
        };
        assert_eq!(
            event,
            parse::<ReadEvent>("event", &json!(event).to_string())
                .unwrap()
                .0
        );
        let mut extra = json!(event);
        extra["unexpected"] = json!(true);
        assert!(parse::<ReadEvent>("event", &extra.to_string()).is_err());
    }
}

fn copy_sqlite(source: &Path, destination: &Path) {
    for suffix in ["", "-shm", "-wal"] {
        let source = PathBuf::from(format!("{}{suffix}", source.display()));
        if source.exists() {
            std::fs::copy(source, format!("{}{suffix}", destination.display())).unwrap();
        }
    }
}

async fn read_ids(path: &Path) -> (String, String) {
    let mut db =
        SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(path).read_only(true))
            .await
            .unwrap();
    // Keep the caller's original identity even when a mutation detaches a run.
    let row = sqlx::query(
        "SELECT system_id,invocation_id FROM engine_start030_requests ORDER BY rowid LIMIT 1",
    )
    .fetch_one(&mut db)
    .await
    .unwrap();
    db.close().await.unwrap();
    (row.get("system_id"), row.get("invocation_id"))
}

async fn core_rows(path: &Path) -> Value {
    use sqlx::Column;
    fn normalize(value: &mut Value) {
        match value {
            Value::Object(fields) => {
                for (key, value) in fields {
                    if key == "eventJson" {
                        if let Some(raw) = value.as_str() {
                            if let Ok(parsed) = serde_json::from_str(raw) {
                                *value = parsed;
                            }
                        }
                    }
                    normalize(value);
                }
            }
            Value::Array(values) => {
                for value in values {
                    normalize(value);
                }
            }
            _ => {}
        }
    }
    let mut db =
        SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(path).read_only(true))
            .await
            .unwrap();
    let mut tables = serde_json::Map::new();
    for (table, query) in [
        (
            "engine_flow030_runs",
            "SELECT * FROM engine_flow030_runs ORDER BY rowid",
        ),
        (
            "engine_flow030_events",
            "SELECT * FROM engine_flow030_events ORDER BY rowid",
        ),
        (
            "engine_flow030_outbox",
            "SELECT * FROM engine_flow030_outbox ORDER BY rowid",
        ),
    ] {
        let rows = sqlx::query(query).fetch_all(&mut db).await.unwrap();
        let values: Vec<Value> = rows
            .iter()
            .map(|row| {
                Value::Object(
                    row.columns()
                        .iter()
                        .map(|column| {
                            let raw: Option<String> = row.get(column.name());
                            let value = match raw {
                                None => Value::Null,
                                Some(raw) if column.name().ends_with("_json") => {
                                    serde_json::from_str(&raw).unwrap()
                                }
                                Some(raw) => Value::String(raw),
                            };
                            (column.name().into(), value)
                        })
                        .collect(),
                )
            })
            .collect();
        tables.insert(table.into(), json!(values));
    }
    db.close().await.unwrap();
    let mut value = Value::Object(tables);
    normalize(&mut value);
    value
}

/// External SQLite artifacts are deliberately never tracked in the public repo.
/// Set AGSDL_REPLAY_AUDIT_DIR, AGSDL_REPLAY_R6_DIR and AGSDL_REPLAY_REPORT, then
/// run this ignored test explicitly. Every input and companion is copied first.
#[tokio::test]
#[ignore = "requires the external R6 and audit corpora"]
async fn real_r6_and_audit_mutations_on_copies() {
    let audit =
        PathBuf::from(std::env::var_os("AGSDL_REPLAY_AUDIT_DIR").expect("AGSDL_REPLAY_AUDIT_DIR"));
    let r6 = PathBuf::from(std::env::var_os("AGSDL_REPLAY_R6_DIR").expect("AGSDL_REPLAY_R6_DIR"));
    let directory = tempfile::tempdir().unwrap();
    let mut report = Vec::new();
    let mut baselines = std::collections::BTreeMap::new();
    let mut files: Vec<_> = std::fs::read_dir(&r6)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .ends_with("-scenario-delete.sqlite")
        })
        .collect();
    files.sort();
    assert_eq!(files.len(), 15);
    for source in files {
        let name = source.file_name().unwrap().to_str().unwrap();
        let scenario = name
            .strip_suffix("-scenario-delete.sqlite")
            .unwrap()
            .to_owned();
        let copy = directory.path().join(name);
        copy_sqlite(&source, &copy);
        let ids = read_ids(&copy).await;
        let verdict = verify_path030(&copy, &ids.0, &ids.1).await;
        baselines.insert(scenario.clone(), (core_rows(&copy).await, ids));
        report.push(json!({"name":scenario,"baseline":true,"verdict":verdict}));
    }
    let cases: Vec<Value> =
        serde_json::from_slice(&std::fs::read(audit.join("all-mutation-results.json")).unwrap())
            .unwrap();
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let source = audit.join("mutations").join(format!("{name}.sqlite"));
        let copy = directory.path().join(format!("mutation-{name}.sqlite"));
        copy_sqlite(&source, &copy);
        let (baseline, ids) = &baselines[case["scenario"].as_str().unwrap()];
        let core_changed = core_rows(&copy).await != *baseline;
        let verdict = verify_path030(&copy, &ids.0, &ids.1).await;
        report.push(
            json!({"name":name,"baseline":false,"coreChanged":core_changed,"verdict":verdict}),
        );
    }
    let output =
        PathBuf::from(std::env::var_os("AGSDL_REPLAY_REPORT").expect("AGSDL_REPLAY_REPORT"));
    std::fs::write(&output, serde_json::to_vec_pretty(&report).unwrap()).unwrap();
    let failures: Vec<_> = report
        .iter()
        .filter(|case| {
            case["verdict"]["ok"] == true
                && (case["baseline"] == false && case["coreChanged"] == true)
                || case["baseline"] == true && case["verdict"]["ok"] != true
        })
        .map(|case| case["name"].as_str().unwrap())
        .collect();
    assert!(
        failures.is_empty(),
        "unexpected replay verdicts: {failures:?}; report: {}",
        output.display()
    );
}
