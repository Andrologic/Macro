use super::super::tests::{database, fixture, git};
use super::*;
use std::{fs, process::Command};

async fn abort_with_checkpoint_failure(rebase: bool, fail_intent: bool) {
    let (temp, repo, _) = fixture(true);
    let pool = database().await;
    let key = workflow_key(&repo, "task-a", "feature", "main").unwrap();
    let request = |action: &str, expected_session_id: Option<String>| {
        dispatch_workflow(
            temp.path(),
            GitState::new(),
            pool.clone(),
            temp.path().to_string_lossy().into_owned(),
            "task-a".into(),
            "feature".into(),
            "main".into(),
            action.into(),
            None,
            None,
            expected_session_id,
        )
    };
    let prepared = request("prepare", None).await.unwrap().unwrap();
    if rebase {
        let journal = load_journal(&pool, &key).await.unwrap().unwrap();
        let pending = rebase::prepare_rebase(&repo, &journal).unwrap();
        save_journal(&pool, &key, &pending).await.unwrap();
        let serialized = serde_json::to_value(&pending).unwrap();
        git(temp.path(), &["checkout", "feature"]);
        // Leave the recorded rebase interrupted, as if its child process died
        // while resolving a conflict, before the normal helper could abort it.
        let output = Command::new("git")
            .arg("-C")
            .arg(temp.path())
            .args(["rebase", "--merge", "main"])
            .env(
                "GIT_REFLOG_ACTION",
                serialized["pendingRebase"]["action"].as_str().unwrap(),
            )
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(repo.path().join("rebase-merge").exists());
    } else {
        let started = request("start", Some(prepared.session_id.clone()))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(started.status, "conflicted");
    }
    let original_state = repo.state();
    let original_index = fs::read(repo.path().join("index")).unwrap();
    let original_file = fs::read(temp.path().join("file.txt")).unwrap();
    let trigger = if fail_intent {
        "CREATE TRIGGER fail_abort_checkpoint BEFORE UPDATE ON app_settings WHEN json_extract(NEW.value_json, '$.pendingAbort') = 1 BEGIN SELECT RAISE(FAIL, 'injected abort checkpoint failure'); END"
    } else {
        "CREATE TRIGGER fail_abort_checkpoint BEFORE UPDATE ON app_settings WHEN json_extract(NEW.value_json, '$.status') = 'aborted' BEGIN SELECT RAISE(FAIL, 'injected abort checkpoint failure'); END"
    };
    sqlx::query(trigger).execute(&pool).await.unwrap();
    let error = request("abort", Some(prepared.session_id.clone()))
        .await
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("injected abort checkpoint failure"),
        "{error}"
    );
    let persisted = load_journal(&pool, &key).await.unwrap().unwrap();

    if fail_intent {
        assert!(!persisted.pending_abort);
        assert_eq!(persisted.session.session_id, prepared.session_id);
        assert_eq!(repo.state(), original_state);
        assert_eq!(fs::read(repo.path().join("index")).unwrap(), original_index);
        assert_eq!(
            fs::read(temp.path().join("file.txt")).unwrap(),
            original_file
        );
    } else {
        assert!(persisted.pending_abort);
        assert_ne!(persisted.session.session_id, prepared.session_id);
        assert_eq!(repo.state(), RepositoryState::Clean);
        assert!(
            ensure_workflow_exclusive(&pool, &repository_common_dir(&repo).unwrap(), "")
                .await
                .is_err()
        );
        for action in [
            "start",
            "no_changes",
            "merge_commit",
            "fast_forward",
            "prepare",
            "abort",
        ] {
            let error = request(action, Some(prepared.session_id.clone()))
                .await
                .unwrap_err();
            assert!(error.to_string().contains("stale"), "{action}: {error}");
        }
        let unchanged = load_journal(&pool, &key).await.unwrap().unwrap();
        assert_eq!(unchanged.session, persisted.session);
        assert!(unchanged.pending_abort);
    }

    sqlx::query("DROP TRIGGER fail_abort_checkpoint")
        .execute(&pool)
        .await
        .unwrap();
    let recovered = if fail_intent {
        request("abort", Some(prepared.session_id.clone()))
            .await
            .unwrap()
            .unwrap()
    } else if rebase {
        request("inspect", None).await.unwrap().unwrap()
    } else {
        // A current-identity restart request may finish the pending abort, but
        // must not also start another merge in the same dispatch.
        request("start", Some(persisted.session.session_id.clone()))
            .await
            .unwrap()
            .unwrap()
    };
    assert_eq!(recovered.status, "aborted");
    assert_ne!(recovered.session_id, prepared.session_id);
    if !fail_intent {
        assert_eq!(recovered.session_id, persisted.session.session_id);
    }
    let confirmed = load_journal(&pool, &key).await.unwrap().unwrap();
    assert!(!confirmed.pending_abort);
    assert!(confirmed.pending_rebase.is_none());
    assert_eq!(request("inspect", None).await.unwrap().unwrap(), recovered);
    assert_eq!(
        request("abort", Some(recovered.session_id.clone()))
            .await
            .unwrap()
            .unwrap(),
        recovered
    );
    assert_eq!(repo.state(), RepositoryState::Clean);
    assert_eq!(git(temp.path(), &["branch", "--show-current"]), "main");
    assert_eq!(
        git(temp.path(), &["rev-parse", "feature"]),
        prepared.source_commit
    );
    assert_eq!(
        git(temp.path(), &["rev-parse", "main"]),
        prepared.target_commit
    );
    ensure_workflow_exclusive(&pool, &repository_common_dir(&repo).unwrap(), "")
        .await
        .unwrap();
}

#[tokio::test]
async fn failed_abort_intent_preserves_merge_and_rebase_without_git_mutation() {
    for rebase in [false, true] {
        abort_with_checkpoint_failure(rebase, true).await;
    }
}

#[tokio::test]
async fn abort_confirmation_failure_fences_old_session_and_recovers_merge_and_rebase() {
    for rebase in [false, true] {
        abort_with_checkpoint_failure(rebase, false).await;
    }
}

#[tokio::test]
async fn abort_preserves_an_integration_completed_before_its_checkpoint() {
    let (temp, repo, journal) = fixture(false);
    let pool = database().await;
    let key = workflow_key(&repo, "task-a", "feature", "main").unwrap();
    save_journal(&pool, &key, &journal).await.unwrap();
    fast_forward_repo(&repo, "feature", "main").unwrap();
    let recovered = dispatch_workflow(
        temp.path(),
        GitState::new(),
        pool.clone(),
        temp.path().to_string_lossy().into_owned(),
        "task-a".into(),
        "feature".into(),
        "main".into(),
        "abort".into(),
        None,
        None,
        Some(journal.session.session_id.clone()),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(recovered.status, "integrated");
    assert_eq!(recovered.session_id, journal.session.session_id);
    assert_eq!(
        recovered.integrated_commit,
        Some(journal.session.source_commit)
    );
    let persisted = load_journal(&pool, &key).await.unwrap().unwrap();
    assert!(!persisted.pending_abort);
    validate_integrated_state(&repo, &persisted).unwrap();
}
