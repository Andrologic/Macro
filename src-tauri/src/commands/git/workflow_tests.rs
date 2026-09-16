use super::*;
use std::{fs, process::Command};
use tempfile::TempDir;

fn git(path: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

fn fixture(diverged: bool) -> (TempDir, Repository, GitWorkflowJournal) {
    let temp = TempDir::new().unwrap();
    git(temp.path(), &["init", "-b", "main"]);
    git(temp.path(), &["config", "user.name", "Workflow test"]);
    git(
        temp.path(),
        &["config", "user.email", "workflow@example.test"],
    );
    fs::write(temp.path().join("file.txt"), "base\n").unwrap();
    git(temp.path(), &["add", "."]);
    git(temp.path(), &["commit", "-m", "base"]);
    git(temp.path(), &["checkout", "-b", "feature"]);
    fs::write(temp.path().join("file.txt"), "source\n").unwrap();
    git(temp.path(), &["commit", "-am", "source"]);
    git(temp.path(), &["checkout", "main"]);
    if diverged {
        fs::write(temp.path().join("file.txt"), "target\n").unwrap();
        git(temp.path(), &["commit", "-am", "target"]);
    }
    let repo = Repository::open(temp.path()).unwrap();
    let journal = initial_session(&repo, temp.path(), "task-a", "feature", "main").unwrap();
    (temp, repo, journal)
}

fn identity(journal: &GitWorkflowJournal) -> GitWorkflowSessionIdentity {
    GitWorkflowSessionIdentity {
        task_id: journal.session.task_id.clone(),
        session_id: journal.session.session_id.clone(),
        source_branch: journal.session.source_branch.clone(),
        target_branch: journal.session.target_branch.clone(),
    }
}

async fn database() -> SqlitePool {
    let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
    sqlx::query("CREATE TABLE app_settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL)")
        .execute(&pool).await.unwrap();
    pool
}

#[tokio::test]
async fn abort_retires_prepared_session_before_any_stale_restart_or_merge() {
    for action in [
        "start",
        "no_changes",
        "merge_commit",
        "fast_forward",
        "prepare",
    ] {
        let (temp, repo, _) = fixture(false);
        let pool = database().await;
        let state = GitState::new();
        let request = |action: &str, expected_session_id: Option<String>| {
            dispatch_workflow(
                temp.path(),
                state.clone(),
                pool.clone(),
                temp.path().to_string_lossy().into_owned(),
                "task-a".to_string(),
                "feature".to_string(),
                "main".to_string(),
                action.to_string(),
                None,
                None,
                expected_session_id,
            )
        };
        let prepared = request("prepare", None).await.unwrap().unwrap();
        let aborted = request("abort", Some(prepared.session_id.clone()))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(aborted.status, "aborted");
        assert_ne!(aborted.session_id, prepared.session_id);
        let index_before = fs::read(repo.path().join("index")).unwrap();
        let file_before = fs::read(temp.path().join("file.txt")).unwrap();

        let error = request(action, Some(prepared.session_id.clone()))
            .await
            .expect_err("a command captured before abort must remain stale");
        assert!(error.to_string().contains("stale"), "{action}: {error}");
        assert_eq!(request("inspect", None).await.unwrap().unwrap(), aborted);
        assert_eq!(
            local_branch_commit(&repo, "main").unwrap().to_string(),
            prepared.target_commit
        );
        assert_eq!(
            local_branch_commit(&repo, "feature").unwrap().to_string(),
            prepared.source_commit
        );
        assert_eq!(repo.state(), RepositoryState::Clean);
        assert_eq!(fs::read(repo.path().join("index")).unwrap(), index_before);
        assert_eq!(fs::read(temp.path().join("file.txt")).unwrap(), file_before);

        // A caller that has observed the post-abort receipt can deliberately
        // prepare a new session and then integrate it using its new identity.
        let restarted = request("prepare", Some(aborted.session_id))
            .await
            .unwrap()
            .unwrap();
        assert_ne!(restarted.session_id, prepared.session_id);
        assert_eq!(restarted.status, "prepared");
        let integrated = request("fast_forward", Some(restarted.session_id))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(integrated.status, "integrated");
    }
}

#[test]
fn recovers_merge_and_fast_forward_before_checkpoint_then_accepts_partial_cleanup() {
    for merge_commit in [false, true] {
        let (temp, repo, prepared) = fixture(false);
        if merge_commit {
            merge_repo(&repo, "feature", "main").unwrap();
        } else {
            fast_forward_repo(&repo, "feature", "main").unwrap();
        }
        let integrated = inspect_or_recover(&repo, &prepared).unwrap();
        assert_eq!(integrated.session.status, "integrated");
        assert_eq!(
            integrated.session.integrated_commit.as_deref(),
            Some(git(temp.path(), &["rev-parse", "main"]).as_str())
        );
        git(
            temp.path(),
            &["commit", "--allow-empty", "-m", "later target work"],
        );
        validate_integrated_state(&repo, &integrated).unwrap();
        git(temp.path(), &["branch", "-D", "feature"]);
        validate_integrated_state(&repo, &integrated).unwrap();
        git(temp.path(), &["branch", "feature", "main"]);
        assert!(validate_integrated_state(&repo, &integrated).is_err());
    }
}

#[test]
fn rejects_target_divergence_and_different_repository_with_matching_commits() {
    let (temp, repo, prepared) = fixture(false);
    fast_forward_repo(&repo, "feature", "main").unwrap();
    let integrated = inspect_or_recover(&repo, &prepared).unwrap();
    git(
        temp.path(),
        &["reset", "--hard", &prepared.session.target_commit],
    );
    assert!(validate_integrated_state(&repo, &integrated).is_err());
    let clone = TempDir::new().unwrap();
    let output = Command::new("git")
        .args(["clone", "--quiet"])
        .arg(temp.path())
        .arg(clone.path())
        .output()
        .unwrap();
    assert!(output.status.success());
    let replacement = Repository::open(clone.path()).unwrap();
    assert!(validate_journal_repository(&replacement, &prepared).is_err());
}

#[test]
fn conflict_access_rejects_wrong_task_session_and_advanced_source_without_touching_index() {
    let (temp, repo, journal) = fixture(true);
    let started = start_merge_resolution_repo(&repo, "feature", "main").unwrap();
    assert_eq!(started.status, "conflicted");
    let before = fs::read(repo.path().join("index")).unwrap();
    let file = fs::read(temp.path().join("file.txt")).unwrap();
    verify_conflict_session(&repo, &journal, &identity(&journal)).unwrap();
    let mut wrong = identity(&journal);
    wrong.task_id = "task-b".into();
    assert!(verify_conflict_session(&repo, &journal, &wrong).is_err());
    wrong = identity(&journal);
    wrong.session_id = "stale-session".into();
    assert!(verify_conflict_session(&repo, &journal, &wrong).is_err());
    let source = repo
        .find_commit(Oid::from_str(&journal.session.source_commit).unwrap())
        .unwrap();
    let sig = repo.signature().unwrap();
    repo.commit(
        Some("refs/heads/feature"),
        &sig,
        &sig,
        "new source",
        &source.tree().unwrap(),
        &[&source],
    )
    .unwrap();
    assert!(verify_conflict_session(&repo, &journal, &identity(&journal)).is_err());
    assert_eq!(fs::read(repo.path().join("index")).unwrap(), before);
    assert_eq!(fs::read(temp.path().join("file.txt")).unwrap(), file);
}

#[test]
fn foreign_merge_is_not_adopted_or_aborted_by_a_prepared_session() {
    let (temp, repo, journal) = fixture(true);
    git(temp.path(), &["checkout", "-b", "foreign"]);
    fs::write(temp.path().join("file.txt"), "foreign\n").unwrap();
    git(temp.path(), &["commit", "-am", "foreign"]);
    git(temp.path(), &["checkout", "main"]);
    start_merge_resolution_repo(&repo, "feature", "main").unwrap();
    // A different incoming OID must be refused even if HEAD still matches.
    fs::write(
        repo.path().join("MERGE_HEAD"),
        format!("{}\n", git(temp.path(), &["rev-parse", "foreign"])),
    )
    .unwrap();
    let index = fs::read(repo.path().join("index")).unwrap();
    let merge_head = fs::read(repo.path().join("MERGE_HEAD")).unwrap();
    assert!(inspect_or_recover(&repo, &journal).is_err());
    assert!(verify_conflict_session(&repo, &journal, &identity(&journal)).is_err());
    assert_eq!(fs::read(repo.path().join("index")).unwrap(), index);
    assert_eq!(
        fs::read(repo.path().join("MERGE_HEAD")).unwrap(),
        merge_head
    );
}

#[test]
fn owned_staged_deletion_survives_completion_and_receipt_recovery() {
    let (temp, repo, mut journal) = fixture(true);
    // Replace the source tip with a deletion to create a modify/delete conflict.
    git(temp.path(), &["checkout", "feature"]);
    git(temp.path(), &["rm", "file.txt"]);
    git(temp.path(), &["commit", "-m", "delete"]);
    git(temp.path(), &["checkout", "main"]);
    journal.session.source_commit = git(temp.path(), &["rev-parse", "feature"]);
    start_merge_resolution_repo(&repo, "feature", "main").unwrap();
    verify_conflict_session(&repo, &journal, &identity(&journal)).unwrap();
    super::super::accept_git_conflict_side(&repo, temp.path(), Path::new("file.txt"), "theirs")
        .unwrap();
    assert!(!temp.path().join("file.txt").exists());
    complete_merge_repo(&repo).unwrap();
    let recovered = inspect_or_recover(&repo, &journal).unwrap();
    assert_eq!(recovered.session.status, "integrated");
    assert!(repo
        .head()
        .unwrap()
        .peel_to_commit()
        .unwrap()
        .tree()
        .unwrap()
        .get_path(Path::new("file.txt"))
        .is_err());
}

#[tokio::test]
async fn durable_preparation_excludes_other_tasks_even_before_git_changes() {
    let (_temp, repo, journal) = fixture(false);
    let pool = database().await;
    let common = repository_common_dir(&repo).unwrap();
    let key_a = workflow_key(&repo, "task-a", "feature", "main").unwrap();
    let key_b = workflow_key(&repo, "task-b", "feature", "main").unwrap();
    save_journal(&pool, &key_a, &journal).await.unwrap();
    ensure_workflow_exclusive(&pool, &common, &key_a)
        .await
        .unwrap();
    assert!(ensure_workflow_exclusive(&pool, &common, &key_b)
        .await
        .is_err());
    // Legacy conflict/complete/abort entry points pass no owner key. They must
    // refuse an owned merge instead of silently bypassing its session guard.
    assert!(ensure_workflow_exclusive(&pool, &common, "").await.is_err());
    // A restarted caller reads the same durable owner.
    let recovered = load_journal(&pool, &key_a).await.unwrap().unwrap();
    assert_eq!(recovered.session.session_id, journal.session.session_id);
    let aborted = replace_session(&journal, None, Some(WorkflowStatus::Aborted), None, None);
    save_journal(&pool, &key_a, &aborted).await.unwrap();
    ensure_workflow_exclusive(&pool, &common, &key_b)
        .await
        .unwrap();
    ensure_workflow_exclusive(&pool, &common, "").await.unwrap();
}
