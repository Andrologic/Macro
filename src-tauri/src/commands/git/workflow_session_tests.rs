use super::*;

fn journal(session_id: &str, status: &str) -> GitWorkflowJournal {
    GitWorkflowJournal {
        session: GitWorkflowSessionDto {
            session_id: session_id.to_string(),
            task_id: "task-a".to_string(),
            source_branch: "feature".to_string(),
            target_branch: "main".to_string(),
            source_commit: "source-commit".to_string(),
            target_commit: "target-commit".to_string(),
            integrated_commit: None,
            status: status.to_string(),
            output: String::new(),
        },
        repo_path: "workflow-test".to_string(),
        common_dir: "workflow-test/.git".to_string(),
        pending_rebase: None,
    }
}

#[test]
fn mutations_require_current_s2_identity_after_s1_was_abandoned() {
    let s2 = journal("s2", WorkflowStatus::Prepared.as_str());
    for action in [
        "prepare",
        "start",
        "adopt_plan",
        "merge_commit",
        "fast_forward",
        "rebase_then_continue",
        "no_changes",
        "complete",
        "abort",
        "cleanup",
    ] {
        assert!(
            verify_requested_session(Some(&s2), None, action).is_err(),
            "{action} omitted identity"
        );
        assert!(
            verify_requested_session(Some(&s2), Some("s1"), action).is_err(),
            "{action} stale identity"
        );
        assert!(verify_requested_session(Some(&s2), Some("s2"), action).is_ok());
    }
}

#[test]
fn rejects_supplied_id_without_a_durable_session() {
    assert!(verify_requested_session(None, Some("s1"), "start").is_err());
}

#[test]
fn allows_initial_creation_and_inspection_without_an_id() {
    assert!(verify_requested_session(None, None, "start").is_ok());
    assert!(verify_requested_session(Some(&journal("s2", "prepared")), None, "inspect").is_ok());
}
