use super::*;
use crate::core::process::background_command;
use std::fs;
use tempfile::TempDir;

fn git(path: &Path, args: &[&str]) -> String {
    let output = background_command("git")
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

fn fixture() -> (TempDir, Repository, GitWorkflowJournal) {
    let temp = TempDir::new().unwrap();
    git(temp.path(), &["init", "-b", "main"]);
    git(temp.path(), &["config", "user.name", "Rebase test"]);
    git(
        temp.path(),
        &["config", "user.email", "rebase@example.test"],
    );
    fs::write(temp.path().join("base"), "base").unwrap();
    git(temp.path(), &["add", "."]);
    git(temp.path(), &["commit", "-m", "base"]);
    git(temp.path(), &["checkout", "-b", "feature"]);
    fs::write(temp.path().join("source"), "source").unwrap();
    git(temp.path(), &["add", "."]);
    git(temp.path(), &["commit", "-m", "source"]);
    git(temp.path(), &["checkout", "main"]);
    fs::write(temp.path().join("target"), "target").unwrap();
    git(temp.path(), &["add", "."]);
    git(temp.path(), &["commit", "-m", "target"]);
    let repo = Repository::open(temp.path()).unwrap();
    let journal = initial_session(&repo, temp.path(), "task", "feature", "main").unwrap();
    (temp, repo, journal)
}

#[tokio::test]
async fn durable_rebase_intent_recovers_crash_after_rewrite_before_checkpoint() {
    let (temp, repo, journal) = fixture();
    let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
    sqlx::query("CREATE TABLE app_settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL)")
        .execute(&pool).await.unwrap();
    let key = workflow_key(&repo, "task", "feature", "main").unwrap();
    let pending = prepare_rebase(&repo, &journal).unwrap();
    save_journal(&pool, &key, &pending).await.unwrap();
    execute_rebase(&repo, &pending).unwrap();
    let rewritten = git(temp.path(), &["rev-parse", "feature"]);
    assert_ne!(rewritten, journal.session.source_commit);
    // Simulate process loss before the source checkpoint reaches SQLite.
    drop(repo);
    let repo = Repository::open(temp.path()).unwrap();
    let persisted = load_journal(&pool, &key).await.unwrap().unwrap();
    assert_eq!(
        persisted.session.source_commit,
        journal.session.source_commit
    );
    let recovered = recover_rebase(&repo, &persisted, false).unwrap();
    assert_eq!(recovered.session.source_commit, rewritten);
    assert!(recovered.pending_rebase.is_none());
    inspect_or_recover(&repo, &recovered).unwrap();
    validate_expected_refs(&repo, &recovered).unwrap(); // abort remains possible
    save_journal(&pool, &key, &recovered).await.unwrap();
    fast_forward_repo(&repo, "feature", "main").unwrap();
    let integrated = inspect_or_recover(&repo, &recovered).unwrap();
    assert_eq!(integrated.session.status, "integrated");
    assert!(repo
        .find_commit(parse_oid(&rewritten, "source").unwrap())
        .unwrap()
        .tree()
        .unwrap()
        .get_name("source")
        .is_some());
}

#[test]
fn rebase_recovery_refuses_a_later_source_commit_or_external_rewrite() {
    for own_rebase in [true, false] {
        let (temp, repo, journal) = fixture();
        let pending = prepare_rebase(&repo, &journal).unwrap();
        if own_rebase {
            execute_rebase(&repo, &pending).unwrap();
            git(temp.path(), &["checkout", "feature"]);
            git(
                temp.path(),
                &["commit", "--allow-empty", "-m", "later work"],
            );
        } else {
            git(temp.path(), &["checkout", "feature"]);
            git(temp.path(), &["rebase", "main"]);
        }
        let source = git(temp.path(), &["rev-parse", "feature"]);
        assert!(recover_rebase(&repo, &pending, false).is_err());
        assert!(recover_rebase(&repo, &pending, true).is_err());
        assert_eq!(git(temp.path(), &["rev-parse", "feature"]), source);
    }
}

#[test]
fn rebase_intent_before_command_is_safe_to_retry_or_abort() {
    let (_temp, repo, journal) = fixture();
    let pending = prepare_rebase(&repo, &journal).unwrap();
    for abort in [false, true] {
        let recovered = recover_rebase(&repo, &pending, abort).unwrap();
        assert_eq!(
            recovered.session.source_commit,
            journal.session.source_commit
        );
        assert!(recovered.pending_rebase.is_none());
        validate_expected_refs(&repo, &recovered).unwrap();
    }
}

#[test]
fn interrupted_owned_rebase_can_be_aborted_but_foreign_rebase_is_preserved() {
    for owned in [true, false] {
        let (temp, repo, _) = fixture();
        git(temp.path(), &["checkout", "feature"]);
        fs::write(temp.path().join("base"), "source edit").unwrap();
        git(temp.path(), &["commit", "-am", "source conflict"]);
        git(temp.path(), &["checkout", "main"]);
        fs::write(temp.path().join("base"), "target edit").unwrap();
        git(temp.path(), &["commit", "-am", "target conflict"]);
        let journal = initial_session(&repo, temp.path(), "task", "feature", "main").unwrap();
        let pending = prepare_rebase(&repo, &journal).unwrap();
        git(temp.path(), &["checkout", "feature"]);
        let mut command = background_command("git");
        command
            .arg("-C")
            .arg(temp.path())
            .args(["rebase", "--merge", "main"]);
        if owned {
            command.env(
                "GIT_REFLOG_ACTION",
                &pending.pending_rebase.as_ref().unwrap().action,
            );
        }
        assert!(!command.output().unwrap().status.success());
        assert!(recover_rebase(&repo, &pending, false).is_err());
        let result = recover_rebase(&repo, &pending, true);
        if owned {
            let recovered = result.unwrap();
            assert!(recovered.pending_rebase.is_none());
            validate_expected_refs(&repo, &recovered).unwrap();
            assert_eq!(repo.state(), RepositoryState::Clean);
            assert_eq!(git(temp.path(), &["branch", "--show-current"]), "main");
        } else {
            assert!(result.is_err());
            assert!(repo.path().join("rebase-merge").exists());
        }
    }
}
