// Git Repository Helpers

use git2::{Commit, Diff, DiffOptions, Repository, Status, StatusOptions, Tree};

use crate::core::error::{BackendError, Result};

pub fn get_head_commit(repo: &Repository) -> Result<Option<Commit<'_>>> {
	let head = match repo.head() {
		Ok(head) => head,
		Err(_) => return Ok(None),
	};

	let commit = head
		.peel_to_commit()
		.map_err(|e| BackendError::Git {
			message: e.to_string(),
		})?;
	Ok(Some(commit))
}

pub fn get_branch_name(repo: &Repository) -> Result<Option<String>> {
	let head = match repo.head() {
		Ok(head) => head,
		Err(_) => return Ok(None),
	};

	if head.is_branch() {
		Ok(head
			.shorthand()
			.map(|s| s.to_string())
			.or_else(|| head.name().map(|s| s.to_string())))
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

