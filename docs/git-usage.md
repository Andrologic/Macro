# Git IPC Documentation

## Command Signatures (IPC)

### `git_status`
- Params: `{ repoPath: string }`
- Returns: Git status with staged/unstaged/untracked files.

### `git_log`
- Params: `{ repoPath: string, limit?: number, branch?: string }`
- Returns: list of commits (newest first).

### `git_branch_list`
- Params: `{ repoPath: string }`
- Returns: local/remote branches + current.

### `git_checkout`
- Params: `{ repoPath: string, branchOrCommit: string, create: boolean }`
- Returns: `void`.

### `git_commit`
- Params: `{ repoPath: string, message: string, stageAll: boolean }`
- Returns: short commit hash.

### `git_add`
- Params: `{ repoPath: string, paths: string[] }`
- Returns: `void`.

### `git_reset`
- Params: `{ repoPath: string, mode: 'soft'|'mixed'|'hard', commit?: string, confirm?: boolean }`
- Returns: `void`.

### `git_stash`
- Params: `{ repoPath: string, message?: string }`
- Returns: stash id (short hash).

### `git_diff`
- Params: `{ repoPath: string, base?: string, head?: string, contextLines?: number, ignoreWhitespace?: boolean, paths?: string[] }`
- Returns: unified diff string.

### `git_get_tree`
- Params: `{ repoPath: string, branch?: string }`
- Returns: predicted git tree.

## Commit Message Convention

Conventional Commits format (enforced):

```
<type>(optional-scope)?: <subject>
```

Allowed types: `feat`, `fix`, `chore`, `refactor`, `docs`, `test`, `perf`.

Examples:
- `feat: add search panel`
- `fix(auth): handle token refresh`
- `chore!: drop legacy config`

## Error Codes (Backend)

Git-related errors come from `BackendError` and include:
- `GitRepositoryNotFound`
- `GitRepositoryNotClean`
- `GitBranchNotFound`
- `GitConflict`
- `GitMergeConflict`
- `GitInvalidCommit`
- `Git` (generic)

## Worktree Architecture

- Each task runs in its own worktree under `.macro/worktrees/`.
- Worktree naming: `task<id>`.
- Repository root remains the canonical source; worktrees isolate task changes.

## Submodules (Simple Support)

- Submodules are detected and reported as `modified` when their repo is dirty or uninitialized.
- Submodule entries appear in `git_status` and in `git_get_tree` as directory-like nodes.

## Common Workflows

### Check status → commit
1. `git_status`
2. `git_add` (paths)
3. `git_commit`
4. `git_log`

### Branch for a task
1. `git_checkout` with `create=true`
2. Work changes in task worktree
3. `git_commit`

### Safe reset
1. `git_reset` with `mode='hard'` and `confirm=true`
