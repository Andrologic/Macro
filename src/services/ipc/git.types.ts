/** git IPC DTOs. Kept separate for generated Rust binding integration. */

import type { GitCommit } from "../../types";

export interface GitFileStatus {
  path: string;
  status: string;
  old_path?: string | null;
}

export interface GitStatusDto {
  branch: string;
  head_commit: GitCommit | null;
  staged_files: GitFileStatus[];
  unstaged_files: GitFileStatus[];
  untracked_files: GitFileStatus[];
  conflicted_files?: string[];
  merge_in_progress?: boolean;
  conflictedFiles: string[];
  mergeInProgress: boolean;
  is_clean: boolean;
  has_origin: boolean;
  has_upstream: boolean;
  ahead: number;
  behind: number;
}

export interface GitBranchDto {
  name: string;
  is_head: boolean;
  commit: string;
}

export interface GitBranchesDto {
  local: GitBranchDto[];
  remote: GitBranchDto[];
  current: string | null;
}

export type GitWorktreeInspectionStatus =
  | "absent"
  | "ready"
  | "stale_registration"
  | "orphan_path"
  | "invalid_repo";

export type GitWorktreeEnsureStatus = "created" | "reused" | "repaired";

export interface GitWorktreeInspectionDto {
  taskId: string;
  worktreePath: string;
  branchName: string | null;
  status: GitWorktreeInspectionStatus;
  isDirty: boolean | null;
}

export interface GitAvailableWorktreeDto {
  name: string;
  path: string;
  branchName: string;
  isDirty: boolean;
}

export interface GitAvailableTaskBranchDto {
  name: string;
  commit: string;
}

export interface GitTaskStartPointsDto {
  worktrees: GitAvailableWorktreeDto[];
  branches: GitAvailableTaskBranchDto[];
}

export interface GitWorktreeEnsureDto {
  createdByThisCall?: boolean;
  taskId: string;
  worktreePath: string;
  branchName: string;
  status: GitWorktreeEnsureStatus;
}

export interface GitWorktreeRemoveDto {
  taskId: string;
  worktreePath: string;
  removedPath: boolean;
  prunedRegistration: boolean;
  alreadyAbsent: boolean;
}

export interface GitBranchWorktreeInspectionDto {
  worktreeKey: string;
  worktreePath: string;
  branchName: string | null;
  status: GitWorktreeInspectionStatus;
  isDirty: boolean | null;
}

export interface GitBranchWorktreeEnsureDto {
  worktreeKey: string;
  worktreePath: string;
  branchName: string;
  status: GitWorktreeEnsureStatus;
}

export interface GitBranchWorktreeRemoveDto {
  worktreeKey: string;
  worktreePath: string;
  removedPath: boolean;
  prunedRegistration: boolean;
  alreadyAbsent: boolean;
}

export interface GitSyncDto {
  branch: string;
  remote: string;
  output: string;
}

export interface GitPreparedBranchSyncDto {
  targetCommit: string;
}

export interface GitRemoteDto {
  remote: string;
  url: string;
}

export interface GitMergeCheckDto {
  mergeable: boolean;
  conflictFiles: string[];
  hasChanges: boolean;
  ahead?: number;
  behind?: number;
}

export interface GitGuardedMergeStateDto {
  status: "pending" | "integrated";
  targetCommit: string;
}

export interface GitRebaseCheckDto {
  rebaseable: boolean;
  conflictFiles: string[];
  output: string;
}

export interface GitFilePairDto {
  headExists: boolean;
  headContent: string;
  indexExists: boolean;
  indexContent: string;
  worktreeExists: boolean;
  worktreeContent: string;
  originalContent: string;
  modifiedContent: string;
}

export interface GitReviewDiffLineDto {
  type: "context" | "added" | "removed";
  content: string;
  oldLineNumber: number | null;
  newLineNumber: number | null;
}

export interface GitReviewDiffHunkDto {
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: GitReviewDiffLineDto[];
}

export interface GitReviewParsedDiffDto {
  originalContent: string;
  modifiedContent: string;
  additions: number;
  deletions: number;
  hunks: GitReviewDiffHunkDto[];
}

export interface GitReviewChangeDto {
  path: string;
  status: "added" | "modified" | "deleted" | string;
  additions: number;
  deletions: number;
  hasPendingVisibleChange: boolean;
  hasValidatedStage: boolean;
  validatedRemovedLineNumbers: number[];
  validatedAddedLineNumbers: number[];
  isBinary: boolean;
  tooLarge: boolean;
  requiresHydration: boolean;
  originalContent: string;
  indexContent: string;
  modifiedContent: string;
  language: string;
  hunks: GitReviewDiffHunkDto[];
}

export interface GitReviewSnapshotDto {
  branch: string;
  stagedPaths: string[];
  changes: GitReviewChangeDto[];
  conflictedFiles: string[];
  mergeInProgress: boolean;
  isClean: boolean;
}

export interface DirectReviewSnapshotDto extends GitReviewSnapshotDto {
  hasAcceptedChanges: boolean;
  snapshotId: string;
  restoreRevisions: Record<string, string>;
}

export interface GitReviewFileDto {
  path: string;
  status: "added" | "modified" | "deleted" | string;
  headExists: boolean;
  indexExists: boolean;
  worktreeExists: boolean;
  headContent: string;
  indexContent: string;
  worktreeContent: string;
  pendingDiff: GitReviewParsedDiffDto;
  fullDiff: GitReviewParsedDiffDto;
  hasValidatedStage: boolean;
  validatedRemovedLineNumbers: number[];
  validatedAddedLineNumbers: number[];
  isBinary: boolean;
  tooLarge: boolean;
  language: string;
}

export interface GitStartMergeResolutionDto {
  status: "merged" | "conflicted" | string;
  conflictFiles: string[];
  output: string;
}

export interface GitConflictFileSideDto {
  exists: boolean;
  content: string;
  sizeBytes: number;
  isBinary: boolean;
  tooLarge: boolean;
}

export interface GitConflictFileDto {
  path: string;
  base: GitConflictFileSideDto;
  ours: GitConflictFileSideDto;
  theirs: GitConflictFileSideDto;
  worktree: GitConflictFileSideDto;
  isBinary: boolean;
  tooLarge: boolean;
}

export interface GitLogPageDto {
  commits: GitCommit[];
  revision: string;
}

export interface GitWorkflowSessionIdentity {
  taskId: string;
  sessionId: string;
  sourceBranch: string;
  targetBranch: string;
}

export interface GitWorkflowSessionDto extends GitWorkflowSessionIdentity {
  sourceCommit: string;
  targetCommit: string;
  integratedCommit: string | null;
  status: 'prepared' | 'conflicted' | 'integrated' | 'aborted';
  output: string;
}
