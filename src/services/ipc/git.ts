import type { OmitFields } from './compatibility.types';
/** git IPC wrappers and frontend adapters. */

import type {
  GitCommit,
  PredictedGitTree,
} from "../../types";
import { invoke } from "../tauriRuntimeBridge";
import type {
  DirectReviewSnapshotDto,
  GitBranchWorktreeEnsureDto,
  GitBranchWorktreeInspectionDto,
  GitBranchWorktreeRemoveDto,
  GitBranchesDto,
  GitConflictFileDto,
  GitFilePairDto,
  GitGuardedMergeStateDto,
  GitLogPageDto,
  GitMergeCheckDto,
  GitPreparedBranchSyncDto,
  GitRebaseCheckDto,
  GitRemoteDto,
  GitReviewFileDto,
  GitReviewSnapshotDto,
  GitStartMergeResolutionDto,
  GitStatusDto,
  GitSyncDto,
  GitTaskStartPointsDto,
  GitWorkflowSessionDto,
  GitWorkflowSessionIdentity,
  GitWorktreeEnsureDto,
  GitWorktreeInspectionDto,
  GitWorktreeRemoveDto,
} from "./git.types";

const normalizeGitStatus = (
  status: OmitFields<GitStatusDto, "conflictedFiles" | "mergeInProgress">,
): GitStatusDto => {
  const conflictedFiles = status.conflicted_files ?? [];
  const mergeInProgress = status.merge_in_progress ?? false;

  return {
    ...status,
    conflicted_files: conflictedFiles,
    merge_in_progress: mergeInProgress,
    conflictedFiles,
    mergeInProgress,
  };
};

export async function gitStatus(repoPath: string): Promise<GitStatusDto> {
  const status = await invoke<
    OmitFields<GitStatusDto, "conflictedFiles" | "mergeInProgress">
  >("git_status", { repoPath });
  return normalizeGitStatus(status);
}

export async function gitLog(params: {
  repoPath: string;
  limit?: number;
  offset?: number;
  branch?: string;
}): Promise<GitCommit[]> {
  return invoke<GitCommit[]>("git_log", {
    repoPath: params.repoPath,
    limit: params.limit ?? null,
    offset: params.offset ?? null,
    branch: params.branch ?? null,
  });
}

export async function gitLogPage(params: {
  repoPath: string;
  limit?: number;
  offset?: number;
  branch?: string;
}): Promise<GitLogPageDto> {
  return invoke<GitLogPageDto>("git_log_page", {
    repoPath: params.repoPath,
    limit: params.limit ?? null,
    offset: params.offset ?? null,
    branch: params.branch ?? null,
  });
}

export async function gitBranchList(repoPath: string): Promise<GitBranchesDto> {
  return invoke<GitBranchesDto>("git_branch_list", { repoPath });
}

export async function gitBranchCreate(params: {
  repoPath: string;
  branchName: string;
  fromRef: string;
}): Promise<void> {
  return invoke("git_branch_create", {
    repoPath: params.repoPath,
    branchName: params.branchName,
    fromRef: params.fromRef,
  });
}

export async function gitBranchDelete(params: {
  repoPath: string;
  branchName: string;
  force?: boolean;
  archiveTaskId?: string | null;
  archiveToken?: string | null;
  expectedCommit?: string | null;
}): Promise<void> {
  return invoke("git_branch_delete", {
    repoPath: params.repoPath,
    branchName: params.branchName,
    force: params.force ?? null,
    archiveTaskId: params.archiveTaskId ?? null,
    archiveToken: params.archiveToken ?? null,
    expectedCommit: params.expectedCommit ?? null,
  });
}

export async function gitBranchDeleteRemote(params: {
  repoPath: string;
  branchName: string;
  remote?: string;
  expectedCommit?: string;
}): Promise<void> {
  return invoke("git_branch_delete_remote", {
    repoPath: params.repoPath,
    branchName: params.branchName,
    remote: params.remote ?? null,
    expectedCommit: params.expectedCommit ?? null,
  });
}

export async function gitCheckout(params: {
  repoPath: string;
  branchOrCommit: string;
  create: boolean;
}): Promise<void> {
  return invoke("git_checkout", {
    repoPath: params.repoPath,
    branchOrCommit: params.branchOrCommit,
    create: params.create,
  });
}

export async function gitMerge(params: {
  repoPath: string;
  branchName: string;
  intoBranch: string;
  expectedBranchCommit?: string | null;
  expectedIntoCommit?: string | null;
}): Promise<string> {
  return invoke<string>("git_merge", {
    repoPath: params.repoPath,
    branchName: params.branchName,
    intoBranch: params.intoBranch,
    expectedBranchCommit: params.expectedBranchCommit ?? null,
    expectedIntoCommit: params.expectedIntoCommit ?? null,
  });
}

export async function gitGuardedMergeState(params: {
  repoPath: string;
  branchName: string;
  intoBranch: string;
  expectedBranchCommit: string;
  expectedIntoCommit: string;
  completeMerge?: boolean;
}): Promise<GitGuardedMergeStateDto> {
  return invoke<GitGuardedMergeStateDto>("git_guarded_merge_state", {
    repoPath: params.repoPath,
    branchName: params.branchName,
    intoBranch: params.intoBranch,
    expectedBranchCommit: params.expectedBranchCommit,
    expectedIntoCommit: params.expectedIntoCommit,
    ...(params.completeMerge ? { completeMerge: true } : {}),
  });
}

export async function gitWorkflow(params: {
  repoPath: string;
  taskId: string;
  sourceBranch: string;
  targetBranch: string;
  expectedSessionId?: string;
  action: 'inspect' | 'prepare' | 'start' | 'merge_commit' | 'fast_forward' | 'rebase_then_continue' | 'complete' | 'abort' | 'adopt_plan' | 'no_changes';
  planId?: string;
  storageBranch?: string;
}): Promise<GitWorkflowSessionDto | null> {
  return invoke<GitWorkflowSessionDto | null>('git_workflow', params);
}

export async function gitWorkflowCleanup(params: {
  repoPath: string;
  identity: GitWorkflowSessionIdentity;
  worktreeKey: string;
  removeRemote: boolean;
  expectedWorktreePath?: string | null;
}): Promise<void> {
  return invoke('git_workflow_cleanup', {
    repoPath: params.repoPath,
    identity: params.identity,
    worktreeKey: params.worktreeKey,
    removeRemote: params.removeRemote,
    expectedWorktreePath: params.expectedWorktreePath ?? null,
  });
}

export async function gitStartMergeResolution(params: {
  repoPath: string;
  branchName: string;
  intoBranch: string;
}): Promise<GitStartMergeResolutionDto> {
  return invoke<GitStartMergeResolutionDto>("git_start_merge_resolution", {
    repoPath: params.repoPath,
    branchName: params.branchName,
    intoBranch: params.intoBranch,
  });
}

export async function gitMergeCheck(params: {
  repoPath: string;
  branchName: string;
  intoBranch: string;
}): Promise<GitMergeCheckDto> {
  return invoke<GitMergeCheckDto>("git_merge_check", {
    repoPath: params.repoPath,
    branchName: params.branchName,
    intoBranch: params.intoBranch,
  });
}

export async function gitFastForward(params: {
  repoPath: string;
  sourceBranch: string;
  targetBranch: string;
}): Promise<string> {
  return invoke<string>("git_fast_forward", {
    repoPath: params.repoPath,
    sourceBranch: params.sourceBranch,
    targetBranch: params.targetBranch,
  });
}

export async function gitRebaseCheck(params: {
  repoPath: string;
  branchName: string;
  ontoBranch: string;
}): Promise<GitRebaseCheckDto> {
  return invoke<GitRebaseCheckDto>("git_rebase_check", {
    repoPath: params.repoPath,
    branchName: params.branchName,
    ontoBranch: params.ontoBranch,
  });
}

export async function gitRebaseBranch(params: {
  repoPath: string;
  branchName: string;
  ontoBranch: string;
  confirm: boolean;
}): Promise<string> {
  return invoke<string>("git_rebase_branch", {
    repoPath: params.repoPath,
    branchName: params.branchName,
    ontoBranch: params.ontoBranch,
    confirm: params.confirm,
  });
}

export async function gitCommit(params: {
  repoPath: string;
  message: string;
  stageAll: boolean;
}): Promise<string> {
  return invoke<string>("git_commit", {
    repoPath: params.repoPath,
    message: params.message,
    stageAll: params.stageAll,
  });
}

export async function gitAdd(params: {
  repoPath: string;
  paths: string[];
}): Promise<void> {
  return invoke("git_add", { repoPath: params.repoPath, paths: params.paths });
}

export async function gitRestorePaths(params: {
  repoPath: string;
  paths: string[];
  target?: "worktree" | "staged" | "staged_and_worktree";
}): Promise<void> {
  return invoke("git_restore_paths", {
    repoPath: params.repoPath,
    paths: params.paths,
    target: params.target ?? null,
  });
}

export async function gitReset(params: {
  repoPath: string;
  mode: "soft" | "mixed" | "hard";
  commit?: string;
  confirm?: boolean;
}): Promise<void> {
  return invoke("git_reset", {
    repoPath: params.repoPath,
    mode: params.mode,
    commit: params.commit ?? null,
    confirm: params.confirm ?? null,
  });
}

export async function gitAbortMerge(params: {
  repoPath: string;
  confirm: boolean;
}): Promise<void> {
  return invoke("git_abort_merge", {
    repoPath: params.repoPath,
    confirm: params.confirm,
  });
}

export async function gitStash(params: {
  repoPath: string;
  message?: string;
}): Promise<string> {
  return invoke<string>("git_stash", {
    repoPath: params.repoPath,
    message: params.message ?? null,
  });
}

export async function gitDiff(params: {
  repoPath: string;
  base?: string;
  head?: string;
  contextLines?: number;
  ignoreWhitespace?: boolean;
  paths?: string[];
  mode?: "patch" | "stat" | "name_only";
  maxBytes?: number;
  requireComplete?: boolean;
}): Promise<string> {
  return invoke<string>("git_diff", {
    repoPath: params.repoPath,
    base: params.base ?? null,
    head: params.head ?? null,
    contextLines: params.contextLines ?? null,
    ignoreWhitespace: params.ignoreWhitespace ?? null,
    paths: params.paths ?? null,
    mode: params.mode ?? null,
    maxBytes: params.maxBytes ?? null,
    requireComplete: params.requireComplete ?? null,
  });
}

export async function gitReadFilePair(params: {
  repoPath: string;
  path: string;
}): Promise<GitFilePairDto> {
  return invoke<GitFilePairDto>("git_read_file_pair", {
    repoPath: params.repoPath,
    path: params.path,
  });
}

export async function gitReviewSnapshot(
  repoPath: string,
  requestId?: string,
): Promise<GitReviewSnapshotDto> {
  return invoke<GitReviewSnapshotDto>("git_review_snapshot", { repoPath, requestId });
}

export async function gitCancelReview(requestId: string): Promise<void> {
  return invoke<void>('git_cancel_review', { requestId });
}

export async function directCheckpointEnsure(params: {
  taskId: string;
  projectPath: string;
  checkpointId?: string;
}): Promise<string> {
  return invoke<string>('direct_checkpoint_ensure', params);
}

export async function directCheckpointRemove(params: {
  taskId: string;
  checkpointId: string;
  projectPath: string;
}): Promise<boolean> {
  return invoke<boolean>('direct_checkpoint_remove', params);
}

export async function directCheckpointResolveId(params: {
  taskId: string;
  projectPath: string;
}): Promise<string> {
  return invoke<string>('direct_checkpoint_resolve_id', params);
}

export async function directReviewSnapshot(params: {
  taskId: string;
  projectPath: string;
  checkpointId?: string;
  requestId?: string;
}): Promise<DirectReviewSnapshotDto> {
  return invoke<DirectReviewSnapshotDto>('direct_review_snapshot', params);
}

export async function directReviewFile(params: {
  taskId: string;
  projectPath: string;
  checkpointId?: string;
  path: string;
  status: string;
  requestId?: string;
}): Promise<GitReviewFileDto> {
  return invoke<GitReviewFileDto>('direct_review_file', params);
}

export async function directStagePaths(params: {
  taskId: string;
  projectPath: string;
  checkpointId?: string;
  snapshotId: string;
  paths: string[];
}): Promise<void> {
  return invoke<void>('direct_stage_paths', params);
}

export async function directUnstagePaths(params: {
  taskId: string;
  projectPath: string;
  checkpointId?: string;
  paths: string[];
}): Promise<void> {
  return invoke<void>('direct_unstage_paths', params);
}

export async function directRestoreWorktreePaths(params: {
  taskId: string;
  projectPath: string;
  checkpointId?: string;
  snapshotId: string;
  paths: string[];
  requestId: string;
}): Promise<void> {
  return invoke<void>('direct_restore_worktree_paths', params);
}

export async function directAcceptChanges(params: {
  taskId: string;
  projectPath: string;
  checkpointId?: string;
}): Promise<string> {
  return invoke<string>('direct_accept_changes', params);
}

export async function gitReviewFile(params: {
  repoPath: string;
  path: string;
  requestId?: string;
}): Promise<GitReviewFileDto> {
  return invoke<GitReviewFileDto>("git_review_file", {
    repoPath: params.repoPath,
    path: params.path,
    requestId: params.requestId,
  });
}

export async function gitReadConflictFile(params: {
  repoPath: string;
  workflowSession?: GitWorkflowSessionIdentity;
  path: string;
}): Promise<GitConflictFileDto> {
  return invoke<GitConflictFileDto>("git_read_conflict_file", {
    repoPath: params.repoPath,
    ...(params.workflowSession ? { workflowSession: params.workflowSession } : {}),
    path: params.path,
  });
}

export async function gitWriteConflictResolution(params: {
  repoPath: string;
  workflowSession?: GitWorkflowSessionIdentity;
  path: string;
  content: string;
  stage?: boolean;
}): Promise<void> {
  return invoke("git_write_conflict_resolution", {
    repoPath: params.repoPath,
    ...(params.workflowSession ? { workflowSession: params.workflowSession } : {}),
    path: params.path,
    content: params.content,
    stage: params.stage ?? true,
  });
}

export async function gitAcceptConflictSide(params: {
  repoPath: string;
  workflowSession?: GitWorkflowSessionIdentity;
  path: string;
  side: "ours" | "theirs";
}): Promise<void> {
  return invoke("git_accept_conflict_side", {
    repoPath: params.repoPath,
    ...(params.workflowSession ? { workflowSession: params.workflowSession } : {}),
    path: params.path,
    side: params.side,
  });
}

export async function gitCompleteMerge(params: {
  repoPath: string;
}): Promise<string> {
  return invoke<string>("git_complete_merge", {
    repoPath: params.repoPath,
  });
}

export async function gitGetTree(params: {
  repoPath: string;
  branch?: string;
}): Promise<PredictedGitTree> {
  return invoke<PredictedGitTree>("git_get_tree", {
    repoPath: params.repoPath,
    branch: params.branch ?? null,
  });
}

export async function gitWorktreeInspect(params: {
  repoPath: string;
  taskId: string;
  branchName?: string | null;
  readOnly?: boolean;
}): Promise<GitWorktreeInspectionDto> {
  return invoke<GitWorktreeInspectionDto>("git_worktree_inspect", {
    repoPath: params.repoPath,
    taskId: params.taskId,
    branchName: params.branchName ?? null,
    ...(params.readOnly === undefined ? {} : { readOnly: params.readOnly }),
  });
}

export async function gitTaskStartPoints(params: {
  repoPath: string;
}): Promise<GitTaskStartPointsDto> {
  return invoke<GitTaskStartPointsDto>("git_task_start_points", {
    repoPath: params.repoPath,
  });
}

export async function gitWorktreeCreate(params: {
  repoPath: string;
  taskId: string;
  branchName: string;
  fromRef?: string | null;
  preferredCommitBranch?: string | null;
  fallbackBranches?: string[] | null;
}): Promise<GitWorktreeEnsureDto> {
  return invoke<GitWorktreeEnsureDto>("git_worktree_create", {
    repoPath: params.repoPath,
    taskId: params.taskId,
    branchName: params.branchName,
    fromRef: params.fromRef ?? null,
    preferredCommitBranch: params.preferredCommitBranch ?? null,
    fallbackBranches: params.fallbackBranches ?? null,
  });
}

export async function gitWorktreeRemove(params: {
  repoPath: string;
  taskId: string;
  force?: boolean;
  branchName?: string | null;
  archiveTaskId?: string | null;
  archiveToken?: string | null;
  expectedCommit?: string | null;
  expectedWorktreePath?: string | null;
}): Promise<GitWorktreeRemoveDto> {
  return invoke<GitWorktreeRemoveDto>("git_worktree_remove", {
    repoPath: params.repoPath,
    taskId: params.taskId,
    force: params.force ?? null,
    branchName: params.branchName ?? null,
    archiveTaskId: params.archiveTaskId ?? null,
    archiveToken: params.archiveToken ?? null,
    expectedCommit: params.expectedCommit ?? null,
    expectedWorktreePath: params.expectedWorktreePath ?? null,
  });
}

export async function gitBranchWorktreeInspect(params: {
  repoPath: string;
  worktreeKey: string;
  branchName: string;
}): Promise<GitBranchWorktreeInspectionDto> {
  return invoke<GitBranchWorktreeInspectionDto>("git_branch_worktree_inspect", {
    repoPath: params.repoPath,
    worktreeKey: params.worktreeKey,
    branchName: params.branchName,
  });
}

export async function gitBranchWorktreeCreate(params: {
  repoPath: string;
  worktreeKey: string;
  branchName: string;
  fromRef?: string | null;
  fallbackBranches?: string[] | null;
}): Promise<GitBranchWorktreeEnsureDto> {
  return invoke<GitBranchWorktreeEnsureDto>("git_branch_worktree_create", {
    repoPath: params.repoPath,
    worktreeKey: params.worktreeKey,
    branchName: params.branchName,
    fromRef: params.fromRef ?? null,
    fallbackBranches: params.fallbackBranches ?? null,
  });
}

export async function gitBranchWorktreeRemove(params: {
  repoPath: string;
  worktreeKey: string;
  branchName: string;
  force?: boolean;
  expectedCommit?: string | null;
  expectedWorktreePath?: string | null;
}): Promise<GitBranchWorktreeRemoveDto> {
  return invoke<GitBranchWorktreeRemoveDto>("git_branch_worktree_remove", {
    repoPath: params.repoPath,
    worktreeKey: params.worktreeKey,
    branchName: params.branchName,
    force: params.force ?? null,
    expectedCommit: params.expectedCommit ?? null,
    expectedWorktreePath: params.expectedWorktreePath ?? null,
  });
}

export async function gitPush(params: {
  repoPath: string;
  remote?: string;
  branch?: string;
}): Promise<GitSyncDto> {
  return invoke<GitSyncDto>("git_push", {
    repoPath: params.repoPath,
    remote: params.remote ?? null,
    branch: params.branch ?? null,
  });
}

export async function gitRemoteAddOrigin(params: {
  repoPath: string;
  url: string;
}): Promise<GitRemoteDto> {
  return invoke<GitRemoteDto>("git_remote_add_origin", {
    repoPath: params.repoPath,
    url: params.url,
  });
}

export async function gitFetch(params: {
  repoPath: string;
  remote?: string;
  branch?: string;
}): Promise<GitSyncDto> {
  return invoke<GitSyncDto>("git_fetch", {
    repoPath: params.repoPath,
    remote: params.remote ?? null,
    branch: params.branch ?? null,
  });
}

export async function gitPull(params: {
  repoPath: string;
  remote?: string;
  branch?: string;
}): Promise<GitSyncDto> {
  return invoke<GitSyncDto>("git_pull", {
    repoPath: params.repoPath,
    remote: params.remote ?? null,
    branch: params.branch ?? null,
  });
}

export async function gitPrepareGuardedBranchSync(params: {
  repoPath: string;
  branchName: string;
  expectedBranchCommit: string;
}): Promise<GitPreparedBranchSyncDto> {
  return invoke<GitPreparedBranchSyncDto>("git_prepare_guarded_branch_sync", {
    repoPath: params.repoPath,
    branchName: params.branchName,
    expectedBranchCommit: params.expectedBranchCommit,
  });
}

export async function gitGuardedBranchSync(params: {
  repoPath: string;
  branchName: string;
  expectedBranchCommit: string;
  syncTargetCommit: string;
}): Promise<GitGuardedMergeStateDto> {
  return invoke<GitGuardedMergeStateDto>("git_guarded_branch_sync", {
    repoPath: params.repoPath,
    branchName: params.branchName,
    expectedBranchCommit: params.expectedBranchCommit,
    syncTargetCommit: params.syncTargetCommit,
  });
}
