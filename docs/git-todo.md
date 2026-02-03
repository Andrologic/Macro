# Git Implementation - TODO List

> This document provides a detailed checklist for implementing the Git module.

## Overview

The Git module provides operations on Git repositories using libgit2. It must:
- Support multi-repo workspaces (one repo per project)
- Provide status, log, commit, diff, and branch operations
- Handle errors gracefully with clear messages
- Support Predicted Git Trees for the Macro planning system
- Use `git worktree` to run tasks in parallel (auto-create one worktree per task/branch)
- Worktree root: `.macro/worktrees/` (worktree name = `task<id>`)

---

## Task 1: Setup `git/mod.rs`

### Repository Management
- [x] Create `GitRepository` struct
  - Wrap `git2::Repository`
  - Store the repository path
  - Implement `Drop` to close repository

- [x] Implement `GitRepository::open(path: &Path) -> Result<Self>`
  - Try to open repository at path
  - Handle errors: not a git repo, not found, etc.
  - Search for `.git` directory (handle worktrees)
  - If path is a worktree, resolve parent repo and active worktree HEAD

- [x] Implement worktree management (auto per task)
  - Create worktree directory for each task/branch under `.macro/worktrees/`
  - Name each worktree `task<id>`
  - Reuse existing worktree when task reopens
  - Track `task_id` ↔ `worktree_path` mapping
  - Cleanup policy for stale worktrees (optional)

- [x] Implement `GitRepository::init(path: &Path) -> Result<Self>`
  - Initialize a new repository
  - Set initial branch to `main` (configurable)
  - Handle existing repository error

- [x] Implement repository pool/cache
  - Store opened repos in a `HashMap<PathBuf, GitRepository>`
  - Thread-safe access using `Arc<Mutex<>>` or dashmap
  - Cleanup stale repositories periodically

### Error Handling
- [ ] Add Git-specific error variants in `core/error.rs` (if not already covered)
  - `Git::RepositoryNotFound`
  - `Git::RepositoryNotClean`
  - `Git::BranchNotFound`
  - `Git::Conflict`
  - `Git::MergeConflict`
  - `Git::InvalidCommit`
- [x] Convert all `git2::Error` to `BackendError::Git`
  - Include relevant context in error messages
  - Preserve error codes when possible

---

## Task 2: Setup `git/repo.rs`

### Helper Methods
- [x] Implement `get_head_commit(&self) -> Result<git2::Commit>`
  - Get HEAD reference
  - Resolve to commit object
  - Handle detached HEAD state

- [x] Implement `get_branch_name(&self) -> Result<Option<String>>`
  - Get HEAD reference
  - Return branch name if not detached
  - Return `None` if detached HEAD

- [ ] Implement `get_status(&self) -> Result<git2::Status>`
  - Get working tree status
  - Include staged and unstaged changes
  - Include untracked files

- [ ] Implement `get_diff(&self, old_tree: Option<&git2::Tree>, new_tree: Option<&git2::Tree>) -> Result<git2::Diff>`
  - Create diff between two trees
  - Support working tree vs HEAD
  - Support commit vs commit

---

## Task 3: Implement `git_status` Command

### Command Signature
```rust
#[tauri::command]
async fn git_status(
    repo_path: String,
) -> Result<GitStatusDto>
```

### Implementation Steps
- [x] Parse and validate repository path
- [x] Open repository using `GitRepository::open`
- [x] Get status for all files
  - Use `repo.status(None)` to get all statuses
  - Convert `git2::Status` to frontend-friendly status
- [x] Classify files by status
  - **Staged**: Added, Modified, Deleted, Renamed
  - **Unstaged**: Modified, Deleted
  - **Untracked**: New files not in index
  - **Ignored**: Files matching `.gitignore` (if requested)
- [x] Return structured status

### Expected Response
```rust
#[derive(Serialize)]
struct GitStatusDto {
    branch: String,
    head_commit: Option<GitCommit>,
    staged_files: Vec<GitFileStatus>,
    unstaged_files: Vec<GitFileStatus>,
    untracked_files: Vec<GitFileStatus>,
    is_clean: bool,
}

#[derive(Serialize)]
struct GitFileStatus {
    path: String,
    status: String, // "added", "modified", "deleted", "renamed", "untracked"
    old_path: Option<String>, // For renames
}

#[derive(Serialize)]
struct GitCommit {
    id: String,
    hash: String,
    message: String,
    author: String,
    date: String,
}
```

---

## Task 4: Implement `git_log` Command

### Command Signature
```rust
#[tauri::command]
async fn git_log(
    repo_path: String,
    limit: Option<u32>,
    branch: Option<String>,
) -> Result<Vec<GitCommit>>
```

### Implementation Steps
- [x] Parse and validate repository path
- [x] Open repository
- [x] Determine commit list起点
  - If `branch` provided: use that branch HEAD
  - Otherwise: use current HEAD
- [x] Walk commit history
  - Use `revwalk()` from libgit2
  - Limit to `limit` commits (default 50)
  - Handle merge commits gracefully
- [x] For each commit, extract:
  - Commit ID and short hash
  - Commit message
  - Author name and email
  - Commit timestamp (convert to ISO 8601)
  - Parent commits (optional)
- [x] Return list of commits in chronological order (newest first)

---

## Task 5: Implement `git_branch_list` Command

### Command Signature
```rust
#[tauri::command]
async fn git_branch_list(
    repo_path: String,
) -> Result<GitBranchesDto>
```

### Implementation Steps
- [x] Open repository
- [x] List local branches
  - Use `repo.branches(Some(BranchType::Local))`
  - Extract branch name
  - Check if it's the current HEAD
- [x] List remote branches
  - Use `repo.branches(Some(BranchType::Remote))`
  - Extract remote name (e.g., `origin/main`)
- [x] Get current branch
  - Use `repo.head()` to get HEAD
  - Extract branch name if HEAD is not detached
- [x] Return structured branch list

### Expected Response
```rust
#[derive(Serialize)]
struct GitBranchesDto {
    local: Vec<GitBranch>,
    remote: Vec<GitBranch>,
    current: Option<String>,
}

#[derive(Serialize)]
struct GitBranch {
    name: String,
    is_head: bool,
    commit: String, // Short hash
}
```

---

## Task 6: Implement `git_checkout` Command

### Command Signature
```rust
#[tauri::command]
async fn git_checkout(
    repo_path: String,
    branch_or_commit: String,
    create: bool,
) -> Result<()>
```

### Implementation Steps
- [x] Open repository
- [x] Validate target exists
  - If `create=false`: check if branch or commit exists
  - If `create=true`: validate branch name format
- [x] Checkout operation
  - If `create=true`: create and checkout new branch
    - Use `repo.branch(branch_name, &commit, false)`
    - Then checkout the new branch
  - If `create=false`: checkout existing branch or commit
    - Use `repo.checkout_tree()` for commits
    - Use `repo.set_head()` for branches
- [x] Update working directory
  - Use `checkout_tree()` with appropriate flags
  - Handle conflicts if checking out a different branch
- [x] Handle merge conflicts
  - If checkout results in conflicts, return error
  - Provide list of conflicted files
- [x] Return success or appropriate error

### Error Handling
- [ ] Branch not found → `BackendError::Git { message: "Branch not found" }`
- [ ] Commit not found → `BackendError::Git { message: "Commit not found" }`
- [ ] Merge conflict → `BackendError::Git { message: "Checkout resulted in merge conflicts" }`
- [ ] Uncommitted changes would be lost → `BackendError::Git { message: "Please commit or stash your changes first" }`

---

## Task 7: Implement `git_commit` Command

### Command Signature
```rust
#[tauri::command]
async fn git_commit(
    repo_path: String,
    message: String,
    stage_all: bool,
) -> Result<String> // Returns commit hash
```

### Implementation Steps
- [x] Open repository
- [x] Get HEAD commit (parent of new commit)
- [x] Prepare commit (if `stage_all=true`)
  - Use `repo.status(None)` to get all changed files
  - Stage all changed files using `repo.index().add_path()`
  - Write index using `index.write()`
- [x] Create commit object
  - Use `repo.commit()` with:
    - Reference name (e.g., `"HEAD"`)
    - Author signature (from config or default)
    - Committer signature
    - Commit message
    - Tree from index
    - Parent commits (HEAD)
- [x] Return commit hash (short format)
- [x] Handle empty commit error (no changes to commit)

### Signature Handling
- [x] Get author name from git config (`user.name`)
- [x] Get author email from git config (`user.email`)
- [x] Use current timestamp
- [x] Fallback to defaults if config not set

---

## Task 8: Implement `git_diff` Command

### Command Signature
```rust
#[tauri::command]
async fn git_diff(
    repo_path: String,
    base: Option<String>, // Commit hash or branch
    head: Option<String>, // Commit hash or branch (defaults to working tree)
) -> Result<String> // Unified diff format
```

### Implementation Steps
- [x] Open repository
- [x] Determine diff base
  - If `base` provided: resolve to commit object
  - If `base` not provided: use HEAD
- [x] Determine diff target
  - If `head` provided: resolve to commit object
  - If `head` not provided: use working tree (index)
- [x] Create diff object
  - If both commits provided: diff between commits
  - If only base: diff between commit and working tree
  - Use `repo.diff_tree_to_tree()` or `repo.diff_tree_to_workdir()`
- [x] Generate unified diff format
  - Use `diff.print(DiffFormat::Patch, printer)`
  - Capture output to string
- [x] Return unified diff string

### Options (future enhancement)
- [ ] Support context lines configuration
- [ ] Support ignoring whitespace
- [ ] Support path filtering (diff specific files only)

---

## Task 9: Implement `git_get_tree` Command

### Command Signature
```rust
#[tauri::command]
async fn git_get_tree(
    repo_path: String,
    branch: Option<String>,
) -> Result<PredictedGitTree>
```

### Implementation Steps
- [x] Open repository
- [x] Get commit tree
  - If `branch` provided: get commit from branch
  - Otherwise: use HEAD commit
- [x] Traverse tree recursively
  - For each entry in tree, extract:
    - Path (relative to repo root)
    - Type (tree or blob)
    - Object ID (hash)
    - File status (from git status if comparing to working tree)
- [x] Calculate file counts
  - Total files
  - Modified files (from working tree)
  - Added files (untracked)
  - Deleted files (deleted in working tree)
- [x] Build `PredictedGitTree` structure

### Expected Response
```rust
#[derive(Serialize)]
struct PredictedGitTree {
    branch: String,
    structure: Vec<GitNode>,
    modified_files_count: u32,
}

#[derive(Serialize)]
struct GitNode {
    path: String,
    kind: String, // "file" | "directory"
    status: String, // "unchanged", "modified", "added", "deleted", "renamed"
    hash: Option<String>,
}
```

---

## Task 10: Additional Git Commands (Optional but Recommended)

### `git_add` Command
```rust
#[tauri::command]
async fn git_add(
    repo_path: String,
    paths: Vec<String>,
) -> Result<()>
```
- [ ] Stage specified files
- [ ] Support glob patterns
- [ ] Return error if file not found

### `git_reset` Command
```rust
#[tauri::command]
async fn git_reset(
    repo_path: String,
    mode: String, // "soft", "mixed", "hard"
    commit: Option<String>,
) -> Result<()>
```
- [ ] Reset to commit or HEAD
- [ ] Support all reset modes
- [ ] Warn on hard reset

### `git_stash` Command
```rust
#[tauri::command]
async fn git_stash(
    repo_path: String,
    message: Option<String>,
) -> Result<String> // Returns stash reference
```
- [ ] Stash current changes
- [ ] Support include/untracked files
- [ ] Return stash reference

---

## Task 11: Integration with Macro's Predicted Git Graph

### Status Mapping
- [ ] Map commit status to frontend expectations
  - `done` → committed changes
  - `planned` → staged but uncommitted changes
  - `in-progress` → unstaged modifications

- [x] Associate commits with tasks
  - Parse commit messages for task references (e.g., `#task-id`)
  - Store task ID in `GitCommit.task_id` field
  - Update frontend when new commits are made

### Git Graph Visualization
- [ ] Provide commit parent relationships for graph
  - Include `parent_ids` in `GitCommit` response
  - Support visualizing merge commits
- [ ] Calculate graph depth for Y-axis positioning
- [ ] Detect branches and branch points

---

## Task 12: Multi-Repo Support

### Workspace Integration
- [ ] Store repository metadata in workspace database
  - Table: `git_repositories (id, project_id, path, default_branch, last_commit)`
  - Update on open/close of projects

- [ ] Cache repository handles
  - Keep frequently accessed repos open
  - Auto-close unused repos after timeout
  - Thread-safe access for concurrent operations

- [ ] Handle submodules
  - Detect and traverse submodules
  - Provide operations on submodule repos
  - Optional: recursive status across submodules

---

## Task 13: Security & Permissions

### Path Validation
- [ ] Validate repository paths are within workspace
- [ ] Prevent accessing `.git` directories directly (use Git API only)
- [ ] Sanitize branch and tag names (prevent injection)

### Operation Safety
- [ ] Warn before destructive operations (reset, hard checkout)
- [ ] Prevent force push (remote operations)
- [ ] Validate commit messages (optional: enforce format)

### Configuration
- [ ] Use safe git config defaults
- - Prevent unsafe config options
- - Respect `.git/config` but override dangerous options

---

## Task 14: Performance Optimization

### Caching
- [ ] Cache commit objects
- [ ] Cache branch lists
- [ ] Invalidate cache on mutations (commit, checkout, etc.)

### Async Operations
- [ ] Use `tokio::task::spawn_blocking` for blocking git2 operations
- [ ] Parallelize operations where possible
- [ ] Stream large diffs instead of loading entirely in memory

### Pagination
- [ ] Support cursor-based pagination for `git_log`
- [ ] Limit default log size (e.g., 50 commits)
- [ ] Allow requesting older commits in batches

---

## Task 15: Tests

### Unit Tests
- [ ] Test `GitRepository::open`
  - Valid repo → success
  - Non-git directory → error
  - Non-existent path → error

- [ ] Test `GitRepository::init`
  - Init new repo → success
  - Init existing repo → error

### Integration Tests
- [ ] Test `git_status`
  - Clean repo → no staged/unstaged files
  - Modified file → shows in unstaged
  - Staged file → shows in staged
  - New file → shows in untracked

- [ ] Test `git_log`
  - New repo → single commit (initial)
  - Multiple commits → returns all (limited)
  - Branch-specific log → returns commits from branch

- [ ] Test `git_branch_list`
  - Default branch (`main`) listed
  - Created branches appear in list
  - Current branch marked with `is_head=true`

- [ ] Test `git_checkout`
  - Checkout existing branch → success
  - Checkout non-existent branch → error
  - Create and checkout new branch → success
  - Checkout commit (detached HEAD) → success

- [ ] Test `git_commit`
  - Commit staged changes → success
  - Commit with message → stores message
  - Empty commit (no changes) → error

- [ ] Test `git_diff`
  - Diff working tree vs HEAD → shows changes
  - Diff between commits → shows changes
  - No changes → empty diff

- [ ] Test `git_get_tree`
  - Empty repo → minimal tree
  - Repo with files → lists all
  - Modified files → status = "modified"

### Edge Cases
- [ ] Test with large repositories (performance)
- [ ] Test with binary files
- [ ] Test with merge conflicts
- [ ] Test with submodules
- [ ] Test with detached HEAD state
- [ ] Test with bare repositories (if supported)

---

## Task 16: Documentation

- [ ] Document command signatures in `commands/git.rs`
- [ ] Add Rust doc comments to all public functions
- [ ] Document `GitRepository` API
- [ ] Document error codes and their meanings
- [ ] Create examples for common Git workflows
- [ ] Document multi-repo architecture

---

## Task 17: Integration with Frontend

- [ ] Update frontend Git service to use real IPC commands
  - Replace mock implementations
  - Handle `BackendError::Git` responses
  - Update Git store with real data

- [ ] Test end-to-end
  - View git status in UI → matches repository
  - View commit history → shows all commits
  - Create new branch → appears in branch list
  - Checkout branch → updates UI
  - Make commit → appears in log and status
  - View diff → shows changes correctly
  - View predicted git tree → matches actual tree

---

## Completion Criteria

- [ ] All core commands implemented and tested
- [ ] Multi-repo support working
- [ ] Predicted Git Trees accurate
- [ ] Error handling comprehensive
- [ ] Frontend successfully uses all Git commands
- [ ] Performance acceptable on large repos
- [ ] Documentation complete

---

## Notes

- libgit2 is already in `Cargo.toml`
- All git2 operations are synchronous (blocking), must run in `spawn_blocking`
- Consider using `git2::Repository` directly or wrap in custom type
- Use chrono for timestamp conversion (already in `Cargo.toml`)
- Use `tokio::task::spawn_blocking` for all git2 operations to avoid blocking the async runtime
