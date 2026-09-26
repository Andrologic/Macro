import type { PlanNode, PredictedBranch, ProjectGitFlowSettings } from '../types';
import * as tauriIpc from './tauriIpc';
import { devLogger } from '../utils/devLogger';
import {
  getArchitectPlanLifecyclePhase,
  isCanonicalArchitectPlan,
  isDefaultNewPlanFamilyLabel,
} from './architectPlanPresentation';
import {
  getArchitectGitNamingSettings,
  isMainlineGitWorkflow,
  normalizeFeatureSlugInput,
  toPlanFeatureBranchName,
  toPlanIntegrationBranchName,
} from './architectGitNaming';
import {
  isSyntheticProjectId,
  normalizeProjectRegistryPath,
  type ValidProjectRegistrySnapshot,
} from './validProjectRegistry';
import {
  getArchitectPlanActionableProjectIdsFromScope,
  getArchitectPlanVisibleProjectIdsFromScope,
  normalizeArchitectPlanIdList,
  normalizeArchitectPlanScope,
} from './architectPlanScope';
import {
  getArchitectPlanKind,
  normalizeArchitectPlanGitFlowMetadata,
  normalizeArchitectPlanKind,
  renderArchitectPlanIntegrationBranchName,
  type ArchitectPlanGitFlowMetadata,
  type ArchitectPlanKind,
} from './architectPlanKinds';
import { SERVICE_ERROR_CODES, createPlanMetadataMissingError } from './contracts/errors';
import { type ResolvedArchitectPlanServiceDependencies } from './architectPlanReadContext';

export type ArchitectPlanStatus =
  | 'draft'
  | 'validated'
  | 'in_progress'
  | 'completed'
  | 'archived'
  | 'deleted';

export type ArchitectPlanRestorableStatus = Exclude<ArchitectPlanStatus, 'archived' | 'deleted'>;

export const ARCHITECT_STRATEGY_LOCKED_AFTER_VALIDATION_MESSAGE =
  'This plan has already been validated. Strategy changes are temporarily disabled for validated plans.';

export const isArchitectPlanStrategyMutable = (
  status: ArchitectPlanStatus | string | null | undefined,
): boolean => status === 'draft';

export const isArchitectPlanStrategyMutationLocked = (
  status: ArchitectPlanStatus | string | null | undefined,
): boolean => typeof status === 'string' && status.trim().length > 0 && !isArchitectPlanStrategyMutable(status);

export type ArchitectPlanReplicationState =
  | 'healthy'
  | 'missing_projects'
  | 'diverged'
  | 'deleted';

export interface ArchitectPlanParticipant {
  projectId: string;
  repoPathSnapshot: string | null;
  mountName?: string | null;
  displayName?: string | null;
}

export interface ArchitectPlanContentHashes {
  plan: string;
  chat: string;
}

export interface ArchitectPlanArtifactManifestSummary {
  count: number;
  indexHash: string;
  contentHash: string;
  reviewHash?: string;
  updatedAt: string;
}

export interface ArchitectPlanConversationSnapshot {
  conversationId: string | null;
  title: string | null;
  messageCount: number;
  lastMessageAt: string | null;
}

export interface ArchitectPlanDeletionSnapshot {
  deletedAt: string;
}

export interface ArchitectPlanManifest {
  schemaVersion: 3;
  planId: string;
  planKind?: ArchitectPlanKind;
  gitFlowPlan?: ArchitectPlanGitFlowMetadata;
  targetBranch: string;
  targetBranchesByProjectId?: Record<string, string>;
  status: ArchitectPlanStatus;
  expectedProjectIds: string[];
  contextProjectIds?: string[];
  participants: ArchitectPlanParticipant[];
  revision: number;
  updatedAt: string;
  contentHashes: ArchitectPlanContentHashes;
  artifacts?: ArchitectPlanArtifactManifestSummary;
  conversation: ArchitectPlanConversationSnapshot;
  deletion: ArchitectPlanDeletionSnapshot | null;
}

export interface ArchitectPlanChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}

export interface ArchitectPlanRecord {
  id: string;
  slug: string;
  title: string;
  label?: string;
  description: string;
  planKind?: ArchitectPlanKind;
  gitFlowPlan?: ArchitectPlanGitFlowMetadata;
  status: ArchitectPlanStatus;
  archivedAt?: string;
  archivedFromStatus?: ArchitectPlanRestorableStatus;
  deletedAt?: string;
  targetBranch: string;
  targetBranchesByProjectId?: Record<string, string>;
  executionModesByProjectId?: Record<string, 'git' | 'direct'>;
  conversationId?: string;
  projectId?: string;
  projectIds?: string[];
  contextProjectIds?: string[];
  createdAt: string;
  updatedAt: string;
  nodes: PlanNode[];
  predictedBranches: PredictedBranch[];
  expectedProjectIds?: string[];
  availableProjectIds?: string[];
  missingProjectIds?: string[];
  replicationState?: ArchitectPlanReplicationState;
  revision?: number;
  replicas?: ArchitectPlanReplica[];
  hasReplicaDivergence?: boolean;
}

export interface ArchitectPlanSummary {
  id: string;
  slug: string;
  title: string;
  label?: string;
  description: string;
  planKind?: ArchitectPlanKind;
  gitFlowPlan?: ArchitectPlanGitFlowMetadata;
  status: ArchitectPlanStatus;
  archivedAt?: string;
  archivedFromStatus?: ArchitectPlanRestorableStatus;
  deletedAt?: string;
  targetBranch: string;
  targetBranchesByProjectId?: Record<string, string>;
  executionModesByProjectId?: Record<string, 'git' | 'direct'>;
  conversationId?: string;
  projectId?: string;
  projectIds?: string[];
  contextProjectIds?: string[];
  createdAt: string;
  updatedAt: string;
  nodeCount: number;
  predictedBranchCount?: number;
  chatMessageCount?: number;
  expectedProjectIds?: string[];
  availableProjectIds?: string[];
  missingProjectIds?: string[];
  replicationState?: ArchitectPlanReplicationState;
  revision?: number;
  replicas?: ArchitectPlanReplica[];
  hasReplicaDivergence?: boolean;
}

export interface ArchitectPlanReplica {
  scopeKey: string;
  projectId: string | null;
  repoPath: string | null;
  workspacePath: string | null;
  source: 'local' | 'project' | 'workspace';
  updatedAt?: string | null;
  missing?: boolean;
}

export interface ArchitectPlanReplicaDivergence {
  branchName: string;
  planId: string;
  reason: 'content_diverged' | 'missing_replica';
  replicas: ArchitectPlanReplica[];
}

export type ArchitectPlanMetadataHealthStatus =
  | 'healthy'
  | 'missing_replica'
  | 'diverged'
  | 'runtime_orphan'
  | 'missing';

export interface ArchitectPlanMetadataHealth {
  branchName: string;
  planId: string;
  status: ArchitectPlanMetadataHealthStatus;
  replicas: ArchitectPlanReplica[];
  orphanedReplicas: ArchitectPlanReplica[];
  technicalMessage: string | null;
}

export interface ArchitectPlanMetadataRepairResult {
  branchName: string;
  planId: string;
  statusBeforeRepair: ArchitectPlanMetadataHealthStatus;
  removedOrphanedReplicas: ArchitectPlanReplica[];
  repairedPlan: ArchitectPlanRecord | null;
}

export interface ArchitectPlanCrudCapabilities {
  canArchive: boolean;
  canRestore: boolean;
  canDelete: boolean;
  canPurgeLegacyDeleted: boolean;
  deleteRequiresCleanup: boolean;
  canEditDetails: boolean;
  canEditDraftContent: boolean;
  canEditSlug: boolean;
  canEditScope: boolean;
  canEditStrategyDirectly: boolean;
}

export const RESTORABLE_PLAN_STATUS_SET = new Set<ArchitectPlanRestorableStatus>([
  'draft',
  'validated',
  'in_progress',
  'completed',
]);

export const PLAN_DELETE_CLEANUP_STATUS_SET = new Set<ArchitectPlanStatus>([
  'archived',
]);

export const isArchitectPlanRestorableStatus = (
  status: string | null | undefined
): status is ArchitectPlanRestorableStatus =>
  Boolean(status && RESTORABLE_PLAN_STATUS_SET.has(status as ArchitectPlanRestorableStatus));

export const getArchitectPlanCrudCapabilities = (
  plan: Pick<ArchitectPlanRecord | ArchitectPlanSummary, 'status'>
): ArchitectPlanCrudCapabilities => {
  const isDeleted = plan.status === 'deleted';
  const isArchived = plan.status === 'archived';
  const isDraft = plan.status === 'draft';
  return {
    canArchive: !isDeleted && !isArchived,
    canRestore: isArchived,
    canDelete: isArchived,
    canPurgeLegacyDeleted: isDeleted,
    deleteRequiresCleanup: PLAN_DELETE_CLEANUP_STATUS_SET.has(plan.status),
    canEditDetails: !isDeleted && !isArchived,
    canEditDraftContent: isDraft,
    canEditSlug: isDraft,
    canEditScope: isDraft,
    canEditStrategyDirectly: isDraft,
  };
};

export const resolveArchivedArchitectPlanRestoreStatus = (
  plan: Pick<ArchitectPlanRecord | ArchitectPlanSummary, 'archivedFromStatus'>
): ArchitectPlanRestorableStatus =>
  isArchitectPlanRestorableStatus(plan.archivedFromStatus)
    ? plan.archivedFromStatus
    : 'draft';

export type ArchitectPlanActivationResolutionMode = 'blank_fast_path' | 'full';

export interface ArchitectPlanActivationPayload {
  plan: ArchitectPlanRecord;
  chatMessages: ArchitectPlanChatMessage[];
  chatMessagesLoaded?: boolean;
  chatTranscriptRevision?: string | null;
  chatMessageCount?: number;
  replicaScopeKey?: string | null;
  replicaProjectId?: string | null;
  conversationId: string | null;
  sharedConversation: boolean;
  targetBranch: string;
  resolutionMode: ArchitectPlanActivationResolutionMode;
}

export interface ArchitectPlanActivationOptions {
  summaryHint?: ArchitectPlanSummary | null;
  scopedProjectIdsHint?: string[];
  allowIndexFallback?: boolean;
}

export const applyArchitectPlanLifecycleForStatus = <T extends {
  status: ArchitectPlanStatus;
  updatedAt: string;
  archivedAt?: string;
  archivedFromStatus?: ArchitectPlanRestorableStatus;
  deletedAt?: string;
}>(
  plan: T,
  previousStatus?: ArchitectPlanStatus
): T => {
  if (plan.status === 'archived') {
    return {
      ...plan,
      archivedAt:
        typeof plan.archivedAt === 'string' && plan.archivedAt.trim().length > 0
          ? plan.archivedAt
          : plan.updatedAt,
      archivedFromStatus: isArchitectPlanRestorableStatus(plan.archivedFromStatus)
        ? plan.archivedFromStatus
        : isArchitectPlanRestorableStatus(previousStatus)
          ? previousStatus
          : 'draft',
      deletedAt: undefined,
    };
  }

  if (plan.status === 'deleted') {
    return {
      ...plan,
      archivedAt: undefined,
      archivedFromStatus: undefined,
      deletedAt:
        typeof plan.deletedAt === 'string' && plan.deletedAt.trim().length > 0
          ? plan.deletedAt
          : plan.updatedAt,
    };
  }

  return {
    ...plan,
    archivedAt: undefined,
    archivedFromStatus: undefined,
    deletedAt: undefined,
  };
};

export const canUseBlankActivationSummary = (
  summary: ArchitectPlanSummary | null
): boolean => {
  if (!summary) {
    return false;
  }

  return (
    isCanonicalArchitectPlan(summary) &&
    isDefaultNewPlanFamilyLabel(summary.label) &&
    getArchitectPlanLifecyclePhase(summary) === 'blank'
  );
};

export const planRecordFromActivationSummary = (
  summary: ArchitectPlanSummary,
  branchName: string
): ArchitectPlanRecord => {
  const scope = normalizeArchitectPlanScope(summary, {
    useExpectedAsActionableFallback: true,
  });

  return {
    id: summary.id,
    slug: summary.slug,
    title: summary.title,
    label: summary.label,
    description: summary.description,
    planKind: summary.planKind,
    gitFlowPlan: summary.gitFlowPlan,
    status: summary.status,
    targetBranch: normalizeBranchName(summary.targetBranch || branchName),
    targetBranchesByProjectId: summary.targetBranchesByProjectId,
    executionModesByProjectId: summary.executionModesByProjectId,
    conversationId: summary.conversationId,
    projectId: scope.actionableProjectIds[0],
    projectIds: scope.actionableProjectIds,
    contextProjectIds: scope.contextProjectIds,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    nodes: [],
    predictedBranches: [],
    expectedProjectIds: scope.expectedProjectIds,
    availableProjectIds: summary.availableProjectIds,
    missingProjectIds: summary.missingProjectIds,
    replicationState: summary.replicationState,
    revision: summary.revision,
    replicas: summary.replicas,
    hasReplicaDivergence: summary.hasReplicaDivergence,
  };
};

export class ArchitectPlanReplicaDivergenceError extends Error {
  readonly code = SERVICE_ERROR_CODES.PLAN_REPLICA_DIVERGED;
  readonly divergence: ArchitectPlanReplicaDivergence;

  constructor(divergence: ArchitectPlanReplicaDivergence) {
    super(
      divergence.reason === 'missing_replica'
        ? `Plan ${divergence.planId} is missing metadata replicas in one or more project repositories.`
        : `Plan ${divergence.planId} has diverged metadata replicas across repositories.`
    );
    this.name = 'ArchitectPlanReplicaDivergenceError';
    this.divergence = divergence;
  }
}

export const isArchitectPlanReplicaDivergenceError = (
  value: unknown
): value is ArchitectPlanReplicaDivergenceError =>
  value instanceof ArchitectPlanReplicaDivergenceError ||
  (value instanceof Error &&
    ((value as { code?: string }).code === SERVICE_ERROR_CODES.PLAN_REPLICA_DIVERGED ||
      (value as { code?: string }).code === 'ARCHITECT_PLAN_REPLICA_DIVERGENCE') &&
    'divergence' in value);

export type ArchitectPlanReplicaRepairStrategy = 'newest' | 'oldest';

export type ArchitectPlanProjectRef = Pick<
  ArchitectPlanSummary,
  | 'projectId'
  | 'projectIds'
  | 'expectedProjectIds'
  | 'contextProjectIds'
  | 'availableProjectIds'
  | 'replicas'
>;

export type ArchitectPlanTargetBranchRef = Pick<
  ArchitectPlanRecord,
  'projectId' | 'projectIds' | 'targetBranch'
> & {
  planKind?: ArchitectPlanKind;
  gitFlowPlan?: ArchitectPlanGitFlowMetadata;
  contextProjectIds?: string[];
  expectedProjectIds?: string[];
  targetBranchesByProjectId?: Record<string, string>;
};

export interface ArchitectPlanIndex {
  version: 2 | 3;
  activePlanId: string | null;
  plans: ArchitectPlanSummary[];
  reservedPlanSlugs: string[];
}

export const LOCAL_INDEX_KEY_PREFIX = 'macro_architect_plan_index';

export const LOCAL_PLAN_KEY_PREFIX = 'macro_architect_plan';

export const LOCAL_PLAN_CHAT_KEY_PREFIX = 'macro_architect_plan_chat';

export const DEFAULT_GIT_FLOW_BASE_BRANCH = 'main';

export const ARCHITECT_PLAN_INDEX_CACHE_TTL_MS = 60_000;

export const ARCHITECT_PLAN_ACTIVATION_CACHE_TTL_MS = 60_000;

export const FEATURE_TARGET_PATTERN = /^feature\/[a-z0-9._-]+$/i;

export const HOTFIX_TARGET_PATTERN = /^hotfix\/[a-z0-9._-]+$/i;

export const LEGACY_DEVELOP_TARGET_PATTERN = /^develop$/i;

export const MAINLINE_REJECTED_TARGET_PATTERNS = [
  /^release\/[a-z0-9._-]+$/i,
  /^bugfix\/[a-z0-9._-]+$/i,
];

export const TYPED_GIT_FLOW_TARGET_PATTERNS = [
  /^release\/[a-z0-9._-]+$/i,
  HOTFIX_TARGET_PATTERN,
  /^bugfix\/[a-z0-9._-]+$/i,
];

export const GIT_FLOW_ALLOWED_TARGET_PATTERNS = [
  FEATURE_TARGET_PATTERN,
  ...TYPED_GIT_FLOW_TARGET_PATTERNS,
];

export const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const getDynamicTargetPatterns = (): RegExp[] => {
  const baseBranch = getGitFlowBaseBranch();
  if (isMainlineGitWorkflow(getArchitectGitNamingSettings())) {
    return [
      new RegExp(`^${escapeRegex(baseBranch)}$`, 'i'),
      LEGACY_DEVELOP_TARGET_PATTERN,
      FEATURE_TARGET_PATTERN,
      HOTFIX_TARGET_PATTERN,
    ];
  }
  return [
    new RegExp(`^${escapeRegex(baseBranch)}$`, 'i'),
    LEGACY_DEVELOP_TARGET_PATTERN,
    ...GIT_FLOW_ALLOWED_TARGET_PATTERNS,
  ];
};

export const normalizeBranchName = (value?: string, fallbackBranch = DEFAULT_GIT_FLOW_BASE_BRANCH): string => {
  const normalized = (value || fallbackBranch)
    .trim()
    .replace(/\\/g, '/')
    .replace(/^refs\/heads\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
  return normalized || fallbackBranch;
};

export const getArchitectPlanIndexCacheKey = (branchName: string): string =>
  normalizeBranchName(branchName);

export const getArchitectPlanActivationSummarySignature = (
  summary?: ArchitectPlanActivationOptions['summaryHint']
): string | null => {
  if (!summary) {
    return null;
  }

  return [
    summary.updatedAt || 'unknown',
    summary.status,
    summary.conversationId || 'none',
    summary.nodeCount,
    summary.predictedBranchCount ?? 0,
    summary.chatMessageCount ?? -1,
  ].join('|');
};

export const getArchitectPlanActivationScopeSignature = (
  scopedProjectIdsHint?: string[]
): string | null => {
  const normalizedProjectIds = normalizeArchitectPlanIdList(scopedProjectIdsHint)
    .sort((left, right) => left.localeCompare(right));
  return normalizedProjectIds.length > 0 ? normalizedProjectIds.join(',') : null;
};

export const getArchitectPlanActivationCacheKey = (
  branchName: string,
  planId: string,
  summarySignature?: string | null,
  scopeSignature?: string | null,
): string =>
  [
    normalizeBranchName(branchName),
    sanitizeId(planId),
    summarySignature || 'unknown',
    scopeSignature || 'all',
  ].join('::');

export const isGitFlowTargetBranch = (branchName: string): boolean =>
  getDynamicTargetPatterns().some((pattern) => pattern.test(branchName));

export const assertGitFlowTargetBranch = (branchName: string): void => {
  if (!isGitFlowTargetBranch(branchName)) {
    if (
      isMainlineGitWorkflow(getArchitectGitNamingSettings()) &&
      MAINLINE_REJECTED_TARGET_PATTERNS.some((pattern) => pattern.test(branchName))
    ) {
      throw new Error(
        `Invalid target branch "${branchName}". Mainline workflow uses "${getGitFlowBaseBranch()}" as the development branch and only allows feature/* or hotfix/* work branches.`
      );
    }
    throw new Error(
      `Invalid target branch "${branchName}". Use configured base branch "${getGitFlowBaseBranch()}" or Git workflow branch naming: feature/*, release/*, hotfix/*, bugfix/*.`
    );
  }
};

export const sanitizeId = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '') || `plan-${Date.now()}`;

export const slugifyPlanTitle = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '') || `plan-${Date.now()}`;

export const createAvailablePlanSlug = (
  value: string,
  reservedSlugs: string[],
  options?: {
    excludeSlug?: string | null;
  }
): string => {
  const baseSlug = slugifyPlanTitle(value);
  const reserved = new Set(
    reservedSlugs
      .map((slug) => slugifyPlanTitle(slug))
      .filter((slug) => slug !== slugifyPlanTitle(options?.excludeSlug || ''))
  );
  if (!reserved.has(baseSlug)) {
    return baseSlug;
  }

  let index = 2;
  let attempt = `${baseSlug}-${index}`;
  while (reserved.has(attempt)) {
    index += 1;
    attempt = `${baseSlug}-${index}`;
  }
  return attempt;
};

export const normalizePlanLabel = (value?: string): string | undefined => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length > 0 ? trimmed : undefined;
};

export const isArchitectPlanSlugMutable = (
  plan: Pick<ArchitectPlanRecord, 'status' | 'nodes'>
): boolean =>
  plan.status === 'draft' &&
  !(plan.nodes || []).some((node) => node.status !== 'pending');

export const hasPersistedArchitectStrategy = (
  plan: Pick<ArchitectPlanRecord, 'nodes' | 'predictedBranches'>
): boolean =>
  (plan.nodes || []).length > 0 || (plan.predictedBranches || []).length > 0;

export const normalizeProjectIds = (projectIds?: string[], projectId?: string): string[] => Array.from(
  new Set(
    [ ...(Array.isArray(projectIds) ? projectIds : []), ...(projectId ? [projectId] : []) ]
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
  )
);

export const normalizeExpectedProjectIds = (expectedProjectIds?: string[], fallbackProjectIds?: string[]): string[] =>
  normalizeProjectIds(expectedProjectIds && expectedProjectIds.length > 0 ? expectedProjectIds : fallbackProjectIds);

export const normalizeContextProjectIds = (
  contextProjectIds?: string[],
  actionableProjectIds?: string[],
  registrySnapshot?: ValidProjectRegistrySnapshot | null
): string[] => {
  const resolvedContextProjectIds = normalizeProjectIds(contextProjectIds);
  const actionableProjectIdSet = new Set(normalizeProjectIds(actionableProjectIds));
  const validateProjectIds = Boolean(registrySnapshot?.hasRegisteredProjects);
  const sanitizedContextProjectIds: string[] = [];
  const seenProjectIds = new Set<string>();

  for (const candidateProjectId of resolvedContextProjectIds) {
    const normalizedProjectId = candidateProjectId.trim();
    if (
      !normalizedProjectId ||
      seenProjectIds.has(normalizedProjectId) ||
      actionableProjectIdSet.has(normalizedProjectId) ||
      isSyntheticProjectId(normalizedProjectId)
    ) {
      continue;
    }

    if (validateProjectIds) {
      if (!registrySnapshot?.validProjectIdSet.has(normalizedProjectId)) {
        continue;
      }
      const contextProjectIdSet = registrySnapshot.manualReadOnlyProjectIdSet ??
        registrySnapshot.readOnlyProjectIdSet;
      if (!contextProjectIdSet.has(normalizedProjectId)) {
        continue;
      }
    }

    seenProjectIds.add(normalizedProjectId);
    sanitizedContextProjectIds.push(normalizedProjectId);
  }

  return sanitizedContextProjectIds;
};

export const normalizeTargetBranchesByProjectId = (
  targetBranchesByProjectId: Record<string, string> | null | undefined,
  projectIds: string[],
  fallbackTargetBranch: string
): Record<string, string> => {
  const normalizedFallback = normalizeBranchName(fallbackTargetBranch || DEFAULT_GIT_FLOW_BASE_BRANCH);
  const normalizedEntries = Object.entries(targetBranchesByProjectId || {})
    .filter(([projectId]) => typeof projectId === 'string' && projectId.trim().length > 0)
    .map(([projectId, branchName]) => [projectId.trim(), normalizeBranchName(branchName, normalizedFallback)] as const);
  const normalized = Object.fromEntries(normalizedEntries);

  for (const projectId of projectIds) {
    if (!normalized[projectId]) {
      normalized[projectId] = normalizedFallback;
    }
  }

  return normalized;
};

export type ProjectGitFlowSettingsResolver = (
  projectId: string
) => Partial<ProjectGitFlowSettings> | null | undefined;

export const normalizeOptionalBranchName = (value?: string | null): string => {
  if (typeof value !== 'string') return '';
  return normalizeBranchName(value, '');
};

export const areBranchNamesEqual = (
  left?: string | null,
  right?: string | null
): boolean =>
  normalizeOptionalBranchName(left).toLowerCase() ===
  normalizeOptionalBranchName(right).toLowerCase();

export const resolveProjectDevelopmentBranch = (
  projectId: string,
  getProjectGitFlowSettings?: ProjectGitFlowSettingsResolver
): string => {
  const settings = getProjectGitFlowSettings?.(projectId);
  const explicitBaseBranch = normalizeOptionalBranchName(settings?.baseBranch);
  if (explicitBaseBranch) {
    return explicitBaseBranch;
  }
  return '';
};

export const resolveProjectMainBranch = (
  projectId: string,
  getProjectGitFlowSettings?: ProjectGitFlowSettingsResolver
): string => {
  const settings = getProjectGitFlowSettings?.(projectId);
  const explicitMainBranch = normalizeOptionalBranchName(settings?.mainBranch);
  if (explicitMainBranch) {
    return explicitMainBranch;
  }
  return '';
};

export const getArchitectPlanEffectiveTargetBranchesByProjectId = (
  plan: ArchitectPlanTargetBranchRef,
  options?: {
    getProjectGitFlowSettings?: ProjectGitFlowSettingsResolver;
    fallbackTargetBranch?: string;
  }
): Record<string, string> => {
  const projectIds = getArchitectPlanActionableProjectIds(plan);
  const fallbackTargetBranch = normalizeBranchName(
    options?.fallbackTargetBranch || plan.targetBranch || getGitFlowBaseBranch()
  );
  const storedTargets = normalizeTargetBranchesByProjectId(
    plan.targetBranchesByProjectId,
    projectIds,
    plan.targetBranch || fallbackTargetBranch
  );
  const planKind = getArchitectPlanKind(plan);
  const output: Record<string, string> = {};

  for (const projectId of projectIds) {
    const storedTarget = storedTargets[projectId] || fallbackTargetBranch;
    const metadataTarget = normalizeOptionalBranchName(
      plan.gitFlowPlan?.projects?.[projectId]?.targetBranch
    );
    const projectDevelopmentBranch = resolveProjectDevelopmentBranch(
      projectId,
      options?.getProjectGitFlowSettings
    );
    const projectMainBranch = resolveProjectMainBranch(
      projectId,
      options?.getProjectGitFlowSettings
    );
    const storedLooksLikeLegacyPlanFallback =
      !plan.targetBranchesByProjectId?.[projectId] ||
      areBranchNamesEqual(storedTarget, plan.targetBranch) ||
      Boolean(
        projectDevelopmentBranch &&
        projectMainBranch &&
        !areBranchNamesEqual(projectDevelopmentBranch, projectMainBranch) &&
        areBranchNamesEqual(storedTarget, projectMainBranch)
      );

    if (planKind === 'release' || planKind === 'hotfix') {
      output[projectId] = metadataTarget || storedTarget || projectDevelopmentBranch || fallbackTargetBranch;
      continue;
    }

    if (projectDevelopmentBranch && storedLooksLikeLegacyPlanFallback) {
      output[projectId] = projectDevelopmentBranch;
      continue;
    }

    output[projectId] = metadataTarget || storedTarget || projectDevelopmentBranch || fallbackTargetBranch;
  }

  return output;
};

export const getUniqueTargetBranchNames = (targetBranchesByProjectId: Record<string, string>): string[] =>
  Array.from(
    new Set(
      Object.values(targetBranchesByProjectId)
        .map((branchName) => branchName.trim())
        .filter((branchName) => branchName.length > 0)
    )
  );

export const getArchitectPlanEffectiveTargetBranch = (
  plan: ArchitectPlanTargetBranchRef,
  options?: {
    getProjectGitFlowSettings?: ProjectGitFlowSettingsResolver;
    fallbackTargetBranch?: string;
  }
): string | null => {
  const uniqueTargets = getUniqueTargetBranchNames(
    getArchitectPlanEffectiveTargetBranchesByProjectId(plan, options)
  );
  return uniqueTargets.length === 1 ? uniqueTargets[0] : null;
};

export const getArchitectPlanTargetDisplay = (
  plan: ArchitectPlanTargetBranchRef,
  selectedProjectId?: string | null,
  options?: {
    getProjectGitFlowSettings?: ProjectGitFlowSettingsResolver;
    fallbackTargetBranch?: string;
  }
): {
  targetBranch: string;
  targetBranchesByProjectId: Record<string, string>;
  hasMixedTargetBranches: boolean;
  effectiveTargetBranch: string | null;
} => {
  const targetBranchesByProjectId = getArchitectPlanEffectiveTargetBranchesByProjectId(
    plan,
    options
  );
  const effectiveTargetBranch = getArchitectPlanEffectiveTargetBranch(plan, options);
  const selectedTarget =
    selectedProjectId && targetBranchesByProjectId[selectedProjectId]
      ? targetBranchesByProjectId[selectedProjectId]
      : null;
  return {
    targetBranch: selectedTarget || effectiveTargetBranch || plan.targetBranch,
    targetBranchesByProjectId,
    hasMixedTargetBranches: getUniqueTargetBranchNames(targetBranchesByProjectId).length > 1,
    effectiveTargetBranch,
  };
};

export const resolveRegistryProjectGitFlowSettings = (
  registrySnapshot: ValidProjectRegistrySnapshot | null | undefined
): ProjectGitFlowSettingsResolver | undefined => {
  if (!registrySnapshot?.gitFlowSettingsByProjectId) {
    return undefined;
  }
  return (projectId) => registrySnapshot.gitFlowSettingsByProjectId.get(projectId) ?? null;
};

export const mergeGitFlowTargetBranchesByProjectId = (
  targetBranchesByProjectId: Record<string, string>,
  gitFlowPlan: ArchitectPlanGitFlowMetadata | undefined,
  projectIds: string[],
  options?: { preferGitFlow?: boolean }
): Record<string, string> => {
  const merged = { ...targetBranchesByProjectId };
  for (const projectId of projectIds) {
    const metadataTarget = gitFlowPlan?.projects?.[projectId]?.targetBranch;
    if (!metadataTarget) continue;
    if (options?.preferGitFlow || !merged[projectId]) {
      merged[projectId] = normalizeBranchName(metadataTarget, merged[projectId]);
    }
  }
  return merged;
};

export const hasMixedPlanTargetBranches = (targetBranchesByProjectId: Record<string, string>): boolean =>
  new Set(Object.values(targetBranchesByProjectId).filter((branchName) => branchName.trim().length > 0)).size > 1;

export const hashString = (value: string): string => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `h${(hash >>> 0).toString(16).padStart(8, '0')}`;
};

export const toJsonLines = (messages: ArchitectPlanChatMessage[]): string =>
  messages
    .map((message) => JSON.stringify(message))
    .join('\n');

export const parseJsonLines = (raw: string): ArchitectPlanChatMessage[] =>
  raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as Partial<ArchitectPlanChatMessage>;
        if (
          typeof parsed.id !== 'string' ||
          (parsed.role !== 'user' && parsed.role !== 'assistant') ||
          typeof parsed.content !== 'string'
        ) {
          return [];
        }
        return [{
          id: parsed.id,
          role: parsed.role,
          content: parsed.content,
          createdAt:
            typeof parsed.createdAt === 'string' && parsed.createdAt.trim().length > 0
              ? parsed.createdAt
              : new Date(0).toISOString(),
        }];
      } catch {
        return [];
      }
    });

export const getArchitectPlanActionableProjectIds = (plan: ArchitectPlanProjectRef): string[] =>
  getArchitectPlanActionableProjectIdsFromScope(plan, {
    useExpectedAsActionableFallback: true,
  });

export const getArchitectPlanVisibleProjectIds = (plan: ArchitectPlanProjectRef): string[] =>
  getArchitectPlanVisibleProjectIdsFromScope(plan, {
    useExpectedAsActionableFallback: true,
  });

export const getArchitectPlanProjectIds = (plan: ArchitectPlanProjectRef): string[] =>
  getArchitectPlanVisibleProjectIds(plan);

export const getArchitectPlanScopeCandidateProjectIds = (
  plan: ArchitectPlanProjectRef
): string[] =>
  normalizeArchitectPlanIdList(
    getArchitectPlanVisibleProjectIds(plan),
    plan.availableProjectIds,
    plan.replicas?.map((replica) => replica.projectId)
  );

export const isArchitectPlanVisibleForScope = (
  plan: ArchitectPlanProjectRef,
  scopedProjectIds: string[]
): boolean => {
  if (scopedProjectIds.length === 0) {
    return true;
  }

  const planProjectIds = getArchitectPlanScopeCandidateProjectIds(plan);
  if (planProjectIds.length === 0) {
    return false;
  }

  const scopedProjectIdSet = new Set(scopedProjectIds);
  return planProjectIds.some((projectId) => scopedProjectIdSet.has(projectId));
};

export const getArchitectPlanTargetBranchesByProjectId = (
  plan: ArchitectPlanTargetBranchRef,
  options?: {
    getProjectGitFlowSettings?: ProjectGitFlowSettingsResolver;
    fallbackTargetBranch?: string;
  }
): Record<string, string> =>
  options
    ? getArchitectPlanEffectiveTargetBranchesByProjectId(plan, options)
    : normalizeTargetBranchesByProjectId(
        plan.targetBranchesByProjectId,
        getArchitectPlanActionableProjectIds(plan),
        plan.targetBranch
      );

export const getArchitectPlanTargetBranchForProject = (
  plan: ArchitectPlanTargetBranchRef,
  projectId?: string | null,
  options?: {
    getProjectGitFlowSettings?: ProjectGitFlowSettingsResolver;
    fallbackTargetBranch?: string;
  }
): string => {
  const targetBranchesByProjectId = getArchitectPlanTargetBranchesByProjectId(plan, options);
  if (projectId && targetBranchesByProjectId[projectId]) {
    return targetBranchesByProjectId[projectId];
  }
  return targetBranchesByProjectId[getArchitectPlanActionableProjectIds(plan)[0] || ''] || plan.targetBranch;
};

export const planHasMixedTargetBranches = (
  plan: ArchitectPlanTargetBranchRef
): boolean => hasMixedPlanTargetBranches(getArchitectPlanTargetBranchesByProjectId(plan));

export const planMatchesProjectId = (
  plan: ArchitectPlanProjectRef,
  selectedProjectId: string | null
): boolean => {
  if (!selectedProjectId) return true;
  return isArchitectPlanVisibleForScope(plan, [selectedProjectId]);
};

export const resolvePlanProjectContextId = (
  plan: ArchitectPlanProjectRef,
  preferredProjectId?: string | null
): string | null => {
  const projectIds = getArchitectPlanScopeCandidateProjectIds(plan);
  if (preferredProjectId && projectIds.includes(preferredProjectId)) {
    return preferredProjectId;
  }
  return projectIds[0] || null;
};

export const normalizePlanNodes = (nodes: PlanNode[]): PlanNode[] =>
  (Array.isArray(nodes) ? nodes : []).map((node) => {
    const projectIds = normalizeProjectIds(node.projectIds, node.projectId);
    const artifactContracts = Array.isArray(node.artifactContracts)
      ? node.artifactContracts
          .filter(
            (contract) =>
              contract &&
              typeof contract.id === 'string' &&
              contract.id.trim().length > 0 &&
              typeof contract.title === 'string' &&
              contract.title.trim().length > 0
          )
          .map((contract) => ({
            id: sanitizeId(contract.id),
            title: contract.title.trim(),
            kind: typeof contract.kind === 'string' && contract.kind.trim().length > 0
              ? contract.kind.trim()
              : 'note',
            ...(typeof contract.description === 'string' && contract.description.trim().length > 0
              ? { description: contract.description.trim() }
              : {}),
            required: true,
          }))
      : undefined;
    return {
      ...node,
      projectId: projectIds[0],
      projectIds,
      artifactContracts: artifactContracts && artifactContracts.length > 0 ? artifactContracts : undefined,
    };
  });

export const normalizePlanPredictedBranches = (predictedBranches: PredictedBranch[]): PredictedBranch[] =>
  (Array.isArray(predictedBranches) ? predictedBranches : []).filter(
    (branch) => typeof branch?.projectId === 'string' && branch.projectId.trim().length > 0
  );

export const resolvePlanProjectIds = (params: {
  projectIds?: string[];
  projectId?: string;
  nodes?: PlanNode[];
  predictedBranches?: PredictedBranch[];
}): string[] => {
  const fromNodes = normalizePlanNodes(params.nodes || []).flatMap((node) => normalizeProjectIds(node.projectIds, node.projectId));
  const fromBranches = normalizePlanPredictedBranches(params.predictedBranches || []).map((branch) => branch.projectId);
  return normalizeProjectIds([...(params.projectIds || []), ...fromNodes, ...fromBranches], params.projectId);
};

export const getPlanRoot = (branchName: string): string => `branches/${normalizeBranchName(branchName)}/plans`;

export const getIndexPath = (branchName: string): string => `${getPlanRoot(branchName)}/index.json`;

export const getPlanDir = (branchName: string, planId: string): string => `${getPlanRoot(branchName)}/${sanitizeId(planId)}`;

export const getPlanManifestPath = (branchName: string, planId: string): string => `${getPlanDir(branchName, planId)}/manifest.json`;

export const getPlanJsonPath = (branchName: string, planId: string): string => `${getPlanDir(branchName, planId)}/plan.json`;

export const getPlanMarkdownPath = (branchName: string, planId: string): string => `${getPlanDir(branchName, planId)}/plan.md`;

export const getPlanChatPath = (branchName: string, planId: string): string => `${getPlanDir(branchName, planId)}/chat.jsonl`;

export const getPlanTasksRoot = (branchName: string, planId: string): string => `${getPlanDir(branchName, planId)}/tasks`;

export const getPlanTaskDir = (branchName: string, planId: string, taskId: string): string => `${getPlanTasksRoot(branchName, planId)}/${sanitizeId(taskId)}`;

export const getTaskPlannedPath = (branchName: string, planId: string, taskId: string): string => `${getPlanTaskDir(branchName, planId, taskId)}/planned.md`;

export const getTaskExecutedPath = (branchName: string, planId: string, taskId: string): string => `${getPlanTaskDir(branchName, planId, taskId)}/executed.md`;

export const emptyIndex = (): ArchitectPlanIndex => ({ version: 3, activePlanId: null, plans: [], reservedPlanSlugs: [] });

export const localIndexKey = (branchName: string): string => `${LOCAL_INDEX_KEY_PREFIX}:${normalizeBranchName(branchName)}`;

export const localPlanKey = (branchName: string, planId: string): string =>
  `${LOCAL_PLAN_KEY_PREFIX}:${normalizeBranchName(branchName)}:${sanitizeId(planId)}`;

export const localPlanChatKey = (branchName: string, planId: string): string =>
  `${LOCAL_PLAN_CHAT_KEY_PREFIX}:${normalizeBranchName(branchName)}:${sanitizeId(planId)}`;

export const buildPlanMarkdown = (
  plan: ArchitectPlanRecord,
  registrySnapshot?: ValidProjectRegistrySnapshot | null
): string => {
  const lines: string[] = [];
  lines.push(`# Plan: ${plan.id}`);
  lines.push('');
  lines.push('## Metadata');
  lines.push(`- Plan ID: ${plan.id}`);
  if (plan.label) {
    lines.push(`- Plan Label: ${plan.label}`);
  }
  lines.push(`- Plan Slug: ${plan.slug}`);
  lines.push(`- Plan Kind: ${getArchitectPlanKind(plan)}`);
  const actionableProjectIds = getArchitectPlanActionableProjectIds(plan);
  if (actionableProjectIds.length > 0) {
    const integrationBranchesByProjectId = Object.fromEntries(
      actionableProjectIds.map((projectId) => [
        projectId,
        renderArchitectPlanIntegrationBranchName({ plan, projectId }),
      ])
    );
    const uniqueIntegrationBranches = Array.from(new Set(Object.values(integrationBranchesByProjectId)));
    lines.push(`- Plan Integration Branch: ${uniqueIntegrationBranches.join(', ')}`);
    for (const [projectId, branchName] of Object.entries(integrationBranchesByProjectId)) {
      lines.push(`- Plan Integration Branch [${projectId}]: ${branchName}`);
    }
  } else {
    lines.push(`- Plan Integration Branch: ${toPlanIntegrationBranch(plan.slug)}`);
  }
  const targetBranchesByProjectId = getArchitectPlanTargetBranchesByProjectId(
    plan,
    {
      getProjectGitFlowSettings: resolveRegistryProjectGitFlowSettings(registrySnapshot),
    }
  );
  const targetCodeBranches = getUniqueTargetBranchNames(targetBranchesByProjectId);
  lines.push(`- Target Code Branch: ${targetCodeBranches.length > 0 ? targetCodeBranches.join(', ') : plan.targetBranch}`);
  if (Object.keys(targetBranchesByProjectId).length > 0) {
    lines.push(`- Mixed Target Branches: ${hasMixedPlanTargetBranches(targetBranchesByProjectId) ? 'yes' : 'no'}`);
    for (const [projectId, branchName] of Object.entries(targetBranchesByProjectId)) {
      lines.push(`- Target Branch [${projectId}]: ${branchName}`);
    }
  }
  lines.push(`- Main Code Branch: ${getGitFlowMainBranch()}`);
  lines.push(`- Development Code Branch: ${getGitFlowBaseBranch()}`);
  lines.push(`- Macro Branch: @macro`);
  lines.push(`- Status: ${plan.status}`);
  if (plan.conversationId) {
    lines.push(`- Conversation ID: ${plan.conversationId}`);
  }
  if (plan.projectId) {
    lines.push(`- Project ID: ${plan.projectId}`);
  }
  lines.push(`- Created At: ${plan.createdAt}`);
  lines.push(`- Updated At: ${plan.updatedAt}`);
  lines.push('');
  lines.push('## Description');
  lines.push(plan.description || 'No description provided.');
  lines.push('');
  lines.push('## Nodes');
  if (plan.nodes.length === 0) {
    lines.push('- No nodes.');
  } else {
    for (const node of plan.nodes) {
      lines.push(`- [${node.type}] ${node.title} (id: ${node.id}, status: ${node.status}, branch: ${node.assignedBranch || 'main'})`);
      if (node.description) {
        lines.push(`  - ${node.description}`);
      }
      if (node.dependencies.length > 0) {
        lines.push(`  - depends_on: ${node.dependencies.join(', ')}`);
      }
      if (node.artifactContracts && node.artifactContracts.length > 0) {
        lines.push(
          `  - expected_artifacts: ${node.artifactContracts
            .map((contract) => contract.title)
            .join(', ')}`
        );
      }
    }
  }
  lines.push('');
  lines.push('## Predicted Branches');
  if (plan.predictedBranches.length === 0) {
    lines.push('- None');
  } else {
    for (const branch of plan.predictedBranches) {
      lines.push(`- ${branch.name} (${branch.status}) tasks=${branch.taskIds.length}`);
    }
  }

  return lines.join('\n');
};

export const buildTaskPlannedMarkdown = (plan: ArchitectPlanRecord, node: PlanNode): string => {
  const lines: string[] = [];
  const projectIds = normalizeProjectIds(node.projectIds, node.projectId);
  lines.push(`# Planned Task: ${node.title}`);
  lines.push('');
  lines.push(`- Plan ID: ${plan.id}`);
  lines.push(`- Plan Title: ${plan.title}`);
  if (plan.label) {
    lines.push(`- Plan Label: ${plan.label}`);
  }
  lines.push(`- Task ID: ${node.id}`);
  lines.push(`- Branch: ${node.assignedBranch || 'work'}`);
  lines.push(`- Projects: ${projectIds.join(', ') || 'none'}`);
  lines.push(`- Status: ${node.status}`);
  if (node.dependencies.length > 0) {
    lines.push(`- Depends On: ${node.dependencies.join(', ')}`);
  }
  if (node.artifactContracts && node.artifactContracts.length > 0) {
    lines.push('');
    lines.push('## Expected Artifacts');
    for (const contract of node.artifactContracts) {
      lines.push(`- ${contract.title}`);
    }
  }
  lines.push('');
  lines.push(node.description || 'No task description provided.');
  return lines.join('\n');
};

export interface ArchitectTaskExecutionRecord {
  taskId: string;
  title: string;
  completedAt: string;
  summary?: string;
  repositories: Array<{
    projectId: string;
    repoPath: string;
    branchName: string;
    planBranchName: string;
    mergeOutput?: string;
  }>;
}

export const buildTaskExecutedMarkdown = (plan: ArchitectPlanRecord, record: ArchitectTaskExecutionRecord): string => {
  const lines: string[] = [];
  lines.push(`# Executed Task: ${record.title}`);
  lines.push('');
  lines.push(`- Plan ID: ${plan.id}`);
  lines.push(`- Plan Title: ${plan.title}`);
  if (plan.label) {
    lines.push(`- Plan Label: ${plan.label}`);
  }
  lines.push(`- Task ID: ${record.taskId}`);
  lines.push(`- Completed At: ${record.completedAt}`);
  if (record.summary) {
    lines.push(`- Summary: ${record.summary}`);
  }
  lines.push('');
  lines.push('## Repository Integrations');
  for (const repo of record.repositories) {
    lines.push(`- ${repo.projectId}: ${repo.branchName} -> ${repo.planBranchName}`);
    lines.push(`  - repo: ${repo.repoPath}`);
    if (repo.mergeOutput) {
      lines.push(`  - merge: ${repo.mergeOutput}`);
    }
  }
  return lines.join('\n');
};

export interface ArchitectMetadataScope {
  scopeKey: string;
  projectId: string | null;
  repoPath: string | null;
  workspacePath: string | null;
  source: 'local' | 'project' | 'workspace';
  workspaceScope?: tauriIpc.WorkspaceScope;
}

export interface ArchitectPlanReplicaSnapshot {
  scope: ArchitectMetadataScope;
  plan: ArchitectPlanRecord;
  manifest: ArchitectPlanManifest;
  files: Record<string, string>;
}

export interface ArchitectPlanReplicaSnapshotDiagnostics extends ArchitectPlanReplicaSnapshot {
  repairApplied: boolean;
  removedInvalidProjectIds: string[];
}

export interface ArchitectPlanReplicaSet {
  canonical: ArchitectPlanReplicaSnapshot;
  snapshots: ArchitectPlanReplicaSnapshot[];
  expectedScopes: ArchitectMetadataScope[];
  replicas: ArchitectPlanReplica[];
  hasReplicaDivergence: boolean;
}

export const toReplicaDescriptor = (
  scope: ArchitectMetadataScope,
  updatedAt?: string | null,
  missing = false
): ArchitectPlanReplica => ({
  scopeKey: scope.scopeKey,
  projectId: scope.projectId,
  repoPath: scope.repoPath,
  workspacePath: scope.workspacePath,
  source: scope.source,
  updatedAt,
  missing,
});

export const stableSortObject = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => stableSortObject(item));
  }
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = stableSortObject((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  return value;
};

export const stableSerialize = (value: unknown): string => JSON.stringify(stableSortObject(value));

export const areSerializedContentsEqual = (left: string, right: string): boolean => left === right;

export const buildPlanContentHashes = (
  plan: ArchitectPlanRecord,
  chatMessages: ArchitectPlanChatMessage[]
): ArchitectPlanContentHashes => ({
  plan: hashString(stableSerialize(stripPlanReplicaMetadata(plan))),
  chat: hashString(toJsonLines(chatMessages)),
});

export const loadParticipantSnapshots = async (
  expectedProjectIds: string[],
  registrySnapshot?: ValidProjectRegistrySnapshot | null,
  deps?: ResolvedArchitectPlanServiceDependencies
): Promise<ArchitectPlanParticipant[]> => {
  const uniqueProjectIds = normalizeExpectedProjectIds(expectedProjectIds);
  if (uniqueProjectIds.length === 0) {
    return [];
  }

  const repoPathByProjectId = registrySnapshot?.repoPathByProjectId ?? new Map<string, string>();

  try {
    const appState = deps ? await deps.getAppState() : null;
    const projects = appState
      ? [
          ...(appState.standaloneProjects ?? []),
          ...appState.projectGroups.flatMap((group) => group.projects),
        ]
      : [];
    return uniqueProjectIds.map((projectId) => {
      const project = projects.find((candidate) => candidate.id === projectId);
      return {
        projectId,
        repoPathSnapshot: normalizeProjectRegistryPath(project?.path) ?? repoPathByProjectId.get(projectId) ?? null,
        mountName: project?.mountName ?? null,
        displayName: project?.name ?? null,
      };
    });
  } catch {
    return uniqueProjectIds.map((projectId) => ({
      projectId,
      repoPathSnapshot: repoPathByProjectId.get(projectId) ?? null,
    }));
  }
};

export const buildPlanConversationSnapshot = (
  plan: ArchitectPlanRecord,
  chatMessages: ArchitectPlanChatMessage[]
): ArchitectPlanConversationSnapshot => ({
  conversationId: plan.conversationId ?? null,
  title: plan.label || plan.title || null,
  messageCount: chatMessages.length,
  lastMessageAt: chatMessages.length > 0 ? chatMessages[chatMessages.length - 1]!.createdAt : null,
});

export const buildPlanManifest = async (params: {
  plan: ArchitectPlanRecord;
  chatMessages: ArchitectPlanChatMessage[];
  registrySnapshot?: ValidProjectRegistrySnapshot | null;
  deps?: ResolvedArchitectPlanServiceDependencies;
}): Promise<ArchitectPlanManifest> => {
  const scope = normalizeArchitectPlanScope(params.plan, {
    useExpectedAsActionableFallback: true,
  });

  return {
    schemaVersion: 3,
    planId: params.plan.id,
    planKind: getArchitectPlanKind(params.plan),
    gitFlowPlan: params.plan.gitFlowPlan,
    targetBranch: normalizeBranchName(params.plan.targetBranch),
    targetBranchesByProjectId: getArchitectPlanTargetBranchesByProjectId(params.plan, {
      getProjectGitFlowSettings: resolveRegistryProjectGitFlowSettings(params.registrySnapshot),
    }),
    status: params.plan.status,
    expectedProjectIds: scope.expectedProjectIds,
    contextProjectIds: scope.contextProjectIds,
    participants: await loadParticipantSnapshots(
      scope.expectedProjectIds,
      params.registrySnapshot,
      params.deps
    ),
    revision:
      typeof params.plan.revision === 'number' && Number.isFinite(params.plan.revision) && params.plan.revision > 0
        ? Math.floor(params.plan.revision)
        : 1,
    updatedAt: params.plan.updatedAt,
    contentHashes: buildPlanContentHashes(params.plan, params.chatMessages),
    conversation: buildPlanConversationSnapshot(params.plan, params.chatMessages),
    deletion: params.plan.status === 'deleted' ? { deletedAt: params.plan.updatedAt } : null,
  };
};

export interface SanitizedArchitectPlanResult {
  plan: ArchitectPlanRecord | null;
  removedInvalidProjectIds: string[];
  changed: boolean;
}

export interface SanitizedArchitectPlanSummaryResult {
  summary: ArchitectPlanSummary;
  removedInvalidProjectIds: string[];
  changed: boolean;
}

export const dedupeProjectIdDiagnostics = (projectIds: string[]): string[] => Array.from(new Set(projectIds));

export const shouldValidateProjectIds = (registrySnapshot?: ValidProjectRegistrySnapshot | null): boolean =>
  Boolean(registrySnapshot?.hasRegisteredProjects);

export const normalizePersistedExecutionModes = (
  value: Record<string, 'git' | 'direct'> | null | undefined,
  projectIds: string[],
): Record<string, 'git' | 'direct'> | undefined => {
  const allowedProjectIds = new Set(projectIds);
  const entries = Object.entries(value ?? {}).filter(
    ([projectId, mode]) => allowedProjectIds.has(projectId) && (mode === 'git' || mode === 'direct'),
  );
  return entries.length > 0
    ? Object.fromEntries(entries) as Record<string, 'git' | 'direct'>
    : undefined;
};

export const sanitizeProjectIdsForRegistry = (
  projectIds?: string[],
  projectId?: string,
  registrySnapshot?: ValidProjectRegistrySnapshot | null
): {
  projectId: string | undefined;
  projectIds: string[];
  removedInvalidProjectIds: string[];
  changed: boolean;
} => {
  const resolvedProjectIds = normalizeProjectIds(projectIds, projectId);
  const removedInvalidProjectIds: string[] = [];
  const sanitizedProjectIds: string[] = [];
  const seenProjectIds = new Set<string>();
  const validateProjectIds = shouldValidateProjectIds(registrySnapshot);

  for (const candidateProjectId of resolvedProjectIds) {
    const normalizedProjectId = candidateProjectId.trim();
    if (!normalizedProjectId || seenProjectIds.has(normalizedProjectId)) {
      continue;
    }

    if (isSyntheticProjectId(normalizedProjectId)) {
      removedInvalidProjectIds.push(normalizedProjectId);
      continue;
    }

    if (validateProjectIds && !registrySnapshot?.validProjectIdSet.has(normalizedProjectId)) {
      removedInvalidProjectIds.push(normalizedProjectId);
      continue;
    }

    const manualReadOnlyProjectIdSet = registrySnapshot?.manualReadOnlyProjectIdSet ??
      registrySnapshot?.readOnlyProjectIdSet;
    if (validateProjectIds && manualReadOnlyProjectIdSet?.has(normalizedProjectId)) {
      removedInvalidProjectIds.push(normalizedProjectId);
      continue;
    }

    seenProjectIds.add(normalizedProjectId);
    sanitizedProjectIds.push(normalizedProjectId);
  }

  return {
    projectId: sanitizedProjectIds[0],
    projectIds: sanitizedProjectIds,
    removedInvalidProjectIds: dedupeProjectIdDiagnostics(removedInvalidProjectIds),
    changed: stableSerialize(resolvedProjectIds) !== stableSerialize(sanitizedProjectIds),
  };
};

export const sanitizePlanNodesForRegistry = (
  nodes: PlanNode[],
  registrySnapshot?: ValidProjectRegistrySnapshot | null
): {
  nodes: PlanNode[];
  removedInvalidProjectIds: string[];
  changed: boolean;
} => {
  const removedInvalidProjectIds: string[] = [];
  let changed = false;

  const sanitizedNodes = normalizePlanNodes(nodes).map((node) => {
    const sanitizedProjects = sanitizeProjectIdsForRegistry(node.projectIds, node.projectId, registrySnapshot);
    if (sanitizedProjects.removedInvalidProjectIds.length > 0) {
      removedInvalidProjectIds.push(...sanitizedProjects.removedInvalidProjectIds);
    }
    if (sanitizedProjects.changed) {
      changed = true;
    }
    return {
      ...node,
      projectId: sanitizedProjects.projectId,
      projectIds: sanitizedProjects.projectIds,
    };
  });

  return {
    nodes: sanitizedNodes,
    removedInvalidProjectIds: dedupeProjectIdDiagnostics(removedInvalidProjectIds),
    changed,
  };
};

export const sanitizePredictedBranchesForRegistry = (
  predictedBranches: PredictedBranch[],
  registrySnapshot?: ValidProjectRegistrySnapshot | null
): {
  predictedBranches: PredictedBranch[];
  removedInvalidProjectIds: string[];
  changed: boolean;
} => {
  const removedInvalidProjectIds: string[] = [];
  const sanitizedPredictedBranches: PredictedBranch[] = [];
  let changed = false;
  const validateProjectIds = shouldValidateProjectIds(registrySnapshot);

  for (const predictedBranch of normalizePlanPredictedBranches(predictedBranches)) {
    const normalizedProjectId = predictedBranch.projectId.trim();
    if (
      isSyntheticProjectId(normalizedProjectId) ||
      (validateProjectIds && !registrySnapshot?.validProjectIdSet.has(normalizedProjectId)) ||
      (validateProjectIds && Boolean(
        (registrySnapshot?.manualReadOnlyProjectIdSet ?? registrySnapshot?.readOnlyProjectIdSet)
          ?.has(normalizedProjectId),
      ))
    ) {
      removedInvalidProjectIds.push(normalizedProjectId);
      changed = true;
      continue;
    }
    sanitizedPredictedBranches.push({
      ...predictedBranch,
      projectId: normalizedProjectId,
    });
  }

  return {
    predictedBranches: sanitizedPredictedBranches,
    removedInvalidProjectIds: dedupeProjectIdDiagnostics(removedInvalidProjectIds),
    changed,
  };
};

export const logArchitectPlanSanitization = (params: {
  branchName: string;
  planId: string;
  removedInvalidProjectIds: string[];
  context: string;
  scopeKey?: string | null;
}): void => {
  if (params.removedInvalidProjectIds.length === 0) {
    return;
  }

  devLogger.info(JSON.stringify({
    event: 'architect_plan_metadata_sanitized',
    at: new Date().toISOString(),
    branchName: params.branchName,
    planId: params.planId,
    scopeKey: params.scopeKey ?? null,
    context: params.context,
    removedInvalidProjectIds: params.removedInvalidProjectIds,
  }));
};

export const logArchitectPlanActivationLoad = (params: {
  branchName: string;
  planId: string;
  resolutionMode: ArchitectPlanActivationResolutionMode;
  durationMs: number;
  sharedConversation: boolean;
}): void => {
  devLogger.info(
    JSON.stringify({
      event: 'architect_plan_activation_loaded',
      at: new Date().toISOString(),
      branchName: params.branchName,
      planId: params.planId,
      resolutionMode: params.resolutionMode,
      sharedConversation: params.sharedConversation,
      durationMs: params.durationMs,
    })
  );
};

export const toErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const sanitizeArchitectPlanRecord = (
  branchName: string,
  planId: string,
  plan: ArchitectPlanRecord | null,
  registrySnapshot?: ValidProjectRegistrySnapshot | null,
  options?: {
    logContext?: string;
    scopeKey?: string | null;
  }
): SanitizedArchitectPlanResult => {
  const normalized = normalizeBranchName(branchName);
  const safeId = sanitizeId(planId);
  if (!plan) {
    return {
      plan: null,
      removedInvalidProjectIds: [],
      changed: false,
    };
  }

  const normalizedNodes = normalizePlanNodes(Array.isArray(plan.nodes) ? plan.nodes : []);
  const normalizedPredictedBranches = normalizePlanPredictedBranches(
    Array.isArray(plan.predictedBranches) ? plan.predictedBranches : []
  );
  const rawActionableProjectIds = resolvePlanProjectIds({
    projectIds: plan.projectIds,
    projectId: plan.projectId,
    nodes: normalizedNodes,
    predictedBranches: normalizedPredictedBranches,
  });
  const normalizedScope = normalizeArchitectPlanScope({
    projectId: rawActionableProjectIds[0],
    projectIds: rawActionableProjectIds,
    contextProjectIds: plan.contextProjectIds,
    expectedProjectIds: plan.expectedProjectIds,
  }, {
    useExpectedAsActionableFallback: true,
  });
  const normalizedProjectIds = normalizedScope.actionableProjectIds;
  const normalizedId = sanitizeId(plan.id || safeId);
  const normalizedTitle = (plan.title || normalizedId).trim() || normalizedId;
  const normalizedSlug = slugifyPlanTitle((plan as Partial<ArchitectPlanRecord>).slug || normalizedTitle || safeId);
  const normalizedPlanKind = normalizeArchitectPlanKind(plan.planKind || plan.gitFlowPlan?.planKind);
  const registryProjectSettingsResolver = resolveRegistryProjectGitFlowSettings(registrySnapshot);
  const normalizedPlan: ArchitectPlanRecord = {
    ...plan,
    id: normalizedId,
    slug: normalizedSlug,
    title: normalizedTitle,
    label: normalizePlanLabel(plan.label),
    planKind: normalizedPlanKind,
    gitFlowPlan: normalizeArchitectPlanGitFlowMetadata({
      planKind: normalizedPlanKind,
      gitFlowPlan: plan.gitFlowPlan,
      projectIds: normalizedProjectIds,
      fallbackSlug: normalizedSlug,
      getProjectSettings: registryProjectSettingsResolver,
      getDefaultBranches: (projectId) => ({
        baseBranch:
          registryProjectSettingsResolver?.(projectId)?.baseBranch ||
          normalizeBranchName(plan.targetBranch || normalized),
        mainBranch: registryProjectSettingsResolver?.(projectId)?.mainBranch || 'main',
      }),
    }),
    targetBranch: normalizeBranchName(plan.targetBranch || normalized),
    targetBranchesByProjectId: normalizeTargetBranchesByProjectId(
      plan.targetBranchesByProjectId,
      normalizedProjectIds,
      plan.targetBranch || normalized
    ),
    executionModesByProjectId: normalizePersistedExecutionModes(
      plan.executionModesByProjectId,
      normalizedProjectIds,
    ),
    projectId: normalizedProjectIds[0],
    projectIds: normalizedScope.actionableProjectIds,
    contextProjectIds: normalizedScope.contextProjectIds,
    expectedProjectIds: normalizedScope.expectedProjectIds,
    revision:
      typeof plan.revision === 'number' && Number.isFinite(plan.revision) && plan.revision > 0
        ? Math.floor(plan.revision)
        : 1,
    nodes: normalizedNodes,
    predictedBranches: normalizedPredictedBranches,
  };

  const sanitizedNodes = sanitizePlanNodesForRegistry(normalizedPlan.nodes, registrySnapshot);
  const sanitizedPredictedBranches = sanitizePredictedBranchesForRegistry(
    normalizedPlan.predictedBranches,
    registrySnapshot
  );
  const sanitizedProjects = sanitizeProjectIdsForRegistry(
    resolvePlanProjectIds({
      projectIds: normalizedPlan.projectIds,
      projectId: normalizedPlan.projectId,
      nodes: sanitizedNodes.nodes,
      predictedBranches: sanitizedPredictedBranches.predictedBranches,
    }),
    normalizedPlan.projectId,
    registrySnapshot
  );
  const migratedContextProjectIds = registrySnapshot?.hasRegisteredProjects
    ? (normalizedPlan.projectIds || []).filter((projectId) =>
        (registrySnapshot.manualReadOnlyProjectIdSet ?? registrySnapshot.readOnlyProjectIdSet)
          .has(projectId)
      )
    : [];
  const sanitizedContextProjectIds = normalizeContextProjectIds(
    [...(normalizedPlan.contextProjectIds || []), ...migratedContextProjectIds],
    sanitizedProjects.projectIds,
    registrySnapshot
  );

  const sanitizedPlan: ArchitectPlanRecord = applyArchitectPlanLifecycleForStatus({
    ...normalizedPlan,
    projectId: sanitizedProjects.projectId,
    projectIds: sanitizedProjects.projectIds,
    planKind: normalizedPlanKind,
    gitFlowPlan: normalizeArchitectPlanGitFlowMetadata({
      planKind: normalizedPlanKind,
      gitFlowPlan: normalizedPlan.gitFlowPlan,
      projectIds: sanitizedProjects.projectIds,
      fallbackSlug: normalizedPlan.slug,
      getProjectSettings: registryProjectSettingsResolver,
      getDefaultBranches: (projectId) => ({
        baseBranch:
          registryProjectSettingsResolver?.(projectId)?.baseBranch ||
          normalizedPlan.targetBranch,
        mainBranch: registryProjectSettingsResolver?.(projectId)?.mainBranch || 'main',
      }),
    }),
    contextProjectIds: sanitizedContextProjectIds,
    expectedProjectIds: normalizeArchitectPlanIdList(
      sanitizedProjects.projectIds,
      sanitizedContextProjectIds
    ),
    targetBranchesByProjectId: getArchitectPlanEffectiveTargetBranchesByProjectId(
      {
        ...normalizedPlan,
        projectId: sanitizedProjects.projectId,
        projectIds: sanitizedProjects.projectIds,
      },
      {
        getProjectGitFlowSettings: registryProjectSettingsResolver,
        fallbackTargetBranch: normalizedPlan.targetBranch,
      }
    ),
    executionModesByProjectId: normalizePersistedExecutionModes(
      normalizedPlan.executionModesByProjectId,
      sanitizedProjects.projectIds,
    ),
    nodes: sanitizedNodes.nodes,
    predictedBranches: sanitizedPredictedBranches.predictedBranches,
  });
  const removedInvalidProjectIds = dedupeProjectIdDiagnostics([
    ...sanitizedProjects.removedInvalidProjectIds,
    ...sanitizedNodes.removedInvalidProjectIds,
    ...sanitizedPredictedBranches.removedInvalidProjectIds,
  ]);
  const changed =
    stableSerialize(stripPlanReplicaMetadata(normalizedPlan)) !==
      stableSerialize(stripPlanReplicaMetadata(sanitizedPlan)) ||
    removedInvalidProjectIds.length > 0 ||
    sanitizedNodes.changed ||
    sanitizedPredictedBranches.changed ||
    sanitizedProjects.changed;

  if (removedInvalidProjectIds.length > 0 && options?.logContext) {
    logArchitectPlanSanitization({
      branchName: normalized,
      planId: sanitizedPlan.id,
      removedInvalidProjectIds,
      context: options.logContext,
      scopeKey: options.scopeKey ?? null,
    });
  }

  return {
    plan: sanitizedPlan,
    removedInvalidProjectIds,
    changed,
  };
};

export const sanitizeArchitectPlanSummary = (
  branchName: string,
  summary: ArchitectPlanSummary,
  registrySnapshot?: ValidProjectRegistrySnapshot | null,
  options?: {
    logContext?: string;
    scopeKey?: string | null;
  }
): SanitizedArchitectPlanSummaryResult => {
  const normalized = normalizeBranchName(branchName);
  const rawActionableProjectIds = resolvePlanProjectIds(summary);
  const normalizedScope = normalizeArchitectPlanScope({
    projectId: rawActionableProjectIds[0],
    projectIds: rawActionableProjectIds,
    contextProjectIds: summary.contextProjectIds,
    expectedProjectIds: summary.expectedProjectIds,
  }, {
    useExpectedAsActionableFallback: true,
  });
  const projectIds = normalizedScope.actionableProjectIds;
  const safeId = sanitizeId(summary.id);
  const normalizedTitle = (summary.title || safeId).trim() || safeId;
  const normalizedSlug = slugifyPlanTitle((summary as Partial<ArchitectPlanSummary>).slug || normalizedTitle || safeId);
  const normalizedPlanKind = normalizeArchitectPlanKind(summary.planKind || summary.gitFlowPlan?.planKind);
  const registryProjectSettingsResolver = resolveRegistryProjectGitFlowSettings(registrySnapshot);
  const normalizedSummary: ArchitectPlanSummary = {
    ...summary,
    id: safeId,
    slug: normalizedSlug,
    title: normalizedTitle,
    label: normalizePlanLabel(summary.label),
    planKind: normalizedPlanKind,
    gitFlowPlan: normalizeArchitectPlanGitFlowMetadata({
      planKind: normalizedPlanKind,
      gitFlowPlan: summary.gitFlowPlan,
      projectIds,
      fallbackSlug: normalizedSlug,
      getProjectSettings: registryProjectSettingsResolver,
      getDefaultBranches: (projectId) => ({
        baseBranch:
          registryProjectSettingsResolver?.(projectId)?.baseBranch ||
          normalizeBranchName(summary.targetBranch || branchName),
        mainBranch: registryProjectSettingsResolver?.(projectId)?.mainBranch || 'main',
      }),
    }),
    targetBranch: normalizeBranchName(summary.targetBranch || branchName),
    targetBranchesByProjectId: normalizeTargetBranchesByProjectId(
      summary.targetBranchesByProjectId,
      projectIds,
      summary.targetBranch || branchName
    ),
    executionModesByProjectId: normalizePersistedExecutionModes(
      summary.executionModesByProjectId,
      projectIds,
    ),
    projectId: normalizedScope.actionableProjectIds[0],
    projectIds: normalizedScope.actionableProjectIds,
    contextProjectIds: normalizedScope.contextProjectIds,
    expectedProjectIds: normalizedScope.expectedProjectIds,
    revision:
      typeof summary.revision === 'number' && Number.isFinite(summary.revision) && summary.revision > 0
        ? Math.floor(summary.revision)
        : 1,
    nodeCount: typeof summary.nodeCount === 'number' ? summary.nodeCount : 0,
    predictedBranchCount:
      typeof summary.predictedBranchCount === 'number' ? summary.predictedBranchCount : 0,
    chatMessageCount:
      typeof summary.chatMessageCount === 'number' &&
      Number.isFinite(summary.chatMessageCount) &&
      summary.chatMessageCount >= 0
        ? Math.floor(summary.chatMessageCount)
        : undefined,
  };
  const sanitizedProjects = sanitizeProjectIdsForRegistry(
    normalizedSummary.projectIds,
    normalizedSummary.projectId,
    registrySnapshot
  );
  const migratedContextProjectIds = registrySnapshot?.hasRegisteredProjects
    ? (normalizedSummary.projectIds || []).filter((projectId) =>
        (registrySnapshot.manualReadOnlyProjectIdSet ?? registrySnapshot.readOnlyProjectIdSet)
          .has(projectId)
      )
    : [];
  const sanitizedContextProjectIds = normalizeContextProjectIds(
    [...(normalizedSummary.contextProjectIds || []), ...migratedContextProjectIds],
    sanitizedProjects.projectIds,
    registrySnapshot
  );
  const sanitizedSummary: ArchitectPlanSummary = applyArchitectPlanLifecycleForStatus({
    ...normalizedSummary,
    projectId: sanitizedProjects.projectId,
    projectIds: sanitizedProjects.projectIds,
    planKind: normalizedPlanKind,
    gitFlowPlan: normalizeArchitectPlanGitFlowMetadata({
      planKind: normalizedPlanKind,
      gitFlowPlan: normalizedSummary.gitFlowPlan,
      projectIds: sanitizedProjects.projectIds,
      fallbackSlug: normalizedSummary.slug,
      getProjectSettings: registryProjectSettingsResolver,
      getDefaultBranches: (projectId) => ({
        baseBranch:
          registryProjectSettingsResolver?.(projectId)?.baseBranch ||
          normalizedSummary.targetBranch,
        mainBranch: registryProjectSettingsResolver?.(projectId)?.mainBranch || 'main',
      }),
    }),
    contextProjectIds: sanitizedContextProjectIds,
    expectedProjectIds: normalizeArchitectPlanIdList(
      sanitizedProjects.projectIds,
      sanitizedContextProjectIds
    ),
    targetBranchesByProjectId: getArchitectPlanEffectiveTargetBranchesByProjectId(
      {
        ...normalizedSummary,
        projectId: sanitizedProjects.projectId,
        projectIds: sanitizedProjects.projectIds,
      },
      {
        getProjectGitFlowSettings: registryProjectSettingsResolver,
        fallbackTargetBranch: normalizedSummary.targetBranch,
      }
    ),
    executionModesByProjectId: normalizePersistedExecutionModes(
      normalizedSummary.executionModesByProjectId,
      sanitizedProjects.projectIds,
    ),
  });
  const changed =
    stableSerialize({
      ...normalizedSummary,
      replicas: undefined,
      hasReplicaDivergence: undefined,
    }) !== stableSerialize({
      ...sanitizedSummary,
      replicas: undefined,
      hasReplicaDivergence: undefined,
    }) ||
    sanitizedProjects.changed;

  if (sanitizedProjects.removedInvalidProjectIds.length > 0 && options?.logContext) {
    logArchitectPlanSanitization({
      branchName: normalized,
      planId: sanitizedSummary.id,
      removedInvalidProjectIds: sanitizedProjects.removedInvalidProjectIds,
      context: options.logContext,
      scopeKey: options.scopeKey ?? null,
    });
  }

  return {
    summary: sanitizedSummary,
    removedInvalidProjectIds: sanitizedProjects.removedInvalidProjectIds,
    changed,
  };
};

export const compareReplicaRecency = (
  left: Pick<ArchitectPlanReplica, 'updatedAt' | 'repoPath'>,
  right: Pick<ArchitectPlanReplica, 'updatedAt' | 'repoPath'>
): number => {
  const leftTime = left.updatedAt ? new Date(left.updatedAt).getTime() : 0;
  const rightTime = right.updatedAt ? new Date(right.updatedAt).getTime() : 0;
  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  return (left.repoPath || '').localeCompare(right.repoPath || '');
};

export const pickCanonicalReplica = <T extends { updatedAt?: string | null; repoPath: string | null }>(
  items: T[],
  strategy: ArchitectPlanReplicaRepairStrategy = 'newest'
): T => {
  const sorted = [...items].sort(compareReplicaRecency);
  return strategy === 'oldest' ? sorted[0] : sorted[sorted.length - 1];
};

export const stripPlanReplicaMetadata = (plan: ArchitectPlanRecord): ArchitectPlanRecord => ({
  ...plan,
  availableProjectIds: undefined,
  missingProjectIds: undefined,
  replicationState: undefined,
  replicas: undefined,
  hasReplicaDivergence: undefined,
});

export const buildComparablePlanSnapshot = (plan: ArchitectPlanRecord): unknown => ({
  ...stripPlanReplicaMetadata(plan),
  updatedAt: undefined,
  revision: undefined,
});

export const areArchitectPlansSemanticallyEqual = (
  left: ArchitectPlanRecord,
  right: ArchitectPlanRecord
): boolean =>
  stableSerialize(buildComparablePlanSnapshot(left)) ===
  stableSerialize(buildComparablePlanSnapshot(right));

export const arePlanChatMessagesEquivalent = (
  left: ArchitectPlanChatMessage[],
  right: ArchitectPlanChatMessage[]
): boolean => areSerializedContentsEqual(toJsonLines(left), toJsonLines(right));

export const buildReplicaComparableSnapshot = (snapshot: ArchitectPlanReplicaSnapshot): unknown => ({
  plan: buildComparablePlanSnapshot(snapshot.plan),
  artifacts: snapshot.manifest.artifacts ?? null,
});

export const buildReplicaComparableSummary = (summary: ArchitectPlanSummary): unknown => ({
  id: summary.id,
  slug: summary.slug,
  title: summary.title,
  label: summary.label,
  description: summary.description,
  planKind: summary.planKind,
  gitFlowPlan: summary.gitFlowPlan,
  status: summary.status,
  archivedAt: summary.archivedAt,
  archivedFromStatus: summary.archivedFromStatus,
  deletedAt: summary.deletedAt,
  targetBranch: summary.targetBranch,
  targetBranchesByProjectId: summary.targetBranchesByProjectId,
  executionModesByProjectId: summary.executionModesByProjectId,
  conversationId: summary.conversationId,
  projectId: summary.projectId,
  projectIds: summary.projectIds,
  contextProjectIds: summary.contextProjectIds,
  createdAt: summary.createdAt,
  nodeCount: summary.nodeCount,
  predictedBranchCount: summary.predictedBranchCount,
  expectedProjectIds: summary.expectedProjectIds,
});

export const throwReplicaDivergence = (params: {
  branchName: string;
  planId: string;
  reason: ArchitectPlanReplicaDivergence['reason'];
  replicas: ArchitectPlanReplica[];
}): never => {
  throw new ArchitectPlanReplicaDivergenceError({
    branchName: params.branchName,
    planId: params.planId,
    reason: params.reason,
    replicas: params.replicas,
  });
};

export function throwPlanMetadataMissing(
  branchName: string,
  planId: string,
  reason = 'plan_metadata_missing'
): never {
  throw createPlanMetadataMissingError({
    branchName: normalizeBranchName(branchName),
    planId: sanitizeId(planId),
    reason,
  });
}

export const toSummary = (
  plan: ArchitectPlanRecord,
  options?: {
    chatMessageCount?: number;
  }
): ArchitectPlanSummary => {
  const projectIds = resolvePlanProjectIds(plan);
  const contextProjectIds = normalizeContextProjectIds(plan.contextProjectIds, projectIds);
  const expectedProjectIds = normalizeArchitectPlanIdList(projectIds, contextProjectIds);

  return {
    id: plan.id,
    slug: plan.slug,
    title: plan.title,
    label: plan.label,
    description: plan.description,
    planKind: getArchitectPlanKind(plan),
    gitFlowPlan: plan.gitFlowPlan,
    status: plan.status,
    archivedAt: plan.archivedAt,
    archivedFromStatus: plan.archivedFromStatus,
    deletedAt: plan.deletedAt,
    targetBranch: plan.targetBranch,
    targetBranchesByProjectId: plan.targetBranchesByProjectId,
    executionModesByProjectId: plan.executionModesByProjectId,
    conversationId: plan.conversationId,
    projectId: plan.projectId,
    projectIds,
    contextProjectIds,
    expectedProjectIds,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
    revision: typeof plan.revision === 'number' ? plan.revision : 1,
    nodeCount: plan.nodes.length,
    predictedBranchCount: plan.predictedBranches.length,
    chatMessageCount: options?.chatMessageCount,
  };
};

export const upsertSummary = (summaries: ArchitectPlanSummary[], summary: ArchitectPlanSummary): ArchitectPlanSummary[] => {
  const found = summaries.some((item) => item.id === summary.id);
  if (!found) return [...summaries, summary];
  return summaries.map((item) => (item.id === summary.id ? summary : item));
};

export const mergePlanSummaries = (
  entries: Array<{ scope: ArchitectMetadataScope; summary: ArchitectPlanSummary }>,
  registrySnapshot?: ValidProjectRegistrySnapshot | null
): ArchitectPlanSummary => {
  const canonicalEntry = pickCanonicalReplica(
    entries.map(({ scope, summary }) => ({
      summary,
      updatedAt: summary.updatedAt,
      repoPath: scope.repoPath,
    }))
  ).summary;
  const projectIds = resolvePlanProjectIds(canonicalEntry);
  const contextProjectIds = normalizeContextProjectIds(
    canonicalEntry.contextProjectIds,
    projectIds,
    registrySnapshot
  );
  const expectedProjectIds = normalizeArchitectPlanIdList(projectIds, contextProjectIds);
  const availableProjectIds = Array.from(
    new Set(
      entries
        .map(({ scope, summary }) => scope.projectId || summary.projectId || null)
        .filter((projectId): projectId is string => Boolean(projectId && expectedProjectIds.includes(projectId)))
    )
  );
  const missingProjectIds = expectedProjectIds.filter((projectId) => !availableProjectIds.includes(projectId));
  const hasReplicaDivergence =
    new Set(entries.map(({ summary }) => stableSerialize(buildReplicaComparableSummary(summary)))).size > 1;
  const replicationState: ArchitectPlanReplicationState =
    canonicalEntry.status === 'deleted'
      ? 'deleted'
      : hasReplicaDivergence
        ? 'diverged'
        : missingProjectIds.length > 0
          ? 'missing_projects'
          : 'healthy';

  const mergedSummary = {
    ...canonicalEntry,
    projectId: projectIds[0],
    projectIds,
    contextProjectIds: normalizeContextProjectIds(
      canonicalEntry.contextProjectIds,
      projectIds,
      registrySnapshot
    ),
    expectedProjectIds,
    availableProjectIds,
    missingProjectIds,
    replicationState,
    replicas: entries.map(({ scope, summary }) => toReplicaDescriptor(scope, summary.updatedAt)),
    hasReplicaDivergence,
  };

  return sanitizeArchitectPlanSummary(
    mergedSummary.targetBranch,
    mergedSummary,
    registrySnapshot,
    {
      logContext: 'index_merge',
    }
  ).summary;
};

export const toPlanScopedFeatureBranch = (planSlug: string, rawBranchName: string): string => {
  const normalizedPlanSlug = slugifyPlanTitle(planSlug);
  const featureSlug = normalizeFeatureSlugInput(rawBranchName);
  return toPlanFeatureBranchName(normalizedPlanSlug, featureSlug);
};

export const toPlanIntegrationBranch = (planSlug: string): string =>
  toPlanIntegrationBranchName(slugifyPlanTitle(planSlug));

export const resolveTargetBranch = (argsValue: unknown): string => {
  const normalized = normalizeBranchName(typeof argsValue === 'string' ? argsValue : getGitFlowBaseBranch(), getGitFlowBaseBranch());
  assertGitFlowTargetBranch(normalized);
  return normalized;
};

export const getGitFlowBaseBranch = (): string =>
  normalizeBranchName(getArchitectGitNamingSettings().baseBranch, DEFAULT_GIT_FLOW_BASE_BRANCH);

export const getGitFlowMainBranch = (): string =>
  normalizeBranchName(getArchitectGitNamingSettings().mainBranch, 'main');
