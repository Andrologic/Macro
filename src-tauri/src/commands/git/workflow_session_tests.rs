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
fn rejects_s1_after_abort_and_accepts_new_s2() {
    let s1 = journal("s1", WorkflowStatus::Aborted.as_str());
    let s2 = journal("s2", WorkflowStatus::Prepared.as_str());

    assert!(verify_requested_session(Some(&s1), Some("s1")).is_err());
    assert!(verify_requested_session(Some(&s2), Some("s1")).is_err());
    assert!(verify_requested_session(Some(&s2), Some("s2")).is_ok());
}

#[test]
fn rejects_supplied_id_without_a_durable_session() {
    assert!(verify_requested_session(None, Some("s1")).is_err());
}

#[test]
fn preserves_compatibility_without_a_supplied_id() {
    assert!(verify_requested_session(None, None).is_ok());
}
