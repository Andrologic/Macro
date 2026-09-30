import type { TaskExecutionTarget, CompletionMergePolicy } from '../types';
import type { CatalogedImplementTask, ImplementTaskPlanSummary } from './implementTaskCatalog';
import type * as tauriIpc from './tauriIpc';
import type * as planApi from './architectPlanService';
import type * as gitFlowApi from './architectGitFlowService';
import type { MergeWorkflowRuntimeState, MergeWorkflowResolutionAction, MergeWorkflowRepositoryResult } from './mergeWorkflow';

export type TaskWorkflowTask = CatalogedImplementTask;
export type TaskWorkflowTarget = TaskExecutionTarget & { repoPath: string; worktreePath?: string };
export interface TaskCompletionRepositoryRecord {
  projectId: string;
  repoPath: string;
  branchName: string;
  planBranchName: string;
  mergeOutput?: string;
}
export interface CompleteTaskOptions {
  allowWithoutCodeChanges?: boolean;
  skipIntegration?: boolean;
  repositories?: TaskCompletionRepositoryRecord[];
  mergeStrategyAction?: MergeWorkflowResolutionAction;
}
export interface TaskWorkflowPorts {
  translate(key: string, fallback: string, options?: Record<string, unknown>): string;
  findTask(taskId: string): CatalogedImplementTask | undefined;
  readRuntime(taskId: string): MergeWorkflowRuntimeState | null;
  publishRuntime(taskId: string, runtime: MergeWorkflowRuntimeState): void;
  /** Persist using the captured task identity even if the selected project has changed. */
  persistRuntime(task: CatalogedImplementTask, runtime: MergeWorkflowRuntimeState | null): Promise<void>;
  reportError(message: string | null): void;
  findPlanSummary(task: CatalogedImplementTask): ImplementTaskPlanSummary | undefined;
  getExecutionTargets(task: CatalogedImplementTask): TaskExecutionTarget[];
  getExecutionTargetsWithRepoPaths(task: CatalogedImplementTask): TaskWorkflowTarget[];
  assertExecutionTargetRunnable(target: TaskExecutionTarget): void;
  isGitExecutionTarget(target: TaskExecutionTarget): boolean;
  isDirectEditTarget(target: TaskExecutionTarget): boolean;
  getTaskIntegrationBranch(task: CatalogedImplementTask, target: TaskExecutionTarget): string | null;
  getReviewTargetBranch(task: CatalogedImplementTask): string | null;
  ensureIntegrationWorktree(task: CatalogedImplementTask, target: TaskWorkflowTarget, branch: string): Promise<string | null>;
  syncIntegrationBranch(repoPath: string, branch: string): Promise<void>;
  git: Pick<typeof tauriIpc, 'gitWorkflow' | 'gitStatus' | 'gitCheckout' | 'gitDiff' | 'gitMergeCheck' | 'gitBranchList' | 'gitRebaseCheck' | 'isTauriAvailable' | 'workspaceArchiveManualFeature' | 'gitWorktreeInspect' | 'gitWorkflowCleanup'>;
  loadPlanReview: typeof gitFlowApi.loadPlanReview;
}
export interface TaskMergeWorkflowPorts extends TaskWorkflowPorts {
  isPlanMutationActive(planId: string): boolean;
  isTaskCommandRunActive(taskId: string): boolean;
  acquireOperation(taskId: string): boolean;
  releaseOperation(taskId: string): void;
  mutationBlockedMessage(): string;
  validatePlanFinalization(task: CatalogedImplementTask): void;
  createTaskTodosBlockedErrorFromPlan(task: CatalogedImplementTask): Promise<Error | null>;
  createTaskArtifactsBlockedErrorFromPlan(task: CatalogedImplementTask): Promise<Error | null>;
  assertTaskBranchExclusive(task: CatalogedImplementTask): void;
  /** Keep the existing project identity reconciliation and workspace preparation in the composition. */
  prepareExecutionTargets(task: CatalogedImplementTask, skipIntegratedTargets: Set<string>): Promise<Array<TaskExecutionTarget & { repoPath: string; worktreePath: string }>>;
  isMissingBaseBranchError(error: unknown): boolean;
  completionMergePolicy(projectId: string): CompletionMergePolicy;
  /** Share this queue with conflict-resolution actions in the composition. */
  serializeRepositoryOperation<T>(repository: Pick<MergeWorkflowRepositoryResult, 'repoPath' | 'targetBranchName'>, operation: () => Promise<T>): Promise<T>;
  loadPlanLifecycleSagas(): Promise<Array<{ operation: string; planId: string; branchName: string }>>;
  resolveTargetBranch(branch: string): string;
  finalizePlanIntoBaseBranch: typeof gitFlowApi.finalizePlanIntoBaseBranch;
  refreshCatalog(): Promise<void>;
  clearPlanRuntime(input: { planId: string; deletedWorktreeKeys: string[] }): void;
  applyTaskCleanup(task: CatalogedImplementTask, removedWorktreeKeys: string[]): Promise<void>;
  syncManualFeatureTaskMetadata(task: CatalogedImplementTask | undefined, onError: (message: string | null) => void): Promise<void>;
  commitManualFeatureTaskMetadata(task: CatalogedImplementTask, message: string, onError: (message: string | null) => void): Promise<void>;
  deselectTaskIfSelected(taskId: string): void;
  getTaskPlanStorageBranch(task: CatalogedImplementTask): string;
  getTaskBusinessId(task: CatalogedImplementTask): string;
  mutateArchitectPlanTaskStatus: typeof planApi.mutateArchitectPlanTaskStatus;
  /** Derive nodes, branch lifecycle and execution status from the locked plan. */
  deriveCompletedPlanStatus(plan: Awaited<ReturnType<typeof planApi.mutateArchitectPlanTaskStatus>>, task: CatalogedImplementTask): Pick<Awaited<ReturnType<typeof planApi.mutateArchitectPlanTaskStatus>>, 'nodes' | 'predictedBranches' | 'status'>;
  publishCompletedPlan(plan: Awaited<ReturnType<typeof planApi.mutateArchitectPlanTaskStatus>>): void;
  writeArchitectTaskExecution: typeof planApi.writeArchitectTaskExecution;
  commitArchitectPlanMetadataForTask(task: CatalogedImplementTask, message: string, onError: (message: string | null) => void): Promise<void>;
  completeTask(task: CatalogedImplementTask): Promise<void>;
}
