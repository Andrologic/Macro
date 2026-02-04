// Git Module

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use git2::{BranchType, Repository, RepositoryInitOptions, WorktreeAddOptions};

use crate::core::error::{BackendError, Result};

pub mod repo;

#[derive(Clone)]
/// Shared Git state with repository/worktree caches.
pub struct GitState {
	inner: Arc<GitStateInner>,
}

#[allow(dead_code)]
struct GitStateInner {
	repos: Mutex<HashMap<PathBuf, Arc<Mutex<Repository>>>>,
	worktrees: Mutex<HashMap<String, PathBuf>>,
}

impl GitState {
	pub fn new() -> Self {
		Self {
			inner: Arc::new(GitStateInner {
				repos: Mutex::new(HashMap::new()),
				worktrees: Mutex::new(HashMap::new()),
			}),
		}
	}

	/// Open a repository and cache its handle.
	pub fn open_repo(&self, path: &Path) -> Result<Arc<Mutex<Repository>>> {
		let canonical = path.to_path_buf();
		let mut repos = self
			.inner
			.repos
			.lock()
			.map_err(|_| BackendError::Internal {
				message: "Failed to lock git repository cache".to_string(),
			})?;

		if let Some(repo) = repos.get(&canonical) {
			return Ok(repo.clone());
		}

		let repo = Repository::discover(&canonical)
			.or_else(|_| Repository::open(&canonical))
			.map_err(|e| BackendError::GitRepositoryNotFound {
				message: format!("{}", e),
			})?;
		let repo_arc = Arc::new(Mutex::new(repo));
		repos.insert(canonical, repo_arc.clone());
		Ok(repo_arc)
	}

	#[allow(dead_code)]
	pub fn get_worktree(&self, task_id: &str) -> Option<PathBuf> {
		self.inner
			.worktrees
			.lock()
			.ok()
			.and_then(|map| map.get(task_id).cloned())
	}

	#[allow(dead_code)]
	pub fn register_worktree(&self, task_id: &str, worktree_path: PathBuf) {
		if let Ok(mut map) = self.inner.worktrees.lock() {
			map.insert(task_id.to_string(), worktree_path);
		}
	}

	#[allow(dead_code)]
	pub fn ensure_task_worktree(
		&self,
		repo: &Repository,
		task_id: &str,
		branch_name: &str,
	) -> Result<PathBuf> {
		if let Some(existing) = self.get_worktree(task_id) {
			return Ok(existing);
		}

		let workdir = repo.workdir().ok_or_else(|| BackendError::Git {
			message: "Bare repositories are not supported for worktrees".to_string(),
		})?;

		let worktree_root = workdir.join(".macro").join("worktrees");
		std::fs::create_dir_all(&worktree_root).map_err(|e| BackendError::Io {
			message: e.to_string(),
			source: e,
		})?;

		let worktree_name = format!("task{}", task_id);
		let worktree_path = worktree_root.join(&worktree_name);

		if worktree_path.exists() {
			self.register_worktree(task_id, worktree_path.clone());
			return Ok(worktree_path);
		}

		if repo.find_branch(branch_name, BranchType::Local).is_err() {
			let head_commit = repo
				.head()
				.and_then(|head| head.peel_to_commit())
				.map_err(|_| BackendError::Git {
					message: "Cannot create branch without an initial commit".to_string(),
				})?;
			repo.branch(branch_name, &head_commit, false)?;
		}

		let reference = repo
			.find_reference(&format!("refs/heads/{}", branch_name))
			.map_err(|e| BackendError::Git {
				message: format!("Failed to find branch '{}': {}", branch_name, e),
			})?;

		let mut opts = WorktreeAddOptions::new();
		opts.reference(Some(&reference));

		repo.worktree(&worktree_name, &worktree_path, Some(&opts))
			.map_err(|e| BackendError::Git {
				message: format!("Failed to create worktree: {}", e),
			})?;

		self.register_worktree(task_id, worktree_path.clone());
		Ok(worktree_path)
	}
}

#[allow(dead_code)]
pub struct GitRepository {
	pub repo: Arc<Mutex<Repository>>,
	pub path: PathBuf,
}

impl GitRepository {
	/// Open an existing Git repository from a path.
	#[allow(dead_code)]
	pub fn open(path: &Path) -> Result<Self> {
		let repo = Repository::discover(path).or_else(|_| Repository::open(path))?;
		let repo_path = repo
			.workdir()
			.map(|p| p.to_path_buf())
			.unwrap_or_else(|| path.to_path_buf());

		Ok(Self {
			repo: Arc::new(Mutex::new(repo)),
			path: repo_path,
		})
	}

	/// Initialize a new Git repository at the given path.
	#[allow(dead_code)]
	pub fn init(path: &Path) -> Result<Self> {
		if path.join(".git").exists() {
			return Err(BackendError::Git {
				message: "Repository already exists".to_string(),
			});
		}

		let mut opts = RepositoryInitOptions::new();
		opts.initial_head("main");
		let repo = Repository::init_opts(path, &opts)?;

		Ok(Self {
			repo: Arc::new(Mutex::new(repo)),
			path: path.to_path_buf(),
		})
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use std::fs;
	use tempfile::TempDir;

	fn init_repo(path: &Path) -> Repository {
		let repo = Repository::init(path).expect("init repo");
		let file_path = path.join("README.md");
		fs::write(&file_path, "hello").expect("write file");

		let mut index = repo.index().expect("index");
		index.add_path(Path::new("README.md")).expect("add");
		let tree_id = index.write_tree().expect("write tree");
		{
			let tree = repo.find_tree(tree_id).expect("tree");
			let sig = git2::Signature::now("Tester", "tester@example.com").expect("sig");
			repo.commit(Some("HEAD"), &sig, &sig, "initial", &tree, &[])
				.expect("commit");
		}

		repo
	}

	#[test]
	fn test_ensure_task_worktree_creates_path() {
		let temp = TempDir::new().expect("temp dir");
		let repo = init_repo(temp.path());
		let state = GitState::new();

		let worktree_path = state
			.ensure_task_worktree(&repo, "123", "task-123")
			.expect("worktree");

		assert!(worktree_path.ends_with(Path::new(".macro/worktrees/task123")));
		assert!(worktree_path.join(".git").exists());
	}

	#[test]
	fn test_git_repository_open() {
		let temp = TempDir::new().expect("temp dir");
		let _repo = init_repo(temp.path());

		let opened = GitRepository::open(temp.path()).expect("open repo");
		assert!(opened.path.exists());
	}

	#[test]
	fn test_git_repository_open_not_git() {
		let temp = TempDir::new().expect("temp dir");
		assert!(GitRepository::open(temp.path()).is_err());
	}

	#[test]
	fn test_git_repository_open_missing_path() {
		let temp = TempDir::new().expect("temp dir");
		let missing = temp.path().join("missing");
		assert!(GitRepository::open(&missing).is_err());
	}

	#[test]
	fn test_git_repository_init() {
		let temp = TempDir::new().expect("temp dir");
		let repo_path = temp.path().join("repo");
		std::fs::create_dir_all(&repo_path).unwrap();

		let created = GitRepository::init(&repo_path).expect("init repo");
		assert!(created.path.join(".git").exists());

		assert!(GitRepository::init(&repo_path).is_err());
	}
}
