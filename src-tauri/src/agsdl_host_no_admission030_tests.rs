//! Reducer/SQLite fixture for the opaque native control. This is not a real
//! Start, provider invocation, or proof of operating-system process termination.
use super::*;
use crate::db::agsdl_execution::flow030::{reduce, FlowPlan030, WorkRef030};

#[tokio::test]
async fn unclaimed_start_is_settled_atomically_without_a_handoff() {
    exercise(0).await;
}

#[tokio::test]
async fn uncertain_without_tombstone_does_not_prove_no_admission() {
    exercise(1).await;
}

#[tokio::test]
async fn durable_handoff_excludes_no_admission_even_after_stop() {
    exercise(2).await;
}

#[tokio::test]
async fn dropped_claim_guard_supplies_a_single_use_tombstone() {
    exercise(3).await;
}

async fn exercise(mode: u8) {
    let temp = tempfile::TempDir::new().unwrap();
    let pool = crate::db::create_pool(&temp.path().join("unadmitted.db"))
        .await
        .unwrap();
    let identity = FlowIdentity030 {
        system_start_id: "system".into(),
        flow_invocation_id: "flow".into(),
        snapshot_id: "snapshot".into(),
        epoch: "capture".into(),
    };
    let plan_json = include_str!("../tests/fixtures/agsdl030_compiled_plan.json");
    let plan: FlowPlan030 = serde_json::from_str(plan_json).unwrap();
    let enter = FlowEvent030 {
        identity: identity.clone(),
        event_id: "enter".into(),
        expected_revision: "0".into(),
        kind: FlowEventKind030::Enter {
            message_json: "{}".into(),
        },
    };
    let transition = reduce(&plan, &FlowState030::new(identity.clone()), &enter).unwrap();
    let start = transition
        .effects
        .iter()
        .find_map(|effect| match &effect.kind {
            FlowEffectKind030::Start { work, .. } => Some(work.clone()),
            _ => None,
        })
        .expect("fixture start");
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("INSERT INTO engine_flow030_runs VALUES (?,?,?,?,?,?,?)")
        .bind("system")
        .bind("flow")
        .bind("snapshot")
        .bind("capture")
        .bind(plan.source.to_string())
        .bind(plan_json)
        .bind(serde_json::to_string(&transition.state).unwrap())
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
        .bind("revoked")
        .bind("a".repeat(64))
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("INSERT INTO engine_flow030_events VALUES (?,?,?,?,?,NULL)")
        .bind("system")
        .bind("flow")
        .bind("enter")
        .bind(serde_json::to_string(&enter).unwrap())
        .bind(serde_json::to_string(&transition.receipt).unwrap())
        .execute(&mut *tx)
        .await
        .unwrap();
    for effect in &transition.effects {
        let status = if effect.id == start.start_effect_id {
            match mode {
                1 | 3 => "uncertain",
                2 => "settled",
                _ => "pending",
            }
        } else {
            "pending"
        };
        let settlement = (status == "settled").then_some("{}");
        sqlx::query("INSERT INTO engine_flow030_outbox VALUES (?,?,?,?,?,?,?,?)")
            .bind("system")
            .bind("flow")
            .bind(&effect.id)
            .bind("enter")
            .bind(serde_json::to_string(effect).unwrap())
            .bind("owner")
            .bind(status)
            .bind(settlement)
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    if mode == 2 {
        sqlx::query("INSERT INTO engine_flow030_handoffs VALUES (?,?,?,?,?,?)")
            .bind("system")
            .bind("flow")
            .bind(&start.start_effect_id)
            .bind("owner")
            .bind("generation")
            .bind("{}")
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    tx.commit().await.unwrap();
    let runtime = FlowHost030::default();
    let control = Arc::new(FlowControl030 {
        owner: EngineOwner {
            system_start_id: "system".into(),
            owner_epoch: "owner".into(),
        },
        identity: identity.clone(),
        generation: "generation".into(),
        admission: Arc::new(tokio::sync::Mutex::new(())),
    });
    runtime
        .controls
        .lock()
        .unwrap()
        .insert("system".into(), control.clone());
    if mode == 3 {
        let effect = transition
            .effects
            .iter()
            .find(|effect| effect.id == start.start_effect_id)
            .unwrap()
            .clone();
        let guard = UnadmittedClaimGuard030 {
            runtime: &runtime,
            witness: Some(Unadmitted030 {
                owner: control.owner.clone(),
                generation: "generation".into(),
                effect,
            }),
        };
        drop(guard);
    }
    let stop = FlowEvent030 {
        identity: identity.clone(),
        event_id: "stop".into(),
        expected_revision: transition.state.revision,
        kind: FlowEventKind030::Stop,
    };
    control.apply(&pool, &stop).await.unwrap();
    assert!(control
        .settle_unadmitted(&FlowHost030::default(), &pool, &start)
        .await
        .is_err());
    if mode == 1 || mode == 2 {
        assert!(control
            .settle_unadmitted(&runtime, &pool, &start)
            .await
            .unwrap()
            .is_none());
        assert!(
            control
                .read(&pool)
                .await
                .unwrap()
                .state
                .activations
                .iter()
                .find(|a| a.id == start.activation_id)
                .unwrap()
                .physical
        );
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM engine_flow030_no_admissions")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 0);
        return;
    }
    sqlx::query("CREATE TRIGGER reject_proof BEFORE INSERT ON engine_flow030_no_admissions BEGIN SELECT RAISE(ABORT,'test rollback'); END")
        .execute(&pool).await.unwrap();
    assert!(control
        .settle_unadmitted(&runtime, &pool, &start)
        .await
        .is_err());
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM engine_flow030_no_admissions")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    assert!(
        control
            .read(&pool)
            .await
            .unwrap()
            .state
            .activations
            .iter()
            .find(|a| a.id == start.activation_id)
            .unwrap()
            .physical
    );
    sqlx::query("DROP TRIGGER reject_proof")
        .execute(&pool)
        .await
        .unwrap();
    let result = control
        .settle_unadmitted(&runtime, &pool, &start)
        .await
        .unwrap();
    assert!(result.is_some());
    let view = control.read(&pool).await.unwrap();
    assert!(
        !view
            .state
            .activations
            .iter()
            .find(|a| a.id == start.activation_id)
            .unwrap()
            .physical
    );
    let row: (String, String) = sqlx::query_as("SELECT status,settlement_json FROM engine_flow030_outbox WHERE system_id='system' AND effect_id=?")
        .bind(&start.start_effect_id).fetch_one(&pool).await.unwrap();
    assert_eq!(row.0, "settled");
    assert!(row.1.contains(if mode == 3 {
        "unreleasedNativeClaim"
    } else {
        "unclaimed"
    }));
    assert!(control
        .settle_unadmitted(&runtime, &pool, &start)
        .await
        .unwrap()
        .is_some());
    let mut foreign: WorkRef030 = start;
    foreign.start_effect_id = "other".into();
    assert!(control
        .settle_unadmitted(&runtime, &pool, &foreign)
        .await
        .is_err());
}
