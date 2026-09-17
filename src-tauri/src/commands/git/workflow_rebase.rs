use super::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RebaseIntent {
    action: String,
    command_path: String,
    original_branch: Option<String>,
}

pub(super) fn prepare_rebase(
    repo: &Repository,
    journal: &GitWorkflowJournal,
) -> Result<GitWorkflowJournal> {
    validate_expected_refs(repo, journal)?;
    ensure_clean(repo)?;
    let root = repo_root(repo)?;
    let branch_worktree =
        super::super::find_worktree_path_for_branch(&root, &journal.session.source_branch)?;
    let command_path = branch_worktree.unwrap_or_else(|| root.clone());
    let command_repo = Repository::open(&command_path)?;
    ensure_clean(&command_repo)?;
    let mut pending = journal.clone();
    pending.pending_rebase = Some(RebaseIntent {
        action: format!(
            "macro-workflow-rebase:{}:{}",
            journal.session.session_id,
            Uuid::new_v4()
        ),
        command_path: command_path.to_string_lossy().into_owned(),
        original_branch: if command_path == root {
            super::super::get_branch_name(repo)?
        } else {
            None
        },
    });
    Ok(pending)
}

pub(super) fn execute_rebase(repo: &Repository, journal: &GitWorkflowJournal) -> Result<()> {
    let intent = journal
        .pending_rebase
        .as_ref()
        .ok_or_else(|| workflow_error("Missing rebase intent."))?;
    validate_expected_refs(repo, journal)?;
    super::super::rebase_branch_repo_with_reflog_action(
        repo,
        &journal.session.source_branch,
        &journal.session.target_branch,
        Some(true),
        Some(&intent.action),
    )?;
    Ok(())
}

pub(super) fn recover_rebase(
    repo: &Repository,
    journal: &GitWorkflowJournal,
    abort: bool,
) -> Result<GitWorkflowJournal> {
    let Some(intent) = journal.pending_rebase.as_ref() else {
        return Ok(journal.clone());
    };
    validate_journal_repository(repo, journal)?;
    let command_repo = Repository::open(&intent.command_path)?;
    validate_journal_repository(&command_repo, journal)?;
    let source = parse_oid(&journal.session.source_commit, "source")?;
    let target = parse_oid(&journal.session.target_commit, "target")?;
    if local_branch_commit(repo, &journal.session.target_branch)? != target {
        return Err(workflow_error(
            "Rebase recovery refused because the target branch changed.",
        ));
    }

    if command_repo.state() != RepositoryState::Clean {
        // An interrupted Git subprocess may leave rebase metadata behind. Only
        // the exact recorded operation may be aborted, including after restart.
        let metadata = command_repo.path().join("rebase-merge");
        let read = |name: &str| {
            std::fs::read_to_string(metadata.join(name)).map(|value| value.trim().to_owned())
        };
        let expected_head = format!("refs/heads/{}", journal.session.source_branch);
        let own_reflog = command_repo.reflog("HEAD").ok().is_some_and(|log| {
            log.get(0).is_some_and(|entry| {
                entry
                    .message()
                    .ok()
                    .flatten()
                    .is_some_and(|message| message.starts_with(&format!("{} ", intent.action)))
            })
        });
        if read("orig-head").ok().as_deref() != Some(journal.session.source_commit.as_str())
            || read("onto").ok().as_deref() != Some(journal.session.target_commit.as_str())
            || read("head-name").ok().as_deref() != Some(expected_head.as_str())
            || !own_reflog
        {
            return Err(workflow_error(
                "Rebase recovery refused an unrelated Git operation.",
            ));
        }
        if !abort {
            return Err(workflow_error(
                "The recorded rebase was interrupted. Abort this workflow before retrying.",
            ));
        }
        validate_source_ref(repo, journal)?;
        let output = super::super::run_git_command(
            Path::new(&intent.command_path),
            &["rebase".into(), "--abort".into()],
        )?;
        if !output.success {
            return Err(workflow_error(command_output_text(&output)));
        }
    }

    let actual = local_branch_commit(repo, &journal.session.source_branch)?;
    if actual != source {
        // A session-specific reflog record is the proof of this rewrite. An
        // arbitrary descendant of the target must never be adopted as a rebase.
        let reference = format!("refs/heads/{}", journal.session.source_branch);
        let log = repo.reflog(&reference)?;
        let entry = log
            .get(0)
            .ok_or_else(|| workflow_error("Rebase recovery has no source reflog proof."))?;
        let expected_message = format!("{} (finish): {} onto {}", intent.action, reference, target);
        if entry.id_old() != source
            || entry.id_new() != actual
            || entry.message()? != Some(expected_message.as_str())
            || (actual != target && !repo.graph_descendant_of(actual, target)?)
        {
            return Err(workflow_error(
                "Rebase recovery refused an unproven source rewrite.",
            ));
        }
    }
    ensure_clean(&command_repo)?;
    if let Some(original) = intent.original_branch.as_deref() {
        if super::super::get_branch_name(&command_repo)?.as_deref()
            == Some(journal.session.source_branch.as_str())
            && original != journal.session.source_branch
        {
            super::super::checkout_repo(&command_repo, original, false)?;
        }
    }
    let mut recovered = replace_session(
        journal,
        Some(actual.to_string()),
        Some(WorkflowStatus::Prepared),
        Some(None),
        Some("Recovered the journaled rebase; integration may continue.".into()),
    );
    recovered.pending_rebase = None;
    Ok(recovered)
}

#[cfg(test)]
#[path = "workflow_rebase_tests.rs"]
mod tests;
