// Git Repository Helpers

use git2::{Commit, Diff, DiffOptions, Repository, Status, StatusOptions, Tree};

use crate::core::error::{BackendError, Result};

pub fn get_head_commit(repo: &Repository) -> Result<Option<Commit<'_>>> {
    let head = match repo.head() {
        Ok(head) => head,
        Err(error) if error.code() == git2::ErrorCode::UnbornBranch => return Ok(None),
        Err(error) => return Err(error.into()),
    };

    let target = head.target().map(|oid| oid.to_string());
    let commit = head.peel_to_commit().map_err(|error| {
        BackendError::git_object_missing(error, target, Some("head_commit".to_string()))
    })?;
    Ok(Some(commit))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn unborn_head_is_the_only_missing_head_treated_as_empty() {
        let temp = TempDir::new().expect("temporary repository");
        let repo = Repository::init(temp.path()).expect("initialize repository");
        assert!(get_head_commit(&repo).expect("unborn repository").is_none());

        fs::remove_file(repo.path().join("HEAD")).expect("remove HEAD reference");
        assert!(
            get_head_commit(&repo).is_err(),
            "a missing HEAD reference must not look like an empty repository"
        );
    }
}

pub fn get_branch_name(repo: &Repository) -> Result<Option<String>> {
    let head = match repo.head() {
        Ok(head) => head,
        Err(_) => return Ok(None),
    };

    if head.is_branch() {
        Ok(head
            .shorthand()
            .or_else(|_| head.name())
            .ok()
            .map(str::to_string))
    } else {
        Ok(None)
    }
}

pub fn get_status_options() -> StatusOptions {
    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false)
        .include_unmodified(false)
        .renames_head_to_index(true)
        .renames_index_to_workdir(true)
        .renames_from_rewrites(true)
        .include_unreadable(true);
    opts
}

pub fn get_status(repo: &Repository) -> Result<Status> {
    let statuses = repo.statuses(Some(&mut get_status_options()))?;
    let mut summary = Status::CURRENT;
    for entry in statuses.iter() {
        summary |= entry.status();
    }
    Ok(summary)
}

#[allow(dead_code)]
pub fn get_diff<'repo>(
    repo: &'repo Repository,
    old_tree: Option<&'repo Tree<'repo>>,
    new_tree: Option<&'repo Tree<'repo>>,
) -> Result<Diff<'repo>> {
    let mut opts = DiffOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_unmodified(false);

    repo.diff_tree_to_tree(old_tree, new_tree, Some(&mut opts))
        .map_err(|e| BackendError::Git {
            message: e.to_string(),
        })
}
