use super::*;

pub(super) fn verify_requested_session(
    existing: Option<&GitWorkflowJournal>,
    expected_session_id: Option<&str>,
) -> Result<()> {
    let Some(expected_session_id) = expected_session_id else {
        return Ok(());
    };

    let Some(existing) = existing else {
        return Err(workflow_error(
            "The supplied expected session id refers to a missing Git workflow session.",
        ));
    };

    if existing.session.status == WorkflowStatus::Aborted.as_str() {
        return Err(workflow_error(
            "The supplied expected session id refers to an aborted workflow.",
        ));
    }

    if existing.session.session_id != expected_session_id {
        return Err(workflow_error(
            "The supplied expected session id is stale for this workflow.",
        ));
    }

    Ok(())
}

#[cfg(test)]
#[path = "workflow_session_tests.rs"]
mod tests;
