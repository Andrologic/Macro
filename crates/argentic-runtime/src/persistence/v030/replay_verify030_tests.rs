use super::*;
use std::path::PathBuf;

async fn fixture() -> (tempfile::TempDir, PathBuf, FlowEvent030) {
    let mut plan: FlowPlan030 = parse(
        "fixture",
        include_str!("../../../tests/fixtures/agsdl030_compiled_plan.json"),
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
    fixture_with_plan(plan).await
}

async fn fixture_with_plan(plan: FlowPlan030) -> (tempfile::TempDir, PathBuf, FlowEvent030) {
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
    sqlx::raw_sql(crate::sqlite::INITIAL_SCHEMA)
        .execute(&mut db)
        .await
        .unwrap();
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
        .bind(json!({"source":plan.source,"entry":{"deliveryId":"delivery","messageJson":"{}"}}).to_string())
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

async fn persist_transition(
    db: &mut SqliteConnection,
    event: &FlowEvent030,
    transition: &FlowTransition030,
) {
    sqlx::query("INSERT INTO engine_flow030_events VALUES('system','invocation',?,?,?,NULL)")
        .bind(&event.event_id)
        .bind(json!(event).to_string())
        .bind(json!(transition.receipt).to_string())
        .execute(&mut *db)
        .await
        .unwrap();
    for effect in &transition.effects {
        sqlx::query("INSERT INTO engine_flow030_outbox VALUES('system','invocation',?,?,?,'owner','pending',NULL)")
            .bind(&effect.id).bind(&event.event_id).bind(json!(effect).to_string()).execute(&mut *db).await.unwrap();
    }
    sqlx::query("UPDATE engine_flow030_runs SET state_json=?")
        .bind(json!(transition.state).to_string())
        .execute(db)
        .await
        .unwrap();
}

async fn append_event(path: &Path, event_id: &str, kind: FlowEventKind030) -> FlowTransition030 {
    let mut db = SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(path))
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
        event_id: event_id.into(),
        expected_revision: state.revision.clone(),
        kind,
    };
    let transition = reduce(&plan, &state, &event).unwrap();
    persist_transition(&mut db, &event, &transition).await;
    db.close().await.unwrap();
    transition
}

async fn settle_host_effect(path: &Path, effect: &FlowEffect030) {
    let receipt = json!({"kind":"nativeOwnedHandoff030","identity":effect.identity,"effectId":effect.id,"ownerEpoch":"owner","generation":"generation","requestId":format!("flow030:system:{}",effect.id)}).to_string();
    let mut db = SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(path))
        .await
        .unwrap();
    sqlx::query("INSERT INTO engine_flow030_handoffs VALUES('system','invocation',?,'owner','generation',?)").bind(&effect.id).bind(&receipt).execute(&mut db).await.unwrap();
    sqlx::query(
        "UPDATE engine_flow030_outbox SET status='settled',settlement_json=? WHERE effect_id=?",
    )
    .bind(receipt)
    .bind(&effect.id)
    .execute(&mut db)
    .await
    .unwrap();
    db.close().await.unwrap();
}

#[cfg(unix)]
#[test]
fn wal_snapshot_permissions_are_restrictive_from_creation() {
    use std::os::unix::fs::PermissionsExt;
    let source = tempfile::tempdir().unwrap();
    let path = source.path().join("source.sqlite");
    for suffix in ["", "-wal", "-shm"] {
        std::fs::write(companion(&path, suffix), b"synthetic journal bytes").unwrap();
        std::fs::set_permissions(
            companion(&path, suffix),
            std::fs::Permissions::from_mode(0o644),
        )
        .unwrap();
    }
    for with_shm in [true, false] {
        if !with_shm {
            std::fs::remove_file(companion(&path, "-shm")).unwrap();
        }
        let copy = private_snapshot(&path).unwrap();
        assert_eq!(copy.path().parent(), Some(std::env::temp_dir().as_path()));
        assert_eq!(
            copy.path().metadata().unwrap().permissions().mode() & 0o777,
            0o700
        );
        for suffix in ["", "-wal", "-shm"] {
            let file = companion(&copy.path().join("journal.sqlite"), suffix);
            assert_eq!(file.metadata().unwrap().permissions().mode() & 0o777, 0o600);
            let expected: &[u8] = if suffix == "-shm" && !with_shm {
                b""
            } else {
                b"synthetic journal bytes"
            };
            assert_eq!(std::fs::read(file).unwrap(), expected);
        }
    }
}

#[tokio::test]
async fn physical_end_requires_its_settled_stop_even_with_a_valid_start() {
    let (_directory, path, _) = fixture().await;
    let start = settled_agent(&path).await;
    let FlowEffectKind030::Start { work, .. } = start.kind else {
        unreachable!()
    };
    let stopped = append_event(&path, "stop", FlowEventKind030::Stop).await;
    let stop = stopped
        .effects
        .iter()
        .find(|effect| matches!(effect.kind, FlowEffectKind030::StopWork { .. }))
        .unwrap();
    settle_host_effect(&path, stop).await;
    append_event(
        &path,
        "ended",
        FlowEventKind030::PhysicalEnded {
            work,
            stop_effect_id: Some(stop.id.clone()),
            evidence: PhysicalEvidence030 {
                native_receipt_id: "joined".into(),
                descendants_joined: true,
            },
        },
    )
    .await;
    assert!(verify_path030(&path, "system", "invocation").await.ok);
    mutate(&path,"DROP TRIGGER engine_flow030_handoff_retained; DELETE FROM engine_flow030_handoffs WHERE effect_id IN (SELECT effect_id FROM engine_flow030_outbox WHERE event_id='stop'); UPDATE engine_flow030_outbox SET status='pending',settlement_json=NULL WHERE event_id='stop'").await;
    assert_eq!(
        verify_path030(&path, "system", "invocation")
            .await
            .divergence
            .unwrap()
            .field,
        "physicalEnded.stop.status"
    );
}

async fn native_no_admission_fixture(reason: &str) -> (tempfile::TempDir, PathBuf) {
    let (directory, path, entered) = fixture().await;
    let original_status = match reason {
        "unclaimed" => "pending",
        "unreleasedNativeClaim" => {
            mutate(
                &path,
                "UPDATE engine_flow030_outbox SET status='uncertain' WHERE event_id='start:enter'",
            )
            .await;
            "uncertain"
        }
        _ => panic!("native reason"),
    };
    let stopped = append_event(&path, "stop", FlowEventKind030::Stop).await;
    let stop = stopped
        .effects
        .iter()
        .find(|effect| matches!(effect.kind, FlowEffectKind030::StopWork { .. }))
        .unwrap();
    let FlowEffectKind030::StopWork { work, .. } = &stop.kind else {
        unreachable!()
    };
    let native_receipt_id = format!("no-admission:synthetic-{reason}");
    let proof = json!({"identity":entered.identity,"work":work,"ownerEpoch":"owner","generation":"generation","nativeReceiptId":native_receipt_id,"reason":reason}).to_string();
    let mut db = SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&path))
        .await
        .unwrap();
    let mut tx = db.begin_with("BEGIN IMMEDIATE").await.unwrap();
    // Exactly the durable no-admission transaction: settle Start, persist the
    // physical end, and leave StopWork pending without manufacturing a handoff.
    sqlx::query("INSERT INTO engine_flow030_no_admissions VALUES('system','invocation',?,'owner','generation',?)").bind(&work.start_effect_id).bind(&proof).execute(&mut *tx).await.unwrap();
    let changed = sqlx::query("UPDATE engine_flow030_outbox SET status='settled',settlement_json=? WHERE effect_id=? AND status=? AND owner_epoch='owner'").bind(proof).bind(&work.start_effect_id).bind(original_status).execute(&mut *tx).await.unwrap().rows_affected();
    assert_eq!(changed, 1);
    let event = FlowEvent030 {
        identity: entered.identity,
        event_id: format!("no-admission:{}", work.start_effect_id),
        expected_revision: stopped.state.revision.clone(),
        kind: FlowEventKind030::PhysicalEnded {
            work: work.clone(),
            stop_effect_id: Some(stop.id.clone()),
            evidence: PhysicalEvidence030 {
                native_receipt_id,
                descendants_joined: true,
            },
        },
    };
    let plan: FlowPlan030 = parse("plan", stopped.state.plan_json.as_deref().unwrap()).unwrap();
    let transition = reduce(&plan, &stopped.state, &event).unwrap();
    persist_transition(&mut tx, &event, &transition).await;
    tx.commit().await.unwrap();
    let stop_row =
        sqlx::query("SELECT status,settlement_json FROM engine_flow030_outbox WHERE effect_id=?")
            .bind(&stop.id)
            .fetch_one(&mut db)
            .await
            .unwrap();
    assert_eq!(stop_row.try_get::<String, _>("status").unwrap(), "pending");
    assert_eq!(
        stop_row
            .try_get::<Option<String>, _>("settlement_json")
            .unwrap(),
        None
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM engine_flow030_handoffs")
            .fetch_one(&mut db)
            .await
            .unwrap(),
        0
    );
    db.close().await.unwrap();
    (directory, path)
}

#[tokio::test]
async fn native_unclaimed_non_admission_accepts_physical_end_with_pending_stop() {
    let (_directory, path) = native_no_admission_fixture("unclaimed").await;
    let verdict = verify_path030(&path, "system", "invocation").await;
    assert!(verdict.ok, "{verdict:?}");
}

#[tokio::test]
async fn native_unreleased_claim_non_admission_accepts_physical_end_with_pending_stop() {
    let (_directory, path) = native_no_admission_fixture("unreleasedNativeClaim").await;
    let verdict = verify_path030(&path, "system", "invocation").await;
    assert!(verdict.ok, "{verdict:?}");
}

#[tokio::test]
async fn no_admission_exception_rejects_missing_contradictory_and_forged_native_proofs() {
    for reason in ["unclaimed", "unreleasedNativeClaim"] {
        let (_directory, source) = native_no_admission_fixture(reason).await;
        let copies = tempfile::tempdir().unwrap();
        for (index,mutation) in [
            "DROP TRIGGER engine_flow030_no_admission_retained; DELETE FROM engine_flow030_no_admissions",
            "DROP TRIGGER engine_flow030_no_admission_immutable; UPDATE engine_flow030_no_admissions SET proof_json=json_set(proof_json,'$.nativeReceiptId','forged'); UPDATE engine_flow030_outbox SET settlement_json=(SELECT proof_json FROM engine_flow030_no_admissions) WHERE event_id='start:enter'",
            "DROP TRIGGER engine_flow030_no_admission_immutable; UPDATE engine_flow030_no_admissions SET proof_json=json_set(proof_json,'$.reason','forged'); UPDATE engine_flow030_outbox SET settlement_json=(SELECT proof_json FROM engine_flow030_no_admissions) WHERE event_id='start:enter'",
            "DROP TRIGGER engine_flow030_no_admission_immutable; UPDATE engine_flow030_no_admissions SET proof_json=json_set(proof_json,'$.generation','foreign'); UPDATE engine_flow030_outbox SET settlement_json=(SELECT proof_json FROM engine_flow030_no_admissions) WHERE event_id='start:enter'",
            "DROP TRIGGER engine_flow030_no_admission_immutable; UPDATE engine_flow030_no_admissions SET proof_json=json_set(proof_json,'$.work.activationId','foreign'); UPDATE engine_flow030_outbox SET settlement_json=(SELECT proof_json FROM engine_flow030_no_admissions) WHERE event_id='start:enter'",
            "UPDATE engine_flow030_outbox SET status='pending',settlement_json=NULL WHERE event_id='start:enter'",
            "INSERT INTO engine_flow030_work_authorizations SELECT 'system','invocation','forged-auth',json_extract(proof_json,'$.work.activationId'),'{}',NULL,NULL FROM engine_flow030_no_admissions",
        ].into_iter().enumerate() {
            let path = copies.path().join(format!("negative-{index}.sqlite"));
            copy_sqlite(&source,&path);
            mutate(&path,mutation).await;
            let verdict = verify_path030(&path,"system","invocation").await;
            assert!(!verdict.ok,"{reason}: {mutation}");
        }
    }
}

async fn diagnostic_fixture() -> (tempfile::TempDir, PathBuf) {
    let plan: FlowPlan030 = parse(
        "plan",
        include_str!("../../../tests/fixtures/agsdl030_shared_stop_pending_compiled_plan.json"),
    )
    .unwrap();
    let (directory, path, _) = fixture_with_plan(plan.clone()).await;
    let start = settled_agent(&path).await;
    let FlowEffectKind030::Start { work, .. } = start.kind else {
        unreachable!()
    };
    let before = append_event(
        &path,
        "origin-result",
        FlowEventKind030::WorkResult {
            work,
            result: WorkResult030::Completed {
                output_json: json!({"choice":"approve","results":{"items":["x","y"]}}).to_string(),
                route_key: Some("approve".into()),
            },
            physical: Some(PhysicalEvidence030 {
                native_receipt_id: "physical-o".into(),
                descendants_joined: true,
            }),
        },
    )
    .await
    .state;
    let reference = before
        .preparations
        .iter()
        .find(|p| p.status == "pending")
        .unwrap()
        .reference
        .clone();
    let route = plan
        .routes
        .iter()
        .find(|route| {
            route.source == reference.route.source
                && route.kind == reference.route.kind
                && route.key == reference.route.key
        })
        .unwrap();
    let batches = route
        .targets
        .iter()
        .enumerate()
        .map(|(ordinal, target)| {
            let Target030::Step {
                each_path_json,
                address,
                ..
            } = target
            else {
                unreachable!()
            };
            let values = if each_path_json.is_some() {
                vec![Some("\"x\"".to_owned()), Some("\"y\"".to_owned())]
            } else {
                vec![None]
            };
            let message = plan
                .steps
                .iter()
                .find(|step| step.address == *address)
                .unwrap()
                .r#type
                == "agent";
            PreparedBatch030 {
                target_ordinal: ordinal,
                target: target.clone(),
                items: values
                    .into_iter()
                    .enumerate()
                    .map(|(index, item_json)| PreparedItem030 {
                        message_json: message.then(|| "{}".into()),
                        item_json,
                        occurrence: DeliveryOccurrence030 {
                            native_receipt_id: "native-prepare".into(),
                            target_ordinal: ordinal,
                            item_index: index.to_string(),
                        },
                    })
                    .collect(),
            }
        })
        .collect();
    let event = FlowEvent030 {
        identity: before.identity.clone(),
        event_id: "ambiguous".into(),
        expected_revision: before.revision.clone(),
        kind: FlowEventKind030::Prepared {
            reference,
            native_receipt_id: "native-prepare".into(),
            result: PreparedResult030::Ready { batches },
        },
    };
    let Err(FlowInputError030::UnspecifiedSharedCancellation {
        closing_join,
        affected_joins,
    }) = reduce(&plan, &before, &event)
    else {
        panic!("shared cancellation fixture")
    };
    let diagnostic = json!({"code":"UNSPECIFIED_SHARED_CANCELLATION","closingJoin":closing_join,"affectedJoins":affected_joins,"retryable":false});
    let mut db = SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&path))
        .await
        .unwrap();
    let effects_before: i64 = sqlx::query_scalar("SELECT count(*) FROM engine_flow030_outbox")
        .fetch_one(&mut db)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO engine_flow030_events VALUES('system','invocation','ambiguous',?,NULL,?)",
    )
    .bind(json!(event).to_string())
    .bind(diagnostic.to_string())
    .execute(&mut db)
    .await
    .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM engine_flow030_outbox")
            .fetch_one(&mut db)
            .await
            .unwrap(),
        effects_before
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT state_json FROM engine_flow030_runs")
            .fetch_one(&mut db)
            .await
            .unwrap(),
        json!(before).to_string()
    );
    db.close().await.unwrap();
    assert!(verify_path030(&path, "system", "invocation").await.ok);
    append_event(&path, "explicit-stop", FlowEventKind030::Stop).await;
    (directory, path)
}

#[tokio::test]
async fn exact_durable_diagnostic_followed_by_stop_is_replayed_without_state_or_effects() {
    let (_directory, path) = diagnostic_fixture().await;
    let verdict = verify_path030(&path, "system", "invocation").await;
    assert!(verdict.ok, "{verdict:?}");
    for mutation in [
        "UPDATE engine_flow030_events SET diagnostic_json=json_set(diagnostic_json,'$.retryable',json('true')) WHERE event_id='ambiguous'",
        "UPDATE engine_flow030_runs SET state_json=json_set(state_json,'$.revision','99')",
        "INSERT INTO engine_flow030_outbox SELECT system_id,invocation_id,'forged','ambiguous',effect_json,owner_epoch,status,settlement_json FROM engine_flow030_outbox WHERE rowid=(SELECT min(rowid) FROM engine_flow030_outbox)",
        "UPDATE engine_flow030_events SET diagnostic_json=json_set(diagnostic_json,'$.affectedJoins',json('[]')) WHERE event_id='ambiguous'",
    ] {
        let (_directory,copy) = diagnostic_fixture().await;
        mutate(&copy,mutation).await;
        assert!(!verify_path030(&copy,"system","invocation").await.ok,"accepted {mutation}");
    }
    let (_directory, copy) = diagnostic_fixture().await;
    mutate(&copy,"UPDATE engine_flow030_events SET rowid=999 WHERE event_id='explicit-stop'; INSERT INTO engine_flow030_events SELECT system_id,invocation_id,'blocked-again',json_set(event_json,'$.eventId','blocked-again'),NULL,diagnostic_json FROM engine_flow030_events WHERE event_id='ambiguous'").await;
    assert_eq!(
        verify_path030(&copy, "system", "invocation")
            .await
            .divergence
            .unwrap()
            .field,
        "event.blocked"
    );
}

#[tokio::test]
#[ignore = "requires the external R6 corpus"]
async fn real_r6_physical_only_pending_and_uncertain_are_rejected() {
    let r6 = PathBuf::from(std::env::var_os("AGSDL_REPLAY_R6_DIR").expect("AGSDL_REPLAY_R6_DIR"));
    let directory = tempfile::tempdir().unwrap();
    for scenario in ["join-group-closes", "join-branch-failed"] {
        for status in ["pending", "uncertain"] {
            let path = directory.path().join(format!("{scenario}-{status}.sqlite"));
            copy_sqlite(
                &r6.join(format!("{scenario}-scenario-delete.sqlite")),
                &path,
            );
            let ids = read_ids(&path).await;
            assert!(verify_path030(&path, &ids.0, &ids.1).await.ok);
            let mut db = SqliteConnection::connect_with(
                &SqliteConnectOptions::new()
                    .filename(&path)
                    .foreign_keys(false),
            )
            .await
            .unwrap();
            let events: Vec<String> =
                sqlx::query_scalar("SELECT event_json FROM engine_flow030_events ORDER BY rowid")
                    .fetch_all(&mut db)
                    .await
                    .unwrap();
            let (work, stop) = events
                .iter()
                .find_map(
                    |raw| match parse::<ReadEvent>("event", raw).unwrap().0.kind {
                        FlowEventKind030::PhysicalEnded {
                            work,
                            stop_effect_id: Some(stop),
                            ..
                        } => Some((work, stop)),
                        _ => None,
                    },
                )
                .unwrap();
            for sql in [
                "DROP TRIGGER engine_flow030_handoff_retained",
                "DROP TRIGGER engine_flow030_work_admissions_retained",
                "DROP TRIGGER engine_flow030_work_authorizations_retained",
                "DROP TRIGGER engine_flow030_work_event_retained",
            ] {
                sqlx::raw_sql(sql).execute(&mut db).await.unwrap();
            }
            for sql in [
                "DELETE FROM engine_flow030_work_admissions WHERE activation_id=?",
                "DELETE FROM engine_flow030_work_authorizations WHERE activation_id=?",
                "DELETE FROM engine_flow030_work_state WHERE activation_id=?",
                "DELETE FROM engine_flow030_work_events WHERE activation_id=?",
                "DELETE FROM engine_flow030_work_checks WHERE activation_id=?",
            ] {
                sqlx::query(sql)
                    .bind(&work.activation_id)
                    .execute(&mut db)
                    .await
                    .unwrap();
            }
            for effect in [&work.start_effect_id, &stop] {
                sqlx::query("UPDATE engine_flow030_outbox SET status=?,settlement_json=NULL WHERE effect_id=?").bind(status).bind(effect).execute(&mut db).await.unwrap();
                sqlx::query("DELETE FROM engine_flow030_handoffs WHERE effect_id=?")
                    .bind(effect)
                    .execute(&mut db)
                    .await
                    .unwrap();
            }
            db.close().await.unwrap();
            let verdict = verify_path030(&path, &ids.0, &ids.1).await;
            assert_eq!(
                verdict.divergence.unwrap().field,
                "physicalEnded.start.status",
                "{scenario} {status}"
            );
        }
    }
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
        FlowEventKind030::SteerConsumed {
            effect_id: "effect".into(),
            work: work.clone(),
            delivery_activation_id: "delivery".into(),
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

#[tokio::test]
#[ignore = "requires the external final R6 corpus"]
async fn real_r6_final_runs_on_copies() {
    let source = PathBuf::from(
        std::env::var_os("AGSDL_REPLAY_R6_FINAL_DIR").expect("AGSDL_REPLAY_R6_FINAL_DIR"),
    );
    let directory = tempfile::tempdir().unwrap();
    let mut files: Vec<_> = std::fs::read_dir(&source)
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
        let copy = directory.path().join(source.file_name().unwrap());
        copy_sqlite(&source, &copy);
        let ids = read_ids(&copy).await;
        let verdict = verify_path030(&copy, &ids.0, &ids.1).await;
        assert!(
            verdict.ok,
            "{}: {verdict:?}",
            source.file_name().unwrap().to_string_lossy()
        );
    }
}

#[tokio::test]
async fn steer_consumption_must_correlate_exact_delivery_work_message_and_checkpoint() {
    let (_directory, path, event) = fixture().await;
    let mut db = SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&path))
        .await
        .unwrap();
    let raw: String = sqlx::query_scalar("SELECT plan_json FROM engine_flow030_runs")
        .fetch_one(&mut db)
        .await
        .unwrap();
    let plan: FlowPlan030 = parse("plan", &raw).unwrap();
    let transition = reduce(&plan, &FlowState030::new(event.identity.clone()), &event).unwrap();
    let mut effect = transition.effects[0].clone();
    let FlowEffectKind030::Start { work, .. } = effect.kind else {
        panic!("agent Start")
    };
    effect.kind = FlowEffectKind030::Steer {
        work: work.clone(),
        delivery_activation_id: "delivery".into(),
        message_json: "{\"prompt\":\"Update.\"}".into(),
        occurrence: None,
        sender: None,
    };
    let consumed = FlowEvent030 {
        identity: event.identity.clone(),
        event_id: "consumed".into(),
        expected_revision: transition.state.revision.clone(),
        kind: FlowEventKind030::SteerConsumed {
            effect_id: effect.id.clone(),
            work: work.clone(),
            delivery_activation_id: "delivery".into(),
        },
    };
    let mut state = transition.state.clone();
    state.steer_deliveries.push(SteerRecord030 {
        effect_id: effect.id.clone(),
        work: work.clone(),
        delivery_activation_id: "delivery".into(),
        status: "consumed".into(),
        resolved_event_id: Some("consumed".into()),
        reason: None,
    });
    state.events.insert(
        "consumed".into(),
        EventRecord030 {
            event_json: json!(consumed).to_string(),
            receipt: FlowReceipt030 {
                event_id: "consumed".into(),
                revision: "2".into(),
                effect_ids: vec![],
            },
        },
    );
    let receipt = json!({"work":work,"deliveryActivationId":"delivery","messageJson":"{\"prompt\":\"Update.\"}","consumedAfterEventId":event.event_id,"consumedEventId":"consumed"});
    assert!(verify_steer_settlement(&state, &effect, &receipt).is_ok());
    for key in [
        "work",
        "deliveryActivationId",
        "messageJson",
        "consumedAfterEventId",
        "consumedEventId",
    ] {
        let mut forged = receipt.clone();
        forged[key] = json!("foreign");
        assert!(
            verify_steer_settlement(&state, &effect, &forged).is_err(),
            "{key}"
        );
    }
    db.close().await.unwrap();
}
