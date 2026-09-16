use super::*;

pub(super) fn prepare_abort(
    repo: &Repository,
    journal: &GitWorkflowJournal,
) -> Result<GitWorkflowJournal> {
    validate_journal_repository(repo, journal)?;
    // This inspection changes no Git state. An integration already completed
    // before its checkpoint must stay recoverable, rather than get stuck in an
    // abort intent that can no longer match the original target.
    let mut pending = if journal.pending_rebase.is_none() {
        inspect_or_recover(repo, journal)?
    } else {
        journal.clone()
    };
    if pending.session.status == WorkflowStatus::Integrated.as_str() {
        return Ok(pending);
    }
    pending.session.session_id = Uuid::new_v4().to_string();
    pending.pending_abort = true;
    Ok(pending)
}

pub(super) fn recover_abort(
    repo: &Repository,
    pending: &GitWorkflowJournal,
) -> Result<GitWorkflowJournal> {
    validate_journal_repository(repo, pending)?;
    let journal = rebase::recover_rebase(repo, pending, true)?;
    if verify_exact_incomplete_merge(
        repo,
        &journal.session.target_branch,
        &journal.session.target_commit,
        &journal.session.source_commit,
    )? {
        validate_source_ref(repo, &journal)?;
        abort_exact_incomplete_merge(
            repo,
            &journal.session.target_branch,
            &journal.session.target_commit,
            &journal.session.source_commit,
        )?;
    } else {
        if repo.state() != RepositoryState::Clean {
            return Err(workflow_error(
                "Refusing to abort an unrelated Git operation.",
            ));
        }
        validate_expected_refs(repo, &journal)?;
    }
    let mut aborted = replace_session(
        &journal,
        None,
        Some(WorkflowStatus::Aborted),
        Some(None),
        Some("Git workflow aborted.".to_string()),
    );
    aborted.pending_abort = false;
    Ok(aborted)
}

#[cfg(test)]
#[path = "workflow_abort_tests.rs"]
mod tests;
