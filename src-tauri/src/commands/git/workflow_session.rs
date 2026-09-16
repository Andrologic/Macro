use super::*;

pub(super) fn verify_requested_session(
    existing: Option<&GitWorkflowJournal>,
    expected_session_id: Option<&str>,
    action: &str,
) -> Result<()> {
    let Some(expected_session_id) = expected_session_id else {
        if existing.is_some() && action != "inspect" {
            return Err(workflow_error(
                "An existing Git workflow requires its expected session id before mutation.",
            ));
        }
        return Ok(());
    };

    let Some(existing) = existing else {
        return Err(workflow_error(
            "The supplied expected session id refers to a missing Git workflow session.",
        ));
    };

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
