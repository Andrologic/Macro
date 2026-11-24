use super::*;
use crate::architect_launch::tests::{archive_fixture, manifest};
use crate::db::architect_library::list_uses;
use argentic_runtime::{
    api::{self, StreamTasks},
    dev_fixture::ScriptedAgent,
};
use std::{cell::Cell, sync::Arc};

const NOW: i64 = 1_960_000_000_000;
const HOUR: i64 = 3_600_000;

async fn fixture() -> (tempfile::TempDir, SqlitePool, VersionKey, ConfigManager) {
    let data = tempfile::tempdir().unwrap();
    let (pool, key) = archive_fixture(data.path(), manifest()).await;
    let manager = ConfigManager::initialize(data.path().join("config"))
        .await
        .unwrap();
    crate::agsdl_host_capture::test_codex_observations030()
        .lock()
        .unwrap()
        .insert(
            manager.root().to_owned(),
            api::synthetic_codex_observation(),
        );
    (data, pool, key, manager)
}

fn wire_request(
    key: &VersionKey,
    token: Option<String>,
    catch_up: bool,
    overlap: bool,
    latest: bool,
) -> Value {
    json!({
        "id": null,
        "launch": {
            "version": key, "configuration": {"workingFolder": null}, "modelOverrides": {},
            "startMessage": "Scheduled work", "name": null, "consentToken": token, "folderReuseToken": null,
        },
        "timing": {"firstAtMs": NOW + HOUR, "repeat": {"kind":"hourly","hours":1}},
        "policy": {"catchUp": catch_up, "allowOverlap": overlap, "alwaysLatest": latest},
    })
}

#[tokio::test]
async fn wire_validation_persists_schedule_pin_and_coalesces_missed_deadlines() {
    let (data, pool, key, manager) = fixture().await;
    let preview = prepare(
        &manager,
        &pool,
        data.path(),
        key.clone(),
        None,
        BTreeMap::new(),
    )
    .await
    .unwrap();
    let mut wire = wire_request(&key, preview.consent_token.clone(), true, false, false);
    wire["launch"]["startMessage"] = Value::Null;
    assert_eq!(
        save(
            &manager,
            &pool,
            data.path(),
            serde_json::from_value(wire).unwrap(),
            || NOW
        )
        .await
        .unwrap_err()
        .code,
        "START_MESSAGE_REQUIRED"
    );

    let make = |catch_up| wire_request(&key, preview.consent_token.clone(), catch_up, false, false);
    let id = save(
        &manager,
        &pool,
        data.path(),
        serde_json::from_value(make(true)).unwrap(),
        || NOW,
    )
    .await
    .unwrap();
    let skip = save(
        &manager,
        &pool,
        data.path(),
        serde_json::from_value(make(false)).unwrap(),
        || NOW,
    )
    .await
    .unwrap();
    assert_eq!(list_uses(&pool, key.clone()).await.unwrap().len(), 2);
    pool.close().await;
    let pool = crate::db::create_pool(&data.path().join("launch.db"))
        .await
        .unwrap();
    assert_eq!(list(&pool).await.unwrap().len(), 2);

    let restarted = NOW + 5 * HOUR + 1;
    let calls = Cell::new(0);
    tick(&pool, restarted, restarted, |occurrence, request| {
        calls.set(calls.get() + 1);
        assert_eq!(occurrence.id, id);
        assert_eq!(occurrence.due_at, NOW + 5 * HOUR);
        assert_eq!(request.start_message.as_deref(), Some("Scheduled work"));
        assert_eq!(request.version.number, 1);
        assert!(request.name.is_some() && request.consent_token.is_none());
        std::future::ready(Err(invalid("MODEL_UNAVAILABLE", "worker")))
    })
    .await
    .unwrap();
    assert_eq!(calls.get(), 1);
    tick(&pool, restarted, restarted, |_, _| {
        panic!("an expired occurrence was submitted twice");
        #[allow(unreachable_code)]
        std::future::ready(Ok(()))
    })
    .await
    .unwrap();

    let rows = list(&pool).await.unwrap();
    let failure = rows.iter().find(|row| row.id == id).unwrap();
    assert_eq!(failure.next_at_ms, Some(NOW + 6 * HOUR));
    assert_eq!(failure.issue_code.as_deref(), Some("MODEL_UNAVAILABLE"));
    assert_eq!(
        rows.iter().find(|row| row.id == skip).unwrap().issue_code,
        None
    );
    let dismiss: ScheduleAction =
        serde_json::from_value(json!({"kind":"dismiss","atMs":NOW+5*HOUR})).unwrap();
    act(&pool, &id, dismiss, restarted).await.unwrap();
    assert!(list(&pool)
        .await
        .unwrap()
        .iter()
        .all(|row| row.issue_code.is_none()));
    act(&pool, &id, ScheduleAction::Delete, restarted)
        .await
        .unwrap();
    assert_eq!(list_uses(&pool, key.clone()).await.unwrap().len(), 1);
    assert!(crate::db::architect_library::delete_version(&pool, key)
        .await
        .is_err());
}

#[tokio::test]
async fn scheduled_fields_are_validated_and_recovered_at_dispatch() {
    let (data, pool, original, manager) = fixture().await;
    let storage = Storage::new(data.path());
    let draft = storage
        .open_draft_project(&pool, &original.blueprint_id)
        .await
        .unwrap();
    let batch = serde_json::from_value(json!({
        "files":[], "settings":{"launchFields":{"version":"macro-launch-fields/1","fields":[
            {"key":"ticket","label":"Ticket","type":"number","required":true},
            {"key":"note","label":"Note","type":"text","required":true},
            {"key":"send","label":"Send","type":"boolean","required":true}
        ]}}
    }))
    .unwrap();
    let updated = storage
        .edit_project(
            &pool,
            &original.blueprint_id,
            draft.project.revision,
            batch,
            true,
        )
        .await
        .unwrap();
    storage
        .freeze(
            &pool,
            original.blueprint_id.clone(),
            updated.revision,
            None,
            None,
        )
        .await
        .unwrap();
    let key = VersionKey {
        number: 2,
        ..original
    };
    let preview = prepare(
        &manager,
        &pool,
        data.path(),
        key.clone(),
        None,
        BTreeMap::new(),
    )
    .await
    .unwrap();
    let mut wire = wire_request(&key, preview.consent_token, true, false, false);
    wire["launch"]["startMessage"] = Value::Null;
    assert_eq!(
        save(
            &manager,
            &pool,
            data.path(),
            serde_json::from_value(wire.clone()).unwrap(),
            || NOW
        )
        .await
        .unwrap_err()
        .code,
        "INVALID_LAUNCH_VALUES"
    );
    let values = json!({"ticket":12.25,"note":"Note \"citée\"\nDeuxième ligne","send":false});
    wire["launch"]["launchValues"] = values.clone();
    let id = save(
        &manager,
        &pool,
        data.path(),
        serde_json::from_value(wire).unwrap(),
        || NOW,
    )
    .await
    .unwrap();
    assert_eq!(
        list(&pool).await.unwrap()[0].launch_values.as_ref(),
        Some(&values)
    );
    let (_, request) = claim(&pool, &id, NOW + HOUR, NOW).await.unwrap().unwrap();
    assert_eq!(request.launch_values, Some(values));
    assert_eq!(request.version.blueprint_id, key.blueprint_id);
    assert_eq!(request.version.number, key.number);
    assert!(request.start_message.is_none());
}

#[tokio::test]
async fn scheduled_start_links_real_archive_run_and_report_skipped_overlap() {
    let (data, pool, key, manager) = fixture().await;
    let preview = prepare(
        &manager,
        &pool,
        data.path(),
        key.clone(),
        None,
        BTreeMap::new(),
    )
    .await
    .unwrap();
    let wire = wire_request(&key, preview.consent_token, true, false, false);
    let id = save(
        &manager,
        &pool,
        data.path(),
        serde_json::from_value(wire).unwrap(),
        || NOW,
    )
    .await
    .unwrap();
    let host = crate::agsdl_host::HostState::new();
    let cleanup = Arc::new(tokio::sync::Notify::new());
    let submitted = Arc::new(tokio::sync::Notify::new());
    let executor = Arc::new(ScriptedAgent {
        cleanup: Some(cleanup.clone()),
        submitted: Some(submitted.clone()),
        independent_finish: true,
        ..Default::default()
    });
    executor.install(&host);
    tick(&pool, NOW + HOUR, NOW, |occurrence, request| {
        let runtime = start::Runtime {
            host: &host,
            manager: &manager,
            pool: &pool,
            app_data: data.path(),
            tasks: StreamTasks::default(),
        };
        async move {
            start::launch_occurrence(runtime, request, Some(occurrence))
                .await
                .map(|_| ())
        }
    })
    .await
    .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(10), submitted.notified())
        .await
        .unwrap();
    let runs = run_systems(&pool).await.unwrap();
    assert_eq!(
        runs.len(),
        1,
        "{}",
        list(&pool).await.unwrap()[0]
            .issue_code
            .as_deref()
            .unwrap_or_default()
    );
    assert!(runs[0].run_name.is_some());
    assert_eq!(list_uses(&pool, key.clone()).await.unwrap().len(), 2);
    let folder = read_folder(&pool, &runs[0].system_start_id).await.unwrap();
    let scope = start::scope_for(Path::new(&folder), &owner(&key.blueprint_id)).unwrap();
    let mut db = pool.acquire().await.unwrap();
    assert!(folder_in_use(&mut db, &scope, None).await.unwrap());
    assert!(folder_in_use(&mut db, &scope, Some("another-schedule"))
        .await
        .unwrap());
    assert!(!folder_in_use(&mut db, &scope, Some(&id)).await.unwrap());
    drop(db);
    let call = |_, _| std::future::ready(Err(invalid("UNEXPECTED_START", "")));
    tick(&pool, NOW + 2 * HOUR, NOW, call).await.unwrap();
    assert_eq!(
        list(&pool).await.unwrap()[0].issue_code.as_deref(),
        Some("SCHEDULE_OVERLAP")
    );

    let mut wire = wire_request(&key, None, true, true, false);
    wire["id"] = json!(&id);
    wire["timing"] = Value::Null;
    save(
        &manager,
        &pool,
        data.path(),
        serde_json::from_value(wire).unwrap(),
        || NOW,
    )
    .await
    .unwrap();
    tick(&pool, NOW + 3 * HOUR, NOW, call).await.unwrap();
    assert_eq!(
        list(&pool).await.unwrap()[0].issue_code.as_deref(),
        Some("UNEXPECTED_START")
    );
    cleanup.notify_one();
    executor
        .wait(&host, &runs[0].system_start_id)
        .await
        .unwrap();
}

#[tokio::test]
async fn suspend_fences_reserved_start_and_latest_is_resolved_at_dispatch() {
    let (data, pool, key, manager) = fixture().await;
    let preview = prepare(
        &manager,
        &pool,
        data.path(),
        key.clone(),
        None,
        BTreeMap::new(),
    )
    .await
    .unwrap();
    let wire = wire_request(&key, preview.consent_token, true, false, true);
    let id = save(
        &manager,
        &pool,
        data.path(),
        serde_json::from_value(wire).unwrap(),
        || NOW,
    )
    .await
    .unwrap();
    sqlx::query("INSERT INTO architect_versions(blueprint_id,number,revision,artifact_id,storage_state,archive_sha256)
        SELECT blueprint_id,2,revision,artifact_id,storage_state,archive_sha256 FROM architect_versions WHERE blueprint_id=? AND number=1")
        .bind(&key.blueprint_id).execute(&pool).await.unwrap();
    let outdated = wire_request(&key, None, true, false, true);
    let error = save(
        &manager,
        &pool,
        data.path(),
        serde_json::from_value(outdated).unwrap(),
        || NOW,
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "SCHEDULE_LATEST_CHANGED");
    assert_eq!(list(&pool).await.unwrap().len(), 1);
    let row = &list(&pool).await.unwrap()[0];
    assert_eq!((row.version.number, row.latest_number), (1, 2));

    let due = NOW + HOUR;
    let (occurrence, request) = claim(&pool, &id, due, NOW).await.unwrap().unwrap();
    assert_eq!(request.version.number, 2);
    act(&pool, &id, ScheduleAction::Suspend, due).await.unwrap();
    let mut db = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
    let error = occurrence
        .link(&mut db, "arbitrary", &request.version)
        .await
        .unwrap_err();
    assert_eq!(error.code, "SCHEDULE_CANCELLED");
    db.rollback().await.unwrap();
    settle(&pool, &id, due, Some(&error.code)).await.unwrap();
    assert!(claim(&pool, &id, due, NOW).await.unwrap().is_none());
    act(&pool, &id, ScheduleAction::Resume, due + 3)
        .await
        .unwrap();
    let (first, second) = tokio::join!(
        claim(&pool, &id, due + 3, NOW),
        claim(&pool, &id, due + 3, NOW)
    );
    assert_ne!(first.unwrap().is_some(), second.unwrap().is_some());
    recover(&pool).await.unwrap();
    let row = &list(&pool).await.unwrap()[0];
    assert_eq!(row.issue_code.as_deref(), Some("SCHEDULE_INTERRUPTED"));
    assert_eq!(row.next_at_ms, Some(due + HOUR));
    assert_eq!(row.version.number, 1);
}

#[tokio::test]
async fn recovery_retains_a_suspended_uncommitted_one_time_launch() {
    let (data, pool, key, manager) = fixture().await;
    let preview = prepare(
        &manager,
        &pool,
        data.path(),
        key.clone(),
        None,
        BTreeMap::new(),
    )
    .await
    .unwrap();
    let mut wire = wire_request(&key, preview.consent_token, true, false, false);
    wire["timing"]["repeat"] = json!({"kind":"once"});
    let id = save(
        &manager,
        &pool,
        data.path(),
        serde_json::from_value(wire).unwrap(),
        || NOW,
    )
    .await
    .unwrap();
    let due = NOW + HOUR;
    assert!(claim(&pool, &id, due, NOW).await.unwrap().is_some());
    act(&pool, &id, ScheduleAction::Suspend, due).await.unwrap();
    recover(&pool).await.unwrap();
    let row = list(&pool).await.unwrap().remove(0);
    assert!(row.suspended && !row.starting);
    assert_eq!(row.next_at_ms, Some(due));
    assert_eq!(row.issue_code, None);
    assert!(claim(&pool, &id, due + 1, due + 1).await.unwrap().is_none());
    act(&pool, &id, ScheduleAction::Resume, due + 1)
        .await
        .unwrap();
    let (occurrence, _) = claim(&pool, &id, due + 1, due + 1).await.unwrap().unwrap();
    assert_eq!(occurrence.due_at, due);
}
