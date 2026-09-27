import { createArchitectPlanReadService, type ArchitectPlanReadService } from './architectPlanReadService';
import {
  createArchitectPlanMutationService,
  type ArchitectPlanMutationService,
} from './architectPlanMutationService';
import { createArchitectPlanSyncService, type ArchitectPlanSyncService } from './architectPlanSyncService';
import {
  resolveArchitectPlanServiceDependencies,
  type ArchitectPlanServiceDependencies,
} from './architectPlanReadContext';
import {
  isArchitectPlanStrategyMutable as isArchitectPlanStrategyMutableImpl,
} from './architectPlanReadModel';
import {
  isArchitectPlanStrategyMutationLocked as isArchitectPlanStrategyMutationLockedImpl,
} from './architectPlanReadModel';
import {
  isArchitectPlanRestorableStatus as isArchitectPlanRestorableStatusImpl,
} from './architectPlanReadModel';
import {
  getArchitectPlanCrudCapabilities as getArchitectPlanCrudCapabilitiesImpl,
} from './architectPlanReadModel';
import {
  isArchitectPlanReplicaDivergenceError as isArchitectPlanReplicaDivergenceErrorImpl,
} from './architectPlanReadModel';
import { isArchitectPlanSlugMutable as isArchitectPlanSlugMutableImpl } from './architectPlanReadModel';
import { hasPersistedArchitectStrategy as hasPersistedArchitectStrategyImpl } from './architectPlanReadModel';
import {
  getArchitectPlanEffectiveTargetBranchesByProjectId as getArchitectPlanEffectiveTargetBranchesByProjectIdImpl,
} from './architectPlanReadModel';
import {
  getArchitectPlanEffectiveTargetBranch as getArchitectPlanEffectiveTargetBranchImpl,
} from './architectPlanReadModel';
import { getArchitectPlanTargetDisplay as getArchitectPlanTargetDisplayImpl } from './architectPlanReadModel';
import {
  getArchitectPlanActionableProjectIds as getArchitectPlanActionableProjectIdsImpl,
} from './architectPlanReadModel';
import {
  getArchitectPlanVisibleProjectIds as getArchitectPlanVisibleProjectIdsImpl,
} from './architectPlanReadModel';
import { getArchitectPlanProjectIds as getArchitectPlanProjectIdsImpl } from './architectPlanReadModel';
import {
  isArchitectPlanVisibleForScope as isArchitectPlanVisibleForScopeImpl,
} from './architectPlanReadModel';
import {
  getArchitectPlanTargetBranchesByProjectId as getArchitectPlanTargetBranchesByProjectIdImpl,
} from './architectPlanReadModel';
import {
  getArchitectPlanTargetBranchForProject as getArchitectPlanTargetBranchForProjectImpl,
} from './architectPlanReadModel';
import { planHasMixedTargetBranches as planHasMixedTargetBranchesImpl } from './architectPlanReadModel';
import { planMatchesProjectId as planMatchesProjectIdImpl } from './architectPlanReadModel';
import { resolvePlanProjectContextId as resolvePlanProjectContextIdImpl } from './architectPlanReadModel';
import { toPlanScopedFeatureBranch as toPlanScopedFeatureBranchImpl } from './architectPlanReadModel';
import { toPlanIntegrationBranch as toPlanIntegrationBranchImpl } from './architectPlanReadModel';
import { resolveTargetBranch as resolveTargetBranchImpl } from './architectPlanReadModel';
import { getGitFlowBaseBranch as getGitFlowBaseBranchImpl } from './architectPlanReadModel';
import { getGitFlowMainBranch as getGitFlowMainBranchImpl } from './architectPlanReadModel';
import {
  clearArchitectPlanFrontendCaches as clearArchitectPlanFrontendCachesImpl,
} from './architectPlanReadContext';
import {
  getArchitectPlanChatTranscript as getArchitectPlanChatTranscriptImpl,
} from './architectPlanReadService';
import {
  getArchitectPlanActivationPayload as getArchitectPlanActivationPayloadImpl,
} from './architectPlanReadService';
import { listArchitectPlans as listArchitectPlansImpl } from './architectPlanReadService';
import { isArchitectPlanSlugAvailable as isArchitectPlanSlugAvailableImpl } from './architectPlanReadService';
import { getArchitectPlan as getArchitectPlanImpl, readArchitectPlanSnapshot as readArchitectPlanSnapshotImpl } from './architectPlanReadService';
import { getArchitectPlanChatMessages as getArchitectPlanChatMessagesImpl } from './architectPlanReadService';
import {
  inspectArchitectPlanMetadataHealth as inspectArchitectPlanMetadataHealthImpl,
} from './architectPlanReadService';
import {
  listArchitectPlanTargetBranches as listArchitectPlanTargetBranchesImpl,
} from './architectPlanReadService';
import { commitArchitectPlanMetadata as commitArchitectPlanMetadataImpl } from './architectPlanSyncService';
import {
  saveArchitectPlanChatMessages as saveArchitectPlanChatMessagesImpl,
} from './architectPlanSyncService';
import {
  syncArchitectPlanChatFromConversation as syncArchitectPlanChatFromConversationImpl,
} from './architectPlanSyncService';
import { repairArchitectPlanReplicas as repairArchitectPlanReplicasImpl } from './architectPlanSyncService';
import { repairArchitectPlanMetadata as repairArchitectPlanMetadataImpl } from './architectPlanSyncService';
import { writeArchitectTaskExecution as writeArchitectTaskExecutionImpl } from './architectPlanSyncService';
import { createArchitectPlan as createArchitectPlanImpl } from './architectPlanMutationService';
import {
  mutateArchitectPlanTaskStatus as mutateArchitectPlanTaskStatusImpl,
} from './architectPlanMutationService';
import { updateArchitectPlan as updateArchitectPlanImpl } from './architectPlanMutationService';
import {
  bindArchitectPlanConversation as bindArchitectPlanConversationImpl,
} from './architectPlanMutationService';
import { setActiveArchitectPlan as setActiveArchitectPlanImpl } from './architectPlanMutationService';
import { deleteArchitectPlan as deleteArchitectPlanImpl } from './architectPlanMutationService';
import { restoreArchitectPlan as restoreArchitectPlanImpl } from './architectPlanMutationService';
import { archiveArchitectPlan as archiveArchitectPlanImpl } from './architectPlanMutationService';
import { mutateArchitectPlan as mutateArchitectPlanImpl } from './architectPlanMutationService';

/** Compatibility facade. Each capability is also usable independently. */
export interface ArchitectPlanService extends ArchitectPlanReadService, ArchitectPlanMutationService, ArchitectPlanSyncService {}

export const createArchitectPlanService = (overrides: ArchitectPlanServiceDependencies = {}): ArchitectPlanService => {
  const deps = resolveArchitectPlanServiceDependencies(overrides);
  return {
    ...createArchitectPlanReadService(deps),
    ...createArchitectPlanMutationService(deps),
    ...createArchitectPlanSyncService(deps),
  };
};

export {
  type ArchitectPlanStatus,
  type ArchitectPlanRestorableStatus,
  ARCHITECT_STRATEGY_LOCKED_AFTER_VALIDATION_MESSAGE,
  type ArchitectPlanReplicationState,
  type ArchitectPlanParticipant,
  type ArchitectPlanContentHashes,
  type ArchitectPlanArtifactManifestSummary,
  type ArchitectPlanConversationSnapshot,
  type ArchitectPlanDeletionSnapshot,
  type ArchitectPlanManifest,
  type ArchitectPlanChatMessage,
  type ArchitectPlanRecord,
  type ArchitectPlanSummary,
  type ArchitectPlanReplica,
  type ArchitectPlanReplicaDivergence,
  type ArchitectPlanMetadataHealthStatus,
  type ArchitectPlanMetadataHealth,
  type ArchitectPlanMetadataRepairResult,
  type ArchitectPlanCrudCapabilities,
  type ArchitectPlanActivationResolutionMode,
  type ArchitectPlanActivationPayload,
  type ArchitectPlanActivationOptions,
  ArchitectPlanReplicaDivergenceError,
  type ArchitectPlanReplicaRepairStrategy,
  type ProjectGitFlowSettingsResolver,
  type ArchitectTaskExecutionRecord,
} from './architectPlanReadModel';
export const isArchitectPlanStrategyMutable: typeof isArchitectPlanStrategyMutableImpl = (...args) => isArchitectPlanStrategyMutableImpl(...args);
export const isArchitectPlanStrategyMutationLocked: typeof isArchitectPlanStrategyMutationLockedImpl = (...args) => isArchitectPlanStrategyMutationLockedImpl(...args);
export const isArchitectPlanRestorableStatus = (status: Parameters<typeof isArchitectPlanRestorableStatusImpl>[0]): status is import('./architectPlanReadModel').ArchitectPlanRestorableStatus => isArchitectPlanRestorableStatusImpl(status);
export const getArchitectPlanCrudCapabilities: typeof getArchitectPlanCrudCapabilitiesImpl = (...args) => getArchitectPlanCrudCapabilitiesImpl(...args);
export const isArchitectPlanReplicaDivergenceError = (value: unknown): value is import('./architectPlanReadModel').ArchitectPlanReplicaDivergenceError => isArchitectPlanReplicaDivergenceErrorImpl(value);
export const isArchitectPlanSlugMutable: typeof isArchitectPlanSlugMutableImpl = (...args) => isArchitectPlanSlugMutableImpl(...args);
export const hasPersistedArchitectStrategy: typeof hasPersistedArchitectStrategyImpl = (...args) => hasPersistedArchitectStrategyImpl(...args);
export const getArchitectPlanEffectiveTargetBranchesByProjectId: typeof getArchitectPlanEffectiveTargetBranchesByProjectIdImpl = (...args) => getArchitectPlanEffectiveTargetBranchesByProjectIdImpl(...args);
export const getArchitectPlanEffectiveTargetBranch: typeof getArchitectPlanEffectiveTargetBranchImpl = (...args) => getArchitectPlanEffectiveTargetBranchImpl(...args);
export const getArchitectPlanTargetDisplay: typeof getArchitectPlanTargetDisplayImpl = (...args) => getArchitectPlanTargetDisplayImpl(...args);
export const getArchitectPlanActionableProjectIds: typeof getArchitectPlanActionableProjectIdsImpl = (...args) => getArchitectPlanActionableProjectIdsImpl(...args);
export const getArchitectPlanVisibleProjectIds: typeof getArchitectPlanVisibleProjectIdsImpl = (...args) => getArchitectPlanVisibleProjectIdsImpl(...args);
export const getArchitectPlanProjectIds: typeof getArchitectPlanProjectIdsImpl = (...args) => getArchitectPlanProjectIdsImpl(...args);
export const isArchitectPlanVisibleForScope: typeof isArchitectPlanVisibleForScopeImpl = (...args) => isArchitectPlanVisibleForScopeImpl(...args);
export const getArchitectPlanTargetBranchesByProjectId: typeof getArchitectPlanTargetBranchesByProjectIdImpl = (...args) => getArchitectPlanTargetBranchesByProjectIdImpl(...args);
export const getArchitectPlanTargetBranchForProject: typeof getArchitectPlanTargetBranchForProjectImpl = (...args) => getArchitectPlanTargetBranchForProjectImpl(...args);
export const planHasMixedTargetBranches: typeof planHasMixedTargetBranchesImpl = (...args) => planHasMixedTargetBranchesImpl(...args);
export const planMatchesProjectId: typeof planMatchesProjectIdImpl = (...args) => planMatchesProjectIdImpl(...args);
export const resolvePlanProjectContextId: typeof resolvePlanProjectContextIdImpl = (...args) => resolvePlanProjectContextIdImpl(...args);
export const toPlanScopedFeatureBranch: typeof toPlanScopedFeatureBranchImpl = (...args) => toPlanScopedFeatureBranchImpl(...args);
export const toPlanIntegrationBranch: typeof toPlanIntegrationBranchImpl = (...args) => toPlanIntegrationBranchImpl(...args);
export const resolveTargetBranch: typeof resolveTargetBranchImpl = (...args) => resolveTargetBranchImpl(...args);
export const getGitFlowBaseBranch: typeof getGitFlowBaseBranchImpl = (...args) => getGitFlowBaseBranchImpl(...args);
export const getGitFlowMainBranch: typeof getGitFlowMainBranchImpl = (...args) => getGitFlowMainBranchImpl(...args);

export {
  type ArchitectPlanServiceAppState,
  type ArchitectPlanServiceDependencies,
} from './architectPlanReadContext';
export const clearArchitectPlanFrontendCaches: typeof clearArchitectPlanFrontendCachesImpl = (...args) => clearArchitectPlanFrontendCachesImpl(...args);

export {
  type ArchitectPlanChatTranscriptOptions,
  type ListArchitectPlansOptions,
} from './architectPlanReadService';
export const getArchitectPlanChatTranscript: typeof getArchitectPlanChatTranscriptImpl = (...args) => getArchitectPlanChatTranscriptImpl(...args);
export const getArchitectPlanActivationPayload: typeof getArchitectPlanActivationPayloadImpl = (...args) => getArchitectPlanActivationPayloadImpl(...args);
export const listArchitectPlans: typeof listArchitectPlansImpl = (...args) => listArchitectPlansImpl(...args);
export const isArchitectPlanSlugAvailable: typeof isArchitectPlanSlugAvailableImpl = (...args) => isArchitectPlanSlugAvailableImpl(...args);
export const getArchitectPlan: typeof getArchitectPlanImpl = (...args) => getArchitectPlanImpl(...args);
export const readArchitectPlanSnapshot: typeof readArchitectPlanSnapshotImpl = (...args) => readArchitectPlanSnapshotImpl(...args);
export const getArchitectPlanChatMessages: typeof getArchitectPlanChatMessagesImpl = (...args) => getArchitectPlanChatMessagesImpl(...args);
export const inspectArchitectPlanMetadataHealth: typeof inspectArchitectPlanMetadataHealthImpl = (...args) => inspectArchitectPlanMetadataHealthImpl(...args);
export const listArchitectPlanTargetBranches: typeof listArchitectPlanTargetBranchesImpl = (...args) => listArchitectPlanTargetBranchesImpl(...args);

export const commitArchitectPlanMetadata: typeof commitArchitectPlanMetadataImpl = (...args) => commitArchitectPlanMetadataImpl(...args);
export const saveArchitectPlanChatMessages: typeof saveArchitectPlanChatMessagesImpl = (...args) => saveArchitectPlanChatMessagesImpl(...args);
export const syncArchitectPlanChatFromConversation: typeof syncArchitectPlanChatFromConversationImpl = (...args) => syncArchitectPlanChatFromConversationImpl(...args);
export const repairArchitectPlanReplicas: typeof repairArchitectPlanReplicasImpl = (...args) => repairArchitectPlanReplicasImpl(...args);
export const repairArchitectPlanMetadata: typeof repairArchitectPlanMetadataImpl = (...args) => repairArchitectPlanMetadataImpl(...args);
export const writeArchitectTaskExecution: typeof writeArchitectTaskExecutionImpl = (...args) => writeArchitectTaskExecutionImpl(...args);

export { type UpdateArchitectPlanInput } from './architectPlanMutationService';
export const createArchitectPlan: typeof createArchitectPlanImpl = (...args) => createArchitectPlanImpl(...args);
export const mutateArchitectPlanTaskStatus: typeof mutateArchitectPlanTaskStatusImpl = (...args) => mutateArchitectPlanTaskStatusImpl(...args);
export const updateArchitectPlan: typeof updateArchitectPlanImpl = (...args) => updateArchitectPlanImpl(...args);
export const bindArchitectPlanConversation: typeof bindArchitectPlanConversationImpl = (...args) => bindArchitectPlanConversationImpl(...args);
export const setActiveArchitectPlan: typeof setActiveArchitectPlanImpl = (...args) => setActiveArchitectPlanImpl(...args);
export const deleteArchitectPlan: typeof deleteArchitectPlanImpl = (...args) => deleteArchitectPlanImpl(...args);
export const restoreArchitectPlan: typeof restoreArchitectPlanImpl = (...args) => restoreArchitectPlanImpl(...args);
export const archiveArchitectPlan: typeof archiveArchitectPlanImpl = (...args) => archiveArchitectPlanImpl(...args);

export const mutateArchitectPlan: typeof mutateArchitectPlanImpl = (...args) => mutateArchitectPlanImpl(...args);
