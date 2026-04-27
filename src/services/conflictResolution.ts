import type {
  PlanFinalizationNextAction,
  PlanReviewRepositoryResult,
} from './architectGitFlowService';
import type {
  MergeWorkflowKind,
  MergeWorkflowRepositoryResult,
} from './mergeWorkflow';
import type { MetadataSyncRepositoryStatus } from '../stores/useAppStore';
import type { MacroSyncNextAction } from './tauriIpc';

export interface ConflictResolutionEntry {
  id: string;
  repoPath: string;
  subtitle: string | null;
  worktreePath: string | null;
  statusLabel: string;
  statusTone: 'success' | 'warning' | 'danger';
  reason: string | null;
  nextStep: string | null;
  conflictFiles: string[];
}

const PLAN_NEXT_STEP_LABELS: Record<PlanFinalizationNextAction, string> = {
  clean_repository: 'Clean or stash local changes, then retry finalization.',
  resolve_conflicts: 'Resolve the conflicting files, then retry finalization.',
  finish_or_abort_merge: 'Finish or abort the in-progress merge, then retry finalization.',
};

const MACRO_NEXT_STEP_LABELS: Record<NonNullable<MacroSyncNextAction>, string> = {
  commit: 'Commit metadata changes before retrying sync.',
  push: 'Push the @macro branch after resolving the current issue.',
  pull: 'Pull the @macro branch again after resolving the current issue.',
  resolve_conflict: 'Resolve the conflicted metadata files, then retry sync.',
  configure_remote: 'Configure the origin remote before retrying sync.',
  configure_auth: 'Configure Git authentication before retrying sync.',
  retry: 'Retry the @macro sync after fixing the reported issue.',
};

const formatPromptEntries = (entries: ConflictResolutionEntry[]): string =>
  entries.map((entry) => {
    const parts = [
      `- Repository: ${entry.repoPath}`,
      entry.subtitle ? `  Context: ${entry.subtitle}` : null,
      entry.worktreePath ? `  Worktree: ${entry.worktreePath}` : null,
      entry.reason ? `  Blocking reason: ${entry.reason}` : null,
      entry.nextStep ? `  Next step: ${entry.nextStep}` : null,
      '  Conflicted files:',
      ...(entry.conflictFiles.length > 0
        ? entry.conflictFiles.map((file) => `    - ${file}`)
        : ['    - (none reported)']),
    ];

    return parts.filter(Boolean).join('\n');
  }).join('\n');

export const describePlanFinalizationNextStep = (
  nextAction: PlanFinalizationNextAction | null | undefined
): string | null => (nextAction ? PLAN_NEXT_STEP_LABELS[nextAction] : null);

export const describeMacroNextStep = (
  nextAction: MacroSyncNextAction | null | undefined
): string | null => (nextAction ? MACRO_NEXT_STEP_LABELS[nextAction] : null);

export const toPlanConflictResolutionEntries = (
  repositories: PlanReviewRepositoryResult[]
): ConflictResolutionEntry[] => repositories.map((repository) => ({
  id: repository.id,
  repoPath: repository.repoPath,
  subtitle: `${repository.planBranchName} -> ${repository.baseBranchName}`,
  worktreePath: null,
  statusLabel: repository.blockingKind === 'repository_dirty'
    ? 'Dirty'
    : repository.blockingKind === 'merge_in_progress'
      ? 'Merge in progress'
      : repository.blockingKind === 'merge_conflict'
        ? 'Conflict'
        : 'Ready',
  statusTone: repository.blockingReason ? 'danger' : 'success',
  reason: repository.blockingReason,
  nextStep: describePlanFinalizationNextStep(repository.nextAction),
  conflictFiles: repository.conflictFiles,
}));

export const toMergeWorkflowConflictResolutionEntries = (
  repositories: MergeWorkflowRepositoryResult[]
): ConflictResolutionEntry[] => repositories.map((repository) => ({
  id: repository.id,
  repoPath: repository.repoPath,
  subtitle: `${repository.sourceBranchName} -> ${repository.targetBranchName}`,
  worktreePath: null,
  statusLabel: repository.blockingKind === 'repository_dirty'
    ? 'Dirty'
    : repository.blockingKind === 'merge_in_progress'
      ? 'Merge in progress'
      : repository.blockingKind === 'merge_conflict'
        ? 'Conflict'
        : 'Ready',
  statusTone: repository.blockingReason ? 'danger' : 'success',
  reason: repository.blockingReason,
  nextStep: describePlanFinalizationNextStep(repository.nextAction),
  conflictFiles: repository.conflictFiles,
}));

export const toMacroConflictResolutionEntries = (
  repositories: MetadataSyncRepositoryStatus[]
): ConflictResolutionEntry[] => repositories.map((repository) => ({
  id: `${repository.projectId || 'repo'}::${repository.repoPath}`,
  repoPath: repository.repoPath,
  subtitle: '@macro metadata branch',
  worktreePath: repository.worktreePath,
  statusLabel: repository.state,
  statusTone: repository.state === 'clean'
    ? 'success'
    : repository.state === 'pending'
      ? 'warning'
      : 'danger',
  reason: repository.error || repository.reason || repository.state,
  nextStep: describeMacroNextStep(repository.nextAction),
  conflictFiles: repository.conflictFiles,
}));

export const buildPlanFinalizationConflictAssistantPrompt = (params: {
  planTitle: string;
  repositories: PlanReviewRepositoryResult[];
}): string => {
  const entries = toPlanConflictResolutionEntries(params.repositories);

  return [
    `I need help resolving Macro plan finalization blockers for "${params.planTitle}".`,
    'This flow is preflight-blocked. Do not start a merge automatically.',
    'Resolve only the reported repository issues, keep history intact, and stay in the desktop local-first workflow.',
    '',
    'Blocked repositories:',
    formatPromptEntries(entries),
    '',
    'Act directly with the available Macro tools to resolve safe blockers. If a tool needs approval or a blocker is unsafe to modify automatically, explain exactly what remains.',
  ].join('\n');
};

export const buildMergeWorkflowConflictAssistantPrompt = (params: {
  kind: MergeWorkflowKind;
  title: string;
  repositories: MergeWorkflowRepositoryResult[];
}): string => {
  const entries = toMergeWorkflowConflictResolutionEntries(params.repositories);
  const intro =
    params.kind === 'plan_finalization'
      ? `I need help resolving Macro plan finalization blockers for "${params.title}".`
      : `I need help resolving Macro merge blockers for task "${params.title}".`;
  const workflowLine =
    params.kind === 'plan_finalization'
      ? 'This flow is preflight-blocked. Do not start a merge automatically.'
      : 'This task is blocked during merge completion. Resolve only the reported merge blockers and keep the task on its current branches.';

  return [
    intro,
    workflowLine,
    'Resolve only the reported repository issues, keep history intact, and stay in the desktop local-first workflow.',
    '',
    'Blocked repositories:',
    formatPromptEntries(entries),
    '',
    'Act directly with the available Macro tools to resolve safe blockers. If a tool needs approval or a blocker is unsafe to modify automatically, explain exactly what remains.',
  ].join('\n');
};

export const buildMacroConflictAssistantPrompt = (params: {
  repositories: MetadataSyncRepositoryStatus[];
}): string => {
  const entries = toMacroConflictResolutionEntries(params.repositories);

  return [
    'I need help resolving @macro metadata sync blockers in Macro.',
    'Do not touch unrelated code branch history.',
    'Resolve only the metadata worktree issues below and keep the workflow safe for an explicit retry.',
    '',
    'Affected repositories:',
    formatPromptEntries(entries),
    '',
    'Act directly with the available Macro tools to resolve safe blockers. If a tool needs approval or a blocker is unsafe to modify automatically, explain exactly what remains.',
  ].join('\n');
};
