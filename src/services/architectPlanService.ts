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
  loadValidProjectRegistrySnapshot,
  normalizeProjectRegistryPath,
  type ValidProjectRegistryAppState,
  type ValidProjectRegistrySnapshot,
} from './validProjectRegistry';
import { getRegisteredAppState } from './appStateRuntime';
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
import {
  flushMacroMetadata,
  recordMacroMetadataMutation,
  type MacroMetadataMutationKind,
} from './macroMetadataCoordinator';
import { getPlanExecutionModesByProjectId } from './planExecutionModes';
import {
  SERVICE_ERROR_CODES,
  createPlanMetadataMissingError,
} from './contracts/errors';
import {
  createArchitectPlanMutationId,
  loadArchitectPlanMutationJournal,
  quarantineArchitectPlanMutationJournal,
  removeArchitectPlanMutationJournal,
  upsertArchitectPlanMutationJournal,
  type ArchitectPlanMutationJournalEntry,
} from './architectPlanMutationJournal';

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

const RESTORABLE_PLAN_STATUS_SET = new Set<ArchitectPlanRestorableStatus>([
  'draft',
  'validated',
  'in_progress',
  'completed',
]);

const PLAN_DELETE_CLEANUP_STATUS_SET = new Set<ArchitectPlanStatus>([
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

const resolveArchivedArchitectPlanRestoreStatus = (
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

export interface ArchitectPlanServiceAppState extends ValidProjectRegistryAppState {
  metadataAutoPush?: boolean;
}

export interface ArchitectPlanServiceDependencies {
  tauri?: typeof tauriIpc;
  getAppState?: () => ArchitectPlanServiceAppState | Promise<ArchitectPlanServiceAppState>;
  loadRegistrySnapshot?: (options?: {
    getAppState?:
      | (() => ValidProjectRegistryAppState | Promise<ValidProjectRegistryAppState>)
      | undefined;
  }) => Promise<ValidProjectRegistrySnapshot>;
}

interface ResolvedArchitectPlanServiceDependencies {
  tauri: typeof tauriIpc;
  getAppState: () => Promise<ArchitectPlanServiceAppState>;
  loadRegistrySnapshot: (options?: {
    getAppState?:
      | (() => ValidProjectRegistryAppState | Promise<ValidProjectRegistryAppState>)
      | undefined;
  }) => Promise<ValidProjectRegistrySnapshot>;
}

const loadDefaultArchitectPlanAppState = async (): Promise<ArchitectPlanServiceAppState> =>
  await getRegisteredAppState<ArchitectPlanServiceAppState>();

const resolveArchitectPlanServiceDependencies = (
  overrides: ArchitectPlanServiceDependencies = {}
): ResolvedArchitectPlanServiceDependencies => {
  const getAppState = overrides.getAppState ?? loadDefaultArchitectPlanAppState;

  return {
    tauri: overrides.tauri ?? tauriIpc,
    getAppState: async () => await getAppState(),
    loadRegistrySnapshot:
      overrides.loadRegistrySnapshot ??
      ((options) =>
        loadValidProjectRegistrySnapshot({
          getAppState: options?.getAppState ?? getAppState,
        })),
  };
};

const createGitFlowMetadataNormalizationContext = async (
  deps: ResolvedArchitectPlanServiceDependencies,
  fallbackBaseBranch: string
): Promise<{
  getProjectSettings: (projectId: string) => Partial<ProjectGitFlowSettings> | null;
  getDefaultBranches: (projectId: string) => { baseBranch: string; mainBranch: string };
}> => {
  try {
    const appState = await deps.getAppState();
    const projectById = new Map(
      (appState.projectGroups || [])
        .flatMap((group) => group.projects || [])
        .map((project) => [project.id, project])
    );

    return {
      getProjectSettings: (projectId) => projectById.get(projectId)?.gitFlowSettings ?? null,
      getDefaultBranches: (projectId) => {
        const settings = projectById.get(projectId)?.gitFlowSettings;
        return {
          baseBranch: settings?.baseBranch || fallbackBaseBranch,
          mainBranch: settings?.mainBranch || 'main',
        };
      },
    };
  } catch {
    return {
      getProjectSettings: () => null,
      getDefaultBranches: () => ({
        baseBranch: fallbackBaseBranch,
        mainBranch: 'main',
      }),
    };
  }
};

const applyArchitectPlanLifecycleForStatus = <T extends {
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

const canUseBlankActivationSummary = (
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

const planRecordFromActivationSummary = (
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

type ArchitectPlanProjectRef = Pick<
  ArchitectPlanSummary,
  | 'projectId'
  | 'projectIds'
  | 'expectedProjectIds'
  | 'contextProjectIds'
  | 'availableProjectIds'
  | 'replicas'
>;

type ArchitectPlanTargetBranchRef = Pick<
  ArchitectPlanRecord,
  'projectId' | 'projectIds' | 'targetBranch'
> & {
  planKind?: ArchitectPlanKind;
  gitFlowPlan?: ArchitectPlanGitFlowMetadata;
  contextProjectIds?: string[];
  expectedProjectIds?: string[];
  targetBranchesByProjectId?: Record<string, string>;
};

interface ArchitectPlanIndex {
  version: 2 | 3;
  activePlanId: string | null;
  plans: ArchitectPlanSummary[];
  reservedPlanSlugs: string[];
}

const LOCAL_INDEX_KEY_PREFIX = 'macro_architect_plan_index';
const LOCAL_PLAN_KEY_PREFIX = 'macro_architect_plan';
const LOCAL_PLAN_CHAT_KEY_PREFIX = 'macro_architect_plan_chat';
const METADATA_WORKSPACE_SCOPE: tauriIpc.WorkspaceScope = 'metadata';
const DEFAULT_GIT_FLOW_BASE_BRANCH = 'main';
const ARCHITECT_PLAN_INDEX_CACHE_TTL_MS = 60_000;
const ARCHITECT_PLAN_ACTIVATION_CACHE_TTL_MS = 60_000;
const FEATURE_TARGET_PATTERN = /^feature\/[a-z0-9._-]+$/i;
const HOTFIX_TARGET_PATTERN = /^hotfix\/[a-z0-9._-]+$/i;
const LEGACY_DEVELOP_TARGET_PATTERN = /^develop$/i;
const MAINLINE_REJECTED_TARGET_PATTERNS = [
  /^release\/[a-z0-9._-]+$/i,
  /^bugfix\/[a-z0-9._-]+$/i,
];
const TYPED_GIT_FLOW_TARGET_PATTERNS = [
  /^release\/[a-z0-9._-]+$/i,
  HOTFIX_TARGET_PATTERN,
  /^bugfix\/[a-z0-9._-]+$/i,
];
const GIT_FLOW_ALLOWED_TARGET_PATTERNS = [
  FEATURE_TARGET_PATTERN,
  ...TYPED_GIT_FLOW_TARGET_PATTERNS,
];

const architectPlanIndexCache = new Map<
  string,
  {
    expiresAt: number;
    value?: ArchitectPlanIndex;
    promise?: Promise<ArchitectPlanIndex>;
  }
>();

const architectPlanActivationCache = new Map<
  string,
  {
    expiresAt: number;
    value?: ArchitectPlanActivationPayload | null;
    promise?: Promise<ArchitectPlanActivationPayload | null>;
  }
>();

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const getDynamicTargetPatterns = (): RegExp[] => {
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

const normalizeBranchName = (value?: string, fallbackBranch = DEFAULT_GIT_FLOW_BASE_BRANCH): string => {
  const normalized = (value || fallbackBranch)
    .trim()
    .replace(/\\/g, '/')
    .replace(/^refs\/heads\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
  return normalized || fallbackBranch;
};

const getArchitectPlanIndexCacheKey = (branchName: string): string =>
  normalizeBranchName(branchName);

const getArchitectPlanActivationSummarySignature = (
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

const getArchitectPlanActivationScopeSignature = (
  scopedProjectIdsHint?: string[]
): string | null => {
  const normalizedProjectIds = normalizeArchitectPlanIdList(scopedProjectIdsHint)
    .sort((left, right) => left.localeCompare(right));
  return normalizedProjectIds.length > 0 ? normalizedProjectIds.join(',') : null;
};

const getArchitectPlanActivationCacheKey = (
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

const loadCachedArchitectPlanValue = async <T>(params: {
  cache: Map<
    string,
    {
      expiresAt: number;
      value?: T;
      promise?: Promise<T>;
    }
  >;
  cacheKey: string;
  ttlMs: number;
  loader: () => Promise<T>;
}): Promise<T> => {
  const now = Date.now();
  const cached = params.cache.get(params.cacheKey);
  if (cached?.value !== undefined && cached.expiresAt > now) {
    return cached.value;
  }
  if (cached?.promise) {
    return cached.promise;
  }

  const promise = params.loader().then(
    (value) => {
      params.cache.set(params.cacheKey, {
        value,
        expiresAt: Date.now() + params.ttlMs,
      });
      return value;
    },
    (error) => {
      const inFlight = params.cache.get(params.cacheKey);
      if (inFlight?.promise === promise) {
        params.cache.delete(params.cacheKey);
      }
      throw error;
    }
  );

  params.cache.set(params.cacheKey, {
    expiresAt: now + params.ttlMs,
    promise,
  });
  return promise;
};

export const clearArchitectPlanFrontendCaches = (params?: {
  branchName?: string | null;
  planId?: string | null;
}): void => {
  const normalizedBranch = params?.branchName
    ? normalizeBranchName(params.branchName)
    : null;

  if (!normalizedBranch) {
    architectPlanIndexCache.clear();
    architectPlanActivationCache.clear();
    return;
  }

  architectPlanIndexCache.delete(getArchitectPlanIndexCacheKey(normalizedBranch));
  if (params?.planId) {
    const activationPrefix = `${normalizedBranch}::${sanitizeId(params.planId)}::`;
    for (const cacheKey of architectPlanActivationCache.keys()) {
      if (cacheKey.startsWith(activationPrefix)) {
        architectPlanActivationCache.delete(cacheKey);
      }
    }
    return;
  }

  const activationPrefix = `${normalizedBranch}::`;
  for (const cacheKey of architectPlanActivationCache.keys()) {
    if (cacheKey.startsWith(activationPrefix)) {
      architectPlanActivationCache.delete(cacheKey);
    }
  }
};

const invalidateArchitectPlanRuntimeCaches = (params?: {
  branchName?: string;
  planId?: string;
}): void => {
  const normalizedBranch = params?.branchName
    ? normalizeBranchName(params.branchName)
    : null;

  clearArchitectPlanFrontendCaches(params);
  if (tauriIpc.isTauriAvailable() && typeof tauriIpc.workspaceArchitectInvalidate === 'function') {
    void tauriIpc.workspaceArchitectInvalidate(
      normalizedBranch ? { branchName: normalizedBranch } : undefined,
    ).catch(() => undefined);
  }
};

const isGitFlowTargetBranch = (branchName: string): boolean =>
  getDynamicTargetPatterns().some((pattern) => pattern.test(branchName));

const assertGitFlowTargetBranch = (branchName: string): void => {
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

const sanitizeId = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '') || `plan-${Date.now()}`;

const slugifyPlanTitle = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '') || `plan-${Date.now()}`;

const createAvailablePlanSlug = (
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

const normalizePlanLabel = (value?: string): string | undefined => {
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

const normalizeProjectIds = (projectIds?: string[], projectId?: string): string[] => Array.from(
  new Set(
    [ ...(Array.isArray(projectIds) ? projectIds : []), ...(projectId ? [projectId] : []) ]
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
  )
);

const normalizeExpectedProjectIds = (expectedProjectIds?: string[], fallbackProjectIds?: string[]): string[] =>
  normalizeProjectIds(expectedProjectIds && expectedProjectIds.length > 0 ? expectedProjectIds : fallbackProjectIds);

const normalizeContextProjectIds = (
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
      if (!registrySnapshot?.readOnlyProjectIdSet.has(normalizedProjectId)) {
        continue;
      }
    }

    seenProjectIds.add(normalizedProjectId);
    sanitizedContextProjectIds.push(normalizedProjectId);
  }

  return sanitizedContextProjectIds;
};

const normalizeTargetBranchesByProjectId = (
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

const normalizeOptionalBranchName = (value?: string | null): string => {
  if (typeof value !== 'string') return '';
  return normalizeBranchName(value, '');
};

const areBranchNamesEqual = (
  left?: string | null,
  right?: string | null
): boolean =>
  normalizeOptionalBranchName(left).toLowerCase() ===
  normalizeOptionalBranchName(right).toLowerCase();

const resolveProjectDevelopmentBranch = (
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

const resolveProjectMainBranch = (
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

const getUniqueTargetBranchNames = (targetBranchesByProjectId: Record<string, string>): string[] =>
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

const resolveRegistryProjectGitFlowSettings = (
  registrySnapshot: ValidProjectRegistrySnapshot | null | undefined
): ProjectGitFlowSettingsResolver | undefined => {
  if (!registrySnapshot?.gitFlowSettingsByProjectId) {
    return undefined;
  }
  return (projectId) => registrySnapshot.gitFlowSettingsByProjectId.get(projectId) ?? null;
};

const mergeGitFlowTargetBranchesByProjectId = (
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

const hasMixedPlanTargetBranches = (targetBranchesByProjectId: Record<string, string>): boolean =>
  new Set(Object.values(targetBranchesByProjectId).filter((branchName) => branchName.trim().length > 0)).size > 1;

const hashString = (value: string): string => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `h${(hash >>> 0).toString(16).padStart(8, '0')}`;
};

const toJsonLines = (messages: ArchitectPlanChatMessage[]): string =>
  messages
    .map((message) => JSON.stringify(message))
    .join('\n');

const parseJsonLines = (raw: string): ArchitectPlanChatMessage[] =>
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

const getArchitectPlanScopeCandidateProjectIds = (
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

const normalizePlanNodes = (nodes: PlanNode[]): PlanNode[] =>
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

const normalizePlanPredictedBranches = (predictedBranches: PredictedBranch[]): PredictedBranch[] =>
  (Array.isArray(predictedBranches) ? predictedBranches : []).filter(
    (branch) => typeof branch?.projectId === 'string' && branch.projectId.trim().length > 0
  );

const resolvePlanProjectIds = (params: {
  projectIds?: string[];
  projectId?: string;
  nodes?: PlanNode[];
  predictedBranches?: PredictedBranch[];
}): string[] => {
  const fromNodes = normalizePlanNodes(params.nodes || []).flatMap((node) => normalizeProjectIds(node.projectIds, node.projectId));
  const fromBranches = normalizePlanPredictedBranches(params.predictedBranches || []).map((branch) => branch.projectId);
  return normalizeProjectIds([...(params.projectIds || []), ...fromNodes, ...fromBranches], params.projectId);
};

const getPlanRoot = (branchName: string): string => `branches/${normalizeBranchName(branchName)}/plans`;
const getIndexPath = (branchName: string): string => `${getPlanRoot(branchName)}/index.json`;
const getPlanDir = (branchName: string, planId: string): string => `${getPlanRoot(branchName)}/${sanitizeId(planId)}`;
const getPlanManifestPath = (branchName: string, planId: string): string => `${getPlanDir(branchName, planId)}/manifest.json`;
const getPlanJsonPath = (branchName: string, planId: string): string => `${getPlanDir(branchName, planId)}/plan.json`;
const getPlanMarkdownPath = (branchName: string, planId: string): string => `${getPlanDir(branchName, planId)}/plan.md`;
const getPlanChatPath = (branchName: string, planId: string): string => `${getPlanDir(branchName, planId)}/chat.jsonl`;
const getPlanTasksRoot = (branchName: string, planId: string): string => `${getPlanDir(branchName, planId)}/tasks`;
const getPlanTaskDir = (branchName: string, planId: string, taskId: string): string => `${getPlanTasksRoot(branchName, planId)}/${sanitizeId(taskId)}`;
const getTaskPlannedPath = (branchName: string, planId: string, taskId: string): string => `${getPlanTaskDir(branchName, planId, taskId)}/planned.md`;
const getTaskExecutedPath = (branchName: string, planId: string, taskId: string): string => `${getPlanTaskDir(branchName, planId, taskId)}/executed.md`;

const emptyIndex = (): ArchitectPlanIndex => ({ version: 3, activePlanId: null, plans: [], reservedPlanSlugs: [] });

const localIndexKey = (branchName: string): string => `${LOCAL_INDEX_KEY_PREFIX}:${normalizeBranchName(branchName)}`;
const localPlanKey = (branchName: string, planId: string): string =>
  `${LOCAL_PLAN_KEY_PREFIX}:${normalizeBranchName(branchName)}:${sanitizeId(planId)}`;
const localPlanChatKey = (branchName: string, planId: string): string =>
  `${LOCAL_PLAN_CHAT_KEY_PREFIX}:${normalizeBranchName(branchName)}:${sanitizeId(planId)}`;

const buildPlanMarkdown = (
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

const buildTaskPlannedMarkdown = (plan: ArchitectPlanRecord, node: PlanNode): string => {
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

const buildTaskExecutedMarkdown = (plan: ArchitectPlanRecord, record: ArchitectTaskExecutionRecord): string => {
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

interface ArchitectMetadataScope {
  scopeKey: string;
  projectId: string | null;
  repoPath: string | null;
  workspacePath: string | null;
  source: 'local' | 'project' | 'workspace';
  workspaceScope?: tauriIpc.WorkspaceScope;
}

interface ArchitectPlanReplicaSnapshot {
  scope: ArchitectMetadataScope;
  plan: ArchitectPlanRecord;
  manifest: ArchitectPlanManifest;
  files: Record<string, string>;
}

interface ArchitectPlanReplicaSnapshotDiagnostics extends ArchitectPlanReplicaSnapshot {
  repairApplied: boolean;
  removedInvalidProjectIds: string[];
}

interface ArchitectPlanReplicaSet {
  canonical: ArchitectPlanReplicaSnapshot;
  snapshots: ArchitectPlanReplicaSnapshot[];
  expectedScopes: ArchitectMetadataScope[];
  replicas: ArchitectPlanReplica[];
  hasReplicaDivergence: boolean;
}

const normalizeRepoPath = (value: string | null | undefined): string | null =>
  normalizeProjectRegistryPath(value);

const buildScopeKey = (source: ArchitectMetadataScope['source'], repoPath: string | null, projectId: string | null): string => {
  if (repoPath) {
    return `repo:${repoPath}`;
  }
  return `${source}:${projectId || 'none'}`;
};

const dedupeScopes = (scopes: ArchitectMetadataScope[]): ArchitectMetadataScope[] => {
  const deduped = new Map<string, ArchitectMetadataScope>();
  for (const scope of scopes) {
    if (!deduped.has(scope.scopeKey)) {
      deduped.set(scope.scopeKey, scope);
    }
  }
  return Array.from(deduped.values());
};

const resolveScopeProjectId = (
  scope: ArchitectMetadataScope,
  registrySnapshot?: ValidProjectRegistrySnapshot | null
): string | null => {
  const explicitProjectId = typeof scope.projectId === 'string' ? scope.projectId.trim() : '';
  if (explicitProjectId) {
    return explicitProjectId;
  }

  const normalizedRepoPath = normalizeRepoPath(scope.repoPath);
  if (!normalizedRepoPath || !registrySnapshot?.repoPathByProjectId) {
    return null;
  }

  for (const [projectId, repoPath] of registrySnapshot.repoPathByProjectId.entries()) {
    if (normalizeRepoPath(repoPath) === normalizedRepoPath) {
      return projectId;
    }
  }

  return null;
};

const getProjectMetadataScopes = (
  registrySnapshot: ValidProjectRegistrySnapshot,
  projectIds?: string[],
  executionModesByProjectId?: Record<string, 'git' | 'direct'>,
): ArchitectMetadataScope[] => {
  const targetProjectIds = projectIds && projectIds.length > 0
    ? Array.from(new Set(projectIds))
    : registrySnapshot.validProjectIds;

  return targetProjectIds.flatMap((projectId) => {
    const repoPath = registrySnapshot.repoPathByProjectId.get(projectId) || null;
    const workspacePath = registrySnapshot.workspacePathByProjectId.get(projectId) || null;
    if (!workspacePath) {
      return [];
    }
    const executionMode = executionModesByProjectId?.[projectId] ??
      registrySnapshot.executionModeByProjectId.get(projectId);
    return [{
      scopeKey: buildScopeKey(repoPath ? 'project' : 'workspace', workspacePath, projectId),
      projectId,
      repoPath,
      workspacePath,
      source: repoPath ? 'project' as const : 'workspace' as const,
      workspaceScope: executionMode === 'direct' ? 'direct' : METADATA_WORKSPACE_SCOPE,
    }];
  });
};

const getScopeWorkspaceScope = (scope: ArchitectMetadataScope): tauriIpc.WorkspaceScope =>
  scope.workspaceScope ?? METADATA_WORKSPACE_SCOPE;

const getWorkspaceFallbackScope = async (): Promise<ArchitectMetadataScope | null> => {
  if (!tauriIpc.isTauriAvailable()) {
    return null;
  }

  try {
    const repoPath = normalizeRepoPath(await tauriIpc.workspaceGetActiveRoot());
    if (!repoPath) return null;
    return {
      scopeKey: buildScopeKey('workspace', repoPath, null),
      projectId: null,
      repoPath,
      workspacePath: repoPath,
      source: 'workspace',
    };
  } catch {
    return null;
  }
};

const resolveMetadataScopes = async (projectIds?: string[], options?: {
  includeAllKnown?: boolean;
  includeWorkspaceFallback?: boolean;
  executionModesByProjectId?: Record<string, 'git' | 'direct'>;
}, registrySnapshot?: ValidProjectRegistrySnapshot | null, deps?: ResolvedArchitectPlanServiceDependencies): Promise<ArchitectMetadataScope[]> => {
  const resolvedDeps = deps ?? resolveArchitectPlanServiceDependencies();
  if (!resolvedDeps.tauri.isTauriAvailable()) {
    return [{
      scopeKey: 'local',
      projectId: projectIds?.[0] || null,
      repoPath: null,
      workspacePath: null,
      source: 'local',
    }];
  }

  const resolvedRegistrySnapshot =
    registrySnapshot ??
    await resolvedDeps.loadRegistrySnapshot({ getAppState: resolvedDeps.getAppState });
  const scopes: ArchitectMetadataScope[] = [];
  if (projectIds && projectIds.length > 0) {
    scopes.push(...getProjectMetadataScopes(
      resolvedRegistrySnapshot,
      projectIds,
      options?.executionModesByProjectId,
    ));
  }
  if (options?.includeAllKnown || ((!projectIds || projectIds.length === 0) && scopes.length === 0)) {
    scopes.push(...getProjectMetadataScopes(
      resolvedRegistrySnapshot,
      undefined,
      options?.executionModesByProjectId,
    ));
  }
  if (options?.includeWorkspaceFallback !== false) {
    const workspaceScope = await getWorkspaceFallbackScope();
    const duplicatesDirectWorkspace = workspaceScope && scopes.some((scope) =>
      scope.source === 'workspace' &&
      normalizeRepoPath(scope.workspacePath) === normalizeRepoPath(workspaceScope.workspacePath)
    );
    if (workspaceScope && !duplicatesDirectWorkspace) {
      scopes.push(workspaceScope);
    }
  }
  return dedupeScopes(scopes);
};

const loadArchitectPlanRegistrySnapshot = async (
  deps?: ResolvedArchitectPlanServiceDependencies
): Promise<ValidProjectRegistrySnapshot | undefined> => {
  const resolvedDeps = deps ?? resolveArchitectPlanServiceDependencies();
  return resolvedDeps.tauri.isTauriAvailable()
    ? resolvedDeps.loadRegistrySnapshot({ getAppState: resolvedDeps.getAppState })
    : undefined;
};

const toReplicaDescriptor = (
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

const stableSortObject = (value: unknown): unknown => {
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

const stableSerialize = (value: unknown): string => JSON.stringify(stableSortObject(value));

const areSerializedContentsEqual = (left: string, right: string): boolean => left === right;

const buildPlanContentHashes = (
  plan: ArchitectPlanRecord,
  chatMessages: ArchitectPlanChatMessage[]
): ArchitectPlanContentHashes => ({
  plan: hashString(stableSerialize(stripPlanReplicaMetadata(plan))),
  chat: hashString(toJsonLines(chatMessages)),
});

const loadParticipantSnapshots = async (
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

const buildPlanConversationSnapshot = (
  plan: ArchitectPlanRecord,
  chatMessages: ArchitectPlanChatMessage[]
): ArchitectPlanConversationSnapshot => ({
  conversationId: plan.conversationId ?? null,
  title: plan.label || plan.title || null,
  messageCount: chatMessages.length,
  lastMessageAt: chatMessages.length > 0 ? chatMessages[chatMessages.length - 1]!.createdAt : null,
});

const buildPlanManifest = async (params: {
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

interface SanitizedArchitectPlanResult {
  plan: ArchitectPlanRecord | null;
  removedInvalidProjectIds: string[];
  changed: boolean;
}

interface SanitizedArchitectPlanSummaryResult {
  summary: ArchitectPlanSummary;
  removedInvalidProjectIds: string[];
  changed: boolean;
}

const dedupeProjectIdDiagnostics = (projectIds: string[]): string[] => Array.from(new Set(projectIds));

const shouldValidateProjectIds = (registrySnapshot?: ValidProjectRegistrySnapshot | null): boolean =>
  Boolean(registrySnapshot?.hasRegisteredProjects);

const normalizePersistedExecutionModes = (
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

const sanitizeProjectIdsForRegistry = (
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

    if (validateProjectIds && registrySnapshot?.readOnlyProjectIdSet.has(normalizedProjectId)) {
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

const sanitizePlanNodesForRegistry = (
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

const sanitizePredictedBranchesForRegistry = (
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
      (validateProjectIds && Boolean(registrySnapshot?.readOnlyProjectIdSet.has(normalizedProjectId)))
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

const logArchitectPlanSanitization = (params: {
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

const logArchitectPlanActivationLoad = (params: {
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

const toErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const sanitizeArchitectPlanRecord = (
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
    ? (normalizedPlan.projectIds || []).filter((projectId) => registrySnapshot.readOnlyProjectIdSet.has(projectId))
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

const sanitizeArchitectPlanSummary = (
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
    ? (normalizedSummary.projectIds || []).filter((projectId) => registrySnapshot.readOnlyProjectIdSet.has(projectId))
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

const compareReplicaRecency = (
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

const pickCanonicalReplica = <T extends { updatedAt?: string | null; repoPath: string | null }>(
  items: T[],
  strategy: ArchitectPlanReplicaRepairStrategy = 'newest'
): T => {
  const sorted = [...items].sort(compareReplicaRecency);
  return strategy === 'oldest' ? sorted[0] : sorted[sorted.length - 1];
};

const stripPlanReplicaMetadata = (plan: ArchitectPlanRecord): ArchitectPlanRecord => ({
  ...plan,
  availableProjectIds: undefined,
  missingProjectIds: undefined,
  replicationState: undefined,
  replicas: undefined,
  hasReplicaDivergence: undefined,
});

const buildComparablePlanSnapshot = (plan: ArchitectPlanRecord): unknown => ({
  ...stripPlanReplicaMetadata(plan),
  updatedAt: undefined,
  revision: undefined,
});

const areArchitectPlansSemanticallyEqual = (
  left: ArchitectPlanRecord,
  right: ArchitectPlanRecord
): boolean =>
  stableSerialize(buildComparablePlanSnapshot(left)) ===
  stableSerialize(buildComparablePlanSnapshot(right));

const arePlanChatMessagesEquivalent = (
  left: ArchitectPlanChatMessage[],
  right: ArchitectPlanChatMessage[]
): boolean => areSerializedContentsEqual(toJsonLines(left), toJsonLines(right));

const buildReplicaComparableSnapshot = (snapshot: ArchitectPlanReplicaSnapshot): unknown => ({
  plan: buildComparablePlanSnapshot(snapshot.plan),
  artifacts: snapshot.manifest.artifacts ?? null,
});

const buildReplicaComparableSummary = (summary: ArchitectPlanSummary): unknown => ({
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

const throwReplicaDivergence = (params: {
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

function throwPlanMetadataMissing(
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

const architectPlanMutationQueues = new Map<string, Promise<void>>();

const getArchitectPlanMutationQueueKey = (branchName: string, _planId: string): string =>
  normalizeBranchName(branchName);

const enqueueArchitectPlanMutation = async <T>(
  branchName: string,
  planId: string,
  mutation: () => Promise<T>
): Promise<T> => {
  const queueKey = getArchitectPlanMutationQueueKey(branchName, planId);
  const previous = architectPlanMutationQueues.get(queueKey) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(mutation);
  const stored = run.then(
    () => undefined,
    () => undefined
  );
  architectPlanMutationQueues.set(queueKey, stored);

  try {
    return await run;
  } finally {
    if (architectPlanMutationQueues.get(queueKey) === stored) {
      architectPlanMutationQueues.delete(queueKey);
    }
  }
};

const enqueueArchitectPlanCreation = async <T>(
  branchName: string,
  creation: () => Promise<T>
): Promise<T> => {
  const queueKey = normalizeBranchName(branchName);
  const previous = architectPlanMutationQueues.get(queueKey) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(creation);
  const stored = run.then(
    () => undefined,
    () => undefined
  );
  architectPlanMutationQueues.set(queueKey, stored);

  try {
    return await run;
  } finally {
    if (architectPlanMutationQueues.get(queueKey) === stored) {
      architectPlanMutationQueues.delete(queueKey);
    }
  }
};

const syncPlanTaskMetadataAtScope = async (
  scope: ArchitectMetadataScope,
  branchName: string,
  plan: ArchitectPlanRecord
): Promise<void> => {
  if (!tauriIpc.isTauriAvailable() || scope.source === 'local') return;
  const normalizedBranch = normalizeBranchName(branchName);
  const normalizedPlan = {
    ...plan,
    nodes: normalizePlanNodes(plan.nodes),
    predictedBranches: normalizePlanPredictedBranches(plan.predictedBranches),
  };
  const activeTaskIds = new Set(normalizedPlan.nodes.map((node) => node.id));

  try {
    const existingTaskEntries = await tauriIpc.fsListDir({
      path: getPlanTasksRoot(normalizedBranch, normalizedPlan.id),
      recursive: false,
      includeHidden: true,
      allowOutsideWorkspace: false,
      workspaceScope: getScopeWorkspaceScope(scope),
      workspacePath: scope.workspacePath,
    });

    await Promise.all(
      existingTaskEntries
        .filter((entry) => entry.kind === 'dir' || entry.kind === 'directory')
        .filter((entry) => !activeTaskIds.has(entry.name))
        .map((entry) =>
          tauriIpc.fsDelete({
            path: getTaskPlannedPath(normalizedBranch, normalizedPlan.id, entry.name),
            workspaceScope: getScopeWorkspaceScope(scope),
            workspacePath: scope.workspacePath,
          }).catch(() => undefined)
        )
    );
  } catch {
    // Ignore missing task directories and keep planned metadata writes best-effort.
  }

  await Promise.all(
    normalizedPlan.nodes.map((node) =>
      writeTextFileAtScope(
        scope,
        getTaskPlannedPath(normalizedBranch, normalizedPlan.id, node.id),
        buildTaskPlannedMarkdown(normalizedPlan, node)
      )
    )
  );
};

const readJsonFileAtScope = async <T>(
  scope: ArchitectMetadataScope,
  path: string
): Promise<T | null> => {
  if (!tauriIpc.isTauriAvailable() || scope.source === 'local') return null;
  try {
    const file = await tauriIpc.fsReadFileWithOptions({
      path,
      allowOutsideWorkspace: false,
      workspaceScope: getScopeWorkspaceScope(scope),
      workspacePath: scope.workspacePath,
    });
    return JSON.parse(file.content) as T;
  } catch {
    return null;
  }
};

const writeJsonFileAtScope = async (
  scope: ArchitectMetadataScope,
  path: string,
  value: unknown
): Promise<boolean> => {
  if (!tauriIpc.isTauriAvailable() || scope.source === 'local') return false;
  const content = JSON.stringify(value, null, 2);
  const existing = await readTextFileAtScope(scope, path);
  if (typeof existing === 'string' && areSerializedContentsEqual(existing, content)) {
    return false;
  }
  await tauriIpc.fsWriteFile({
    path,
    content,
    createDirs: true,
    allowOutsideWorkspace: false,
    workspaceScope: getScopeWorkspaceScope(scope),
    workspacePath: scope.workspacePath,
  });
  return true;
};

const readTextFileAtScope = async (
  scope: ArchitectMetadataScope,
  path: string
): Promise<string | null> => {
  if (!tauriIpc.isTauriAvailable() || scope.source === 'local') return null;
  try {
    const file = await tauriIpc.fsReadFileWithOptions({
      path,
      allowOutsideWorkspace: false,
      workspaceScope: getScopeWorkspaceScope(scope),
      workspacePath: scope.workspacePath,
    });
    return file.content;
  } catch {
    return null;
  }
};

const writeTextFileAtScope = async (
  scope: ArchitectMetadataScope,
  path: string,
  content: string
): Promise<boolean> => {
  if (!tauriIpc.isTauriAvailable() || scope.source === 'local') return false;
  const existing = await readTextFileAtScope(scope, path);
  if (typeof existing === 'string' && areSerializedContentsEqual(existing, content)) {
    return false;
  }
  await tauriIpc.fsWriteFile({
    path,
    content,
    createDirs: true,
    allowOutsideWorkspace: false,
    workspaceScope: getScopeWorkspaceScope(scope),
    workspacePath: scope.workspacePath,
  });
  return true;
};

const readLocalIndex = (branchName: string): ArchitectPlanIndex => {
  if (typeof window === 'undefined') return emptyIndex();
  try {
    const raw = window.localStorage.getItem(localIndexKey(branchName));
    if (!raw) return emptyIndex();
    const parsed = JSON.parse(raw) as Partial<ArchitectPlanIndex>;
    const reservedPlanSlugs = Array.isArray(parsed.reservedPlanSlugs)
      ? parsed.reservedPlanSlugs
          .filter((slug): slug is string => typeof slug === 'string')
          .map((slug) => slugifyPlanTitle(slug))
      : [];
    const planSlugsFromIndex = Array.isArray(parsed.plans)
      ? parsed.plans.map((plan) => slugifyPlanTitle((plan as Partial<ArchitectPlanSummary>).slug || plan.title || plan.id))
      : [];
    if (parsed && Array.isArray(parsed.plans)) {
      return {
        version: parsed.version === 2 ? 2 : 3,
        activePlanId: parsed.activePlanId || null,
        plans: parsed.plans,
        reservedPlanSlugs: Array.from(new Set([...reservedPlanSlugs, ...planSlugsFromIndex])),
      };
    }
    return emptyIndex();
  } catch {
    return emptyIndex();
  }
};

const readLocalPlan = (branchName: string, planId: string): ArchitectPlanRecord | null => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(localPlanKey(branchName, planId));
    if (!raw) return null;
    return JSON.parse(raw) as ArchitectPlanRecord;
  } catch {
    return null;
  }
};

const readLocalPlanChat = (branchName: string, planId: string): ArchitectPlanChatMessage[] => {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(localPlanChatKey(branchName, planId));
    if (!raw) return [];
    return parseJsonLines(raw);
  } catch {
    return [];
  }
};

const writeLocalValueIfChanged = (key: string, value: string): boolean => {
  if (typeof window === 'undefined') return false;
  const existing = window.localStorage.getItem(key);
  if (existing === value) {
    return false;
  }
  window.localStorage.setItem(key, value);
  return true;
};

const writeLocalPlan = (branchName: string, plan: ArchitectPlanRecord): boolean =>
  writeLocalValueIfChanged(localPlanKey(branchName, plan.id), JSON.stringify(plan));

const writeLocalPlanChat = (
  branchName: string,
  planId: string,
  messages: ArchitectPlanChatMessage[]
): boolean =>
  writeLocalValueIfChanged(localPlanChatKey(branchName, planId), toJsonLines(messages));

const writeLocalIndex = (branchName: string, value: ArchitectPlanIndex): boolean =>
  writeLocalValueIfChanged(localIndexKey(branchName), JSON.stringify(value));

const deleteLocalPlan = (branchName: string, planId: string): void => {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(localPlanKey(branchName, planId));
};

const deleteLocalPlanChat = (branchName: string, planId: string): void => {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(localPlanChatKey(branchName, planId));
};

const normalizeSummariesForBranch = (
  branchName: string,
  summaries: ArchitectPlanSummary[],
  registrySnapshot?: ValidProjectRegistrySnapshot | null,
  options?: {
    logContext?: string;
    scopeKey?: string | null;
  }
): ArchitectPlanSummary[] =>
  summaries.map((summary) =>
    sanitizeArchitectPlanSummary(branchName, summary, registrySnapshot, options).summary
  );

const readIndexAtScope = async (
  scope: ArchitectMetadataScope,
  branchName: string,
  registrySnapshot?: ValidProjectRegistrySnapshot | null
): Promise<ArchitectPlanIndex> => {
  const normalized = normalizeBranchName(branchName);
  if (!tauriIpc.isTauriAvailable() || scope.source === 'local') {
    const local = readLocalIndex(normalized);
    return {
      ...local,
      plans: normalizeSummariesForBranch(normalized, local.plans, registrySnapshot, {
        logContext: 'index_read',
        scopeKey: scope.scopeKey,
      }),
      reservedPlanSlugs: Array.from(new Set(local.reservedPlanSlugs.map((slug) => slugifyPlanTitle(slug)))),
    };
  }

  const parsed = await readJsonFileAtScope<Partial<ArchitectPlanIndex>>(scope, getIndexPath(normalized));
  if (parsed && Array.isArray(parsed.plans)) {
    const reservedPlanSlugs = Array.isArray(parsed.reservedPlanSlugs)
      ? parsed.reservedPlanSlugs
          .filter((slug): slug is string => typeof slug === 'string')
          .map((slug) => slugifyPlanTitle(slug))
      : [];
    const planSlugsFromIndex = parsed.plans.map((plan) =>
      slugifyPlanTitle((plan as Partial<ArchitectPlanSummary>).slug || plan.title || plan.id)
    );
    return {
      version: parsed.version === 2 ? 2 : 3,
      activePlanId: parsed.activePlanId || null,
      plans: normalizeSummariesForBranch(normalized, parsed.plans, registrySnapshot, {
        logContext: 'index_read',
        scopeKey: scope.scopeKey,
      }),
      reservedPlanSlugs: Array.from(new Set([...reservedPlanSlugs, ...planSlugsFromIndex])),
    };
  }

  return emptyIndex();
};

const writeIndexAtScope = async (
  scope: ArchitectMetadataScope,
  branchName: string,
  index: ArchitectPlanIndex
): Promise<boolean> => {
  const normalized = normalizeBranchName(branchName);
  if (!tauriIpc.isTauriAvailable() || scope.source === 'local') {
    return writeLocalIndex(normalized, index);
  }

  return writeJsonFileAtScope(scope, getIndexPath(normalized), index);
};

const normalizePlanRecordForBranch = (
  branchName: string,
  planId: string,
  plan: ArchitectPlanRecord | null,
  registrySnapshot?: ValidProjectRegistrySnapshot | null,
  options?: {
    logContext?: string;
    scopeKey?: string | null;
  }
): ArchitectPlanRecord | null =>
  sanitizeArchitectPlanRecord(branchName, planId, plan, registrySnapshot, options).plan;

const readPlanAtScopeWithDiagnostics = async (
  scope: ArchitectMetadataScope,
  branchName: string,
  planId: string,
  registrySnapshot?: ValidProjectRegistrySnapshot | null
): Promise<SanitizedArchitectPlanResult> => {
  const normalized = normalizeBranchName(branchName);
  const safeId = sanitizeId(planId);
  if (!tauriIpc.isTauriAvailable() || scope.source === 'local') {
    return sanitizeArchitectPlanRecord(
      normalized,
      safeId,
      readLocalPlan(normalized, safeId),
      registrySnapshot,
      {
        logContext: 'plan_read',
        scopeKey: scope.scopeKey,
      }
    );
  }

  return sanitizeArchitectPlanRecord(
    normalized,
    safeId,
    await readJsonFileAtScope<ArchitectPlanRecord>(scope, getPlanJsonPath(normalized, safeId)),
    registrySnapshot,
    {
      logContext: 'plan_read',
      scopeKey: scope.scopeKey,
    }
  );
};

const readPlanChatAtScope = async (
  scope: ArchitectMetadataScope,
  branchName: string,
  planId: string
): Promise<ArchitectPlanChatMessage[]> => {
  const normalized = normalizeBranchName(branchName);
  const safeId = sanitizeId(planId);
  if (!tauriIpc.isTauriAvailable() || scope.source === 'local') {
    return readLocalPlanChat(normalized, safeId);
  }
  const raw = await readTextFileAtScope(scope, getPlanChatPath(normalized, safeId));
  return raw ? parseJsonLines(raw) : [];
};

const readStoredPlanManifestAtScope = async (
  scope: ArchitectMetadataScope,
  branchName: string,
  planId: string
): Promise<Partial<ArchitectPlanManifest> | null> => {
  const normalized = normalizeBranchName(branchName);
  const safeId = sanitizeId(planId);
  if (!tauriIpc.isTauriAvailable() || scope.source === 'local') {
    return null;
  }

  return await readJsonFileAtScope<Partial<ArchitectPlanManifest>>(
    scope,
    getPlanManifestPath(normalized, safeId)
  );
};

const normalizeArtifactManifestSummary = (
  value: unknown
): ArchitectPlanArtifactManifestSummary | undefined => {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const parsed = value as Partial<ArchitectPlanArtifactManifestSummary>;
  if (
    typeof parsed.count !== 'number' ||
    !Number.isFinite(parsed.count) ||
    typeof parsed.indexHash !== 'string' ||
    parsed.indexHash.trim().length === 0 ||
    typeof parsed.contentHash !== 'string' ||
    parsed.contentHash.trim().length === 0 ||
    typeof parsed.updatedAt !== 'string' ||
    parsed.updatedAt.trim().length === 0
  ) {
    return undefined;
  }
  return {
    count: Math.max(0, Math.floor(parsed.count)),
    indexHash: parsed.indexHash,
    contentHash: parsed.contentHash,
    ...(typeof parsed.reviewHash === 'string' && parsed.reviewHash.trim().length > 0
      ? { reviewHash: parsed.reviewHash }
      : {}),
    updatedAt: parsed.updatedAt,
  };
};

const preservePlanArtifactManifestAtScope = async (
  scope: ArchitectMetadataScope,
  branchName: string,
  planId: string,
  manifest: ArchitectPlanManifest
): Promise<ArchitectPlanManifest> => {
  if (!tauriIpc.isTauriAvailable() || scope.source === 'local') {
    return manifest;
  }
  const existing = await readStoredPlanManifestAtScope(scope, branchName, planId);
  const artifacts = normalizeArtifactManifestSummary(existing?.artifacts);
  return artifacts ? { ...manifest, artifacts } : manifest;
};

const readPlanManifestAtScope = async (params: {
  scope: ArchitectMetadataScope;
  branchName: string;
  plan: ArchitectPlanRecord;
  chatMessages: ArchitectPlanChatMessage[];
  registrySnapshot?: ValidProjectRegistrySnapshot | null;
}): Promise<ArchitectPlanManifest> => {
  const normalized = normalizeBranchName(params.branchName);
  const safeId = sanitizeId(params.plan.id);
  const fallbackManifest = await buildPlanManifest({
    plan: params.plan,
    chatMessages: params.chatMessages,
    registrySnapshot: params.registrySnapshot,
  });

  if (!tauriIpc.isTauriAvailable() || params.scope.source === 'local') {
    return fallbackManifest;
  }

  const parsed = await readJsonFileAtScope<Partial<ArchitectPlanManifest>>(
    params.scope,
    getPlanManifestPath(normalized, safeId)
  );
  if (!parsed) {
    return fallbackManifest;
  }

  const actionableProjectIds = getArchitectPlanActionableProjectIds(params.plan);
  const contextProjectIds = normalizeContextProjectIds(
    parsed.contextProjectIds ?? fallbackManifest.contextProjectIds,
    actionableProjectIds,
    params.registrySnapshot
  );
  const expectedProjectIds = normalizeArchitectPlanIdList(actionableProjectIds, contextProjectIds);

  return {
    ...fallbackManifest,
    ...parsed,
    schemaVersion: 3,
    planId: safeId,
    targetBranch: normalized,
    targetBranchesByProjectId: normalizeTargetBranchesByProjectId(
      parsed.targetBranchesByProjectId,
      actionableProjectIds,
      normalized
    ),
    status: params.plan.status,
    expectedProjectIds,
    contextProjectIds,
    participants: Array.isArray(parsed.participants) ? parsed.participants : fallbackManifest.participants,
    revision:
      typeof parsed.revision === 'number' && Number.isFinite(parsed.revision) && parsed.revision > 0
        ? Math.floor(parsed.revision)
        : fallbackManifest.revision,
    updatedAt:
      typeof parsed.updatedAt === 'string' && parsed.updatedAt.trim().length > 0
        ? parsed.updatedAt
        : fallbackManifest.updatedAt,
    contentHashes: parsed.contentHashes && typeof parsed.contentHashes === 'object'
      ? {
          plan:
            typeof parsed.contentHashes.plan === 'string'
              ? parsed.contentHashes.plan
              : fallbackManifest.contentHashes.plan,
          chat:
            typeof parsed.contentHashes.chat === 'string'
              ? parsed.contentHashes.chat
              : fallbackManifest.contentHashes.chat,
        }
      : fallbackManifest.contentHashes,
    artifacts: normalizeArtifactManifestSummary(parsed.artifacts),
    conversation: parsed.conversation && typeof parsed.conversation === 'object'
      ? {
          conversationId:
            typeof parsed.conversation.conversationId === 'string' ? parsed.conversation.conversationId : fallbackManifest.conversation.conversationId,
          title: typeof parsed.conversation.title === 'string' ? parsed.conversation.title : fallbackManifest.conversation.title,
          messageCount:
            typeof parsed.conversation.messageCount === 'number' ? parsed.conversation.messageCount : fallbackManifest.conversation.messageCount,
          lastMessageAt:
            typeof parsed.conversation.lastMessageAt === 'string' ? parsed.conversation.lastMessageAt : fallbackManifest.conversation.lastMessageAt,
        }
      : fallbackManifest.conversation,
    deletion:
      parsed.deletion && typeof parsed.deletion === 'object' && typeof parsed.deletion.deletedAt === 'string'
        ? { deletedAt: parsed.deletion.deletedAt }
        : fallbackManifest.deletion,
  };
};

const writePlanAtScope = async (
  scope: ArchitectMetadataScope,
  branchName: string,
  plan: ArchitectPlanRecord,
  registrySnapshot?: ValidProjectRegistrySnapshot | null,
  options?: {
    chatMessages?: ArchitectPlanChatMessage[];
  }
): Promise<void> => {
  const normalized = normalizeBranchName(branchName);
  const sanitizedPlanResult = sanitizeArchitectPlanRecord(
    normalized,
    plan.id,
    {
      ...stripPlanReplicaMetadata(plan),
      title: isCanonicalArchitectPlan(plan) ? plan.id : (plan.title || plan.id).trim() || plan.id,
    },
    registrySnapshot,
    {
      logContext: 'plan_write',
      scopeKey: scope.scopeKey,
    }
  );
  if (!sanitizedPlanResult.plan) {
    throwPlanMetadataMissing(normalized, plan.id);
  }
  const normalizedPlan: ArchitectPlanRecord = {
    ...sanitizedPlanResult.plan,
    label: normalizePlanLabel(sanitizedPlanResult.plan.label),
  };

  if (!tauriIpc.isTauriAvailable() || scope.source === 'local') {
    writeLocalPlan(normalized, normalizedPlan);
    return;
  }

  const safeId = sanitizeId(normalizedPlan.id);
  await writeJsonFileAtScope(scope, getPlanJsonPath(normalized, safeId), normalizedPlan);
  await writeTextFileAtScope(scope, getPlanMarkdownPath(normalized, safeId), buildPlanMarkdown(normalizedPlan, registrySnapshot));
  await syncPlanTaskMetadataAtScope(scope, normalized, normalizedPlan);
  const chatMessages = options?.chatMessages ?? await readPlanChatAtScope(scope, normalized, safeId);
  const manifest = await preservePlanArtifactManifestAtScope(scope, normalized, safeId, await buildPlanManifest({
    plan: normalizedPlan,
    chatMessages,
    registrySnapshot,
  }));
  await writeJsonFileAtScope(scope, getPlanManifestPath(normalized, safeId), manifest);
};

const writePlanChatAtScope = async (
  scope: ArchitectMetadataScope,
  branchName: string,
  planId: string,
  messages: ArchitectPlanChatMessage[],
  registrySnapshot?: ValidProjectRegistrySnapshot | null,
  options?: {
    skipManifest?: boolean;
  }
): Promise<void> => {
  const normalized = normalizeBranchName(branchName);
  const safeId = sanitizeId(planId);
  if (!tauriIpc.isTauriAvailable() || scope.source === 'local') {
    writeLocalPlanChat(normalized, safeId, messages);
    return;
  }

  await writeTextFileAtScope(scope, getPlanChatPath(normalized, safeId), toJsonLines(messages));
  if (options?.skipManifest) {
    return;
  }
  const planResult = await readPlanAtScopeWithDiagnostics(scope, normalized, safeId, registrySnapshot);
  if (planResult.plan) {
    const manifest = await preservePlanArtifactManifestAtScope(scope, normalized, safeId, await buildPlanManifest({
      plan: planResult.plan,
      chatMessages: messages,
      registrySnapshot,
    }));
    await writeJsonFileAtScope(scope, getPlanManifestPath(normalized, safeId), manifest);
  }
};

const removePlanAtScope = async (scope: ArchitectMetadataScope, branchName: string, planId: string): Promise<void> => {
  const normalized = normalizeBranchName(branchName);
  const safeId = sanitizeId(planId);
  if (!tauriIpc.isTauriAvailable() || scope.source === 'local') {
    deleteLocalPlan(normalized, safeId);
    deleteLocalPlanChat(normalized, safeId);
    return;
  }

  const path = getPlanDir(normalized, safeId);
  if (!await tauriIpc.fsExists(path, {
    workspaceScope: getScopeWorkspaceScope(scope),
    workspacePath: scope.workspacePath,
  })) return;
  await tauriIpc.fsDelete({
    path,
    recursive: true,
    workspaceScope: getScopeWorkspaceScope(scope),
    workspacePath: scope.workspacePath,
  });
};

interface ArchitectPlanReplicaMutationTarget {
  scope: ArchitectMetadataScope;
  action: 'upsert' | 'remove' | 'index';
  plan: ArchitectPlanRecord | null;
  executionModesByProjectId?: Record<string, 'git' | 'direct'>;
  index: ArchitectPlanIndex;
  chatMessages?: ArchitectPlanChatMessage[];
  replacePlanDirectory?: boolean;
  extraFiles?: Record<string, string>;
}

interface ArchitectPlanReplicaMutationPayload {
  targets: ArchitectPlanReplicaMutationTarget[];
  commitMessage: string;
}

const isReplicaMutationPayload = (
  entry: ArchitectPlanMutationJournalEntry,
): entry is ArchitectPlanMutationJournalEntry<ArchitectPlanReplicaMutationPayload> => {
  const payload = entry.payload;
  const candidate = payload as Partial<ArchitectPlanReplicaMutationPayload>;
  const scopeKeys = new Set<string>();
  return entry.branchName === normalizeBranchName(entry.branchName) && entry.planId === sanitizeId(entry.planId) &&
    typeof candidate.commitMessage === 'string' && candidate.commitMessage.trim().length > 0 &&
    Array.isArray(candidate?.targets) && candidate.targets.length > 0 && candidate.targets.every((target) => {
    const scope = target?.scope;
    const validScope = !!scope && typeof scope.scopeKey === 'string' && scope.scopeKey.length > 0 &&
      !scopeKeys.has(scope.scopeKey) && (scope.source === 'local' || scope.source === 'project' || scope.source === 'workspace') &&
      (scope.projectId === null || typeof scope.projectId === 'string') &&
      (scope.repoPath === null || typeof scope.repoPath === 'string') &&
      (scope.workspacePath === null || typeof scope.workspacePath === 'string');
    if (validScope) scopeKeys.add(scope.scopeKey);
    return validScope &&
    !!target && (target.action === 'upsert' || target.action === 'remove' || target.action === 'index') &&
    !!target.index && (target.index.version === 2 || target.index.version === 3) &&
    Array.isArray(target.index.plans) && target.index.plans.every((summary) =>
      !!summary && typeof summary.id === 'string' && typeof summary.targetBranch === 'string'
    ) && Array.isArray(target.index.reservedPlanSlugs) &&
    (target.action === 'remove'
      ? target.plan === null && !target.index.plans.some((summary) => summary.id === entry.planId)
      : target.action === 'index'
        ? target.plan === null
        : !!target.plan && target.plan.id === entry.planId && target.plan.targetBranch === entry.branchName &&
          target.index.plans.some((summary) => summary.id === entry.planId)) &&
    (target.executionModesByProjectId === undefined || (
      target.executionModesByProjectId !== null &&
      typeof target.executionModesByProjectId === 'object' &&
      Object.entries(target.executionModesByProjectId).every(([projectId, mode]) =>
        projectId.length > 0 && (mode === 'git' || mode === 'direct')
      )
    )) && (target.chatMessages === undefined || (Array.isArray(target.chatMessages) && target.chatMessages.every((message) =>
      !!message && typeof message.id === 'string' && (message.role === 'user' || message.role === 'assistant') &&
      typeof message.content === 'string' && typeof message.createdAt === 'string'
    ))) && (target.replacePlanDirectory === undefined || typeof target.replacePlanDirectory === 'boolean') &&
    (target.extraFiles === undefined || (target.extraFiles !== null && typeof target.extraFiles === 'object' &&
      Object.entries(target.extraFiles).every(([path, content]) =>
        path.startsWith('artifacts/') && !path.includes('..') && !path.includes('\\') &&
        typeof content === 'string'
      )));
  });
};

const getMutationTargetExecutionModes = (
  target: ArchitectPlanReplicaMutationTarget,
  registrySnapshot?: ValidProjectRegistrySnapshot | null,
): Record<string, 'git' | 'direct'> =>
  target.executionModesByProjectId ??
  (target.plan ? getPlanExecutionModes(target.plan, registrySnapshot) : {});

const shouldCommitMutationTarget = (
  target: ArchitectPlanReplicaMutationTarget,
  registrySnapshot?: ValidProjectRegistrySnapshot | null,
): boolean => {
  const modesByProjectId = getMutationTargetExecutionModes(target, registrySnapshot);
  if (target.scope.projectId) {
    return modesByProjectId[target.scope.projectId] === 'git';
  }
  return Object.values(modesByProjectId).some((mode) => mode === 'git');
};

const getPlanExecutionModes = (
  plan: ArchitectPlanRecord,
  registrySnapshot?: ValidProjectRegistrySnapshot | null,
): Record<string, 'git' | 'direct'> => {
  const projectIds = new Set(plan.projectIds ?? []);
  const modes = Object.fromEntries(
    Object.entries(plan.executionModesByProjectId ?? {}).filter(
      ([projectId, mode]) => projectIds.has(projectId) && (mode === 'git' || mode === 'direct'),
    ),
  ) as Record<string, 'git' | 'direct'>;
  const nodeModes = getPlanExecutionModesByProjectId(plan.nodes);
  for (const [projectId, mode] of Object.entries(nodeModes)) {
    if (!modes[projectId]) modes[projectId] = mode;
  }
  for (const projectId of plan.projectIds ?? []) {
    if (modes[projectId]) continue;
    const observedMode = registrySnapshot?.executionModeByProjectId.get(projectId);
    if (observedMode === 'git' || observedMode === 'direct') {
      modes[projectId] = observedMode;
    }
  }
  return modes;
};

interface PersistedDirectPlanDiscovery {
  plan: ArchitectPlanRecord;
  scopes: ArchitectMetadataScope[];
}

const discoverPersistedDirectPlan = async (params: {
  branchName: string;
  planId: string;
  registrySnapshot?: ValidProjectRegistrySnapshot | null;
  deps: ResolvedArchitectPlanServiceDependencies;
}): Promise<PersistedDirectPlanDiscovery | null> => {
  const registrySnapshot = params.registrySnapshot;
  if (!registrySnapshot || !params.deps.tauri.isTauriAvailable()) {
    return null;
  }
  const directModes = Object.fromEntries(
    registrySnapshot.validProjectIds.map((projectId) => [projectId, 'direct' as const]),
  );
  const directScopes = getProjectMetadataScopes(
    registrySnapshot,
    registrySnapshot.validProjectIds,
    directModes,
  );
  const candidates = (
    await Promise.all(directScopes.map(async (scope) => ({
      scope,
      result: await readPlanAtScopeWithDiagnostics(
        scope,
        params.branchName,
        params.planId,
        registrySnapshot,
      ),
    })))
  ).filter(({ scope, result }) => {
    if (!scope.projectId || !result.plan) return false;
    return getPlanExecutionModes(result.plan, registrySnapshot)[scope.projectId] === 'direct';
  });
  if (candidates.length === 0) {
    return null;
  }
  const plan = candidates
    .map(({ result }) => result.plan as ArchitectPlanRecord)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  if (!plan) {
    return null;
  }
  const executionModesByProjectId = getPlanExecutionModes(plan, registrySnapshot);
  const expectedProjectIds = normalizeArchitectPlanScope(plan, {
    useExpectedAsActionableFallback: true,
  }).expectedProjectIds;
  const scopes = await resolveMetadataScopes(
    expectedProjectIds,
    {
      includeWorkspaceFallback: false,
      executionModesByProjectId,
    },
    registrySnapshot,
    params.deps,
  );
  return { plan, scopes };
};

const getReplicaMutationWorkspaceKey = (targets: ArchitectPlanReplicaMutationTarget[]): string => {
  const roots = Array.from(new Set(targets.map((target) =>
    normalizeProjectRegistryPath(target.scope.workspacePath || target.scope.repoPath) || `local:${target.scope.scopeKey}`
  ))).sort();
  return roots.join('|');
};

const getRegistryWorkspaceKey = (
  registrySnapshot: ValidProjectRegistrySnapshot | null | undefined,
  targets: ArchitectPlanReplicaMutationTarget[],
): string => {
  const roots = Array.from(new Set([
    ...Array.from(registrySnapshot?.workspacePathByProjectId.values() || []),
    ...Array.from(registrySnapshot?.repoPathByProjectId.values() || []),
  ]))
    .map(normalizeProjectRegistryPath).filter((value): value is string => !!value).sort();
  return roots.length > 0 ? roots.join('|') : getReplicaMutationWorkspaceKey(targets);
};

const applyArchitectPlanReplicaMutation = async (
  entry: ArchitectPlanMutationJournalEntry<ArchitectPlanReplicaMutationPayload>,
  registrySnapshot: ValidProjectRegistrySnapshot | null | undefined,
): Promise<void> => {
  for (const target of entry.payload.targets) {
    if (target.action === 'upsert' && target.plan) {
      if (target.replacePlanDirectory) {
        await removePlanAtScope(target.scope, entry.branchName, entry.planId);
      }
      await writePlanAtScope(target.scope, entry.branchName, target.plan, registrySnapshot, {
        chatMessages: target.chatMessages,
      });
      if (target.chatMessages) {
        await writePlanChatAtScope(
          target.scope,
          entry.branchName,
          entry.planId,
          target.chatMessages,
          registrySnapshot,
          { skipManifest: true },
        );
      }
      if (target.extraFiles && target.scope.source !== 'local') {
        for (const [relativePath, content] of Object.entries(target.extraFiles)) {
          await tauriIpc.fsWriteFile({
            path: `${getPlanDir(entry.branchName, entry.planId)}/${relativePath}`,
            content,
            createDirs: true,
            allowOutsideWorkspace: false,
            workspaceScope: getScopeWorkspaceScope(target.scope),
            workspacePath: target.scope.workspacePath,
          });
        }
      }
    } else if (target.action === 'remove') {
      await removePlanAtScope(target.scope, entry.branchName, entry.planId);
    }
    await writeIndexAtScope(target.scope, entry.branchName, target.index);
  }
};

const replicaTransactionQueues = new Map<string, Promise<void>>();
const withReplicaTransactionLock = async <T>(workspaceKey: string, operation: () => Promise<T>): Promise<T> => {
  const previous = replicaTransactionQueues.get(workspaceKey) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(operation);
  const stored = run.then(() => undefined, () => undefined);
  replicaTransactionQueues.set(workspaceKey, stored);
  try { return await run; } finally {
    if (replicaTransactionQueues.get(workspaceKey) === stored) replicaTransactionQueues.delete(workspaceKey);
  }
};

const resolveReplicaWorkspaceKey = async (
  deps: ResolvedArchitectPlanServiceDependencies,
  registrySnapshot: ValidProjectRegistrySnapshot | null | undefined,
  targets: ArchitectPlanReplicaMutationTarget[] = [],
): Promise<string> => {
  let workspaceKey = getRegistryWorkspaceKey(registrySnapshot, targets);
  if (!workspaceKey && typeof deps.tauri.workspaceGetActiveRoot === 'function') {
    workspaceKey = normalizeProjectRegistryPath(await deps.tauri.workspaceGetActiveRoot()) || '';
  }
  return workspaceKey;
};

const recoverArchitectPlanReplicaMutationsUnlocked = async (
  deps: ResolvedArchitectPlanServiceDependencies,
  registrySnapshot: ValidProjectRegistrySnapshot | null | undefined,
  currentWorkspaceKey: string,
): Promise<void> => {
  const entries = await loadArchitectPlanMutationJournal(deps.tauri);
  if (entries.length === 0) return;
  const allowedWorkspaceRoots = new Set(currentWorkspaceKey.split('|').filter(Boolean));
  for (const entry of entries.filter((candidate) => candidate.workspaceKey === currentWorkspaceKey)) {
      if (!isReplicaMutationPayload(entry)) {
        await quarantineArchitectPlanMutationJournal(
          entry,
          'Payload ou scopes invalides ; aucune écriture de reprise n’a été exécutée.',
          deps.tauri,
        );
        continue;
      }
      const scopesBelongToWorkspace = entry.payload.targets.every((target) => {
        if (target.scope.source === 'local') return true;
        const root = normalizeProjectRegistryPath(target.scope.workspacePath || target.scope.repoPath);
        return !!root && allowedWorkspaceRoots.has(root);
      });
      if (!scopesBelongToWorkspace) {
        await quarantineArchitectPlanMutationJournal(
          entry,
          'Un scope ne correspond pas au workspace propriétaire ; aucune écriture de reprise n’a été exécutée.',
          deps.tauri,
        );
        continue;
      }
      let currentEntry = entry;
      try {
        if (currentEntry.phase === 'prepared' || currentEntry.phase === 'applying') {
          await applyArchitectPlanReplicaMutation(currentEntry, registrySnapshot);
          currentEntry = { ...currentEntry, phase: 'files_applied', updatedAt: new Date().toISOString() };
          await upsertArchitectPlanMutationJournal(currentEntry, deps.tauri);
        }
        currentEntry = { ...currentEntry, phase: 'committing', updatedAt: new Date().toISOString() };
        await upsertArchitectPlanMutationJournal(currentEntry, deps.tauri);
        await commitMetadataScopes(
          currentEntry.payload.targets
            .filter((target) => shouldCommitMutationTarget(target, registrySnapshot))
            .map((target) => target.scope),
          currentEntry.payload.commitMessage,
          { commit: true },
          deps,
        );
        await removeArchitectPlanMutationJournal(currentEntry.id, deps.tauri);
      } catch (error) {
        await upsertArchitectPlanMutationJournal({
          ...currentEntry,
          updatedAt: new Date().toISOString(),
          lastError: toErrorMessage(error),
        }, deps.tauri);
        throw error;
      }
  }
};

const recoverArchitectPlanReplicaMutations = async (
  deps: ResolvedArchitectPlanServiceDependencies,
): Promise<void> => {
  if (!deps.tauri.isTauriAvailable()) return;
  const registrySnapshot = await loadArchitectPlanRegistrySnapshot(deps);
  const workspaceKey = await resolveReplicaWorkspaceKey(deps, registrySnapshot);
  await withReplicaTransactionLock(workspaceKey, () =>
    recoverArchitectPlanReplicaMutationsUnlocked(deps, registrySnapshot, workspaceKey)
  );
};

const runArchitectPlanReplicaMutation = async (params: {
  branchName: string;
  planId: string;
  operation: ArchitectPlanMutationJournalEntry['operation'];
  targets: ArchitectPlanReplicaMutationTarget[];
  registrySnapshot: ValidProjectRegistrySnapshot | null | undefined;
  deps: ResolvedArchitectPlanServiceDependencies;
  commitMessage: string;
}): Promise<void> => {
  const workspaceKey = await resolveReplicaWorkspaceKey(params.deps, params.registrySnapshot, params.targets);
  await withReplicaTransactionLock(workspaceKey, async () => {
    await recoverArchitectPlanReplicaMutationsUnlocked(params.deps, params.registrySnapshot, workspaceKey);
    const now = new Date().toISOString();
    const entry: ArchitectPlanMutationJournalEntry<ArchitectPlanReplicaMutationPayload> = {
    id: createArchitectPlanMutationId(params),
    workspaceKey,
    branchName: params.branchName,
    planId: params.planId,
    operation: params.operation,
    phase: 'prepared',
    payload: { targets: params.targets, commitMessage: params.commitMessage },
    createdAt: now,
    updatedAt: now,
  };
    let currentEntry = entry;
    await upsertArchitectPlanMutationJournal(currentEntry, params.deps.tauri);
    try {
    currentEntry = { ...currentEntry, phase: 'applying', updatedAt: new Date().toISOString() };
    await upsertArchitectPlanMutationJournal(currentEntry, params.deps.tauri);
    await applyArchitectPlanReplicaMutation(currentEntry, params.registrySnapshot);
    currentEntry = { ...currentEntry, phase: 'files_applied', updatedAt: new Date().toISOString() };
    await upsertArchitectPlanMutationJournal(currentEntry, params.deps.tauri);
    currentEntry = { ...currentEntry, phase: 'committing', updatedAt: new Date().toISOString() };
    await upsertArchitectPlanMutationJournal(currentEntry, params.deps.tauri);
    await commitMetadataScopes(
      params.targets
        .filter((target) => shouldCommitMutationTarget(target, params.registrySnapshot))
        .map((target) => target.scope),
      params.commitMessage,
      { commit: true },
      params.deps,
    );
    await removeArchitectPlanMutationJournal(currentEntry.id, params.deps.tauri);
    } catch (error) {
      await upsertArchitectPlanMutationJournal({
        ...currentEntry,
        updatedAt: new Date().toISOString(),
        lastError: toErrorMessage(error),
      }, params.deps.tauri);
      throw error;
    }
  });
};

const buildUpsertReplicaMutationTarget = async (params: {
  scope: ArchitectMetadataScope;
  branchName: string;
  plan: ArchitectPlanRecord;
  registrySnapshot: ValidProjectRegistrySnapshot | null | undefined;
  setActive?: boolean;
  chatMessageCount?: number;
  chatMessages?: ArchitectPlanChatMessage[];
  replacePlanDirectory?: boolean;
  extraFiles?: Record<string, string>;
}): Promise<ArchitectPlanReplicaMutationTarget> => {
  const index = await readIndexAtScope(params.scope, params.branchName, params.registrySnapshot);
  const previousSummary = index.plans.find((candidate) => candidate.id === params.plan.id);
  const plans = upsertSummary(index.plans, toSummary(params.plan, {
    chatMessageCount: params.chatMessageCount ?? previousSummary?.chatMessageCount,
  }));
  const nextPlanSlugs = plans.map((candidate) => slugifyPlanTitle(candidate.slug || candidate.title || candidate.id));
  const releasedSlug = previousSummary?.status === 'draft' && params.plan.status === 'draft' &&
    slugifyPlanTitle(previousSummary.slug || previousSummary.title || previousSummary.id) !== slugifyPlanTitle(params.plan.slug)
    ? slugifyPlanTitle(previousSummary.slug || previousSummary.title || previousSummary.id) : null;
  return {
    scope: params.scope,
    action: 'upsert',
    plan: params.plan,
    executionModesByProjectId: getPlanExecutionModes(params.plan, params.registrySnapshot),
    chatMessages: params.chatMessages,
    replacePlanDirectory: params.replacePlanDirectory,
    extraFiles: params.extraFiles,
    index: {
      ...index,
      version: 3,
      plans,
      activePlanId: params.setActive ? params.plan.id : index.activePlanId,
      reservedPlanSlugs: Array.from(new Set([
        ...index.reservedPlanSlugs.map(slugifyPlanTitle).filter((slug) => slug !== releasedSlug || nextPlanSlugs.includes(slug)),
        ...nextPlanSlugs,
      ])),
    },
  };
};

const buildRemoveReplicaMutationTarget = async (params: {
  scope: ArchitectMetadataScope;
  branchName: string;
  planId: string;
  plan?: ArchitectPlanRecord;
  registrySnapshot: ValidProjectRegistrySnapshot | null | undefined;
}): Promise<ArchitectPlanReplicaMutationTarget> => {
  const index = await readIndexAtScope(params.scope, params.branchName, params.registrySnapshot);
  const removed = index.plans.find((plan) => plan.id === params.planId);
  const plans = index.plans.filter((plan) => plan.id !== params.planId);
  const remainingSlugs = new Set(plans.map((plan) => slugifyPlanTitle(plan.slug || plan.title || plan.id)));
  const releasedSlug = removed?.status === 'draft' ? slugifyPlanTitle(removed.slug || removed.title || removed.id) : null;
  return {
    scope: params.scope,
    action: 'remove',
    plan: null,
    executionModesByProjectId: params.plan
      ? getPlanExecutionModes(params.plan, params.registrySnapshot)
      : {},
    index: {
      ...index,
      version: 3,
      plans,
      activePlanId: index.activePlanId === params.planId
        ? plans.find((plan) => plan.status !== 'deleted' && plan.status !== 'archived')?.id || null
        : index.activePlanId,
      reservedPlanSlugs: index.reservedPlanSlugs.filter((slug) => {
        const normalized = slugifyPlanTitle(slug);
        return normalized !== releasedSlug || remainingSlugs.has(normalized);
      }),
    },
  };
};

const readPlanFilesAtScope = async (
  scope: ArchitectMetadataScope,
  branchName: string,
  planId: string
): Promise<Record<string, string>> => {
  if (!tauriIpc.isTauriAvailable() || scope.source === 'local') {
    return {};
  }

  const normalized = normalizeBranchName(branchName);
  const safeId = sanitizeId(planId);
  const planDir = getPlanDir(normalized, safeId);

  try {
    const entries = await tauriIpc.fsListDir({
      path: planDir,
      recursive: true,
      includeHidden: true,
      allowOutsideWorkspace: false,
      workspaceScope: getScopeWorkspaceScope(scope),
      workspacePath: scope.workspacePath,
    });
    const files = entries.filter((entry) => entry.kind === 'file');
    const contents = await Promise.all(
      files.map(async (entry) => {
        const relativePath = entry.relative_path.replace(/\\/g, '/').replace(/^\/+/, '');
        const content = await tauriIpc.fsReadFileWithOptions({
          path: `${planDir}/${relativePath}`,
          allowOutsideWorkspace: false,
          workspaceScope: getScopeWorkspaceScope(scope),
          workspacePath: scope.workspacePath,
        });
        return [relativePath, content.content] as const;
      })
    );
    return Object.fromEntries(contents);
  } catch {
    return {};
  }
};

const toSummary = (
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

const upsertSummary = (summaries: ArchitectPlanSummary[], summary: ArchitectPlanSummary): ArchitectPlanSummary[] => {
  const found = summaries.some((item) => item.id === summary.id);
  if (!found) return [...summaries, summary];
  return summaries.map((item) => (item.id === summary.id ? summary : item));
};

const mergePlanSummaries = (
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

const listLocalTargetBranches = (): string[] => {
  if (typeof window === 'undefined') return [];

  const branches: string[] = [];
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (!key?.startsWith(`${LOCAL_INDEX_KEY_PREFIX}:`)) {
      continue;
    }

    const branchName = key.slice(`${LOCAL_INDEX_KEY_PREFIX}:`.length).trim();
    if (branchName.length > 0) {
      branches.push(normalizeBranchName(branchName));
    }
  }

  return Array.from(new Set(branches));
};

const listTargetBranchesAtScope = async (
  scope: ArchitectMetadataScope
): Promise<string[]> => {
  if (!tauriIpc.isTauriAvailable() || scope.source === 'local') {
    return listLocalTargetBranches();
  }

  try {
    const entries = await tauriIpc.fsListDir({
      path: 'branches',
      recursive: true,
      includeHidden: true,
      allowOutsideWorkspace: false,
      workspaceScope: getScopeWorkspaceScope(scope),
      workspacePath: scope.workspacePath,
    });

    const suffix = '/plans/index.json';
    return Array.from(new Set(
      entries
        .filter((entry) => entry.kind === 'file')
        .map((entry) => entry.relative_path.replace(/\\/g, '/').replace(/^\/+/, ''))
        .filter((relativePath) => relativePath.endsWith(suffix))
        .map((relativePath) => normalizeBranchName(relativePath.slice(0, -suffix.length)))
        .filter((branchName) => branchName.length > 0)
    ));
  } catch {
    return [];
  }
};

const readAggregatedIndex = async (
  branchName: string,
  registrySnapshot?: ValidProjectRegistrySnapshot | null,
  deps?: ResolvedArchitectPlanServiceDependencies
): Promise<ArchitectPlanIndex> => {
  const normalized = normalizeBranchName(branchName);
  const cacheKey = getArchitectPlanIndexCacheKey(normalized);

  return await loadCachedArchitectPlanValue({
    cache: architectPlanIndexCache,
    cacheKey,
    ttlMs: ARCHITECT_PLAN_INDEX_CACHE_TTL_MS,
    loader: async () => {
      const resolvedDeps = deps ?? resolveArchitectPlanServiceDependencies();
      const resolvedRegistrySnapshot =
        resolvedDeps.tauri.isTauriAvailable()
          ? (registrySnapshot ??
            await resolvedDeps.loadRegistrySnapshot({
              getAppState: resolvedDeps.getAppState,
            }))
          : registrySnapshot;
      const scopes = await resolveMetadataScopes(
        undefined,
        { includeAllKnown: true },
        resolvedRegistrySnapshot,
        resolvedDeps
      );
      if (resolvedRegistrySnapshot) {
        const transitionedDirectScopes = getProjectMetadataScopes(
          resolvedRegistrySnapshot,
          resolvedRegistrySnapshot.validProjectIds.filter(
            (projectId) => resolvedRegistrySnapshot.executionModeByProjectId.get(projectId) !== 'direct',
          ),
          Object.fromEntries(
            resolvedRegistrySnapshot.validProjectIds.map((projectId) => [projectId, 'direct']),
          ),
        ).map((scope) => ({
          ...scope,
          scopeKey: `direct:${scope.workspacePath || scope.projectId || 'unknown'}`,
          repoPath: null,
          workspaceScope: 'direct' as const,
        }));
        scopes.push(...transitionedDirectScopes);
      }
      const dedupedScopes = dedupeScopes(scopes);
      const indexes = await Promise.all(
        dedupedScopes.map(async (scope) => ({
          scope,
          index: await readIndexAtScope(scope, normalized, resolvedRegistrySnapshot),
        }))
      );

      const plansById = new Map<
        string,
        Array<{ scope: ArchitectMetadataScope; summary: ArchitectPlanSummary }>
      >();
      for (const { scope, index } of indexes) {
        for (const summary of index.plans) {
          const existing = plansById.get(summary.id) || [];
          existing.push({ scope, summary });
          plansById.set(summary.id, existing);
        }
      }

      const activePlanIds = Array.from(
        new Set(
          indexes
            .map(({ index }) => index.activePlanId)
            .filter((planId): planId is string => Boolean(planId))
        )
      );

      return {
        version: 3,
        activePlanId: activePlanIds.length === 1 ? activePlanIds[0] : null,
        plans: Array.from(plansById.values()).map((entries) =>
          mergePlanSummaries(entries, resolvedRegistrySnapshot)
        ),
        reservedPlanSlugs: Array.from(
          new Set(
            indexes.flatMap(({ index }) =>
              index.reservedPlanSlugs.map((slug) => slugifyPlanTitle(slug))
            )
          )
        ),
      };
    },
  });
};

const listArchitectPlanTargetBranchesImpl = async (
  deps: ResolvedArchitectPlanServiceDependencies
): Promise<string[]> => {
  const registrySnapshot = await loadArchitectPlanRegistrySnapshot(deps);
  const scopes = await resolveMetadataScopes(undefined, { includeAllKnown: true }, registrySnapshot, deps);
  const discoveredBranches = (
    await Promise.all(scopes.map((scope) => listTargetBranchesAtScope(scope)))
  ).flat();

  return Array.from(new Set([
    getGitFlowBaseBranch(),
    ...discoveredBranches,
  ])).sort((left, right) => left.localeCompare(right));
};

const loadPlanReplicaSet = async (
  branchName: string,
  planId: string,
  options?: {
    allowDivergence?: boolean;
    disableAutoHeal?: boolean;
    registrySnapshot?: ValidProjectRegistrySnapshot | null;
  },
  deps?: ResolvedArchitectPlanServiceDependencies
): Promise<ArchitectPlanReplicaSet | null> => {
  const resolvedDeps = deps ?? resolveArchitectPlanServiceDependencies();
  const normalizedBranch = normalizeBranchName(branchName);
  const safeId = sanitizeId(planId);
  const resolvedRegistrySnapshot =
    resolvedDeps.tauri.isTauriAvailable()
      ? (options?.registrySnapshot ??
        await resolvedDeps.loadRegistrySnapshot({ getAppState: resolvedDeps.getAppState }))
      : undefined;
  const persistedDirectPlan = await discoverPersistedDirectPlan({
    branchName: normalizedBranch,
    planId: safeId,
    registrySnapshot: resolvedRegistrySnapshot,
    deps: resolvedDeps,
  });
  const scopes = persistedDirectPlan?.scopes ?? await resolveMetadataScopes(
    undefined,
    { includeAllKnown: true },
    resolvedRegistrySnapshot,
    resolvedDeps
  );
  const snapshotDiagnosticsRaw: Array<ArchitectPlanReplicaSnapshotDiagnostics | null> = await Promise.all(
    scopes.map(async (scope) => {
      const planResult = await readPlanAtScopeWithDiagnostics(
        scope,
        normalizedBranch,
        safeId,
        resolvedRegistrySnapshot
      );
      if (!planResult.plan) {
        return null;
      }

      const chatMessages = await readPlanChatAtScope(scope, normalizedBranch, safeId);
      const manifest = await readPlanManifestAtScope({
        scope,
        branchName: normalizedBranch,
        plan: planResult.plan,
        chatMessages,
        registrySnapshot: resolvedRegistrySnapshot,
      });
      const files = await readPlanFilesAtScope(scope, normalizedBranch, safeId);

      return {
        scope,
        plan: {
          ...planResult.plan,
          contextProjectIds: manifest.contextProjectIds,
          expectedProjectIds: manifest.expectedProjectIds,
          revision: manifest.revision,
        },
        manifest,
        files,
        repairApplied: planResult.changed,
        removedInvalidProjectIds: planResult.removedInvalidProjectIds,
      };
    })
  );
  const snapshotDiagnostics = snapshotDiagnosticsRaw.filter(
    (snapshot): snapshot is ArchitectPlanReplicaSnapshotDiagnostics => snapshot !== null
  );

  if (snapshotDiagnostics.length === 0) {
    return null;
  }

  const snapshots = snapshotDiagnostics.map(({ repairApplied: _repairApplied, removedInvalidProjectIds: _removedInvalidProjectIds, ...snapshot }) => snapshot);
  const removedInvalidProjectIds = dedupeProjectIdDiagnostics(
    snapshotDiagnostics.flatMap((snapshot) => snapshot.removedInvalidProjectIds)
  );
  const hasSanitizedReplicaRepair = snapshotDiagnostics.some((snapshot) => snapshot.repairApplied);

  const canonical = pickCanonicalReplica(
    snapshots.map((snapshot) => ({
      ...snapshot,
      updatedAt: snapshot.plan.updatedAt,
      repoPath: snapshot.scope.repoPath,
    })),
    'newest'
  );
  const projectIds = getArchitectPlanActionableProjectIds(canonical.plan);
  const contextProjectIds = normalizeContextProjectIds(
    canonical.plan.contextProjectIds,
    projectIds,
    resolvedRegistrySnapshot
  );
  const expectedProjectIds = normalizeArchitectPlanIdList(projectIds, contextProjectIds);
  const expectedScopes = dedupeScopes([
    ...(await resolveMetadataScopes(
      expectedProjectIds,
      {
        includeWorkspaceFallback: false,
        executionModesByProjectId: getPlanExecutionModes(canonical.plan, resolvedRegistrySnapshot),
      },
      resolvedRegistrySnapshot,
      resolvedDeps
    )),
    ...snapshots.map((snapshot) => snapshot.scope),
  ]);

  const availableProjectIds = Array.from(
    new Set(
      snapshots.flatMap((snapshot) => {
        if (
          snapshot.scope.source === 'local' &&
          expectedProjectIds.length > 0 &&
          !resolvedRegistrySnapshot?.hasRegisteredProjects
        ) {
          return expectedProjectIds;
        }

        const scopedProjectId = resolveScopeProjectId(snapshot.scope, resolvedRegistrySnapshot) || '';
        return scopedProjectId && expectedProjectIds.includes(scopedProjectId)
          ? [scopedProjectId]
          : [];
      })
    )
  );
  const missingProjectIds = expectedProjectIds.filter((projectId) => !availableProjectIds.includes(projectId));

  const missingReplicas = expectedScopes
    .filter((scope) => {
      const scopeProjectId = resolveScopeProjectId(scope, resolvedRegistrySnapshot);
      return Boolean(scopeProjectId) &&
        missingProjectIds.includes(scopeProjectId as string) &&
        !snapshots.some((snapshot) => snapshot.scope.scopeKey === scope.scopeKey);
    })
    .map((scope) => toReplicaDescriptor(scope, null, true));

  const hasContentDivergence =
    new Set(snapshots.map((snapshot) => stableSerialize(buildReplicaComparableSnapshot(snapshot)))).size > 1;
  const hasReplicaDivergence = hasContentDivergence;
  const replicas = [
    ...snapshots.map((snapshot) => toReplicaDescriptor(snapshot.scope, snapshot.plan.updatedAt)),
    ...missingReplicas,
  ];

  if (
    !options?.disableAutoHeal &&
    (removedInvalidProjectIds.length > 0 || hasSanitizedReplicaRepair) &&
    missingReplicas.length === 0 &&
    !hasContentDivergence
  ) {
    const canonicalSnapshot = pickCanonicalReplica(
      snapshots.map((snapshot) => ({
        ...snapshot,
        updatedAt: snapshot.plan.updatedAt,
        repoPath: snapshot.scope.repoPath,
      })),
      'newest'
    );
    logArchitectPlanSanitization({
      branchName: normalizedBranch,
      planId: canonicalSnapshot.plan.id,
      removedInvalidProjectIds,
      context: removedInvalidProjectIds.length > 0
        ? 'replica_auto_heal'
        : 'replica_target_branch_auto_heal',
    });
    const canonicalMessages = parseJsonLines(canonicalSnapshot.files['chat.jsonl'] || '');
    const extraFiles = Object.fromEntries(
      Object.entries(canonicalSnapshot.files).filter(([relativePath]) => relativePath.startsWith('artifacts/'))
    );
    const targets = await Promise.all(snapshotDiagnostics.map((snapshot) =>
      buildUpsertReplicaMutationTarget({
        scope: snapshot.scope,
        branchName: normalizedBranch,
        plan: canonicalSnapshot.plan,
        registrySnapshot: resolvedRegistrySnapshot,
        chatMessages: canonicalMessages,
        chatMessageCount: canonicalMessages.length,
        extraFiles,
      })
    ));
    await runArchitectPlanReplicaMutation({
      branchName: normalizedBranch,
      planId: canonicalSnapshot.plan.id,
      operation: 'auto_heal',
      targets,
      registrySnapshot: resolvedRegistrySnapshot,
      deps: resolvedDeps,
      commitMessage: `chore(metadata): auto-heal architect plan ${canonicalSnapshot.plan.id}`,
    });

    return loadPlanReplicaSet(normalizedBranch, safeId, {
      ...options,
      disableAutoHeal: true,
      registrySnapshot: resolvedRegistrySnapshot,
    }, resolvedDeps);
  }

  if (!options?.allowDivergence) {
    if (hasContentDivergence) {
      throwReplicaDivergence({
        branchName: normalizedBranch,
        planId: safeId,
        reason: 'content_diverged',
        replicas,
      });
    }
  }

  const replicationState: ArchitectPlanReplicationState =
    canonical.plan.status === 'deleted'
      ? 'deleted'
      : hasContentDivergence
        ? 'diverged'
        : missingProjectIds.length > 0
          ? 'missing_projects'
          : 'healthy';

  return {
    canonical: {
      scope: canonical.scope,
      plan: {
        ...canonical.plan,
        projectId: projectIds[0],
        projectIds,
        contextProjectIds,
        expectedProjectIds,
        availableProjectIds,
        missingProjectIds,
        replicationState,
        revision: canonical.manifest.revision,
        replicas,
        hasReplicaDivergence,
      },
      manifest: canonical.manifest,
      files: canonical.files,
    },
    snapshots,
    expectedScopes,
    replicas,
    hasReplicaDivergence,
  };
};

interface ArchitectPlanActivationSnapshot {
  scope: ArchitectMetadataScope;
  plan: ArchitectPlanRecord;
  updatedAt: string;
  expectedProjectIds: string[];
  conversationId: string | null;
  chatMessageCount: number | null;
}

const isWorkspaceArchitectRuntimeAvailable = (
  deps: ResolvedArchitectPlanServiceDependencies
): boolean =>
  (deps.tauri.isTauriAvailable() || deps.tauri.isRemoteBackendAvailable()) &&
  typeof deps.tauri.workspaceArchitectListPlans === 'function' &&
  typeof deps.tauri.workspaceArchitectActivatePlanHead === 'function' &&
  typeof deps.tauri.workspaceArchitectActivatePlanChat === 'function';

const canUseWorkspaceArchitectRuntimeForScope = (
  registrySnapshot: ValidProjectRegistrySnapshot | null | undefined,
  scopedProjectIdsHint?: string[],
): boolean => {
  if (!registrySnapshot?.hasRegisteredProjects) return true;
  const projectIds = scopedProjectIdsHint?.length
    ? scopedProjectIdsHint
    : registrySnapshot.scopedProjectIds.length > 0
      ? registrySnapshot.scopedProjectIds
      : registrySnapshot.validProjectIds;
  return projectIds.length > 0 && projectIds.every(
    (projectId) => registrySnapshot.executionModeByProjectId.get(projectId) === 'git',
  );
};

const mapRuntimeArchitectPlanSummary = (
  branchName: string,
  summary: tauriIpc.WorkspaceArchitectPlanSummaryDto
): ArchitectPlanSummary =>
  sanitizeArchitectPlanSummary(
    branchName,
    summary as unknown as ArchitectPlanSummary,
    null
  ).summary;

const mapRuntimeArchitectPlanRecord = (
  branchName: string,
  plan: tauriIpc.WorkspaceArchitectPlanRecordDto
): ArchitectPlanRecord => {
  const sanitized = sanitizeArchitectPlanRecord(
    branchName,
    plan.id,
    plan as unknown as ArchitectPlanRecord,
    null
  ).plan;

  return sanitized ?? (plan as unknown as ArchitectPlanRecord);
};

const mapRuntimeArchitectChatMessages = (
  messages: tauriIpc.WorkspaceArchitectChatMessageDto[]
): ArchitectPlanChatMessage[] =>
  messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => ({
      id: message.id,
      role: message.role as 'user' | 'assistant',
      content: message.content,
      createdAt: message.createdAt,
    }));

const loadArchitectPlanActivationPayloadFromRuntime = async (
  branchName: string,
  planId: string,
  options: ArchitectPlanActivationOptions,
  deps: ResolvedArchitectPlanServiceDependencies
): Promise<ArchitectPlanActivationPayload | null> => {
  if (!isWorkspaceArchitectRuntimeAvailable(deps)) {
    return null;
  }

  const head = await deps.tauri.workspaceArchitectActivatePlanHead({
    branchName,
    planId,
    summaryHint: options.summaryHint
      ? (options.summaryHint as unknown as tauriIpc.WorkspaceArchitectPlanSummaryDto)
      : null,
    scopedProjectIdsHint: options.scopedProjectIdsHint,
  });
  if (!head) {
    return null;
  }

  return {
    plan: mapRuntimeArchitectPlanRecord(branchName, head.plan),
    chatMessages: [],
    chatMessagesLoaded: false,
    chatTranscriptRevision: head.chatTranscriptRevision,
    chatMessageCount: head.chatMessageCount,
    conversationId: head.conversationId,
    sharedConversation: head.sharedConversation,
    targetBranch: normalizeBranchName(head.targetBranch || branchName),
    resolutionMode:
      head.resolutionMode === 'blank_fast_path' ? 'blank_fast_path' : 'full',
  };
};

export const getArchitectPlanChatTranscript = async (
  branchName: string,
  planId: string,
  deps: ResolvedArchitectPlanServiceDependencies = resolveArchitectPlanServiceDependencies()
): Promise<{
  messages: ArchitectPlanChatMessage[];
  transcriptRevision: string | null;
  messageCount: number;
} | null> => {
  const normalizedBranch = normalizeBranchName(branchName);
  assertGitFlowTargetBranch(normalizedBranch);
  const safeId = sanitizeId(planId);
  const registrySnapshot = await loadArchitectPlanRegistrySnapshot(deps);
  const persistedDirectPlan = await discoverPersistedDirectPlan({
    branchName: normalizedBranch,
    planId: safeId,
    registrySnapshot,
    deps,
  });

  if (!persistedDirectPlan &&
      isWorkspaceArchitectRuntimeAvailable(deps) &&
      canUseWorkspaceArchitectRuntimeForScope(registrySnapshot)) {
    const transcript = await deps.tauri.workspaceArchitectActivatePlanChat({
      branchName: normalizedBranch,
      planId: safeId,
    });
    if (!transcript) {
      return null;
    }
    return {
      messages: mapRuntimeArchitectChatMessages(transcript.messages),
      transcriptRevision: transcript.transcriptRevision,
      messageCount: transcript.messageCount,
    };
  }

  const messages = await getArchitectPlanChatMessages(normalizedBranch, safeId, deps);
  return {
    messages,
    transcriptRevision: null,
    messageCount: messages.length,
  };
};

const buildArchitectPlanActivationSnapshot = async (params: {
  scope: ArchitectMetadataScope;
  branchName: string;
  planId: string;
  summary?: ArchitectPlanSummary | null;
  registrySnapshot?: ValidProjectRegistrySnapshot | null;
}): Promise<ArchitectPlanActivationSnapshot | null> => {
  const planResult = await readPlanAtScopeWithDiagnostics(
    params.scope,
    params.branchName,
    params.planId,
    params.registrySnapshot
  );
  if (!planResult.plan || planResult.plan.status === 'deleted') {
    return null;
  }

  const storedManifest = await readStoredPlanManifestAtScope(
    params.scope,
    params.branchName,
    params.planId
  );
  const fallbackProjectIds = params.summary
    ? getArchitectPlanActionableProjectIds(params.summary)
    : resolvePlanProjectIds(planResult.plan);
  const actionableProjectIds = normalizeProjectIds(planResult.plan.projectIds, planResult.plan.projectId);
  const resolvedActionableProjectIds =
    actionableProjectIds.length > 0 ? actionableProjectIds : fallbackProjectIds;
  const contextProjectIds = normalizeContextProjectIds(
    Array.isArray(storedManifest?.contextProjectIds)
      ? storedManifest.contextProjectIds
      : planResult.plan.contextProjectIds,
    resolvedActionableProjectIds,
    params.registrySnapshot
  );
  const expectedProjectIds = normalizeArchitectPlanIdList(
    resolvedActionableProjectIds,
    contextProjectIds
  );
  const targetBranch = normalizeBranchName(
    typeof storedManifest?.targetBranch === 'string'
      ? storedManifest.targetBranch
      : planResult.plan.targetBranch
  );
  const targetBranchesByProjectId = normalizeTargetBranchesByProjectId(
    storedManifest?.targetBranchesByProjectId,
    resolvedActionableProjectIds,
    targetBranch
  );
  const planKind = normalizeArchitectPlanKind(
    planResult.plan.planKind ||
      storedManifest?.planKind ||
      storedManifest?.gitFlowPlan?.planKind
  );
  const gitFlowPlan = normalizeArchitectPlanGitFlowMetadata({
    planKind,
    gitFlowPlan: planResult.plan.gitFlowPlan || storedManifest?.gitFlowPlan,
    projectIds: resolvedActionableProjectIds,
    fallbackSlug: planResult.plan.slug,
  });
  const updatedAt =
    typeof storedManifest?.updatedAt === 'string' && storedManifest.updatedAt.trim().length > 0
      ? storedManifest.updatedAt
      : planResult.plan.updatedAt;
  const conversationId =
    storedManifest?.conversation &&
    typeof storedManifest.conversation === 'object' &&
    typeof storedManifest.conversation.conversationId === 'string'
      ? storedManifest.conversation.conversationId
      : params.summary?.conversationId ?? planResult.plan.conversationId ?? null;
  const chatMessageCount =
    typeof params.summary?.chatMessageCount === 'number'
      ? params.summary.chatMessageCount
      : storedManifest?.conversation &&
          typeof storedManifest.conversation === 'object' &&
          typeof storedManifest.conversation.messageCount === 'number' &&
          Number.isFinite(storedManifest.conversation.messageCount) &&
          storedManifest.conversation.messageCount >= 0
        ? Math.floor(storedManifest.conversation.messageCount)
        : null;

  return {
    scope: params.scope,
    updatedAt,
    expectedProjectIds,
    conversationId,
    chatMessageCount,
    plan: {
      ...planResult.plan,
      planKind,
      gitFlowPlan,
      targetBranch,
      targetBranchesByProjectId,
      expectedProjectIds,
      contextProjectIds,
      conversationId: conversationId ?? undefined,
      revision:
        typeof storedManifest?.revision === 'number' &&
        Number.isFinite(storedManifest.revision) &&
        storedManifest.revision > 0
          ? Math.floor(storedManifest.revision)
          : planResult.plan.revision,
      updatedAt,
    },
  };
};

const loadArchitectPlanActivationPayloadImpl = async (
  branchName: string,
  planId: string,
  options: ArchitectPlanActivationOptions,
  deps: ResolvedArchitectPlanServiceDependencies
): Promise<ArchitectPlanActivationPayload | null> => {
  const startedAt = Date.now();
  const normalizedBranch = normalizeBranchName(branchName);
  const safeId = sanitizeId(planId);
  const hintedSummary =
    options.summaryHint && sanitizeId(options.summaryHint.id) === safeId
      ? options.summaryHint
      : null;
  const fastPathSummary =
    hintedSummary && canUseBlankActivationSummary(hintedSummary)
      ? hintedSummary
      : null;
  if (fastPathSummary) {
    const payload: ArchitectPlanActivationPayload = {
      plan: planRecordFromActivationSummary(fastPathSummary, normalizedBranch),
      chatMessages: [],
      chatMessagesLoaded: true,
      chatTranscriptRevision: null,
      chatMessageCount: 0,
      conversationId: null,
      sharedConversation: false,
      targetBranch: normalizedBranch,
      resolutionMode: 'blank_fast_path',
    };
    logArchitectPlanActivationLoad({
      branchName: normalizedBranch,
      planId: safeId,
      resolutionMode: payload.resolutionMode,
      sharedConversation: false,
      durationMs: Date.now() - startedAt,
    });
    return payload;
  }

  const registrySnapshot = await loadArchitectPlanRegistrySnapshot(deps);
  const persistedDirectPlan = await discoverPersistedDirectPlan({
    branchName: normalizedBranch,
    planId: safeId,
    registrySnapshot,
    deps,
  });
  const persistedDirectSummary: ArchitectPlanSummary | null = persistedDirectPlan
    ? {
        ...persistedDirectPlan.plan,
        nodeCount: persistedDirectPlan.plan.nodes.length,
        predictedBranchCount: persistedDirectPlan.plan.predictedBranches.length,
      }
    : null;

  if (!persistedDirectPlan && canUseWorkspaceArchitectRuntimeForScope(
    registrySnapshot,
    options.scopedProjectIdsHint,
  )) {
    try {
      const runtimePayload = await loadArchitectPlanActivationPayloadFromRuntime(
        normalizedBranch,
        safeId,
        options,
        deps
      );
      if (runtimePayload) {
        logArchitectPlanActivationLoad({
          branchName: normalizedBranch,
          planId: safeId,
          resolutionMode: runtimePayload.resolutionMode,
          sharedConversation: runtimePayload.sharedConversation,
          durationMs: Date.now() - startedAt,
        });
        return runtimePayload;
      }
    } catch (error) {
      devLogger.warn(
        JSON.stringify({
          event: 'architect_plan_runtime_activation_fallback',
          at: new Date().toISOString(),
          branchName: normalizedBranch,
          planId: safeId,
          error: toErrorMessage(error),
        })
      );
    }
  }

  let index: ArchitectPlanIndex | null = null;
  let summary: ArchitectPlanSummary | null = hintedSummary ?? persistedDirectSummary;

  if (!persistedDirectPlan && (!summary || options.allowIndexFallback !== false)) {
    index = await readAggregatedIndex(normalizedBranch, registrySnapshot, deps);
    summary =
      summary ??
      index.plans.find((candidate) => candidate.id === safeId) ??
      null;
  }

  const blankSummary =
    summary && canUseBlankActivationSummary(summary) ? summary : null;
  if (blankSummary) {
    const payload: ArchitectPlanActivationPayload = {
      plan: planRecordFromActivationSummary(blankSummary, normalizedBranch),
      chatMessages: [],
      chatMessagesLoaded: true,
      chatTranscriptRevision: null,
      chatMessageCount: 0,
      conversationId: null,
      sharedConversation: false,
      targetBranch: normalizedBranch,
      resolutionMode: 'blank_fast_path',
    };
    logArchitectPlanActivationLoad({
      branchName: normalizedBranch,
      planId: safeId,
      resolutionMode: payload.resolutionMode,
      sharedConversation: false,
      durationMs: Date.now() - startedAt,
    });
    return payload;
  }
  const scopedProjectIds = Array.from(
    new Set(
      (
        options.scopedProjectIdsHint?.length
          ? options.scopedProjectIdsHint
          : summary
            ? getArchitectPlanVisibleProjectIds(summary)
            : []
      )
        .map((projectId) => projectId.trim())
        .filter((projectId) => projectId.length > 0)
    )
  );
  const scopes = persistedDirectPlan?.scopes ?? await resolveMetadataScopes(
    scopedProjectIds.length > 0 ? scopedProjectIds : undefined,
    {
      includeAllKnown: !summary && scopedProjectIds.length === 0,
      includeWorkspaceFallback: true,
    },
    registrySnapshot,
    deps
  );
  const snapshots = (
    await Promise.all(
      scopes.map((scope) =>
        buildArchitectPlanActivationSnapshot({
          scope,
          branchName: normalizedBranch,
          planId: safeId,
          summary,
          registrySnapshot,
        })
      )
    )
  ).filter((snapshot): snapshot is ArchitectPlanActivationSnapshot => snapshot !== null);

  if (snapshots.length === 0) {
    return null;
  }

  const canonicalSnapshot = pickCanonicalReplica(
    snapshots.map((snapshot) => ({
      ...snapshot,
      repoPath: snapshot.scope.repoPath,
    })),
    'newest'
  );
  const scope = normalizeArchitectPlanScope(canonicalSnapshot.plan, {
    useExpectedAsActionableFallback: true,
  });
  const expectedProjectIds = scope.expectedProjectIds;
  const availableProjectIds = Array.from(
    new Set(
      snapshots.flatMap((snapshot) => {
        if (
          snapshot.scope.source === 'local' &&
          expectedProjectIds.length > 0 &&
          !registrySnapshot?.hasRegisteredProjects
        ) {
          return expectedProjectIds;
        }

        const scopedProjectId = resolveScopeProjectId(snapshot.scope, registrySnapshot) || '';
        return scopedProjectId && expectedProjectIds.includes(scopedProjectId)
          ? [scopedProjectId]
          : [];
      })
    )
  );
  const missingProjectIds = expectedProjectIds.filter(
    (projectId) => !availableProjectIds.includes(projectId)
  );
  const plan = {
    ...canonicalSnapshot.plan,
    projectId: scope.actionableProjectIds[0] ?? canonicalSnapshot.plan.projectId,
    projectIds: scope.actionableProjectIds,
    contextProjectIds: scope.contextProjectIds,
    expectedProjectIds,
    availableProjectIds,
    missingProjectIds,
    replicationState:
      canonicalSnapshot.plan.status === 'deleted'
        ? 'deleted'
        : missingProjectIds.length > 0
          ? 'missing_projects'
          : 'healthy',
  } satisfies ArchitectPlanRecord;
  const chatMessageCountHint =
    typeof summary?.chatMessageCount === 'number'
      ? summary.chatMessageCount
      : canonicalSnapshot.chatMessageCount;
  const chatMessages = await (
    chatMessageCountHint === 0
      ? Promise.resolve([] as ArchitectPlanChatMessage[])
      : readPlanChatAtScope(canonicalSnapshot.scope, normalizedBranch, safeId)
  );
  const conversationId = canonicalSnapshot.conversationId ?? null;
  const payload: ArchitectPlanActivationPayload = {
    plan,
    chatMessages,
    chatMessagesLoaded: true,
    chatTranscriptRevision: null,
    chatMessageCount: chatMessages.length,
    conversationId,
    sharedConversation: Boolean(
      conversationId &&
        index?.plans.some(
          (candidate) =>
            candidate.id !== safeId &&
            candidate.status !== 'deleted' &&
            candidate.conversationId === conversationId
        )
    ),
    targetBranch: normalizedBranch,
    resolutionMode: 'full',
  };

  logArchitectPlanActivationLoad({
    branchName: normalizedBranch,
    planId: safeId,
    resolutionMode: payload.resolutionMode,
    sharedConversation: payload.sharedConversation,
    durationMs: Date.now() - startedAt,
  });

  return payload;
};

export const getArchitectPlanActivationPayload = async (
  branchName: string,
  planId: string,
  options: ArchitectPlanActivationOptions = {},
  deps: ResolvedArchitectPlanServiceDependencies = resolveArchitectPlanServiceDependencies()
): Promise<ArchitectPlanActivationPayload | null> => {
  const normalizedBranch = normalizeBranchName(branchName);
  assertGitFlowTargetBranch(normalizedBranch);

  if (isWorkspaceArchitectRuntimeAvailable(deps)) {
    return await loadArchitectPlanActivationPayloadImpl(
      normalizedBranch,
      planId,
      options,
      deps
    );
  }

  const cacheKey = getArchitectPlanActivationCacheKey(
    normalizedBranch,
    planId,
    getArchitectPlanActivationSummarySignature(options.summaryHint),
    getArchitectPlanActivationScopeSignature(options.scopedProjectIdsHint),
  );

  return await loadCachedArchitectPlanValue({
    cache: architectPlanActivationCache,
    cacheKey,
    ttlMs: ARCHITECT_PLAN_ACTIVATION_CACHE_TTL_MS,
    loader: async () =>
      await loadArchitectPlanActivationPayloadImpl(
        normalizedBranch,
        planId,
        options,
        deps
      ),
  });
};

const assertPlanReplicaSetWritable = (
  replicaSet: ArchitectPlanReplicaSet,
  action: string
): void => {
  if (replicaSet.canonical.plan.status === 'archived') {
    throw new Error(
      `Cannot ${action} archived plan ${replicaSet.canonical.plan.id}. Restore the plan before editing it.`
    );
  }

  const missingProjectIds = replicaSet.canonical.plan.missingProjectIds || [];
  if (missingProjectIds.length === 0) {
    return;
  }

  throw new Error(
    `Cannot ${action} plan ${replicaSet.canonical.plan.id} while expected project replicas are missing: ${missingProjectIds.join(', ')}.`
  );
};

const extractMacroMutationLabel = (message: string): string | null => {
  const normalized = message.trim();
  const match = normalized.match(/(?:plan|metadata)\s+([a-zA-Z0-9._/-]+)$/);
  return match?.[1] ?? null;
};

const inferMacroMutationKind = (message: string): MacroMetadataMutationKind => {
  const lower = message.toLowerCase();
  if (lower.includes('create architect plan')) return 'plan_created';
  if (lower.includes('archive architect plan')) return 'plan_archived';
  if (lower.includes('delete architect plan')) return 'plan_deleted';
  if (lower.includes('repair architect plan')) return 'plan_repaired';
  if (lower.includes('task')) return 'task_metadata';
  if (lower.includes('chat')) return 'chat_synced';
  if (lower.includes('plan')) return 'plan_updated';
  return 'project_state';
};

const isStructuralMacroMutation = (kind: MacroMetadataMutationKind): boolean =>
  kind === 'plan_created' ||
  kind === 'plan_archived' ||
  kind === 'plan_deleted' ||
  kind === 'plan_repaired' ||
  kind === 'task_metadata' ||
  kind === 'manual_feature';

const commitMetadataScopes = async (
  scopes: ArchitectMetadataScope[],
  commitMessage: string,
  options?: {
    commit?: boolean;
    mutationKind?: MacroMetadataMutationKind;
    mutationLabel?: string | null;
    structural?: boolean;
  },
  deps?: ResolvedArchitectPlanServiceDependencies
): Promise<void> => {
  const resolvedDeps = deps ?? resolveArchitectPlanServiceDependencies();

  if (
    !resolvedDeps.tauri.isTauriAvailable() ||
    typeof resolvedDeps.tauri.macroBranchCommitIfDirty !== 'function'
  ) {
    return;
  }

  const repoScopes = dedupeScopes(
    scopes.filter(
      (scope): scope is ArchitectMetadataScope & { workspacePath: string } =>
        scope.source !== 'local' && typeof scope.workspacePath === 'string' && scope.workspacePath.trim().length > 0
    )
  );

  if (repoScopes.length === 0) {
    return;
  }

  if (options?.commit) {
    await flushMacroMetadata({
      trigger: 'explicit_checkpoint',
      workspacePaths: repoScopes.map((scope) => scope.workspacePath as string),
      message: commitMessage,
    }, {
      tauri: resolvedDeps.tauri,
    });
    return;
  }

  const inferredKind = options?.mutationKind ?? inferMacroMutationKind(commitMessage);
  const structural = options?.structural ?? isStructuralMacroMutation(inferredKind);
  if (structural) {
    await flushMacroMetadata({
      trigger: 'explicit_checkpoint',
      workspacePaths: repoScopes.map((scope) => scope.workspacePath as string),
      message: commitMessage,
    }, {
      tauri: resolvedDeps.tauri,
    });
    return;
  }

  for (const scope of repoScopes) {
    recordMacroMetadataMutation({
      workspacePath: scope.workspacePath as string,
      kind: inferredKind,
      entityId: options?.mutationLabel ?? extractMacroMutationLabel(commitMessage),
      label: options?.mutationLabel ?? extractMacroMutationLabel(commitMessage),
      importance: structural ? 'structural' : 'light',
    }, {
      tauri: resolvedDeps.tauri,
    });
  }
};

const ensurePlanScopes = async (
  projectIds: string[],
  registrySnapshot?: ValidProjectRegistrySnapshot | null,
  deps?: ResolvedArchitectPlanServiceDependencies,
  executionModesByProjectId?: Record<string, 'git' | 'direct'>,
): Promise<ArchitectMetadataScope[]> => {
  const resolvedDeps = deps ?? resolveArchitectPlanServiceDependencies();
  if (!resolvedDeps.tauri.isTauriAvailable()) {
    return [{
      scopeKey: 'local',
      projectId: projectIds[0] || null,
      repoPath: null,
      workspacePath: null,
      source: 'local',
    }];
  }

  const resolvedRegistrySnapshot =
    registrySnapshot ??
    await resolvedDeps.loadRegistrySnapshot({ getAppState: resolvedDeps.getAppState });

  if (projectIds.length > 0) {
    const scopes = dedupeScopes(getProjectMetadataScopes(
      resolvedRegistrySnapshot,
      projectIds,
      executionModesByProjectId,
    ));
    if (scopes.length > 0) {
      return scopes;
    }
  }

  const scopedProjectIds = resolvedRegistrySnapshot.scopedProjectIds;
  if (scopedProjectIds.length > 0) {
    const selectedScopes = dedupeScopes(getProjectMetadataScopes(
      resolvedRegistrySnapshot,
      scopedProjectIds,
      executionModesByProjectId,
    ));
    if (selectedScopes.length > 0) {
      return selectedScopes;
    }
  }

  const workspaceScope = await getWorkspaceFallbackScope();
  if (workspaceScope) {
    return [workspaceScope];
  }

  throw new Error('Unable to resolve a repository scope for this plan.');
};

export const commitArchitectPlanMetadata = async (input: {
  branchName: string;
  planId: string;
  commitMessage: string;
}, deps: ResolvedArchitectPlanServiceDependencies = resolveArchitectPlanServiceDependencies()): Promise<void> => {
  const normalizedBranch = normalizeBranchName(input.branchName);
  assertGitFlowTargetBranch(normalizedBranch);
  const safeId = sanitizeId(input.planId);
  return enqueueArchitectPlanMutation(normalizedBranch, safeId, async () => {
    const registrySnapshot = await loadArchitectPlanRegistrySnapshot(deps);
    const replicaSet = await loadPlanReplicaSet(normalizedBranch, safeId, {
      allowDivergence: true,
      registrySnapshot,
    }, deps);
    if (!replicaSet) {
      throwPlanMetadataMissing(normalizedBranch, safeId);
    }

    const executionModesByProjectId = getPlanExecutionModes(
      replicaSet.canonical.plan,
      registrySnapshot,
    );
    const persistedModes = Object.values(executionModesByProjectId);
    const metadataScopes = dedupeScopes([
        ...replicaSet.expectedScopes,
        ...replicaSet.snapshots.map((snapshot) => snapshot.scope),
      ]).filter((scope) => {
        if (scope.projectId) {
          return executionModesByProjectId[scope.projectId] === 'git';
        }
        return persistedModes.some((mode) => mode === 'git');
      });

    await commitMetadataScopes(
      metadataScopes,
      input.commitMessage,
      { commit: true },
      deps
    );
  });
};

export interface ListArchitectPlansOptions {
  scopedProjectIdsHint?: string[];
}

export const listArchitectPlans = async (
  branchName: string,
  includeDeleted = false,
  includeArchived = false,
  options: ListArchitectPlansOptions = {},
): Promise<{
  activePlanId: string | null;
  plans: ArchitectPlanSummary[];
}> => {
  const deps = resolveArchitectPlanServiceDependencies();
  return listArchitectPlansWithDeps(branchName, includeDeleted, includeArchived, deps, options);
};

const listArchitectPlansWithDeps = async (
  branchName: string,
  includeDeleted = false,
  includeArchived = false,
  deps: ResolvedArchitectPlanServiceDependencies,
  options: ListArchitectPlansOptions = {},
): Promise<{
  activePlanId: string | null;
  plans: ArchitectPlanSummary[];
}> => {
  await recoverArchitectPlanReplicaMutations(deps);
  const normalizedBranch = normalizeBranchName(branchName);
  assertGitFlowTargetBranch(normalizedBranch);
  const registrySnapshot = await loadArchitectPlanRegistrySnapshot(deps);
  const index = await readAggregatedIndex(normalizedBranch, registrySnapshot, deps);
  const hasPersistedDirectPlan = index.plans.some((plan) =>
    Object.values(plan.executionModesByProjectId ?? {}).includes('direct')
  );

  if (isWorkspaceArchitectRuntimeAvailable(deps) &&
      canUseWorkspaceArchitectRuntimeForScope(registrySnapshot, options.scopedProjectIdsHint) &&
      !hasPersistedDirectPlan) {
    try {
      const runtimeList = await deps.tauri.workspaceArchitectListPlans({
        branchName: normalizedBranch,
        includeDeleted,
        includeArchived,
        scopedProjectIdsHint: options.scopedProjectIdsHint,
      });
      return {
        activePlanId: runtimeList.activePlanId,
        plans: runtimeList.plans.map((summary) =>
          mapRuntimeArchitectPlanSummary(normalizedBranch, summary)
        ),
      };
    } catch (error) {
      devLogger.warn(
        JSON.stringify({
          event: 'architect_plan_runtime_list_fallback',
          at: new Date().toISOString(),
          branchName: normalizedBranch,
          error: toErrorMessage(error),
        })
      );
    }
  }

  const plans = index.plans.filter((plan) => {
    if (!includeDeleted && plan.status === 'deleted') return false;
    if (!includeArchived && plan.status === 'archived') return false;
    return true;
  });
  return {
    activePlanId: index.activePlanId,
    plans,
  };
};

export const isArchitectPlanSlugAvailable = async (params: {
  branchName: string;
  slug: string;
  excludePlanId?: string | null;
}, deps: ResolvedArchitectPlanServiceDependencies = resolveArchitectPlanServiceDependencies()): Promise<boolean> => {
  const normalizedBranch = normalizeBranchName(params.branchName);
  assertGitFlowTargetBranch(normalizedBranch);
  const normalizedSlug = slugifyPlanTitle(params.slug);
  const normalizedExcludePlanId = params.excludePlanId ? sanitizeId(params.excludePlanId) : null;
  const registrySnapshot = await loadArchitectPlanRegistrySnapshot(deps);
  const index = await readAggregatedIndex(normalizedBranch, registrySnapshot, deps);
  const currentSlugForExcludedPlan =
    index.plans.find((plan) => plan.id === normalizedExcludePlanId)?.slug || null;

  if (
    index.plans.some(
      (plan) =>
        plan.id !== normalizedExcludePlanId &&
        slugifyPlanTitle(plan.slug || plan.title || plan.id) === normalizedSlug
    )
  ) {
    return false;
  }

  return !index.reservedPlanSlugs.some(
    (slug) =>
      slugifyPlanTitle(slug) === normalizedSlug &&
      slugifyPlanTitle(currentSlugForExcludedPlan || '') !== normalizedSlug
  );
};

export const getArchitectPlan = async (
  branchName: string,
  planId: string,
  deps: ResolvedArchitectPlanServiceDependencies = resolveArchitectPlanServiceDependencies()
): Promise<ArchitectPlanRecord | null> => {
  await recoverArchitectPlanReplicaMutations(deps);
  const normalizedBranch = normalizeBranchName(branchName);
  assertGitFlowTargetBranch(normalizedBranch);
  const registrySnapshot = await loadArchitectPlanRegistrySnapshot(deps);
  const replicaSet = await loadPlanReplicaSet(normalizedBranch, planId, {
    registrySnapshot,
  }, deps);
  return replicaSet?.canonical.plan || null;
};

type CreateArchitectPlanInput = {
  branchName: string;
  title?: string;
  label?: string;
  slug?: string;
  description?: string;
  planKind?: ArchitectPlanKind;
  gitFlowPlan?: Partial<ArchitectPlanGitFlowMetadata>;
  conversationId?: string;
  projectId?: string;
  projectIds?: string[];
  contextProjectIds?: string[];
  targetBranchesByProjectId?: Record<string, string>;
  status?: ArchitectPlanStatus;
  nodes?: PlanNode[];
  predictedBranches?: PredictedBranch[];
  planId?: string;
  setActive?: boolean;
};

const createArchitectPlanId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  return `plan-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
};

const createArchitectPlanUnlocked = async (
  input: CreateArchitectPlanInput,
  deps: ResolvedArchitectPlanServiceDependencies
): Promise<ArchitectPlanRecord> => {
  const normalizedBranch = normalizeBranchName(input.branchName);
  assertGitFlowTargetBranch(normalizedBranch);
  const now = new Date().toISOString();
  const registrySnapshot = await loadArchitectPlanRegistrySnapshot(deps);

  const initialLabel = normalizePlanLabel(input.label || input.title);
  const index = await readAggregatedIndex(normalizedBranch, registrySnapshot, deps);
  const explicitPlanId = input.planId?.trim() ? sanitizeId(input.planId) : null;
  let planId = explicitPlanId || createArchitectPlanId();
  while (!explicitPlanId && index.plans.some((plan) => plan.id === planId)) {
    planId = createArchitectPlanId();
  }
  const canonicalSlug = createAvailablePlanSlug(
    input.slug || initialLabel || planId,
    index.reservedPlanSlugs,
  );

  if (explicitPlanId && index.plans.some((plan) => plan.id === planId)) {
    throw new Error(`A plan with id "${planId}" already exists. Choose a different identifier.`);
  }

  const normalizedNodes = normalizePlanNodes(input.nodes || []);
  const normalizedPredictedBranches = normalizePlanPredictedBranches(input.predictedBranches || []);
  const projectIds = resolvePlanProjectIds({
    projectIds: input.projectIds,
    projectId: input.projectId,
    nodes: normalizedNodes,
    predictedBranches: normalizedPredictedBranches,
  });
  const contextProjectIds = normalizeContextProjectIds(
    input.contextProjectIds,
    projectIds,
    registrySnapshot
  );
  const expectedProjectIds = normalizeArchitectPlanIdList(projectIds, contextProjectIds);
  const planKind = normalizeArchitectPlanKind(input.planKind || input.gitFlowPlan?.planKind);
  const gitFlowNormalizationContext = await createGitFlowMetadataNormalizationContext(
    deps,
    normalizedBranch
  );
  const normalizedGitFlowPlan = normalizeArchitectPlanGitFlowMetadata({
    planKind,
    gitFlowPlan: input.gitFlowPlan,
    projectIds,
    fallbackSlug: canonicalSlug,
    ...gitFlowNormalizationContext,
  });
  const normalizedTargetBranchesByProjectId = getArchitectPlanEffectiveTargetBranchesByProjectId({
    projectId: projectIds[0],
    projectIds,
    targetBranch: normalizedBranch,
    targetBranchesByProjectId: mergeGitFlowTargetBranchesByProjectId(
      normalizeTargetBranchesByProjectId(
        input.targetBranchesByProjectId,
        projectIds,
        normalizedBranch
      ),
      normalizedGitFlowPlan,
      projectIds,
      { preferGitFlow: input.targetBranchesByProjectId === undefined }
    ),
    planKind,
    gitFlowPlan: normalizedGitFlowPlan,
  }, {
    getProjectGitFlowSettings: gitFlowNormalizationContext.getProjectSettings,
    fallbackTargetBranch: normalizedBranch,
  });

  const initialPlanRecord = applyArchitectPlanLifecycleForStatus({
    id: planId,
    slug: canonicalSlug,
    title: planId,
    label: initialLabel,
    description: (input.description || '').trim(),
    planKind,
    gitFlowPlan: normalizedGitFlowPlan,
    status: input.status || 'draft',
    targetBranch: normalizedBranch,
    targetBranchesByProjectId: normalizedTargetBranchesByProjectId,
    executionModesByProjectId: normalizePersistedExecutionModes(
      Object.fromEntries(
        projectIds.map((projectId) => [
          projectId,
          registrySnapshot?.executionModeByProjectId.get(projectId),
        ]),
      ) as Record<string, 'git' | 'direct'>,
      projectIds,
    ),
    conversationId: input.conversationId,
    projectId: projectIds[0],
    projectIds,
    contextProjectIds,
    expectedProjectIds,
    createdAt: now,
    updatedAt: now,
    revision: 1,
    nodes: normalizedNodes,
    predictedBranches: normalizedPredictedBranches,
  });
  const planResult = sanitizeArchitectPlanRecord(normalizedBranch, planId, initialPlanRecord, registrySnapshot, {
    logContext: 'plan_create',
  });
  if (!planResult.plan) {
    throwPlanMetadataMissing(normalizedBranch, planId);
  }
  const plan = planResult.plan;

  const scopes = await ensurePlanScopes(
    plan.expectedProjectIds || plan.projectIds || [],
    registrySnapshot,
    deps,
    getPlanExecutionModes(plan, registrySnapshot),
  );
  const targets = await Promise.all(scopes.map((scope) => buildUpsertReplicaMutationTarget({
    scope,
    branchName: normalizedBranch,
    plan,
    registrySnapshot,
    setActive: input.setActive !== false,
    chatMessageCount: 0,
  })));
  await runArchitectPlanReplicaMutation({
    branchName: normalizedBranch,
    planId: plan.id,
    operation: 'create',
    targets,
    registrySnapshot,
    deps,
    commitMessage: `chore(metadata): create architect plan ${plan.id}`,
  });
  invalidateArchitectPlanRuntimeCaches({
    branchName: normalizedBranch,
    planId: plan.id,
  });

  return (await getArchitectPlan(normalizedBranch, plan.id, deps)) || plan;
};

export const createArchitectPlan = async (
  input: CreateArchitectPlanInput,
  deps: ResolvedArchitectPlanServiceDependencies = resolveArchitectPlanServiceDependencies()
): Promise<ArchitectPlanRecord> =>
  enqueueArchitectPlanCreation(input.branchName, () => createArchitectPlanUnlocked(input, deps));

export const updateArchitectPlan = async (input: {
  branchName: string;
  planId: string;
  title?: string;
  label?: string;
  slug?: string;
  description?: string;
  planKind?: ArchitectPlanKind;
  gitFlowPlan?: Partial<ArchitectPlanGitFlowMetadata>;
  conversationId?: string;
  status?: ArchitectPlanStatus;
  projectId?: string;
  projectIds?: string[];
  contextProjectIds?: string[];
  targetBranchesByProjectId?: Record<string, string>;
  expectedProjectIds?: string[];
  nodes?: PlanNode[];
  predictedBranches?: PredictedBranch[];
  setActive?: boolean;
}, deps: ResolvedArchitectPlanServiceDependencies = resolveArchitectPlanServiceDependencies()): Promise<ArchitectPlanRecord> => {
  const normalizedBranch = normalizeBranchName(input.branchName);
  assertGitFlowTargetBranch(normalizedBranch);
  const safeId = sanitizeId(input.planId);
  return enqueueArchitectPlanMutation(normalizedBranch, safeId, async () => {
  const registrySnapshot = await loadArchitectPlanRegistrySnapshot(deps);
  const replicaSet = await loadPlanReplicaSet(normalizedBranch, safeId, {
    registrySnapshot,
  }, deps);
  if (!replicaSet) {
    throwPlanMetadataMissing(normalizedBranch, safeId);
  }
  const existing = replicaSet.canonical.plan;
  const inputKeys = Object.keys(input).filter((key) => key !== 'branchName' && key !== 'planId');
  const isRestoringArchivedPlan =
    existing.status === 'archived' &&
    isArchitectPlanRestorableStatus(input.status) &&
    inputKeys.every((key) => key === 'status' || key === 'setActive');
  if (!isRestoringArchivedPlan) {
    assertPlanReplicaSetWritable(replicaSet, 'update');
  }
  const isCanonicalPlan = isCanonicalArchitectPlan(existing);

  if (!isCanonicalPlan && input.title && input.title.trim().toLowerCase() !== existing.title.trim().toLowerCase()) {
    const idx = await readAggregatedIndex(normalizedBranch, registrySnapshot, deps);
    const normalizedTitle = input.title.trim().toLowerCase();
    const titleConflict = idx.plans.find(
      (p) => p.id !== safeId && p.status !== 'deleted' && p.title.trim().toLowerCase() === normalizedTitle
    );
    if (titleConflict) {
      throw new Error(`A plan named "${titleConflict.title}" already exists. Choose a different name.`);
    }
  }

  const requestedSlug = input.slug ? slugifyPlanTitle(input.slug) : existing.slug;
  if (requestedSlug !== existing.slug && !isArchitectPlanSlugMutable(existing)) {
    throw new Error('Plan slug is immutable and cannot be changed after creation.');
  }
  if (requestedSlug !== existing.slug) {
    const idx = await readAggregatedIndex(normalizedBranch, registrySnapshot, deps);
    const currentSlugForPlan = idx.plans.find((plan) => plan.id === safeId)?.slug || existing.slug;
    const hasSlugConflict =
      idx.plans.some(
        (plan) =>
          plan.id !== safeId &&
          slugifyPlanTitle(plan.slug || plan.title || plan.id) === requestedSlug
      ) ||
      idx.reservedPlanSlugs.some(
        (slug) =>
          slugifyPlanTitle(slug) === requestedSlug &&
          slugifyPlanTitle(currentSlugForPlan) !== requestedSlug
      );
    if (hasSlugConflict) {
      throw new Error(`A plan slug "${requestedSlug}" already exists. Choose a different slug.`);
    }
  }

  const requestedLabel = normalizePlanLabel(input.label ?? input.title);

  const nextNodes = input.nodes !== undefined ? normalizePlanNodes(input.nodes) : existing.nodes;
  const nextPredictedBranches =
    input.predictedBranches !== undefined
      ? normalizePlanPredictedBranches(input.predictedBranches)
      : existing.predictedBranches;
  const projectIds = resolvePlanProjectIds({
    projectIds: input.projectIds ?? existing.projectIds,
    projectId: input.projectId !== undefined ? input.projectId : existing.projectId,
    nodes: nextNodes,
    predictedBranches: nextPredictedBranches,
  });
  const contextProjectIds = normalizeContextProjectIds(
    input.contextProjectIds !== undefined ? input.contextProjectIds : existing.contextProjectIds,
    projectIds,
    registrySnapshot
  );
  const expectedProjectIds = normalizeArchitectPlanIdList(projectIds, contextProjectIds);
  const planKind = normalizeArchitectPlanKind(
    input.planKind || input.gitFlowPlan?.planKind || existing.planKind || existing.gitFlowPlan?.planKind
  );
  const gitFlowNormalizationContext = await createGitFlowMetadataNormalizationContext(
    deps,
    existing.targetBranch || normalizedBranch
  );
  const normalizedGitFlowPlan = normalizeArchitectPlanGitFlowMetadata({
    planKind,
    gitFlowPlan: input.gitFlowPlan !== undefined ? input.gitFlowPlan : existing.gitFlowPlan,
    projectIds,
    fallbackSlug: requestedSlug,
    ...gitFlowNormalizationContext,
  });
  const normalizedTargetBranchesByProjectId = getArchitectPlanEffectiveTargetBranchesByProjectId({
    ...existing,
    projectId: projectIds[0],
    projectIds,
    targetBranchesByProjectId: mergeGitFlowTargetBranchesByProjectId(
      normalizeTargetBranchesByProjectId(
        input.targetBranchesByProjectId !== undefined
          ? input.targetBranchesByProjectId
          : existing.targetBranchesByProjectId,
        projectIds,
        existing.targetBranch
      ),
      normalizedGitFlowPlan,
      projectIds,
      { preferGitFlow: input.targetBranchesByProjectId === undefined }
    ),
    planKind,
    gitFlowPlan: normalizedGitFlowPlan,
  }, {
    getProjectGitFlowSettings: gitFlowNormalizationContext.getProjectSettings,
    fallbackTargetBranch: existing.targetBranch || normalizedBranch,
  });
  if (!getArchitectPlanCrudCapabilities(existing).canEditScope) {
    const existingProjectIds = normalizeProjectIds(existing.projectIds, existing.projectId);
    const existingContextProjectIds = normalizeContextProjectIds(
      existing.contextProjectIds,
      existingProjectIds,
      registrySnapshot
    );
    const existingExpectedProjectIds = normalizeArchitectPlanIdList(
      existingProjectIds,
      existingContextProjectIds
    );
    const existingTargetBranchesByProjectId = normalizeTargetBranchesByProjectId(
      existing.targetBranchesByProjectId,
      existingProjectIds,
      existing.targetBranch
    );
    const existingPlanKind = normalizeArchitectPlanKind(
      existing.planKind || existing.gitFlowPlan?.planKind
    );
    const existingGitFlowPlan = normalizeArchitectPlanGitFlowMetadata({
      planKind: existingPlanKind,
      gitFlowPlan: existing.gitFlowPlan,
      projectIds: existingProjectIds,
      fallbackSlug: existing.slug,
      ...gitFlowNormalizationContext,
    });
    const scopeChanged =
      stableSerialize(projectIds) !== stableSerialize(existingProjectIds) ||
      stableSerialize(contextProjectIds) !== stableSerialize(existingContextProjectIds) ||
      stableSerialize(expectedProjectIds) !== stableSerialize(existingExpectedProjectIds);
    const branchMetadataChanged =
      input.targetBranchesByProjectId !== undefined &&
      stableSerialize(normalizedTargetBranchesByProjectId) !==
        stableSerialize(existingTargetBranchesByProjectId);
    const gitFlowMetadataChanged =
      (input.gitFlowPlan !== undefined || input.planKind !== undefined) &&
      (planKind !== existingPlanKind ||
        stableSerialize(normalizedGitFlowPlan) !== stableSerialize(existingGitFlowPlan));

    if (scopeChanged || branchMetadataChanged || gitFlowMetadataChanged) {
      throw new Error('Plan scope and Git workflow metadata are immutable after draft status.');
    }
  }

  const candidateResult = sanitizeArchitectPlanRecord(normalizedBranch, safeId, {
    ...existing,
    slug: requestedSlug,
    title: isCanonicalPlan ? existing.title : input.title?.trim() || existing.title,
    label: isCanonicalPlan
      ? (input.label !== undefined || input.title !== undefined ? requestedLabel : existing.label)
      : normalizePlanLabel(input.label) ?? existing.label,
    description: input.description !== undefined ? input.description.trim() : existing.description,
    planKind,
    gitFlowPlan: normalizedGitFlowPlan,
    conversationId: input.conversationId !== undefined ? input.conversationId : existing.conversationId,
    status: input.status || existing.status,
    targetBranchesByProjectId: normalizedTargetBranchesByProjectId,
    projectId: projectIds[0],
    projectIds,
    contextProjectIds,
    expectedProjectIds,
    nodes: nextNodes,
    predictedBranches: nextPredictedBranches,
    updatedAt: existing.updatedAt,
    revision: existing.revision,
  }, registrySnapshot, {
    logContext: 'plan_update',
  });
  if (!candidateResult.plan) {
    throwPlanMetadataMissing(normalizedBranch, safeId);
  }
  const candidate = candidateResult.plan;

  const targetScopes = await ensurePlanScopes(
    candidate.expectedProjectIds || candidate.projectIds || [],
    registrySnapshot,
    deps,
    getPlanExecutionModes(candidate, registrySnapshot),
  );
  const existingScopes = dedupeScopes([
    ...replicaSet.expectedScopes,
    ...replicaSet.snapshots.map((snapshot) => snapshot.scope),
  ]);
  const targetScopeKeys = new Set(targetScopes.map((scope) => scope.scopeKey));
  const existingScopeKeys = new Set(existingScopes.map((scope) => scope.scopeKey));
  const removedScopes = existingScopes.filter((scope) => !targetScopeKeys.has(scope.scopeKey));
  const writeScopes = dedupeScopes([
    ...targetScopes,
    ...existingScopes.filter((scope) => targetScopeKeys.has(scope.scopeKey)),
  ]);
  const hasScopeChanges =
    targetScopes.length !== existingScopes.length ||
    targetScopes.some((scope) => !existingScopeKeys.has(scope.scopeKey));
  const hasSemanticChange = !areArchitectPlansSemanticallyEqual(existing, candidate);
  let shouldActivate = input.setActive === true;
  if (shouldActivate) {
    const activationStates = await Promise.all(
      targetScopes.map(async (scope) => {
        const index = await readIndexAtScope(scope, normalizedBranch, registrySnapshot);
        const exists = index.plans.some((plan) => plan.id === safeId && plan.status !== 'deleted');
        return exists && index.activePlanId !== safeId;
      })
    );
    shouldActivate = activationStates.some(Boolean);
  }
  if (!hasSemanticChange && !hasScopeChanges && !shouldActivate) {
    return existing;
  }

  if (!hasSemanticChange && !hasScopeChanges && shouldActivate) {
    const targets = await Promise.all(targetScopes.map(async (scope): Promise<ArchitectPlanReplicaMutationTarget> => {
      const index = await readIndexAtScope(scope, normalizedBranch, registrySnapshot);
      return {
        scope,
        action: 'index',
        plan: null,
        executionModesByProjectId: getPlanExecutionModes(existing, registrySnapshot),
        index: { ...index, version: 3, activePlanId: safeId },
      };
    }));
    await runArchitectPlanReplicaMutation({
      branchName: normalizedBranch,
      planId: safeId,
      operation: 'update',
      targets,
      registrySnapshot,
      deps,
      commitMessage: `chore(metadata): activate architect plan ${safeId}`,
    });
    return existing;
  }

  const nextCandidate = applyArchitectPlanLifecycleForStatus({
    ...candidate,
    updatedAt: new Date().toISOString(),
    revision: (existing.revision || 1) + 1,
  }, existing.status);
  const nextResult = sanitizeArchitectPlanRecord(normalizedBranch, safeId, nextCandidate, registrySnapshot, {
    logContext: 'plan_update',
  });
  if (!nextResult.plan) {
    throwPlanMetadataMissing(normalizedBranch, safeId);
  }
  const next = nextResult.plan;

  const targets = [
    ...await Promise.all(writeScopes.map((scope) => buildUpsertReplicaMutationTarget({
      scope,
      branchName: normalizedBranch,
      plan: next,
      registrySnapshot,
      setActive: shouldActivate,
      chatMessageCount: replicaSet.canonical.manifest.conversation.messageCount,
    }))),
    ...await Promise.all(removedScopes.map((scope) => buildRemoveReplicaMutationTarget({
      scope,
      branchName: normalizedBranch,
      planId: next.id,
      plan: next,
      registrySnapshot,
    }))),
  ];
  await runArchitectPlanReplicaMutation({
    branchName: normalizedBranch,
    planId: next.id,
    operation: existing.status === 'archived' && next.status !== 'archived' ? 'restore' : 'update',
    targets,
    registrySnapshot,
    deps,
    commitMessage: `chore(metadata): update architect plan ${next.id}`,
  });
  invalidateArchitectPlanRuntimeCaches({
    branchName: normalizedBranch,
    planId: next.id,
  });

  try {
    return (await getArchitectPlan(normalizedBranch, next.id, deps)) || next;
  } catch (error) {
    if (isArchitectPlanReplicaDivergenceError(error)) {
      devLogger.warn(
        JSON.stringify({
          event: 'architect_plan_post_update_replica_verification_failed',
          at: new Date().toISOString(),
          branchName: normalizedBranch,
          planId: next.id,
          reason: error.divergence.reason,
        })
      );
      return {
        ...next,
        hasReplicaDivergence: true,
        replicationState: 'diverged',
        replicas: error.divergence.replicas,
      };
    }
    throw error;
  }
  });
};

const bindArchitectPlanConversationWithReplicaSet = async (params: {
  normalizedBranch: string;
  safeId: string;
  conversationId: string;
  registrySnapshot?: ValidProjectRegistrySnapshot | null;
  replicaSet: ArchitectPlanReplicaSet;
  deps: ResolvedArchitectPlanServiceDependencies;
}): Promise<ArchitectPlanRecord> => {
  const {
    normalizedBranch,
    safeId,
    conversationId,
    registrySnapshot,
    replicaSet,
    deps,
  } = params;
  const existing = replicaSet.canonical.plan;
  if (existing.status === 'deleted') {
    throwPlanMetadataMissing(normalizedBranch, safeId);
  }
  if (existing.conversationId === conversationId) {
    return existing;
  }
  assertPlanReplicaSetWritable(replicaSet, 'bind conversation');

  const nextResult = sanitizeArchitectPlanRecord(normalizedBranch, safeId, {
    ...existing,
    conversationId,
    updatedAt: new Date().toISOString(),
    revision: (existing.revision || 1) + 1,
  }, registrySnapshot, {
    logContext: 'plan_bind_conversation',
  });
  if (!nextResult.plan) {
    throwPlanMetadataMissing(normalizedBranch, safeId);
  }
  const nextPlan = nextResult.plan;
  const scopes = dedupeScopes(replicaSet.expectedScopes);

  const targets = await Promise.all(scopes.map(async (scope) => {
    const chatMessages = await readPlanChatAtScope(scope, normalizedBranch, nextPlan.id);
    return buildUpsertReplicaMutationTarget({
      scope,
      branchName: normalizedBranch,
      plan: nextPlan,
      registrySnapshot,
      chatMessages,
      chatMessageCount: chatMessages.length,
    });
  }));
  await runArchitectPlanReplicaMutation({
    branchName: normalizedBranch,
    planId: safeId,
    operation: 'bind',
    targets,
    registrySnapshot,
    deps,
    commitMessage: `chore(metadata): bind architect plan conversation ${safeId}`,
  });
  invalidateArchitectPlanRuntimeCaches({
    branchName: normalizedBranch,
    planId: safeId,
  });

  try {
    return (await getArchitectPlan(normalizedBranch, safeId, deps)) || nextPlan;
  } catch (error) {
    if (isArchitectPlanReplicaDivergenceError(error)) {
      devLogger.warn(
        JSON.stringify({
          event: 'architect_plan_post_update_replica_verification_failed',
          at: new Date().toISOString(),
          branchName: normalizedBranch,
          planId: safeId,
          reason: error.divergence.reason,
        })
      );
      return {
        ...nextPlan,
        hasReplicaDivergence: true,
        replicationState: 'diverged',
        replicas: error.divergence.replicas,
      };
    }
    throw error;
  }
};

export const bindArchitectPlanConversation = async (params: {
  branchName: string;
  planId: string;
  conversationId: string;
}, deps: ResolvedArchitectPlanServiceDependencies = resolveArchitectPlanServiceDependencies()): Promise<ArchitectPlanRecord> => {
  const normalizedBranch = normalizeBranchName(params.branchName);
  assertGitFlowTargetBranch(normalizedBranch);
  const safeId = sanitizeId(params.planId);
  const conversationId = params.conversationId.trim();
  if (!conversationId) {
    throw new Error('Conversation id is required to bind an architect plan conversation.');
  }

  return enqueueArchitectPlanMutation(normalizedBranch, safeId, async () => {
    const registrySnapshot = await loadArchitectPlanRegistrySnapshot(deps);
    const replicaSet = await loadPlanReplicaSet(normalizedBranch, safeId, {
      registrySnapshot,
    }, deps);
    if (!replicaSet) {
      throwPlanMetadataMissing(normalizedBranch, safeId);
    }
    return bindArchitectPlanConversationWithReplicaSet({
      normalizedBranch,
      safeId,
      conversationId,
      registrySnapshot,
      replicaSet,
      deps,
    });
  });
};

export const setActiveArchitectPlan = async (
  branchName: string,
  planId: string,
  deps: ResolvedArchitectPlanServiceDependencies = resolveArchitectPlanServiceDependencies()
): Promise<void> => {
  const normalizedBranch = normalizeBranchName(branchName);
  assertGitFlowTargetBranch(normalizedBranch);
  const safeId = sanitizeId(planId);
  return enqueueArchitectPlanMutation(normalizedBranch, safeId, async () => {
    const registrySnapshot = await loadArchitectPlanRegistrySnapshot(deps);
    const replicaSet = await loadPlanReplicaSet(normalizedBranch, safeId, {
      registrySnapshot,
    }, deps);
    if (
      !replicaSet ||
      replicaSet.canonical.plan.status === 'deleted' ||
      replicaSet.canonical.plan.status === 'archived'
    ) {
      throw new Error(`Cannot activate missing, deleted, or archived plan: ${planId}`);
    }

    const targets = (await Promise.all(
      dedupeScopes(replicaSet.expectedScopes).map(async (scope): Promise<ArchitectPlanReplicaMutationTarget | null> => {
        const index = await readIndexAtScope(scope, normalizedBranch, registrySnapshot);
        const exists = index.plans.some((plan) => plan.id === safeId && plan.status !== 'deleted');
        if (!exists || index.activePlanId === safeId) {
          return null;
        }
        return {
          scope,
          action: 'index',
          plan: null,
          executionModesByProjectId: getPlanExecutionModes(replicaSet.canonical.plan, registrySnapshot),
          index: {
            ...index,
            version: 3,
            activePlanId: safeId,
          },
        };
      })
    )).filter((target): target is ArchitectPlanReplicaMutationTarget => target !== null);
    if (targets.length > 0) {
      await runArchitectPlanReplicaMutation({
        branchName: normalizedBranch,
        planId: safeId,
        operation: 'activate',
        targets,
        registrySnapshot,
        deps,
        commitMessage: `chore(metadata): activate architect plan ${safeId}`,
      });
    }
    invalidateArchitectPlanRuntimeCaches({ branchName: normalizedBranch });
  });
};

export const deleteArchitectPlan = async (input: {
  branchName: string;
  planId: string;
  hardDelete?: boolean;
}, deps: ResolvedArchitectPlanServiceDependencies = resolveArchitectPlanServiceDependencies()): Promise<void> => {
  const normalizedBranch = normalizeBranchName(input.branchName);
  assertGitFlowTargetBranch(normalizedBranch);
  const safeId = sanitizeId(input.planId);
  return enqueueArchitectPlanMutation(normalizedBranch, safeId, async () => {
    const registrySnapshot = await loadArchitectPlanRegistrySnapshot(deps);
    const replicaSet = await loadPlanReplicaSet(normalizedBranch, safeId, {
      registrySnapshot,
    }, deps);
    if (!replicaSet) {
      throwPlanMetadataMissing(normalizedBranch, safeId);
    }
    const scopes = dedupeScopes(replicaSet.expectedScopes);

    if (input.hardDelete) {
      const targets = await Promise.all(scopes.map((scope) => buildRemoveReplicaMutationTarget({
        scope,
        branchName: normalizedBranch,
        planId: safeId,
        plan: replicaSet.canonical.plan,
        registrySnapshot,
      })));
      await runArchitectPlanReplicaMutation({
        branchName: normalizedBranch, planId: safeId, operation: 'delete', targets, registrySnapshot, deps,
        commitMessage: `chore(metadata): hard delete architect plan ${safeId}`,
      });
      invalidateArchitectPlanRuntimeCaches({
        branchName: normalizedBranch,
        planId: safeId,
      });
      return;
    }

    const deletedRecord = applyArchitectPlanLifecycleForStatus({
      ...replicaSet.canonical.plan,
      status: 'deleted' as ArchitectPlanStatus,
      updatedAt: new Date().toISOString(),
      revision: (replicaSet.canonical.plan.revision || 1) + 1,
    }, replicaSet.canonical.plan.status);
    const deletedResult = sanitizeArchitectPlanRecord(normalizedBranch, safeId, deletedRecord, registrySnapshot, {
      logContext: 'plan_delete',
    });
    if (!deletedResult.plan) {
      throwPlanMetadataMissing(normalizedBranch, safeId);
    }
    const deleted = deletedResult.plan;
    const targets = await Promise.all(scopes.map((scope) => buildUpsertReplicaMutationTarget({
      scope,
      branchName: normalizedBranch,
      plan: deleted,
      registrySnapshot,
      setActive: false,
      chatMessageCount: replicaSet.canonical.manifest.conversation.messageCount,
    }).then((target) => ({
      ...target,
      index: {
        ...target.index,
        activePlanId: target.index.activePlanId === safeId
          ? target.index.plans.find((plan) => plan.status !== 'deleted' && plan.status !== 'archived')?.id || null
          : target.index.activePlanId,
      },
    }))));
    await runArchitectPlanReplicaMutation({
      branchName: normalizedBranch, planId: safeId, operation: 'delete', targets, registrySnapshot, deps,
      commitMessage: `chore(metadata): delete architect plan ${safeId}`,
    });
    invalidateArchitectPlanRuntimeCaches({
      branchName: normalizedBranch,
      planId: safeId,
    });
  });
};

export const restoreArchitectPlan = async (
  branchName: string,
  planId: string,
  deps: ResolvedArchitectPlanServiceDependencies = resolveArchitectPlanServiceDependencies()
): Promise<ArchitectPlanRecord> => {
  const normalizedBranch = normalizeBranchName(branchName);
  assertGitFlowTargetBranch(normalizedBranch);
  const existing = await getArchitectPlan(normalizedBranch, planId, deps);
  if (!existing || existing.status === 'deleted') {
    throwPlanMetadataMissing(normalizedBranch, planId);
  }
  const restoredStatus =
    existing.status === 'archived'
      ? resolveArchivedArchitectPlanRestoreStatus(existing)
      : existing.status;
  return updateArchitectPlan({ branchName: normalizedBranch, planId, status: restoredStatus }, deps);
};

export const archiveArchitectPlan = async (
  branchName: string,
  planId: string,
  deps: ResolvedArchitectPlanServiceDependencies = resolveArchitectPlanServiceDependencies()
): Promise<ArchitectPlanRecord> => {
  const normalizedBranch = normalizeBranchName(branchName);
  assertGitFlowTargetBranch(normalizedBranch);
  const safeId = sanitizeId(planId);
  return enqueueArchitectPlanMutation(normalizedBranch, safeId, async () => {
    const registrySnapshot = await loadArchitectPlanRegistrySnapshot(deps);
    const replicaSet = await loadPlanReplicaSet(normalizedBranch, safeId, {
      registrySnapshot,
    }, deps);
    if (!replicaSet) throwPlanMetadataMissing(normalizedBranch, safeId);
    assertPlanReplicaSetWritable(replicaSet, 'archive');
    const now = new Date().toISOString();
    const archivedRecord = applyArchitectPlanLifecycleForStatus({
      ...replicaSet.canonical.plan,
      status: 'archived',
      updatedAt: now,
      revision: (replicaSet.canonical.plan.revision || 1) + 1,
    }, replicaSet.canonical.plan.status);
    const archivedResult = sanitizeArchitectPlanRecord(normalizedBranch, safeId, archivedRecord, registrySnapshot, {
      logContext: 'plan_archive',
    });
    if (!archivedResult.plan) {
      throwPlanMetadataMissing(normalizedBranch, safeId);
    }
    const archived = archivedResult.plan;
    const targets = await Promise.all(dedupeScopes(replicaSet.expectedScopes).map((scope) =>
      buildUpsertReplicaMutationTarget({
        scope,
        branchName: normalizedBranch,
        plan: archived,
        registrySnapshot,
        chatMessageCount: replicaSet.canonical.manifest.conversation.messageCount,
      }).then((target) => ({
        ...target,
        index: {
          ...target.index,
          activePlanId: target.index.activePlanId === safeId
            ? target.index.plans.find((plan) => plan.status !== 'deleted' && plan.status !== 'archived')?.id || null
            : target.index.activePlanId,
        },
      }))
    ));
    await runArchitectPlanReplicaMutation({
      branchName: normalizedBranch, planId: safeId, operation: 'archive', targets, registrySnapshot, deps,
      commitMessage: `chore(metadata): archive architect plan ${safeId}`,
    });
    invalidateArchitectPlanRuntimeCaches({
      branchName: normalizedBranch,
      planId: safeId,
    });
    return (await getArchitectPlan(normalizedBranch, safeId, deps)) || archived;
  });
};

export const getArchitectPlanChatMessages = async (
  branchName: string,
  planId: string,
  deps: ResolvedArchitectPlanServiceDependencies = resolveArchitectPlanServiceDependencies()
): Promise<ArchitectPlanChatMessage[]> => {
  const normalizedBranch = normalizeBranchName(branchName);
  assertGitFlowTargetBranch(normalizedBranch);
  const registrySnapshot = await loadArchitectPlanRegistrySnapshot(deps);
  const replicaSet = await loadPlanReplicaSet(normalizedBranch, planId, {
    registrySnapshot,
  }, deps);
  if (!replicaSet) {
    throwPlanMetadataMissing(normalizedBranch, planId);
  }
  return readPlanChatAtScope(replicaSet.canonical.scope, normalizedBranch, sanitizeId(planId));
};

const saveArchitectPlanChatMessagesWithReplicaSet = async (params: {
  normalizedBranch: string;
  safeId: string;
  messages: ArchitectPlanChatMessage[];
  registrySnapshot?: ValidProjectRegistrySnapshot | null;
  replicaSet: ArchitectPlanReplicaSet;
  deps: ResolvedArchitectPlanServiceDependencies;
  action?: string;
}): Promise<void> => {
  const {
    normalizedBranch,
    safeId,
    messages,
    registrySnapshot,
    replicaSet,
    deps,
    action = 'save chat transcript',
  } = params;
  assertPlanReplicaSetWritable(replicaSet, action);
  const nextMessages = messages.map((message) => ({ ...message }));
  const persistedMessages =
    replicaSet.canonical.scope.source === 'local'
      ? await readPlanChatAtScope(replicaSet.canonical.scope, normalizedBranch, safeId)
      : parseJsonLines(replicaSet.canonical.files['chat.jsonl'] || '');
  if (arePlanChatMessagesEquivalent(persistedMessages, nextMessages)) {
    return;
  }
  const nextPlan = {
    ...replicaSet.canonical.plan,
    updatedAt: new Date().toISOString(),
    revision: (replicaSet.canonical.plan.revision || 1) + 1,
  };
  const targets = await Promise.all(dedupeScopes(replicaSet.expectedScopes).map((scope) =>
    buildUpsertReplicaMutationTarget({
      scope,
      branchName: normalizedBranch,
      plan: nextPlan,
      registrySnapshot,
      chatMessages: nextMessages,
      chatMessageCount: nextMessages.length,
    })
  ));
  await runArchitectPlanReplicaMutation({
    branchName: normalizedBranch,
    planId: safeId,
    operation: 'chat',
    targets,
    registrySnapshot,
    deps,
    commitMessage: `chore(metadata): update architect plan chat ${safeId}`,
  });
  invalidateArchitectPlanRuntimeCaches({
    branchName: normalizedBranch,
    planId: safeId,
  });
};

export const saveArchitectPlanChatMessages = async (
  branchName: string,
  planId: string,
  messages: ArchitectPlanChatMessage[],
  deps: ResolvedArchitectPlanServiceDependencies = resolveArchitectPlanServiceDependencies()
): Promise<void> => {
  const normalizedBranch = normalizeBranchName(branchName);
  assertGitFlowTargetBranch(normalizedBranch);
  const safeId = sanitizeId(planId);
  return enqueueArchitectPlanMutation(normalizedBranch, safeId, async () => {
    const registrySnapshot = await loadArchitectPlanRegistrySnapshot(deps);
    const replicaSet = await loadPlanReplicaSet(normalizedBranch, safeId, {
      registrySnapshot,
    }, deps);
    if (!replicaSet) {
      throwPlanMetadataMissing(normalizedBranch, safeId);
    }
    await saveArchitectPlanChatMessagesWithReplicaSet({
      normalizedBranch,
      safeId,
      messages,
      registrySnapshot,
      replicaSet,
      deps,
    });
  });
};

export const syncArchitectPlanChatFromConversation = async (params: {
  branchName: string;
  planId: string;
  conversationId?: string | null;
}, deps: ResolvedArchitectPlanServiceDependencies = resolveArchitectPlanServiceDependencies()): Promise<void> => {
  if (!deps.tauri.isTauriAvailable()) {
    return;
  }

  const normalizedBranch = normalizeBranchName(params.branchName);
  assertGitFlowTargetBranch(normalizedBranch);
  const safeId = sanitizeId(params.planId);
  return enqueueArchitectPlanMutation(normalizedBranch, safeId, async () => {
    const registrySnapshot = await loadArchitectPlanRegistrySnapshot(deps);
    const replicaSet = await loadPlanReplicaSet(normalizedBranch, safeId, {
      registrySnapshot,
    }, deps);
    if (!replicaSet) {
      throwPlanMetadataMissing(normalizedBranch, safeId);
    }
    assertPlanReplicaSetWritable(replicaSet, 'sync chat transcript');

    const conversationId = params.conversationId ?? replicaSet.canonical.plan.conversationId ?? null;
    if (!conversationId) {
      await saveArchitectPlanChatMessagesWithReplicaSet({
        normalizedBranch,
        safeId,
        messages: [],
        registrySnapshot,
        replicaSet,
        deps,
        action: 'sync chat transcript',
      });
      return;
    }

    const dbMessages = await deps.tauri.listMessages(conversationId);
    const transcript = dbMessages
      .filter((message) => message.role === 'user' || message.role === 'assistant')
      .map((message) => ({
        id: message.id,
        role: message.role as 'user' | 'assistant',
        content: message.content,
        createdAt: message.created_at,
      }));

    await saveArchitectPlanChatMessagesWithReplicaSet({
      normalizedBranch,
      safeId,
      messages: transcript,
      registrySnapshot,
      replicaSet,
      deps,
      action: 'sync chat transcript',
    });
  });
};

export const repairArchitectPlanReplicas = async (input: {
  branchName: string;
  planId: string;
  strategy: ArchitectPlanReplicaRepairStrategy;
}, deps: ResolvedArchitectPlanServiceDependencies = resolveArchitectPlanServiceDependencies()): Promise<ArchitectPlanRecord> => {
  const normalizedBranch = normalizeBranchName(input.branchName);
  assertGitFlowTargetBranch(normalizedBranch);
  const safeId = sanitizeId(input.planId);
  return enqueueArchitectPlanMutation(normalizedBranch, safeId, async () => {
  const registrySnapshot = await loadArchitectPlanRegistrySnapshot(deps);
  const replicaSet = await loadPlanReplicaSet(normalizedBranch, input.planId, {
    allowDivergence: true,
    registrySnapshot,
  }, deps);
  if (!replicaSet) {
    throwPlanMetadataMissing(normalizedBranch, input.planId);
  }

  const canonicalSnapshot = pickCanonicalReplica(
    replicaSet.snapshots.map((snapshot) => ({
      ...snapshot,
      updatedAt: snapshot.plan.updatedAt,
      repoPath: snapshot.scope.repoPath,
    })),
    input.strategy
  );
  const canonicalPlan = normalizePlanRecordForBranch(
    normalizedBranch,
    canonicalSnapshot.plan.id,
    {
      ...stripPlanReplicaMetadata(canonicalSnapshot.plan),
      updatedAt: new Date().toISOString(),
      revision: (canonicalSnapshot.plan.revision || canonicalSnapshot.manifest.revision || 1) + 1,
    },
    registrySnapshot,
    {
      logContext: 'replica_repair',
    }
  );
  if (!canonicalPlan) {
    throwPlanMetadataMissing(normalizedBranch, input.planId);
  }

  const replicatedExtraFiles = Object.entries(canonicalSnapshot.files)
    .filter(([relativePath]) => relativePath.startsWith('artifacts/'));
  const canonicalMessages = parseJsonLines(canonicalSnapshot.files['chat.jsonl'] || '');
  const extraFiles = Object.fromEntries(replicatedExtraFiles);
  const targets = await Promise.all(dedupeScopes(replicaSet.expectedScopes).map((scope) =>
    buildUpsertReplicaMutationTarget({
      scope,
      branchName: normalizedBranch,
      plan: canonicalPlan,
      registrySnapshot,
      chatMessages: canonicalMessages,
      chatMessageCount: canonicalMessages.length,
      replacePlanDirectory: true,
      extraFiles,
    })
  ));
  await runArchitectPlanReplicaMutation({
    branchName: normalizedBranch,
    planId: canonicalPlan.id,
    operation: 'repair',
    targets,
    registrySnapshot,
    deps,
    commitMessage: `chore(metadata): repair architect plan ${canonicalPlan.id}`,
  });

  const repairedReplicaSet = await loadPlanReplicaSet(normalizedBranch, canonicalPlan.id, {
    registrySnapshot,
  }, deps);
  invalidateArchitectPlanRuntimeCaches({
    branchName: normalizedBranch,
    planId: canonicalPlan.id,
  });
  const repaired = repairedReplicaSet?.canonical.plan || null;
  if (!repaired) {
    throwPlanMetadataMissing(normalizedBranch, input.planId);
  }
  return repaired;
  });
};

const listPlanRelativeFilesAtScope = async (
  scope: ArchitectMetadataScope,
  branchName: string,
  planId: string
): Promise<string[]> => {
  if (!tauriIpc.isTauriAvailable() || scope.source === 'local') {
    return [];
  }

  try {
    const planDir = getPlanDir(branchName, planId);
    const entries = await tauriIpc.fsListDir({
      path: planDir,
      recursive: true,
      includeHidden: true,
      allowOutsideWorkspace: false,
      workspaceScope: getScopeWorkspaceScope(scope),
      workspacePath: scope.workspacePath,
    });
    return entries
      .filter((entry) => entry.kind === 'file')
      .map((entry) => entry.relative_path.replace(/\\/g, '/').replace(/^\/+/, ''));
  } catch {
    return [];
  }
};

export const inspectArchitectPlanMetadataHealth = async (input: {
  branchName: string;
  planId: string;
}, deps: ResolvedArchitectPlanServiceDependencies = resolveArchitectPlanServiceDependencies()): Promise<ArchitectPlanMetadataHealth> => {
  const normalizedBranch = normalizeBranchName(input.branchName);
  const safeId = sanitizeId(input.planId);
  const registrySnapshot = await loadArchitectPlanRegistrySnapshot(deps);
  const replicaSet = await loadPlanReplicaSet(normalizedBranch, safeId, {
    allowDivergence: true,
    registrySnapshot,
  }, deps);

  if (replicaSet) {
    const hasMissingReplica = replicaSet.replicas.some((replica) => replica.missing);
    const status: ArchitectPlanMetadataHealthStatus = replicaSet.hasReplicaDivergence
      ? 'diverged'
      : hasMissingReplica
        ? 'missing_replica'
        : 'healthy';
    return {
      branchName: normalizedBranch,
      planId: safeId,
      status,
      replicas: replicaSet.replicas,
      orphanedReplicas: [],
      technicalMessage:
        status === 'healthy'
          ? null
          : `Plan ${safeId} metadata health is ${status}.`,
    };
  }

  const scopes = await resolveMetadataScopes(
    undefined,
    { includeAllKnown: true },
    registrySnapshot,
    deps
  );
  const orphanedReplicas = (
    await Promise.all(
      scopes.map(async (scope) => {
        const files = await listPlanRelativeFilesAtScope(scope, normalizedBranch, safeId);
        if (files.length === 0 || files.includes('plan.json')) {
          return null;
        }
        return toReplicaDescriptor(scope, null, true);
      })
    )
  ).filter((replica): replica is ArchitectPlanReplica => replica !== null);

  return {
    branchName: normalizedBranch,
    planId: safeId,
    status: orphanedReplicas.length > 0 ? 'runtime_orphan' : 'missing',
    replicas: orphanedReplicas,
    orphanedReplicas,
    technicalMessage:
      orphanedReplicas.length > 0
        ? `Plan ${safeId} has orphaned metadata files without plan.json.`
        : `Plan ${safeId} metadata was not found.`,
  };
};

export const repairArchitectPlanMetadata = async (input: {
  branchName: string;
  planId: string;
  strategy?: ArchitectPlanReplicaRepairStrategy;
}, deps: ResolvedArchitectPlanServiceDependencies = resolveArchitectPlanServiceDependencies()): Promise<ArchitectPlanMetadataRepairResult> => {
  const normalizedBranch = normalizeBranchName(input.branchName);
  const safeId = sanitizeId(input.planId);
  assertGitFlowTargetBranch(normalizedBranch);
  const health = await inspectArchitectPlanMetadataHealth({
    branchName: normalizedBranch,
    planId: safeId,
  }, deps);

  if (health.status === 'healthy') {
    return {
      branchName: normalizedBranch,
      planId: safeId,
      statusBeforeRepair: health.status,
      removedOrphanedReplicas: [],
      repairedPlan: await getArchitectPlan(normalizedBranch, safeId, deps),
    };
  }

  if (health.status === 'diverged' || health.status === 'missing_replica') {
    return {
      branchName: normalizedBranch,
      planId: safeId,
      statusBeforeRepair: health.status,
      removedOrphanedReplicas: [],
      repairedPlan: await repairArchitectPlanReplicas({
        branchName: normalizedBranch,
        planId: safeId,
        strategy: input.strategy ?? 'newest',
      }, deps),
    };
  }

  if (health.status !== 'runtime_orphan') {
    throwPlanMetadataMissing(normalizedBranch, safeId);
  }

  return enqueueArchitectPlanMutation(normalizedBranch, safeId, async () => {
    const registrySnapshot = await loadArchitectPlanRegistrySnapshot(deps);
    const scopes = await resolveMetadataScopes(
      undefined,
      { includeAllKnown: true },
      registrySnapshot,
      deps
    );
    const orphanScopeKeys = new Set(health.orphanedReplicas.map((replica) => replica.scopeKey));
    const removedScopes = scopes.filter((scope) => orphanScopeKeys.has(scope.scopeKey));

    if (removedScopes.length > 0) {
      const targets = await Promise.all(removedScopes.map((scope) => buildRemoveReplicaMutationTarget({
        scope,
        branchName: normalizedBranch,
        planId: safeId,
        registrySnapshot,
      })));
      await runArchitectPlanReplicaMutation({
        branchName: normalizedBranch,
        planId: safeId,
        operation: 'orphan_cleanup',
        targets,
        registrySnapshot,
        deps,
        commitMessage: `chore(metadata): remove orphaned architect plan ${safeId}`,
      });
    }

    invalidateArchitectPlanRuntimeCaches({
      branchName: normalizedBranch,
      planId: safeId,
    });

    return {
      branchName: normalizedBranch,
      planId: safeId,
      statusBeforeRepair: health.status,
      removedOrphanedReplicas: health.orphanedReplicas,
      repairedPlan: null,
    };
  });
};

export const writeArchitectTaskExecution = async (params: {
  branchName: string;
  planId: string;
  execution: ArchitectTaskExecutionRecord;
}, deps: ResolvedArchitectPlanServiceDependencies = resolveArchitectPlanServiceDependencies()): Promise<void> => {
  const normalizedBranch = normalizeBranchName(params.branchName);
  const registrySnapshot = await loadArchitectPlanRegistrySnapshot(deps);
  const replicaSet = await loadPlanReplicaSet(normalizedBranch, params.planId, {
    registrySnapshot,
  }, deps);
  if (!replicaSet) {
    throwPlanMetadataMissing(normalizedBranch, params.planId);
  }
  if (!deps.tauri.isTauriAvailable()) return;

  await Promise.all(
    dedupeScopes(replicaSet.expectedScopes).map((scope) =>
      deps.tauri.fsWriteFile({
        path: getTaskExecutedPath(normalizedBranch, replicaSet.canonical.plan.id, params.execution.taskId),
        content: buildTaskExecutedMarkdown(replicaSet.canonical.plan, params.execution),
        createDirs: true,
        allowOutsideWorkspace: false,
        workspaceScope: getScopeWorkspaceScope(scope),
        workspacePath: scope.workspacePath,
      })
    )
  );

  const executionModesByProjectId = getPlanExecutionModes(
    replicaSet.canonical.plan,
    registrySnapshot,
  );
  const persistedModes = Object.values(executionModesByProjectId);
  const taskExecutionWorkspacePaths: string[] = [];
  for (const scope of dedupeScopes(replicaSet.expectedScopes)) {
    if (scope.source === 'local' || !scope.workspacePath) continue;
    const shouldSyncGitMetadata = scope.projectId
      ? executionModesByProjectId[scope.projectId] === 'git'
      : persistedModes.includes('git');
    if (!shouldSyncGitMetadata) continue;
    taskExecutionWorkspacePaths.push(scope.workspacePath);
    recordMacroMetadataMutation({
      workspacePath: scope.workspacePath,
      kind: 'task_metadata',
      entityId: params.execution.taskId,
      label: params.execution.taskId,
      importance: 'light',
    }, {
      tauri: deps.tauri,
    });
  }
  if (taskExecutionWorkspacePaths.length > 0) {
    await flushMacroMetadata({
      trigger: 'explicit_checkpoint',
      workspacePaths: taskExecutionWorkspacePaths,
      message: `chore(@macro): update task metadata ${params.execution.taskId}`,
    }, {
      tauri: deps.tauri,
    });
  }
};

export interface ArchitectPlanService {
  listArchitectPlanTargetBranches: () => Promise<string[]>;
  commitArchitectPlanMetadata: typeof commitArchitectPlanMetadata;
  listArchitectPlans: typeof listArchitectPlans;
  isArchitectPlanSlugAvailable: typeof isArchitectPlanSlugAvailable;
  getArchitectPlanActivationPayload: typeof getArchitectPlanActivationPayload;
  getArchitectPlan: typeof getArchitectPlan;
  createArchitectPlan: typeof createArchitectPlan;
  updateArchitectPlan: typeof updateArchitectPlan;
  bindArchitectPlanConversation: typeof bindArchitectPlanConversation;
  setActiveArchitectPlan: typeof setActiveArchitectPlan;
  deleteArchitectPlan: typeof deleteArchitectPlan;
  restoreArchitectPlan: typeof restoreArchitectPlan;
  archiveArchitectPlan: typeof archiveArchitectPlan;
  getArchitectPlanChatMessages: typeof getArchitectPlanChatMessages;
  getArchitectPlanChatTranscript: typeof getArchitectPlanChatTranscript;
  saveArchitectPlanChatMessages: typeof saveArchitectPlanChatMessages;
  syncArchitectPlanChatFromConversation: typeof syncArchitectPlanChatFromConversation;
  repairArchitectPlanReplicas: typeof repairArchitectPlanReplicas;
  inspectArchitectPlanMetadataHealth: typeof inspectArchitectPlanMetadataHealth;
  repairArchitectPlanMetadata: typeof repairArchitectPlanMetadata;
  writeArchitectTaskExecution: typeof writeArchitectTaskExecution;
}

export const createArchitectPlanService = (
  overrides: ArchitectPlanServiceDependencies = {}
): ArchitectPlanService => {
  const deps = resolveArchitectPlanServiceDependencies(overrides);

  return {
    listArchitectPlanTargetBranches: () => listArchitectPlanTargetBranchesImpl(deps),
    commitArchitectPlanMetadata: (input) => commitArchitectPlanMetadata(input, deps),
    listArchitectPlans: (branchName, includeDeleted, includeArchived, options) =>
      listArchitectPlansWithDeps(branchName, includeDeleted, includeArchived, deps, options),
    isArchitectPlanSlugAvailable: (params) => isArchitectPlanSlugAvailable(params, deps),
    getArchitectPlanActivationPayload: (branchName, planId, options) =>
      getArchitectPlanActivationPayload(branchName, planId, options, deps),
    getArchitectPlan: (branchName, planId) => getArchitectPlan(branchName, planId, deps),
    createArchitectPlan: (input) => createArchitectPlan(input, deps),
    updateArchitectPlan: (input) => updateArchitectPlan(input, deps),
    bindArchitectPlanConversation: (params) => bindArchitectPlanConversation(params, deps),
    setActiveArchitectPlan: (branchName, planId) => setActiveArchitectPlan(branchName, planId, deps),
    deleteArchitectPlan: (input) => deleteArchitectPlan(input, deps),
    restoreArchitectPlan: (branchName, planId) => restoreArchitectPlan(branchName, planId, deps),
    archiveArchitectPlan: (branchName, planId) => archiveArchitectPlan(branchName, planId, deps),
    getArchitectPlanChatMessages: (branchName, planId) =>
      getArchitectPlanChatMessages(branchName, planId, deps),
    getArchitectPlanChatTranscript: (branchName, planId) =>
      getArchitectPlanChatTranscript(branchName, planId, deps),
    saveArchitectPlanChatMessages: (branchName, planId, messages) =>
      saveArchitectPlanChatMessages(branchName, planId, messages, deps),
    syncArchitectPlanChatFromConversation: (params) => syncArchitectPlanChatFromConversation(params, deps),
    repairArchitectPlanReplicas: (input) => repairArchitectPlanReplicas(input, deps),
    inspectArchitectPlanMetadataHealth: (input) => inspectArchitectPlanMetadataHealth(input, deps),
    repairArchitectPlanMetadata: (input) => repairArchitectPlanMetadata(input, deps),
    writeArchitectTaskExecution: (params) => writeArchitectTaskExecution(params, deps),
  };
};

export const listArchitectPlanTargetBranches = async (): Promise<string[]> =>
  listArchitectPlanTargetBranchesImpl(resolveArchitectPlanServiceDependencies());

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
