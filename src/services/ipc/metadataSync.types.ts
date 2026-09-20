/** metadataSync IPC DTOs. Kept separate for generated Rust binding integration. */

export type MacroSyncState = "clean" | "pending" | "failed" | "conflict";

export type MacroSyncReason =
  | "clean"
  | "dirty"
  | "ahead"
  | "behind"
  | "diverged"
  | "merge_conflict"
  | "missing_origin"
  | "missing_upstream"
  | "auth_required"
  | "network_error"
  | "unknown_error";

export type MacroSyncNextAction =
  | "commit"
  | "push"
  | "pull"
  | "resolve_conflict"
  | "configure_remote"
  | "configure_auth"
  | "retry";

export interface MacroBranchSyncDto {
  branch: string;
  state: MacroSyncState;
  worktree_path: string;
  is_dirty: boolean;
  has_origin: boolean;
  has_upstream: boolean;
  ahead: number;
  behind: number;
  conflicted_files: string[];
  committed: boolean;
  commit_hash: string | null;
  reason: MacroSyncReason | null;
  next_action: MacroSyncNextAction | null;
  output: string | null;
  error: string | null;
}
