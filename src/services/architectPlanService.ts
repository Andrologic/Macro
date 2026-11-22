import {
archiveArchitectPlan as archiveArchitectPlanImpl,
bindArchitectPlanConversation as bindArchitectPlanConversationImpl,
createArchitectPlan as createArchitectPlanImpl,
createArchitectPlanMutationService,
deleteArchitectPlan as deleteArchitectPlanImpl,
mutateAgsdlPlanLifecycle as mutateAgsdlPlanLifecycleImpl,
mutateArchitectPlan as mutateArchitectPlanImpl,
mutateArchitectPlanTaskStatus as mutateArchitectPlanTaskStatusImpl,
restoreArchitectPlan as restoreArchitectPlanImpl,
setActiveArchitectPlan as setActiveArchitectPlanImpl,
updateArchitectPlan as updateArchitectPlanImpl,
type ArchitectPlanMutationService,
} from './architectPlanMutationService';
import {
clearArchitectPlanFrontendCaches as clearArchitectPlanFrontendCachesImpl,
resolveArchitectPlanServiceDependencies,
type ArchitectPlanServiceDependencies,
} from './architectPlanReadContext';
import {
getArchitectPlanActionableProjectIds as getArchitectPlanActionableProjectIdsImpl,
getArchitectPlanCrudCapabilities as getArchitectPlanCrudCapabilitiesImpl,
getArchitectPlanEffectiveTargetBranchesByProjectId as getArchitectPlanEffectiveTargetBranchesByProjectIdImpl,
getArchitectPlanEffectiveTargetBranch as getArchitectPlanEffectiveTargetBranchImpl,
getArchitectPlanProjectIds as getArchitectPlanProjectIdsImpl,
getArchitectPlanTargetBranchesByProjectId as getArchitectPlanTargetBranchesByProjectIdImpl,
getArchitectPlanTargetBranchForProject as getArchitectPlanTargetBranchForProjectImpl,
getArchitectPlanTargetDisplay as getArchitectPlanTargetDisplayImpl,
getArchitectPlanVisibleProjectIds as getArchitectPlanVisibleProjectIdsImpl,
getGitFlowBaseBranch as getGitFlowBaseBranchImpl,
getGitFlowMainBranch as getGitFlowMainBranchImpl,
hasPersistedArchitectStrategy as hasPersistedArchitectStrategyImpl,
isArchitectPlanReplicaDivergenceError as isArchitectPlanReplicaDivergenceErrorImpl,
isArchitectPlanRestorableStatus as isArchitectPlanRestorableStatusImpl,
isArchitectPlanSlugMutable as isArchitectPlanSlugMutableImpl,
isArchitectPlanStrategyMutable as isArchitectPlanStrategyMutableImpl,
isArchitectPlanStrategyMutationLocked as isArchitectPlanStrategyMutationLockedImpl,
isArchitectPlanVisibleForScope as isArchitectPlanVisibleForScopeImpl,
planHasMixedTargetBranches as planHasMixedTargetBranchesImpl,
planMatchesProjectId as planMatchesProjectIdImpl,
resolvePlanProjectContextId as resolvePlanProjectContextIdImpl,
resolveTargetBranch as resolveTargetBranchImpl,
toPlanIntegrationBranch as toPlanIntegrationBranchImpl,
toPlanScopedFeatureBranch as toPlanScopedFeatureBranchImpl,
} from './architectPlanReadModel';
import { createArchitectPlanReadService,getArchitectPlanActivationPayload as getArchitectPlanActivationPayloadImpl,getArchitectPlanChatMessages as getArchitectPlanChatMessagesImpl,getArchitectPlanChatTranscript as getArchitectPlanChatTranscriptImpl,getArchitectPlan as getArchitectPlanImpl,inspectArchitectPlanMetadataHealth as inspectArchitectPlanMetadataHealthImpl,isArchitectPlanSlugAvailable as isArchitectPlanSlugAvailableImpl,listArchitectPlans as listArchitectPlansImpl,listArchitectPlanTargetBranches as listArchitectPlanTargetBranchesImpl,readArchitectPlanSnapshot as readArchitectPlanSnapshotImpl,type ArchitectPlanReadService } from './architectPlanReadService';
import { commitArchitectPlanMetadata as commitArchitectPlanMetadataImpl,createArchitectPlanSyncService,repairArchitectPlanMetadata as repairArchitectPlanMetadataImpl,repairArchitectPlanReplicas as repairArchitectPlanReplicasImpl,saveArchitectPlanChatMessages as saveArchitectPlanChatMessagesImpl,syncArchitectPlanChatFromConversation as syncArchitectPlanChatFromConversationImpl,writeArchitectTaskExecution as writeArchitectTaskExecutionImpl,type ArchitectPlanSyncService } from './architectPlanSyncService';

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
ARCHITECT_STRATEGY_LOCKED_AFTER_VALIDATION_MESSAGE,ArchitectPlanReplicaDivergenceError,type ArchitectPlanActivationOptions,type ArchitectPlanActivationPayload,type ArchitectPlanActivationResolutionMode,type ArchitectPlanArtifactManifestSummary,type ArchitectPlanChatMessage,type ArchitectPlanContentHashes,type ArchitectPlanConversationSnapshot,type ArchitectPlanCrudCapabilities,type ArchitectPlanDeletionSnapshot,
type ArchitectPlanManifest,type ArchitectPlanMetadataHealth,type ArchitectPlanMetadataHealthStatus,type ArchitectPlanMetadataRepairResult,type ArchitectPlanParticipant,type ArchitectPlanRecord,type ArchitectPlanReplica,
type ArchitectPlanReplicaDivergence,type ArchitectPlanReplicaRepairStrategy,type ArchitectPlanReplicationState,type ArchitectPlanRestorableStatus,type ArchitectPlanStatus,type ArchitectPlanSummary,type ArchitectTaskExecutionRecord,type ProjectGitFlowSettingsResolver
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
type ArchitectPlanServiceDependencies
} from './architectPlanReadContext';
export const clearArchitectPlanFrontendCaches: typeof clearArchitectPlanFrontendCachesImpl = (...args) => clearArchitectPlanFrontendCachesImpl(...args);

export {
type ArchitectPlanChatTranscriptOptions,
type ListArchitectPlansOptions
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
export const mutateAgsdlPlanLifecycle: typeof mutateAgsdlPlanLifecycleImpl = (...args) => mutateAgsdlPlanLifecycleImpl(...args);

export const mutateArchitectPlan: typeof mutateArchitectPlanImpl = (...args) => mutateArchitectPlanImpl(...args);
