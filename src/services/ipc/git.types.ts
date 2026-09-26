import type {
DirectReviewSnapshotDto as NativeDirectReviewSnapshotDto,
GitAvailableTaskBranchDto as NativeGitAvailableTaskBranchDto,
GitAvailableWorktreeDto as NativeGitAvailableWorktreeDto,
GitBranch as NativeGitBranchDto,
GitBranchesDto as NativeGitBranchesDto,
GitBranchWorktreeEnsureDto as NativeGitBranchWorktreeEnsureDto,
GitBranchWorktreeInspectionDto as NativeGitBranchWorktreeInspectionDto,
GitBranchWorktreeRemoveDto as NativeGitBranchWorktreeRemoveDto,
GitConflictFileDto as NativeGitConflictFileDto,
GitConflictFileSideDto as NativeGitConflictFileSideDto,
GitFilePairDto as NativeGitFilePairDto,
GitFileStatus as NativeGitFileStatus,
GitGuardedMergeStateDto as NativeGitGuardedMergeStateDto,
GitLogPageDto as NativeGitLogPageDto,
GitMergeCheckDto as NativeGitMergeCheckDto,
GitPreparedBranchSyncDto as NativeGitPreparedBranchSyncDto,
GitRebaseCheckDto as NativeGitRebaseCheckDto,
GitRemoteDto as NativeGitRemoteDto,
GitReviewChangeDto as NativeGitReviewChangeDto,
GitReviewDiffHunkDto as NativeGitReviewDiffHunkDto,
GitReviewDiffLineDto as NativeGitReviewDiffLineDto,
GitReviewFileDto as NativeGitReviewFileDto,
GitReviewParsedDiffDto as NativeGitReviewParsedDiffDto,
GitReviewSnapshotDto as NativeGitReviewSnapshotDto,
GitStartMergeResolutionDto as NativeGitStartMergeResolutionDto,
GitStatusDto as NativeGitStatusDto,
GitSyncDto as NativeGitSyncDto,
GitTaskStartPointsDto as NativeGitTaskStartPointsDto,
GitWorkflowSessionDto as NativeGitWorkflowSessionDto,
GitWorkflowSessionIdentity as NativeGitWorkflowSessionIdentity,
GitWorktreeEnsureDto as NativeGitWorktreeEnsureDto,
GitWorktreeInspectionDto as NativeGitWorktreeInspectionDto,
GitWorktreeRemoveDto as NativeGitWorktreeRemoveDto
} from '../../types/generated/ipc';
import type { OmitFields, OptionalFields } from './compatibility.types';

/** git IPC contracts and explicit frontend adaptations of generated native bindings. */

import type { GitCommit } from "../../types";

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type GitFileStatus = OptionalFields<NativeGitFileStatus, "old_path">;

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type GitStatusDto = OptionalFields<OmitFields<NativeGitStatusDto,
  | "head_commit"
  | "staged_files"
  | "unstaged_files"
  | "untracked_files"
>, "conflicted_files" | "merge_in_progress"> & {
  head_commit: GitCommit | null;
  staged_files: GitFileStatus[];
  unstaged_files: GitFileStatus[];
  untracked_files: GitFileStatus[];
  conflictedFiles: string[];
  mergeInProgress: boolean;
};

export type GitBranchDto = NativeGitBranchDto;

export type GitBranchesDto = NativeGitBranchesDto;

export type GitWorktreeInspectionStatus =
  | "absent"
  | "ready"
  | "stale_registration"
  | "orphan_path"
  | "invalid_repo";

export type GitWorktreeEnsureStatus = "created" | "reused" | "repaired";

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type GitWorktreeInspectionDto = OmitFields<NativeGitWorktreeInspectionDto, "status"> & {
  status: GitWorktreeInspectionStatus;
};

export type GitAvailableWorktreeDto = NativeGitAvailableWorktreeDto;

export type GitAvailableTaskBranchDto = NativeGitAvailableTaskBranchDto;

export type GitTaskStartPointsDto = NativeGitTaskStartPointsDto;

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type GitWorktreeEnsureDto = OptionalFields<OmitFields<NativeGitWorktreeEnsureDto, "status">, "createdByThisCall"> & {
  status: GitWorktreeEnsureStatus;
};

export type GitWorktreeRemoveDto = NativeGitWorktreeRemoveDto;

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type GitBranchWorktreeInspectionDto = OmitFields<NativeGitBranchWorktreeInspectionDto, "status"> & {
  status: GitWorktreeInspectionStatus;
};

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type GitBranchWorktreeEnsureDto = OmitFields<NativeGitBranchWorktreeEnsureDto, "status"> & {
  status: GitWorktreeEnsureStatus;
};

export type GitBranchWorktreeRemoveDto = NativeGitBranchWorktreeRemoveDto;

export type GitSyncDto = NativeGitSyncDto;

export type GitPreparedBranchSyncDto = NativeGitPreparedBranchSyncDto;

export type GitRemoteDto = NativeGitRemoteDto;

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type GitMergeCheckDto = OptionalFields<NativeGitMergeCheckDto, "ahead" | "behind">;

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type GitGuardedMergeStateDto = OmitFields<NativeGitGuardedMergeStateDto, "status"> & {
  status: "pending" | "integrated";
};

export type GitRebaseCheckDto = NativeGitRebaseCheckDto;

export type GitFilePairDto = NativeGitFilePairDto;

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type GitReviewDiffLineDto = OmitFields<NativeGitReviewDiffLineDto, "type"> & {
  type: "context" | "added" | "removed";
};

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type GitReviewDiffHunkDto = OmitFields<NativeGitReviewDiffHunkDto, "lines"> & {
  lines: GitReviewDiffLineDto[];
};

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type GitReviewParsedDiffDto = OmitFields<NativeGitReviewParsedDiffDto, "hunks"> & {
  hunks: GitReviewDiffHunkDto[];
};

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type GitReviewChangeDto = OmitFields<NativeGitReviewChangeDto, "hunks"> & {
  hunks: GitReviewDiffHunkDto[];
};

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type GitReviewSnapshotDto = OmitFields<NativeGitReviewSnapshotDto, "changes"> & {
  changes: GitReviewChangeDto[];
};

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type DirectReviewSnapshotDto = OmitFields<NativeDirectReviewSnapshotDto, "changes"> & {
  changes: GitReviewChangeDto[];
};

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type GitReviewFileDto = OmitFields<NativeGitReviewFileDto, "pendingDiff" | "fullDiff"> & {
  pendingDiff: GitReviewParsedDiffDto;
  fullDiff: GitReviewParsedDiffDto;
};

export type GitStartMergeResolutionDto = NativeGitStartMergeResolutionDto;

export type GitConflictFileSideDto = NativeGitConflictFileSideDto;

export type GitConflictFileDto = NativeGitConflictFileDto;

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type GitLogPageDto = OmitFields<NativeGitLogPageDto, "commits"> & {
  commits: GitCommit[];
};

export type GitWorkflowSessionIdentity = NativeGitWorkflowSessionIdentity;

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type GitWorkflowSessionDto = OmitFields<NativeGitWorkflowSessionDto, "status"> & {
  status: 'prepared' | 'conflicted' | 'integrated' | 'aborted';
};
