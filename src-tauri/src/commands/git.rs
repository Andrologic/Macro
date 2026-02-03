// Git Commands

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use git2::{BranchType, Commit, DiffFormat, Oid, Repository, Status, StatusEntry};
use serde::Serialize;
use tauri::State;

use crate::core::error::{BackendError, Result};
use crate::fs::validate_path;
use crate::git::repo::{get_branch_name, get_diff, get_head_commit, get_status, get_status_options};
use crate::git::GitState;

const DEFAULT_LOG_LIMIT: usize = 50;

#[derive(Serialize)]
pub struct GitStatusDto {
	pub branch: String,
	pub head_commit: Option<GitCommitDto>,
	pub staged_files: Vec<GitFileStatus>,
	pub unstaged_files: Vec<GitFileStatus>,
	pub untracked_files: Vec<GitFileStatus>,
	pub is_clean: bool,
}

#[derive(Serialize)]
pub struct GitFileStatus {
	pub path: String,
	pub status: String,
	pub old_path: Option<String>,
}

#[derive(Serialize)]
pub struct GitCommitDto {
	pub id: String,
	pub hash: String,
	pub message: String,
	pub author: String,
	pub date: String,
	pub status: String,
	pub task_id: Option<String>,
}

#[derive(Serialize)]
pub struct GitBranchesDto {
	pub local: Vec<GitBranch>,
	pub remote: Vec<GitBranch>,
	pub current: Option<String>,
}

#[derive(Serialize)]
pub struct GitBranch {
	pub name: String,
	pub is_head: bool,
	pub commit: String,
}

#[derive(Serialize)]
pub struct PredictedGitTreeDto {
	pub branch: String,
	pub structure: Vec<GitNode>,
	pub modified_files_count: u32,
}

#[derive(Serialize, Clone)]
pub struct GitNode {
	pub name: String,
	pub path: String,
	#[serde(rename = "type")]
	pub node_type: String,
	pub status: Option<String>,
	pub children: Option<Vec<GitNode>>,
	pub hash: Option<String>,
}

fn to_join_error(err: tokio::task::JoinError) -> BackendError {
	BackendError::Internal {
		message: format!("Git task join error: {}", err),
	}
}

fn validate_repo_path(repo_path: &str, workspace: &PathBuf) -> Result<PathBuf> {
	let validated = validate_path(Path::new(repo_path), workspace)?;
	for component in validated.components() {
		if let std::path::Component::Normal(part) = component {
			if part == ".git" {
				return Err(BackendError::GitRepositoryNotFound {
					message: "Direct .git access is not allowed".to_string(),
				});
			}
		}
	}
	Ok(validated)
}

fn validate_branch_name(branch: &str) -> Result<()> {
	let ref_name = format!("refs/heads/{}", branch);
	if git2::Reference::is_valid_name(&ref_name) {
		Ok(())
	} else {
		Err(BackendError::GitBranchNotFound {
			message: format!("Invalid branch name: {}", branch),
		})
	}
}

fn short_hash(oid: Oid) -> String {
	oid.to_string().chars().take(12).collect()
}

fn commit_to_dto(commit: &Commit<'_>) -> GitCommitDto {
	let message = commit
		.summary()
		.unwrap_or("(no message)")
		.to_string();
	let author = commit
		.author()
		.name()
		.unwrap_or("Unknown")
		.to_string();
	let time = commit.time();
	let date = DateTime::<Utc>::from_timestamp(time.seconds(), 0)
		.unwrap_or_else(|| DateTime::<Utc>::from_timestamp(0, 0).unwrap())
		.to_rfc3339();

	let task_id = parse_task_id(&message);

	GitCommitDto {
		id: commit.id().to_string(),
		hash: short_hash(commit.id()),
		message,
		author,
		date,
		status: "done".to_string(),
		task_id,
	}
}

fn parse_task_id(message: &str) -> Option<String> {
	let marker = "#";
	if let Some(idx) = message.find(marker) {
		let rest = &message[idx + 1..];
		let token: String = rest
			.chars()
			.take_while(|c| c.is_alphanumeric() || *c == '-' || *c == '_')
			.collect();
		if !token.is_empty() {
			return Some(token);
		}
	}

	if let Some(idx) = message.find("task-") {
		let rest = &message[idx..];
		let token: String = rest
			.chars()
			.take_while(|c| c.is_alphanumeric() || *c == '-' || *c == '_')
			.collect();
		if !token.is_empty() {
			return Some(token);
		}
	}

	None
}

fn status_to_label(status: Status) -> Option<String> {
	if status.is_wt_new() || status.is_index_new() {
		Some("added".to_string())
	} else if status.is_wt_deleted() || status.is_index_deleted() {
		Some("deleted".to_string())
	} else if status.is_wt_renamed() || status.is_index_renamed() {
		Some("renamed".to_string())
	} else if status.is_wt_modified() || status.is_index_modified() {
		Some("modified".to_string())
	} else {
		None
	}
}

fn status_entry_paths(entry: &StatusEntry<'_>) -> (Option<String>, Option<String>) {
	if let Some(delta) = entry.head_to_index() {
		let old_path = delta.old_file().path().and_then(|p| p.to_str()).map(|s| s.to_string());
		let new_path = delta.new_file().path().and_then(|p| p.to_str()).map(|s| s.to_string());
		return (old_path, new_path);
	}

	if let Some(delta) = entry.index_to_workdir() {
		let old_path = delta.old_file().path().and_then(|p| p.to_str()).map(|s| s.to_string());
		let new_path = delta.new_file().path().and_then(|p| p.to_str()).map(|s| s.to_string());
		return (old_path, new_path);
	}

	(entry.path().map(|s| s.to_string()), entry.path().map(|s| s.to_string()))
}

fn build_status_map(repo: &Repository) -> Result<HashMap<String, String>> {
	let mut map = HashMap::new();
	let statuses = repo.statuses(Some(&mut get_status_options()))?;

	for entry in statuses.iter() {
		if let Some(label) = status_to_label(entry.status()) {
			let (_, path) = status_entry_paths(&entry);
			if let Some(path) = path {
				map.insert(path, label);
			}
		}
	}

	Ok(map)
}

fn insert_node(nodes: &mut Vec<GitNode>, parts: &[&str], prefix: &str, status: &str) {
	if parts.is_empty() {
		return;
	}

	let name = parts[0];
	let path = if prefix.is_empty() {
		name.to_string()
	} else {
		format!("{}/{}", prefix, name)
	};

	if parts.len() == 1 {
		if let Some(existing) = nodes.iter_mut().find(|n| n.path == path) {
			existing.status = Some(status.to_string());
		} else {
			nodes.push(GitNode {
				name: name.to_string(),
				path,
				node_type: "file".to_string(),
				status: Some(status.to_string()),
				children: None,
				hash: None,
			});
		}
		return;
	}

	let idx = if let Some(idx) = nodes
		.iter()
		.position(|n| n.name == name && n.node_type == "directory")
	{
		idx
	} else {
		nodes.push(GitNode {
			name: name.to_string(),
			path: path.clone(),
			node_type: "directory".to_string(),
			status: None,
			children: Some(Vec::new()),
			hash: None,
		});
		nodes.len() - 1
	};

	if nodes[idx].children.is_none() {
		nodes[idx].children = Some(Vec::new());
	}

	let children = nodes[idx].children.as_mut().unwrap();
	insert_node(children, &parts[1..], &path, status);
}

fn build_tree_nodes(
	repo: &Repository,
	tree: &git2::Tree<'_>,
	prefix: &str,
	status_map: &HashMap<String, String>,
	seen_paths: &mut HashSet<String>,
) -> Vec<GitNode> {
	let mut nodes = Vec::new();

	for entry in tree.iter() {
		let name = entry.name().unwrap_or("").to_string();
		let path = if prefix.is_empty() {
			name.clone()
		} else {
			format!("{}/{}", prefix, name)
		};

		match entry.kind() {
			Some(git2::ObjectType::Tree) => {
				let child = entry.to_object(repo).ok();
				let child_tree = child.and_then(|obj| obj.as_tree().cloned());
				let children = child_tree
					.map(|t| build_tree_nodes(repo, &t, &path, status_map, seen_paths))
					.unwrap_or_default();

				nodes.push(GitNode {
					name,
					path: path.clone(),
					node_type: "directory".to_string(),
					status: None,
					children: Some(children),
					hash: Some(entry.id().to_string()),
				});
				seen_paths.insert(path);
			}
			Some(git2::ObjectType::Blob) => {
				let status = status_map.get(&path).cloned();
				nodes.push(GitNode {
					name,
					path: path.clone(),
					node_type: "file".to_string(),
					status,
					children: None,
					hash: Some(entry.id().to_string()),
				});
				seen_paths.insert(path);
			}
			_ => {}
		}
	}

	nodes
}

fn resolve_commit<'repo>(repo: &'repo Repository, spec: &str) -> Result<Commit<'repo>> {
	if let Ok(reference) = repo.find_reference(&format!("refs/heads/{}", spec)) {
		return reference
			.peel_to_commit()
			.map_err(|e| BackendError::Git {
				message: e.to_string(),
			});
	}

	repo.revparse_single(spec)
		.and_then(|obj| obj.peel_to_commit())
		.map_err(|e| BackendError::Git {
			message: e.to_string(),
		})
}

fn ensure_clean(repo: &Repository) -> Result<()> {
	let status = get_status(repo)?;
	if status != Status::CURRENT {
		return Err(BackendError::GitRepositoryNotClean {
			message: "Please commit or stash your changes first".to_string(),
		});
	}
	Ok(())
}

#[tauri::command]
pub async fn git_status(
	workspace: State<'_, PathBuf>,
	git_state: State<'_, GitState>,
	repo_path: String,
) -> Result<GitStatusDto> {
	let workspace = workspace.inner().clone();
	let git_state = git_state.inner().clone();

	tokio::task::spawn_blocking(move || {
		let validated = validate_repo_path(&repo_path, &workspace)?;
		let repo = git_state.open_repo(&validated)?;
		let repo = repo.lock().map_err(|_| BackendError::Internal {
			message: "Failed to lock repository".to_string(),
		})?;

		let branch = get_branch_name(&repo)?.unwrap_or_else(|| "DETACHED".to_string());
		let head_commit = get_head_commit(&repo)?.map(|c| commit_to_dto(&c));

		let statuses = repo.statuses(Some(&mut get_status_options()))?;
		let mut staged = Vec::new();
		let mut unstaged = Vec::new();
		let mut untracked = Vec::new();

		for entry in statuses.iter() {
			let status = entry.status();
			let (old_path, path) = status_entry_paths(&entry);

			if status.is_index_new()
				|| status.is_index_modified()
				|| status.is_index_deleted()
				|| status.is_index_renamed()
			{
				if let Some(path) = path.clone() {
					staged.push(GitFileStatus {
						path,
						status: status_to_label(status).unwrap_or_else(|| "modified".to_string()),
						old_path,
					});
				}
			}

			if status.is_wt_modified() || status.is_wt_deleted() || status.is_wt_renamed() {
				if let Some(path) = path.clone() {
					unstaged.push(GitFileStatus {
						path,
						status: status_to_label(status).unwrap_or_else(|| "modified".to_string()),
						old_path: None,
					});
				}
			}

			if status.is_wt_new() {
				if let Some(path) = path {
					untracked.push(GitFileStatus {
						path,
						status: "untracked".to_string(),
						old_path: None,
					});
				}
			}
		}

		Ok(GitStatusDto {
			branch,
			head_commit,
			staged_files: staged,
			unstaged_files: unstaged,
			untracked_files: untracked,
			is_clean: statuses.is_empty(),
		})
	})
	.await
	.map_err(to_join_error)?
}

#[tauri::command]
pub async fn git_log(
	workspace: State<'_, PathBuf>,
	git_state: State<'_, GitState>,
	repo_path: String,
	limit: Option<u32>,
	branch: Option<String>,
) -> Result<Vec<GitCommitDto>> {
	let workspace = workspace.inner().clone();
	let git_state = git_state.inner().clone();
	let limit = limit.map(|v| v as usize).unwrap_or(DEFAULT_LOG_LIMIT);

	tokio::task::spawn_blocking(move || {
		let validated = validate_repo_path(&repo_path, &workspace)?;
		let repo = git_state.open_repo(&validated)?;
		let repo = repo.lock().map_err(|_| BackendError::Internal {
			message: "Failed to lock repository".to_string(),
		})?;

		let mut revwalk = repo.revwalk()?;

		if let Some(branch) = branch {
			let commit = resolve_commit(&repo, &branch)?;
			revwalk.push(commit.id())?;
		} else if let Ok(head) = repo.head() {
			if let Some(target) = head.target() {
				revwalk.push(target)?;
			} else {
				return Ok(Vec::new());
			}
		} else {
			return Ok(Vec::new());
		}

		let mut commits = Vec::new();
		for oid in revwalk.take(limit) {
			let oid = oid.map_err(|e| BackendError::Git {
				message: e.to_string(),
			})?;
			let commit = repo.find_commit(oid)?;
			commits.push(commit_to_dto(&commit));
		}

		Ok(commits)
	})
	.await
	.map_err(to_join_error)?
}

#[tauri::command]
pub async fn git_branch_list(
	workspace: State<'_, PathBuf>,
	git_state: State<'_, GitState>,
	repo_path: String,
) -> Result<GitBranchesDto> {
	let workspace = workspace.inner().clone();
	let git_state = git_state.inner().clone();

	tokio::task::spawn_blocking(move || {
		let validated = validate_repo_path(&repo_path, &workspace)?;
		let repo = git_state.open_repo(&validated)?;
		let repo = repo.lock().map_err(|_| BackendError::Internal {
			message: "Failed to lock repository".to_string(),
		})?;

		let current = get_branch_name(&repo)?;

		let mut local = Vec::new();
		let mut remote = Vec::new();

		for branch in repo.branches(Some(BranchType::Local))? {
			let (branch, _) = branch?;
			let name = branch.name()?.unwrap_or("").to_string();
			let is_head = current.as_deref() == Some(&name);
			let commit = branch
				.get()
				.peel_to_commit()
				.map(|c| short_hash(c.id()))
				.unwrap_or_default();
			local.push(GitBranch {
				name,
				is_head,
				commit,
			});
		}

		for branch in repo.branches(Some(BranchType::Remote))? {
			let (branch, _) = branch?;
			let name = branch.name()?.unwrap_or("").to_string();
			let commit = branch
				.get()
				.peel_to_commit()
				.map(|c| short_hash(c.id()))
				.unwrap_or_default();
			remote.push(GitBranch {
				name,
				is_head: false,
				commit,
			});
		}

		Ok(GitBranchesDto { local, remote, current })
	})
	.await
	.map_err(to_join_error)?
}

#[tauri::command]
pub async fn git_checkout(
	workspace: State<'_, PathBuf>,
	git_state: State<'_, GitState>,
	repo_path: String,
	branch_or_commit: String,
	create: bool,
) -> Result<()> {
	let workspace = workspace.inner().clone();
	let git_state = git_state.inner().clone();

	tokio::task::spawn_blocking(move || {
		let validated = validate_repo_path(&repo_path, &workspace)?;
		let repo = git_state.open_repo(&validated)?;
		let repo = repo.lock().map_err(|_| BackendError::Internal {
			message: "Failed to lock repository".to_string(),
		})?;

		ensure_clean(&repo)?;

		if create {
			validate_branch_name(&branch_or_commit)?;
			let head_commit = repo
				.head()
				.and_then(|head| head.peel_to_commit())
				.map_err(|_| BackendError::Git {
					message: "Cannot create branch without an initial commit".to_string(),
				})?;
			repo.branch(&branch_or_commit, &head_commit, false)?;
			repo.set_head(&format!("refs/heads/{}", branch_or_commit))?;
		} else if repo
			.find_reference(&format!("refs/heads/{}", branch_or_commit))
			.is_ok()
		{
			repo.set_head(&format!("refs/heads/{}", branch_or_commit))?;
		} else {
			let ref_name = format!("refs/heads/{}", branch_or_commit);
			if git2::Reference::is_valid_name(&ref_name) {
				return Err(BackendError::GitBranchNotFound {
					message: format!("Branch not found: {}", branch_or_commit),
				});
			}

			let commit = resolve_commit(&repo, &branch_or_commit).map_err(|_| {
				BackendError::GitInvalidCommit {
					message: format!("Commit not found: {}", branch_or_commit),
				}
			})?;
			repo.set_head_detached(commit.id())?;
		}

		let mut checkout = git2::build::CheckoutBuilder::new();
		checkout.safe();
		repo.checkout_head(Some(&mut checkout)).map_err(|e| BackendError::GitConflict {
			message: e.to_string(),
		})?;

		if repo.index().map(|idx| idx.has_conflicts()).unwrap_or(false) {
			return Err(BackendError::GitMergeConflict {
				message: "Checkout resulted in merge conflicts".to_string(),
			});
		}
		Ok(())
	})
	.await
	.map_err(to_join_error)?
}

#[tauri::command]
pub async fn git_commit(
	workspace: State<'_, PathBuf>,
	git_state: State<'_, GitState>,
	repo_path: String,
	message: String,
	stage_all: bool,
) -> Result<String> {
	let workspace = workspace.inner().clone();
	let git_state = git_state.inner().clone();

	tokio::task::spawn_blocking(move || {
		let validated = validate_repo_path(&repo_path, &workspace)?;
		let repo = git_state.open_repo(&validated)?;
		let repo = repo.lock().map_err(|_| BackendError::Internal {
			message: "Failed to lock repository".to_string(),
		})?;

		if stage_all {
			let mut index = repo.index()?;
			let statuses = repo.statuses(Some(&mut get_status_options()))?;
			for entry in statuses.iter() {
				let status = entry.status();
				let (old_path, path) = status_entry_paths(&entry);
				if status.is_wt_deleted() || status.is_index_deleted() {
					if let Some(path) = path {
						let _ = index.remove_path(Path::new(&path));
					}
					continue;
				}

				if let Some(path) = path {
					index.add_path(Path::new(&path))?;
				}

				if status.is_index_renamed() {
					if let Some(old_path) = old_path {
						let _ = index.remove_path(Path::new(&old_path));
					}
				}
			}
			index.write()?;
		}

		let statuses = repo.statuses(Some(&mut get_status_options()))?;
		if statuses.is_empty() {
			return Err(BackendError::Git {
				message: "No changes to commit".to_string(),
			});
		}

		let mut index = repo.index()?;
		let tree_id = index.write_tree()?;
		let tree = repo.find_tree(tree_id)?;

		let signature = repo.signature().unwrap_or_else(|_| {
			git2::Signature::now("Macro", "macro@local").unwrap()
		});

		let parent = repo
			.head()
			.ok()
			.and_then(|head| head.peel_to_commit().ok());

		let oid = if let Some(parent) = parent {
			repo.commit(Some("HEAD"), &signature, &signature, &message, &tree, &[&parent])?
		} else {
			repo.commit(Some("HEAD"), &signature, &signature, &message, &tree, &[])?
		};

		Ok(short_hash(oid))
	})
	.await
	.map_err(to_join_error)?
}

#[tauri::command]
pub async fn git_diff(
	workspace: State<'_, PathBuf>,
	git_state: State<'_, GitState>,
	repo_path: String,
	base: Option<String>,
	head: Option<String>,
) -> Result<String> {
	let workspace = workspace.inner().clone();
	let git_state = git_state.inner().clone();

	tokio::task::spawn_blocking(move || {
		let validated = validate_repo_path(&repo_path, &workspace)?;
		let repo = git_state.open_repo(&validated)?;
		let repo = repo.lock().map_err(|_| BackendError::Internal {
			message: "Failed to lock repository".to_string(),
		})?;

		let base_commit = if let Some(base) = base {
			Some(resolve_commit(&repo, &base)?)
		} else {
			get_head_commit(&repo)?
		};

		let base_tree = if let Some(commit) = base_commit.as_ref() {
			Some(commit.tree()?)
		} else {
			None
		};

		let mut output = String::new();
		if let Some(head) = head {
			let head_commit = resolve_commit(&repo, &head)?;
			let head_tree = head_commit.tree()?;
			let diff = get_diff(&repo, base_tree.as_ref(), Some(&head_tree))?;
			diff.print(DiffFormat::Patch, |_, _, line| {
				output.push_str(std::str::from_utf8(line.content()).unwrap_or(""));
				true
			})?;
		} else {
			let diff = repo.diff_tree_to_workdir_with_index(base_tree.as_ref(), None)?;
			diff.print(DiffFormat::Patch, |_, _, line| {
				output.push_str(std::str::from_utf8(line.content()).unwrap_or(""));
				true
			})?;
		}

		Ok(output)
	})
	.await
	.map_err(to_join_error)?
}

#[tauri::command]
pub async fn git_get_tree(
	workspace: State<'_, PathBuf>,
	git_state: State<'_, GitState>,
	repo_path: String,
	branch: Option<String>,
) -> Result<PredictedGitTreeDto> {
	let workspace = workspace.inner().clone();
	let git_state = git_state.inner().clone();

	tokio::task::spawn_blocking(move || {
		let validated = validate_repo_path(&repo_path, &workspace)?;
		let repo = git_state.open_repo(&validated)?;
		let repo = repo.lock().map_err(|_| BackendError::Internal {
			message: "Failed to lock repository".to_string(),
		})?;

		let branch_name = if let Some(branch) = branch {
			branch
		} else {
			get_branch_name(&repo)?.unwrap_or_else(|| "DETACHED".to_string())
		};

		let commit = resolve_commit(&repo, &branch_name).or_else(|_| {
			get_head_commit(&repo)?.ok_or_else(|| BackendError::GitInvalidCommit {
				message: "No commits found".to_string(),
			})
		})?;

		let tree = commit.tree()?;
		let status_map = build_status_map(&repo)?;
		let mut seen_paths = HashSet::new();
		let mut structure = build_tree_nodes(&repo, &tree, "", &status_map, &mut seen_paths);

		for (path, status) in status_map.iter() {
			if !seen_paths.contains(path) {
				let parts: Vec<&str> = path.split('/').collect();
				insert_node(&mut structure, &parts, "", status);
			}
		}

		Ok(PredictedGitTreeDto {
			branch: branch_name,
			structure,
			modified_files_count: status_map.len() as u32,
		})
	})
	.await
	.map_err(to_join_error)?
}

#[cfg(test)]
mod tests {
	use super::*;
	use std::fs;
	use tempfile::TempDir;

	fn init_repo() -> (TempDir, Repository) {
		let temp = TempDir::new().expect("temp dir");
		let repo = Repository::init(temp.path()).expect("init repo");

		let file_path = temp.path().join("README.md");
		fs::write(&file_path, "hello").expect("write file");

		let mut index = repo.index().expect("index");
		index.add_path(Path::new("README.md")).expect("add");
		let tree_id = index.write_tree().expect("write tree");
		{
			let tree = repo.find_tree(tree_id).expect("tree");
			let sig = git2::Signature::now("Tester", "tester@example.com").expect("sig");
			repo.commit(Some("HEAD"), &sig, &sig, "initial commit", &tree, &[])
				.expect("commit");
		}

		(temp, repo)
	}

	#[test]
	fn test_parse_task_id_hash() {
		let msg = "feat: add feature #task-123";
		assert_eq!(parse_task_id(msg), Some("task-123".to_string()));
	}

	#[test]
	fn test_parse_task_id_prefix() {
		let msg = "feat: add feature task-999";
		assert_eq!(parse_task_id(msg), Some("task-999".to_string()));
	}

	#[test]
	fn test_resolve_commit_branch() {
		let (_temp, repo) = init_repo();
		let head = repo.head().unwrap().peel_to_commit().unwrap();
		repo.branch("feature", &head, false).unwrap();
		let commit = resolve_commit(&repo, "feature").unwrap();
		assert_eq!(commit.id(), head.id());
	}

	#[test]
	fn test_build_status_map_untracked() {
		let (temp, repo) = init_repo();
		let new_file = temp.path().join("new.txt");
		fs::write(&new_file, "data").unwrap();

		let map = build_status_map(&repo).unwrap();
		assert_eq!(map.get("new.txt"), Some(&"added".to_string()));
	}

	#[test]
	fn test_ensure_clean_detects_changes() {
		let (temp, repo) = init_repo();
		let new_file = temp.path().join("dirty.txt");
		fs::write(&new_file, "dirty").unwrap();

		let err = ensure_clean(&repo).unwrap_err();
		match err {
			BackendError::GitRepositoryNotClean { .. } => {}
			other => panic!("expected git not clean error, got {other:?}"),
		}
	}

	#[test]
	fn test_build_tree_nodes_with_status() {
		let (_temp, repo) = init_repo();
		let commit = repo.head().unwrap().peel_to_commit().unwrap();
		let tree = commit.tree().unwrap();
		let mut status_map = HashMap::new();
		status_map.insert("README.md".to_string(), "modified".to_string());
		let mut seen = HashSet::new();

		let nodes = build_tree_nodes(&repo, &tree, "", &status_map, &mut seen);
		let readme = nodes.iter().find(|n| n.path == "README.md").unwrap();
		assert_eq!(readme.status.as_deref(), Some("modified"));
	}
}
