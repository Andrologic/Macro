use super::*;
use crate::core::process::background_command;
use std::{fs, path::PathBuf};
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

fn fixture() -> (TempDir, Repository, GitState, GitWorkflowJournal, PathBuf) {
    let temp = TempDir::new().unwrap();
    git(temp.path(), &["init", "-b", "main"]);
    git(temp.path(), &["config", "user.name", "Cleanup test"]);
    git(
        temp.path(),
        &["config", "user.email", "cleanup@example.test"],
    );
    fs::write(temp.path().join("file"), "base").unwrap();
    git(temp.path(), &["add", "."]);
    git(temp.path(), &["commit", "-m", "base"]);
    git(temp.path(), &["checkout", "-b", "feature"]);
    fs::write(temp.path().join("file"), "source").unwrap();
    git(temp.path(), &["commit", "-am", "source"]);
    git(temp.path(), &["checkout", "main"]);
    let repo = Repository::open(temp.path()).unwrap();
    let journal = initial_session(&repo, temp.path(), "task", "feature", "main").unwrap();
    fast_forward_repo(&repo, "feature", "main").unwrap();
    let journal = inspect_or_recover(&repo, &journal).unwrap();
    let state = GitState::new();
    let worktree = state
        .ensure_task_worktree(&repo, "cleanup", "feature", None, None, &[])
        .unwrap()
        .worktree_path;
    (temp, repo, state, journal, worktree)
}

fn identity(journal: &GitWorkflowJournal) -> GitWorkflowSessionIdentity {
    GitWorkflowSessionIdentity {
        task_id: journal.session.task_id.clone(),
        session_id: journal.session.session_id.clone(),
        source_branch: journal.session.source_branch.clone(),
        target_branch: journal.session.target_branch.clone(),
    }
}

#[test]
fn cleanup_refuses_target_rewrite_after_frontend_inspection_without_removing_resources() {
    let (temp, repo, state, journal, worktree) = fixture();
    validate_integrated_state(&repo, &journal).unwrap();
    git(
        temp.path(),
        &[
            "update-ref",
            "refs/heads/main",
            &journal.session.target_commit,
        ],
    );
    assert!(cleanup_integrated_repo(
        &repo,
        &state,
        &journal,
        &identity(&journal),
        "cleanup",
        false,
        worktree.to_str()
    )
    .is_err());
    assert!(worktree.exists());
    assert_eq!(
        local_branch_commit(&repo, "feature").unwrap().to_string(),
        journal.session.source_commit
    );
}

#[test]
fn cleanup_locks_target_against_external_rewrite_then_removes_source_idempotently() {
    let (temp, repo, state, journal, worktree) = fixture();
    let transaction = lock_cleanup_refs(&repo, &journal).unwrap();
    let output = background_command("git")
        .arg("-C")
        .arg(temp.path())
        .args([
            "update-ref",
            "refs/heads/main",
            &journal.session.target_commit,
        ])
        .output()
        .unwrap();
    assert!(!output.status.success());
    verify_cleanup_session(&repo, &journal, &identity(&journal)).unwrap();
    drop(transaction);
    for _ in 0..2 {
        cleanup_integrated_repo(
            &repo,
            &state,
            &journal,
            &identity(&journal),
            "cleanup",
            false,
            worktree.to_str(),
        )
        .unwrap();
    }
    assert!(!worktree.exists());
    assert!(repo
        .find_branch("feature", git2::BranchType::Local)
        .is_err());
    assert_eq!(
        local_branch_commit(&repo, "main").unwrap().to_string(),
        journal.session.integrated_commit.unwrap()
    );
}

#[test]
fn cleanup_preserves_dirty_worktree_and_changed_source() {
    for changed_source in [false, true] {
        let (_temp, repo, state, journal, worktree) = fixture();
        fs::write(worktree.join("file"), "new work").unwrap();
        if changed_source {
            git(&worktree, &["commit", "-am", "later source"]);
        }
        assert!(cleanup_integrated_repo(
            &repo,
            &state,
            &journal,
            &identity(&journal),
            "cleanup",
            false,
            worktree.to_str()
        )
        .is_err());
        assert_eq!(
            fs::read_to_string(worktree.join("file")).unwrap(),
            "new work"
        );
        assert!(repo.find_branch("feature", git2::BranchType::Local).is_ok());
    }
}

#[test]
fn cleanup_recovers_missing_directory_but_preserves_unique_staged_admin_data() {
    for staged in [false, true] {
        let (_temp, repo, state, journal, worktree) = fixture();
        if staged {
            fs::write(worktree.join("file"), "unique staged data").unwrap();
            git(&worktree, &["add", "file"]);
        }
        fs::remove_dir_all(&worktree).unwrap();
        let result = cleanup_integrated_repo(
            &repo,
            &state,
            &journal,
            &identity(&journal),
            "cleanup",
            false,
            worktree.to_str(),
        );
        if staged {
            assert!(result.is_err());
            assert!(repo.find_worktree("taskcleanup").is_ok());
            assert!(repo.find_branch("feature", git2::BranchType::Local).is_ok());
        } else {
            result.unwrap();
            assert!(repo.find_worktree("taskcleanup").is_err());
            assert!(repo
                .find_branch("feature", git2::BranchType::Local)
                .is_err());
        }
    }
}

#[test]
fn remote_lease_failure_preserves_local_source_and_cleanup_can_resume() {
    let (temp, repo, state, journal, worktree) = fixture();
    let remote = TempDir::new().unwrap();
    git(remote.path(), &["init", "--bare"]);
    git(
        temp.path(),
        &["remote", "add", "origin", remote.path().to_str().unwrap()],
    );
    git(temp.path(), &["push", "origin", "feature"]);
    git(
        remote.path(),
        &[
            "--git-dir=.",
            "update-ref",
            "refs/heads/feature",
            &journal.session.target_commit,
        ],
    );
    assert!(cleanup_integrated_repo_with_network(
        &repo,
        &state,
        &journal,
        &identity(&journal),
        "cleanup",
        true,
        worktree.to_str(),
        super::super::super::run_git_command
    )
    .is_err());
    assert!(!worktree.exists());
    assert!(repo.find_branch("feature", git2::BranchType::Local).is_ok());
    assert_eq!(
        git(remote.path(), &["--git-dir=.", "rev-parse", "feature"]),
        journal.session.target_commit
    );
    git(
        remote.path(),
        &[
            "--git-dir=.",
            "update-ref",
            "refs/heads/feature",
            &journal.session.source_commit,
        ],
    );
    for _ in 0..2 {
        cleanup_integrated_repo_with_network(
            &repo,
            &state,
            &journal,
            &identity(&journal),
            "cleanup",
            true,
            worktree.to_str(),
            super::super::super::run_git_command,
        )
        .unwrap();
    }
    assert!(repo
        .find_branch("feature", git2::BranchType::Local)
        .is_err());
    assert!(git(
        remote.path(),
        &["--git-dir=.", "for-each-ref", "refs/heads/feature"]
    )
    .is_empty());
}

#[test]
fn cleanup_network_timeout_releases_both_ref_locks_and_preserves_source() {
    for timeout_during_push in [false, true] {
        let (_temp, repo, state, journal, worktree) = fixture();
        repo.remote("origin", "https://example.invalid/repository.git")
            .unwrap();
        let started = std::time::Instant::now();
        let error = cleanup_integrated_repo_with_network(
            &repo,
            &state,
            &journal,
            &identity(&journal),
            "cleanup",
            true,
            worktree.to_str(),
            |root, args| {
                assert!(lock_cleanup_refs(&repo, &journal).is_err());
                if timeout_during_push && args[0] == "ls-remote" {
                    return Ok(super::super::super::GitCommandOutput {
                        success: true,
                        code: Some(0),
                        stderr: String::new(),
                        stdout: format!("{}\trefs/heads/feature\n", journal.session.source_commit),
                    });
                }
                super::super::super::run_git_command_with_timeout(
                    root,
                    &[
                        "-c".into(),
                        "alias.macro-timeout=!sh -c 'sleep 30 & wait'".into(),
                        "macro-timeout".into(),
                    ],
                    std::time::Duration::from_millis(200),
                )
            },
        )
        .unwrap_err();
        assert!(error.to_string().contains("timed out"));
        assert!(started.elapsed() < std::time::Duration::from_secs(4));
        assert_eq!(
            local_branch_commit(&repo, "feature").unwrap().to_string(),
            journal.session.source_commit
        );
        lock_cleanup_refs(&repo, &journal).expect("timeout must release both transaction locks");
    }
}
