import { create } from 'zustand';
import { AppMode, ChatMessage, ContextRefKind, ContextReference, Conversation, PlanNode, PlanNodeStatus, PlanNodeType, PredictedBranch, ToolTrace } from '../types';
import { toServiceError } from '../services/contracts/errors';
import { useProviderStore } from './useProviderStore';
import { useCitationsStore } from './useCitationsStore';
import { streamChat, cancelStream, sendChatNonStreaming, type StreamCompletionResult } from '../services/streamingChat';
import { getStreamingWebSearchConfig } from '../services/webSearchSettings';
import { useToolsStore } from './useToolsStore';
import { useAppStore } from './useAppStore';
import { useTaskStore } from './useTaskStore';
import { getToolModePolicy as getLocalToolModePolicy } from '../services/toolModePolicy';
import { executeWorkspaceTool } from '../services/workspaceToolExecutor';
import { loadPreference, PREF_KEYS, savePreference } from '../services/preferences';
import { useNeedsStore } from './useNeedsStore';
import { useTerminalStore } from './useTerminalStore';
import { canUseRemoteKernel, getRemoteToolModePolicy } from '../services/remoteKernelApi';
import * as tauriIpc from '../services/tauriIpc';
import {
  type ArchitectPlanRecord,
  getArchitectPlan,
  getArchitectPlanChatMessages,
  getArchitectPlanProjectIds,
  getArchitectPlanNeeds,
  getGitFlowBaseBranch,
  listArchitectPlans,
  resolvePlanProjectContextId,
  resolveTargetBranch,
  saveArchitectPlanNeeds,
  toPlanIntegrationBranch,
  toPlanScopedFeatureBranch,
  updateArchitectPlan,
} from '../services/architectPlanService';
import {
  getArchitectPlanConversationTitle,
  getArchitectPlanDisplayName,
  isCanonicalArchitectPlan,
} from '../services/architectPlanPresentation';
import { normalizeArchitectToolId } from '../services/architectToolNames';
import { normalizeStrategyDependencies } from '../services/implementTaskDerivation';
import { getLocalProjectContextState } from '../services/localProjectContext';
import {
  getFocusedProjectForGroup,
  getGlobalProjectById,
  getProjectGroupByProjectId,
  getScopedProjectIds,
} from '../services/globalProjects';
import { syncMacroMetadataAfterStream as syncMacroMetadataAfterStreamService } from '../services/macroSyncService';
import { resolveProjectExecutionContext } from '../services/projectExecutionContext';
import { parseMessageQuickReplies } from '../services/chatQuickReplies';

const METADATA_MAX_TITLE_LENGTH = 72;
const METADATA_MAX_DESCRIPTION_LENGTH = 180;
const metadataGenerationInFlight = new Set<string>();

const createTokenBatcher = (appendChunk: (chunk: string) => void) => {
  let buffer = '';
  let rafId: number | null = null;

  const flush = () => {
    rafId = null;
    if (!buffer) return;
    const chunk = buffer;
    buffer = '';
    appendChunk(chunk);
  };

  return {
    push: (token: string) => {
      buffer += token;
      if (rafId !== null) return;
      rafId = window.requestAnimationFrame(flush);
    },
    flushNow: () => {
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
        rafId = null;
      }
      if (!buffer) return;
      const chunk = buffer;
      buffer = '';
      appendChunk(chunk);
    },
    dispose: () => {
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
        rafId = null;
      }
      buffer = '';
    },
  };
};

const getConversationFallbackTitle = (content: string): string => {
  const cleaned = content.replace(/\s+/g, ' ').trim();
  if (!cleaned) return 'New Conversation';
  const words = cleaned.split(' ').slice(0, 6).join(' ');
  return words.slice(0, METADATA_MAX_TITLE_LENGTH);
};

const getConversationFallbackDescription = (content: string): string => {
  const cleaned = content.replace(/\s+/g, ' ').trim();
  if (!cleaned) return 'General discussion.';
  return cleaned.slice(0, METADATA_MAX_DESCRIPTION_LENGTH);
};

const extractMetadataFromModelOutput = (raw: string): { title: string; description: string } => {
  const noThinking = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const firstBrace = noThinking.indexOf('{');
  const lastBrace = noThinking.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace <= firstBrace) {
    throw new Error('No JSON object found');
  }

  const parsed = JSON.parse(noThinking.slice(firstBrace, lastBrace + 1)) as {
    title?: unknown;
    description?: unknown;
  };

  if (typeof parsed.title !== 'string' || typeof parsed.description !== 'string') {
    throw new Error('Invalid metadata shape');
  }

  const title = parsed.title.replace(/\s+/g, ' ').trim().slice(0, METADATA_MAX_TITLE_LENGTH);
  const description = parsed.description
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, METADATA_MAX_DESCRIPTION_LENGTH);

  if (!title || !description) {
    throw new Error('Empty metadata values');
  }

  return { title, description };
};

const MESSAGE_IMAGES_STORAGE_KEY = 'macro_chat_message_images';

type AISelectionModeKey = 'ChatDebug' | 'Architect' | 'Implement';

interface PersistedAISelection {
  providerId: string | null;
  modelId: string | null;
  updatedAt: string;
}

interface PersistedAIContextSelections {
  version: 1;
  modeSelections: Partial<Record<AISelectionModeKey, PersistedAISelection>>;
  conversationSelections: Record<string, PersistedAISelection>;
}

const EMPTY_AI_CONTEXT_SELECTIONS: PersistedAIContextSelections = {
  version: 1,
  modeSelections: {},
  conversationSelections: {},
};

const getSelectionModeKey = (mode: AppMode): AISelectionModeKey => {
  if (mode === 'Chat' || mode === 'Debug') {
    return 'ChatDebug';
  }
  if (mode === 'Architect') {
    return 'Architect';
  }
  return 'Implement';
};

const normalizePersistedSelection = (value: unknown): PersistedAISelection | null => {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as {
    providerId?: unknown;
    modelId?: unknown;
    updatedAt?: unknown;
  };

  const providerId =
    candidate.providerId === null || typeof candidate.providerId === 'string'
      ? candidate.providerId
      : null;
  const modelId =
    candidate.modelId === null || typeof candidate.modelId === 'string'
      ? candidate.modelId
      : null;

  if (!providerId || !modelId) {
    return null;
  }

  return {
    providerId,
    modelId,
    updatedAt:
      typeof candidate.updatedAt === 'string' && candidate.updatedAt.trim().length > 0
        ? candidate.updatedAt
        : new Date().toISOString(),
  };
};

const normalizeAIContextSelections = (value: unknown): PersistedAIContextSelections => {
  if (!value || typeof value !== 'object') {
    return { ...EMPTY_AI_CONTEXT_SELECTIONS };
  }

  const raw = value as {
    version?: unknown;
    modeSelections?: unknown;
    conversationSelections?: unknown;
  };

  const modeSelections: Partial<Record<AISelectionModeKey, PersistedAISelection>> = {};
  if (raw.modeSelections && typeof raw.modeSelections === 'object') {
    const modeMap = raw.modeSelections as Record<string, unknown>;
    for (const key of ['ChatDebug', 'Architect', 'Implement'] as AISelectionModeKey[]) {
      const normalized = normalizePersistedSelection(modeMap[key]);
      if (normalized) {
        modeSelections[key] = normalized;
      }
    }
  }

  const conversationSelections: Record<string, PersistedAISelection> = {};
  if (raw.conversationSelections && typeof raw.conversationSelections === 'object') {
    for (const [conversationId, selection] of Object.entries(
      raw.conversationSelections as Record<string, unknown>
    )) {
      const normalized = normalizePersistedSelection(selection);
      if (normalized) {
        conversationSelections[conversationId] = normalized;
      }
    }
  }

  return {
    version: raw.version === 1 ? 1 : 1,
    modeSelections,
    conversationSelections,
  };
};

export interface MessageImageAttachment {
  id: string;
  mimeType: string;
  dataUrl: string;
  width?: number;
  height?: number;
  createdAt: string;
}

const loadMessageImagesFromStorage = (): Record<string, MessageImageAttachment[]> => {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(MESSAGE_IMAGES_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, MessageImageAttachment[]>;
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed;
  } catch {
    return {};
  }
};

const saveMessageImagesToStorage = (imagesByMessageId: Record<string, MessageImageAttachment[]>) => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(MESSAGE_IMAGES_STORAGE_KEY, JSON.stringify(imagesByMessageId));
  } catch {
    // Ignore storage errors
  }
};

interface ChatStore {
  messages: ChatMessage[];
  conversations: Conversation[];
  selectedConversationId: string | null;
  selectedConversationIdsByMode: Partial<Record<AppMode, string | null>>;
  isLoading: boolean;
  isStreaming: boolean;
  lastError: string | null;
  abortController: AbortController | null;
  messageImagesByMessageId: Record<string, MessageImageAttachment[]>;
  addMessage: (message: ChatMessage) => void;
  updateMessageContent: (messageId: string, content: string) => void;
  updateMessageFields: (
    messageId: string,
    patch: Partial<Pick<ChatMessage, 'tool_traces' | 'hidden_context'>>
  ) => void;
  updateLastMessage: (content: string) => void;
  appendToLastMessage: (token: string) => void;
  appendToMessage: (messageId: string, tokenChunk: string) => void;
  clearMessages: () => void;
  selectConversation: (conversationId: string) => void;
  createConversation: (
    title: string,
    taskId: string | null,
    projectId: string | null,
    groupId?: string | null
  ) => Promise<Conversation>;
  ensureArchitectConversationForPlan: (params: {
    plan: ArchitectPlanRecord;
    targetBranch: string;
    fallbackProjectId?: string;
    fallbackGroupId?: string;
    sharedConversation?: boolean;
  }) => Promise<{
    conversationId: string | null;
    restoredTranscript: boolean;
    createdConversation: boolean;
  }>;
  ensureConversationForCurrentMode: () => Promise<string | null>;
  renameConversation: (conversationId: string, title: string) => Promise<void>;
  deleteConversation: (
    conversationId: string,
    confirmation?: {
      mode: 'chat' | 'implement' | 'architect';
      typedProjectName?: string;
    }
  ) => Promise<void>;
  markAsRead: (conversationId: string) => void;
  getConversationByTask: (taskId: string) => Conversation | undefined;
  getConversationMessages: (conversationId: string) => ChatMessage[];
  sendMessage: (payload: {
    conversationId: string;
    content: string;
    taskId?: string | null;
    images?: MessageImageAttachment[];
  }) => Promise<void>;
  stopStreaming: () => void;
  editMessage: (messageId: string, newContent: string) => Promise<void>;
  setMessageImages: (messageId: string, images: MessageImageAttachment[]) => void;
  getMessageImages: (messageId: string) => MessageImageAttachment[];
  composerContextRefs: ContextReference[];
  addComposerContextRef: (ref: ContextReference) => void;
  removeComposerContextRef: (id: string, kind: ContextRefKind) => void;
  clearComposerContextRefs: () => void;
  reconcileProjectRegistry: (validGroupIds: string[], validProjectIds: string[]) => void;
  initialize: () => Promise<void>;
}

export const useChatStore = create<ChatStore>((set, get) => {
  let aiSelections = { ...EMPTY_AI_CONTEXT_SELECTIONS };
  let aiSelectionsLoaded = false;
  let providerSelectionUnsubscribe: (() => void) | null = null;
  let modeSelectionUnsubscribe: (() => void) | null = null;

  const persistAiSelections = () => {
    if (!aiSelectionsLoaded) return;
    void savePreference(PREF_KEYS.AI_CONTEXT_SELECTIONS, aiSelections);
  };

  const getCurrentSelection = (): PersistedAISelection | null => {
    const providerState = useProviderStore.getState();
    if (!providerState.selectedProviderId || !providerState.selectedModelId) {
      return null;
    }

    return {
      providerId: providerState.selectedProviderId,
      modelId: providerState.selectedModelId,
      updatedAt: new Date().toISOString(),
    };
  };

  const providerHasAuthSession = (provider: { providerType: string; authStatus?: string }): boolean => {
    return provider.providerType === 'chatgpt'
      && ['authenticated', 'refreshing', 'expired'].includes(provider.authStatus ?? '');
  };

  const hasProviderCredentials = (providerId: string): boolean => {
    const provider = useProviderStore.getState().providerConfigs.find((candidate) => candidate.id === providerId);
    if (!provider || !provider.isEnabled) return false;
    return provider.isLocal || !!provider.apiKey?.trim() || providerHasAuthSession(provider);
  };

  const isSelectionUsable = (selection: PersistedAISelection | null): boolean => {
    if (!selection?.providerId || !selection.modelId) return false;
    if (!hasProviderCredentials(selection.providerId)) return false;

    const providerState = useProviderStore.getState();
    const models = providerState.modelsByProvider[selection.providerId] || [];
    return models.some((model) => model.id === selection.modelId && model.isEnabled !== false);
  };

  const persistSelectionForContext = (mode: AppMode, conversationId: string | null) => {
    const selection = getCurrentSelection();
    if (!selection) return;

    const modeKey = getSelectionModeKey(mode);
    aiSelections = {
      ...aiSelections,
      modeSelections: {
        ...aiSelections.modeSelections,
        [modeKey]: selection,
      },
      conversationSelections: conversationId
        ? {
          ...aiSelections.conversationSelections,
          [conversationId]: selection,
        }
        : aiSelections.conversationSelections,
    };
    persistAiSelections();
  };

  const removeConversationSelection = (conversationId: string) => {
    if (!aiSelections.conversationSelections[conversationId]) return;
    const nextConversationSelections = { ...aiSelections.conversationSelections };
    delete nextConversationSelections[conversationId];
    aiSelections = {
      ...aiSelections,
      conversationSelections: nextConversationSelections,
    };
    persistAiSelections();
  };

  const applySelection = async (selection: PersistedAISelection | null): Promise<boolean> => {
    if (!selection?.providerId || !selection.modelId) {
      return false;
    }

    const providerStore = useProviderStore.getState();
    const provider = providerStore.providerConfigs.find((candidate) => candidate.id === selection.providerId);
    if (!provider || !provider.isEnabled) {
      return false;
    }
    if (!provider.isLocal && !provider.apiKey?.trim() && !providerHasAuthSession(provider)) {
      return false;
    }

    useProviderStore.setState({
      selectedProviderId: selection.providerId,
      selectedModelId: selection.modelId,
    });

    let loadedModels = await providerStore.loadProviderModels(selection.providerId);
    let modelExists = loadedModels.some(
      (model) => model.id === selection.modelId && model.isEnabled !== false
    );

    if (!modelExists) {
      loadedModels = await providerStore.scanModelsForProvider(selection.providerId);
      modelExists = loadedModels.some(
        (model) => model.id === selection.modelId && model.isEnabled !== false
      );
    }

    if (!modelExists) {
      return false;
    }

    useProviderStore.getState().selectModel(selection.modelId);
    return true;
  };

  const applyFallbackSelection = async (): Promise<boolean> => {
    const providerStore = useProviderStore.getState();
    const candidateProviders = providerStore.providerConfigs.filter(
      (provider) => provider.isEnabled && (provider.isLocal || !!provider.apiKey?.trim() || providerHasAuthSession(provider))
    );

    for (const provider of candidateProviders) {
      providerStore.selectProvider(provider.id);
      const models = await providerStore.loadProviderModels(provider.id);
      const firstEnabledModel = models.find((model) => model.isEnabled !== false);
      if (firstEnabledModel) {
        useProviderStore.getState().selectModel(firstEnabledModel.id);
        return true;
      }
    }

    return false;
  };

  const applySelectionForContext = async (mode: AppMode, conversationId: string | null) => {
    const modeKey = getSelectionModeKey(mode);
    const conversationSelection = conversationId
      ? aiSelections.conversationSelections[conversationId] || null
      : null;

    if (conversationSelection) {
      const appliedConversation = await applySelection(conversationSelection);
      if (appliedConversation) {
        return;
      }

      removeConversationSelection(conversationId!);
    }

    const modeSelection = aiSelections.modeSelections[modeKey] || null;
    if (modeSelection) {
      const appliedMode = await applySelection(modeSelection);
      if (appliedMode) {
        return;
      }

      const nextModeSelections = { ...aiSelections.modeSelections };
      delete nextModeSelections[modeKey];
      aiSelections = {
        ...aiSelections,
        modeSelections: nextModeSelections,
      };
      persistAiSelections();
    }

    const currentSelection = getCurrentSelection();
    if (!isSelectionUsable(currentSelection)) {
      await applyFallbackSelection();
    }
  };

  const ensureProviderSelectionSync = () => {
    if (providerSelectionUnsubscribe) return;

    providerSelectionUnsubscribe = useProviderStore.subscribe((nextState, previousState) => {
      if (!aiSelectionsLoaded) return;

      const providerChanged = nextState.selectedProviderId !== previousState.selectedProviderId;
      const modelChanged = nextState.selectedModelId !== previousState.selectedModelId;
      if (!providerChanged && !modelChanged) {
        return;
      }

      const appState = useAppStore.getState();
      const selectedConversationId = get().selectedConversationId;
      persistSelectionForContext(appState.mode, selectedConversationId);
    });
  };

  const ensureModeSelectionSync = () => {
    if (modeSelectionUnsubscribe) return;

    modeSelectionUnsubscribe = useAppStore.subscribe((nextState, previousState) => {
      if (nextState.mode === previousState.mode) return;
      void get().ensureConversationForCurrentMode();
    });
  };

  const sanitizeAssistantContentForModel = (content: string): string => {
    return content
      .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
      .split('\n')
      .filter((line) => {
        const trimmed = line.trim();
        if (/^\[\s*TOOL\s*\]/i.test(trimmed)) return false;
        if (/^\[\s*TOOL_DONE\s*\]/i.test(trimmed)) return false;
        if (/^🔍\s*\*\*(Recherche web|Web search):\*\*/i.test(trimmed)) return false;
        return true;
      })
      .join('\n')
      .trim();
  };

  const ensureToolsLoaded = async (): Promise<void> => {
    const toolsState = useToolsStore.getState();
    if (Object.keys(toolsState.internalTools).length > 0) return;
    await toolsState.loadSettings();
  };

  const getModePolicyForCurrentMode = async (): Promise<{ allowedToolIds: string[]; enforceMacroOnlyWrites: boolean }> => {
    const mode = useAppStore.getState().mode;

    if (tauriIpc.isTauriAvailable()) {
      try {
        const backendPolicy = await tauriIpc.getToolModePolicy(mode);
        return {
          allowedToolIds: backendPolicy.allowed_tool_ids,
          enforceMacroOnlyWrites: backendPolicy.enforce_macro_only_writes,
        };
      } catch (error) {
        console.warn('Failed to load backend tool policy, using local fallback:', error);
      }
    }

    if (canUseRemoteKernel()) {
      try {
        const backendPolicy = await getRemoteToolModePolicy(mode);
        return {
          allowedToolIds: backendPolicy.allowed_tool_ids,
          enforceMacroOnlyWrites: backendPolicy.enforce_macro_only_writes,
        };
      } catch (error) {
        console.warn('Failed to load remote backend tool policy, using local fallback:', error);
      }
    }

    const fallback = getLocalToolModePolicy(mode);
    return {
      allowedToolIds: fallback.allowedToolIds,
      enforceMacroOnlyWrites: fallback.enforceMacroOnlyWrites,
    };
  };

  const isSourceToolEnabled = async (toolId: string): Promise<boolean> => {
    const mode = useAppStore.getState().mode;
    const modePolicy = await getModePolicyForCurrentMode();
    if (!modePolicy.allowedToolIds.includes(toolId)) {
      return false;
    }

    const toolsState = useToolsStore.getState();
    if (mode === 'Chat') {
      return toolsState.isChatToolEnabled(toolId);
    }

    return toolsState.isToolEnabled(toolId);
  };

  const handleToolCall = async (
    conversationId: string,
    assistantMessageId: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<string | void> => {
    const normalizedToolName = normalizeArchitectToolId(toolName);

    if (!(await isSourceToolEnabled(normalizedToolName))) {
      return `Tool ${normalizedToolName} is disabled for the current mode.`;
    }

    const resolveActivePlanId = (): string | null => {
      const appState = useAppStore.getState();
      return appState.activeArchitectPlanId;
    };

    const resolveArchitectTargetBranch = (rawTargetBranch: unknown): string => {
      if (typeof rawTargetBranch === 'string' && rawTargetBranch.trim().length > 0) {
        return resolveTargetBranch(rawTargetBranch);
      }

      const appState = useAppStore.getState();
      const activeTargetBranch = appState.activePlanContext?.targetBranch;
      if (activeTargetBranch && activeTargetBranch.trim().length > 0) {
        try {
          return resolveTargetBranch(activeTargetBranch);
        } catch {
          // Fall through to default base branch.
        }
      }

      return getGitFlowBaseBranch();
    };

    const hydratePlanContext = async (targetBranch: string, planId: string): Promise<void> => {
      const plan = await getArchitectPlan(targetBranch, planId);
      if (!plan || plan.status === 'deleted') return;

      const appStore = useAppStore.getState();
      const planProjectId = resolvePlanProjectContextId(plan, appStore.selectedProjectId);
      const scopedProjectIds = getScopedProjectIds(
        appStore.projectGroups,
        appStore.selectedGroupId,
        appStore.selectedProjectId
      );
      const isPlanAlreadyInScope =
        scopedProjectIds.length > 0 &&
        (getArchitectPlanProjectIds(plan).length === 0 ||
          getArchitectPlanProjectIds(plan).some((projectId) => scopedProjectIds.includes(projectId)));
      if (planProjectId && !isPlanAlreadyInScope) {
        await appStore.switchProjectContext(planProjectId);
      }
      appStore.setActiveArchitectPlanId(plan.id);
      appStore.setPlanNodes(plan.nodes || []);
      appStore.setPredictedBranches(plan.predictedBranches || []);
      appStore.setActivePlanContext({
        id: plan.id,
        slug: plan.slug,
        title: plan.title,
        label: plan.label,
        description: plan.description,
        status: plan.status,
        targetBranch: plan.targetBranch,
      });

      const planNeeds = await getArchitectPlanNeeds(targetBranch, plan.id);
      useNeedsStore.getState().replaceNeedsForPlan(plan.id, planNeeds);

      const plansIndex = await listArchitectPlans(targetBranch, true, true);
      const conversationId = plan.conversationId;
      const hasSharedConversation = Boolean(
        conversationId &&
        plansIndex.plans.some(
          (candidate) => candidate.id !== plan.id && candidate.conversationId === conversationId
        )
      );

      const fallbackGroupId = appStore.selectedGroupId;
      const fallbackGroupProjectId = getFocusedProjectForGroup(
        appStore.projectGroups,
        fallbackGroupId,
        appStore.selectedProjectId
      )?.id ?? null;
      const fallbackProjectId =
        resolvePlanProjectContextId(plan, appStore.selectedProjectId) ||
        fallbackGroupProjectId ||
        appStore.selectedProjectId ||
        appStore.projectGroups.flatMap((group) => group.projects)[0]?.id ||
        null;
      await get().ensureArchitectConversationForPlan({
        plan,
        targetBranch,
        fallbackProjectId: fallbackProjectId ?? undefined,
        fallbackGroupId: fallbackGroupId ?? undefined,
        sharedConversation: hasSharedConversation,
      });
    };

    const allowedNodeTypes = new Set<PlanNodeType>(['spec', 'feature', 'task', 'milestone']);
    const allowedNodeStatuses = new Set<PlanNodeStatus>(['pending', 'in-progress', 'completed', 'blocked']);

    const normalizeNodeInput = (
      rawNode: unknown,
      index: number
    ): {
      id?: string;
      title: string;
      description: string;
      type: PlanNodeType;
      assignedBranch: string;
      status: PlanNodeStatus;
      dependencies: string[];
      projectIds: string[];
    } => {
      const node = (rawNode && typeof rawNode === 'object' ? rawNode : {}) as Record<string, unknown>;
      const title = typeof node.title === 'string' ? node.title.trim() : '';
      const description = typeof node.description === 'string' ? node.description.trim() : '';
      const rawType = typeof node.type === 'string' ? node.type.trim().toLowerCase() : 'task';
      const rawStatus = typeof node.status === 'string' ? node.status.trim().toLowerCase() : 'pending';
      const assignedBranchRaw = typeof node.assignedBranch === 'string' ? node.assignedBranch.trim() : '';
      const dependencies = Array.isArray(node.dependencies)
        ? node.dependencies
            .filter((dep): dep is string => typeof dep === 'string')
            .map((dep) => dep.trim())
            .filter(Boolean)
        : [];
      const projectIds = Array.isArray(node.projectIds)
        ? node.projectIds
            .filter((projectId): projectId is string => typeof projectId === 'string')
            .map((projectId) => projectId.trim())
            .filter(Boolean)
        : typeof node.projectId === 'string' && node.projectId.trim().length > 0
          ? [node.projectId.trim()]
          : [];

      if (!title) {
        throw new Error(`Invalid strategy node at index ${index}: missing title.`);
      }
      if (!allowedNodeTypes.has(rawType as PlanNodeType)) {
        throw new Error(`Invalid node type for "${title}": ${rawType}.`);
      }
      if (!allowedNodeStatuses.has(rawStatus as PlanNodeStatus)) {
        throw new Error(`Invalid node status for "${title}": ${rawStatus}.`);
      }

      return {
        id: typeof node.id === 'string' ? node.id.trim() : undefined,
        title,
        description,
        type: rawType as PlanNodeType,
        assignedBranch: assignedBranchRaw || 'work',
        status: rawStatus as PlanNodeStatus,
        dependencies: Array.from(new Set(dependencies)),
        projectIds: Array.from(new Set(projectIds)),
      };
    };

    const buildPredictedBranches = (
      nodes: PlanNode[],
      parentBranchName: string
    ): PredictedBranch[] => {
      const branchMap = new Map<string, { projectId: string; taskIds: string[] }>();
      nodes.forEach((node) => {
        const branchName = node.assignedBranch || parentBranchName;
        const projectIds = Array.isArray(node.projectIds) && node.projectIds.length > 0
          ? node.projectIds
          : (node.projectId ? [node.projectId] : []);
        projectIds.forEach((projectId) => {
          const key = `${projectId}::${branchName}`;
          if (!branchMap.has(key)) {
            branchMap.set(key, { projectId, taskIds: [] });
          }
          branchMap.get(key)!.taskIds.push(node.id);
        });
      });

      const colors = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4'];
      return Array.from(branchMap.entries()).map(([key, value], index) => ({
        id: `branch-${Date.now()}-${index}`,
        name: key.split('::')[1] || parentBranchName,
        color: colors[index % colors.length],
        parentBranch: parentBranchName,
        projectId: value.projectId,
        taskIds: Array.from(new Set(value.taskIds)),
        status: 'pending' as const,
      }));
    };

    const resolveStrategyForPlan = async (params: {
      targetBranch: string;
      activePlanId: string;
      nodesInput: unknown[];
      reuseExistingIds?: boolean;
      existingNodesForPatch?: PlanNode[];
    }): Promise<{ planNodes: PlanNode[]; predictedBranches: PredictedBranch[]; resolvedProjectId: string | undefined; resolvedProjectIds: string[]; activePlanTitle: string; activePlanDescription: string }> => {
      const { targetBranch, activePlanId, nodesInput, reuseExistingIds = false, existingNodesForPatch = [] } = params;

      if (nodesInput.length === 0) {
        throw new Error('No nodes provided for strategy update.');
      }
      if (nodesInput.length > 250) {
        throw new Error('Strategy too large. Maximum 250 nodes.');
      }

      const appState = useAppStore.getState();
      const selectedProjectIds = getScopedProjectIds(
        appState.projectGroups,
        appState.selectedGroupId,
        appState.selectedProjectId
      );
      const fallbackProjectIds = appState.projectGroups.flatMap((group) => group.projects).map((project) => project.id);
      const defaultProjectIds = Array.from(new Set([
        ...selectedProjectIds,
        ...(appState.selectedProjectId ? [appState.selectedProjectId] : []),
        ...fallbackProjectIds,
      ])).filter(Boolean);

      const activePlan = await getArchitectPlan(targetBranch, activePlanId);
      if (!activePlan || activePlan.status === 'deleted') {
        throw new Error(`Active plan ${activePlanId} is unavailable. Select another plan.`);
      }

      const scopedBranchBySource = new Map<string, string>();
      const planSlug = activePlan.slug;
      const scopeBranchName = (sourceBranch: string): string => {
        const trimmed = sourceBranch.trim();
        const alreadyScopedPrefix = `feature/${planSlug}/`;
        if (trimmed.startsWith(alreadyScopedPrefix)) {
          scopedBranchBySource.set(sourceBranch, trimmed);
          return trimmed;
        }
        if (scopedBranchBySource.has(sourceBranch)) {
          return scopedBranchBySource.get(sourceBranch)!;
        }
        const baseName = toPlanScopedFeatureBranch(planSlug, sourceBranch || 'work');
        scopedBranchBySource.set(sourceBranch, baseName);
        return baseName;
      };

      const idBase = `plan-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const existingIdByTitle = new Map(existingNodesForPatch.map((node) => [node.title, node.id]));

      const normalizedNodes = nodesInput.map((rawNode, index) => normalizeNodeInput(rawNode, index));
      const titleSet = new Set<string>();
      normalizedNodes.forEach((node) => {
        if (titleSet.has(node.title)) {
          throw new Error(`Duplicate strategy node title detected: "${node.title}".`);
        }
        titleSet.add(node.title);
      });

      const planNodes: PlanNode[] = normalizedNodes.map((node, index) => {
        const existingId = reuseExistingIds ? existingIdByTitle.get(node.title) : undefined;
        const preferredId = node.id || existingId;
        const resolvedProjectIds = node.projectIds.length > 0 ? node.projectIds : defaultProjectIds;
        return {
          id: preferredId && preferredId.length > 0 ? preferredId : `${idBase}-${index}`,
          title: node.title,
          description: node.description,
          type: node.type,
          assignedBranch: scopeBranchName(node.assignedBranch),
          status: node.status,
          projectId: resolvedProjectIds[0] || undefined,
          projectIds: resolvedProjectIds,
          dependencies: [...node.dependencies],
        };
      });

      const nodeById = new Map(planNodes.map((node) => [node.id, node]));
      const nodeByTitle = new Map(planNodes.map((node) => [node.title, node]));

      planNodes.forEach((node) => {
        node.dependencies = node.dependencies.map((dependencyRef) => {
          const byId = nodeById.get(dependencyRef);
          if (byId) return byId.id;
          const byTitle = nodeByTitle.get(dependencyRef);
          if (byTitle) return byTitle.id;
          throw new Error(`Unknown dependency "${dependencyRef}" for node "${node.title}".`);
        });
      });

      const visiting = new Set<string>();
      const visited = new Set<string>();
      const hasCycle = (id: string): boolean => {
        if (visiting.has(id)) return true;
        if (visited.has(id)) return false;

        visiting.add(id);
        const node = nodeById.get(id);
        if (node) {
          for (const dependencyId of node.dependencies) {
            if (!nodeById.has(dependencyId)) {
              throw new Error(`Dependency id "${dependencyId}" is missing from strategy nodes.`);
            }
            if (dependencyId === id || hasCycle(dependencyId)) {
              return true;
            }
          }
        }
        visiting.delete(id);
        visited.add(id);
        return false;
      };

      for (const node of planNodes) {
        if (hasCycle(node.id)) {
          throw new Error(`Cycle detected in strategy dependencies near node "${node.title}".`);
        }
      }

      const predictedBranches = buildPredictedBranches(
        planNodes,
        toPlanIntegrationBranch(planSlug)
      );

      const normalizedStrategy = normalizeStrategyDependencies(planNodes, predictedBranches);
      const resolvedProjectIds = Array.from(new Set(normalizedStrategy.nodes.flatMap((node) => node.projectIds || (node.projectId ? [node.projectId] : []))));
      return {
        planNodes: normalizedStrategy.nodes,
        predictedBranches: normalizedStrategy.predictedBranches,
        resolvedProjectId: resolvedProjectIds[0] || undefined,
        resolvedProjectIds,
        activePlanTitle: activePlan.title,
        activePlanDescription: activePlan.description,
      };
    };
    if (normalizedToolName === 'need_add') {
      const targetBranch = resolveArchitectTargetBranch(args.target_branch);
      const activePlanId = resolveActivePlanId();
      if (!activePlanId) {
        return 'Cannot need_add without an active plan. Create or select a plan first.';
      }

      const title = typeof args.title === 'string' ? args.title.trim() : '';
      const description = typeof args.description === 'string' ? args.description.trim() : '';
      const category = typeof args.category === 'string' ? args.category.trim().toLowerCase() : '';
      const priority = typeof args.priority === 'string' ? args.priority.trim().toLowerCase() : '';
      if (!title || !description || !category || !priority) {
        return 'Missing required fields for need_add (title, description, category, priority).';
      }

      const allowedCategories = new Set([
        'functional',
        'technical',
        'ux',
        'performance',
        'security',
        'data',
        'business',
        'other',
      ]);
      const allowedPriorities = new Set(['low', 'medium', 'high']);
      if (!allowedCategories.has(category)) {
        return `Invalid category for need_add: ${category}.`;
      }
      if (!allowedPriorities.has(priority)) {
        return `Invalid priority for need_add: ${priority}.`;
      }

      const tags = Array.isArray(args.tags)
        ? Array.from(
          new Set(
            args.tags
              .filter((tag): tag is string => typeof tag === 'string')
              .map((tag) => tag.trim().toLowerCase())
              .filter((tag) => tag.length > 0)
          )
        ).slice(0, 12)
        : [];

      const id = useNeedsStore.getState().addNeed({
        planId: activePlanId,
        title,
        description,
        category: category as any,
        priority: priority as any,
        tags,
        status: 'identified',
        sourceMessageId: assistantMessageId,
      });

      const planNeeds = useNeedsStore.getState().getNeedsForPlan(activePlanId);
      await saveArchitectPlanNeeds(targetBranch, activePlanId, planNeeds);

      return `Successfully added need: "${title}" (ID: ${id}).`;
    }

    if (normalizedToolName === 'plan_create') {
      return 'plan_create is disabled in Architect chat. Ask the user to create a plan from the plan selector, then continue on the active plan.';
    }

    if (normalizedToolName === 'plan_list') {
      const targetBranch = resolveArchitectTargetBranch(args.target_branch);
      const includeDeleted = args.include_deleted === true;
      const includeArchived = args.include_archived === true || includeDeleted;
      const plansIndex = await listArchitectPlans(targetBranch, includeDeleted, includeArchived);

      return JSON.stringify(
        {
          target_branch: targetBranch,
          active_plan_id: plansIndex.activePlanId,
          plans: plansIndex.plans.map((plan) => ({
            id: plan.id,
            slug: plan.slug,
            title: plan.title,
            label: plan.label ?? null,
            display_name: getArchitectPlanDisplayName(plan),
            status: plan.status,
            description: plan.description,
            target_branch: plan.targetBranch,
            node_count: plan.nodeCount,
            conversation_id: plan.conversationId ?? null,
          })),
        },
        null,
        2
      );
    }

    if (normalizedToolName === 'plan_get') {
      const planId = typeof args.plan_id === 'string' ? args.plan_id.trim() : '';
      if (!planId) {
        return 'Missing plan_id for plan_get.';
      }
      const targetBranch = resolveArchitectTargetBranch(args.target_branch);
      const plan = await getArchitectPlan(targetBranch, planId);
      if (!plan || plan.status === 'deleted') {
        return `Plan ${planId} is unavailable.`;
      }

      return JSON.stringify(
        {
          id: plan.id,
          slug: plan.slug,
          title: plan.title,
          label: plan.label ?? null,
          display_name: getArchitectPlanDisplayName(plan),
          is_canonical: isCanonicalArchitectPlan(plan),
          description: plan.description,
          status: plan.status,
          target_branch: plan.targetBranch,
          conversation_id: plan.conversationId ?? null,
          project_ids: getArchitectPlanProjectIds(plan),
          nodes: plan.nodes,
          predicted_branches: plan.predictedBranches,
        },
        null,
        2
      );
    }

    if (normalizedToolName === 'plan_update') {
      const planId = typeof args.plan_id === 'string' ? args.plan_id.trim() : '';
      if (!planId) {
        return 'Missing plan_id for plan_update.';
      }
      const targetBranch = resolveArchitectTargetBranch(args.target_branch);
      const existingPlan = await getArchitectPlan(targetBranch, planId);
      if (!existingPlan || existingPlan.status === 'deleted') {
        return `Plan ${planId} is unavailable.`;
      }
      if (args.status !== undefined) {
        return 'plan_update cannot modify plan status in Architect chat.';
      }
      if (args.set_active !== undefined) {
        return 'plan_update cannot change the active plan in Architect chat. Ask the user to select the plan from the plan selector instead.';
      }

      const isCanonicalPlan = isCanonicalArchitectPlan(existingPlan);
      const titleAlias = typeof args.title === 'string' ? args.title.trim() : undefined;
      const label = typeof args.label === 'string' ? args.label.trim() : undefined;
      const shouldPassTitleAlias =
        titleAlias !== undefined &&
        (!isCanonicalPlan || titleAlias !== existingPlan.title || label !== undefined);

      const updatedPlan = await updateArchitectPlan({
        branchName: targetBranch,
        planId,
        ...(shouldPassTitleAlias ? { title: titleAlias } : {}),
        ...(label !== undefined ? { label } : {}),
        ...(typeof args.description === 'string' ? { description: args.description } : {}),
      });

      if (resolveActivePlanId() === updatedPlan.id) {
        await hydratePlanContext(targetBranch, updatedPlan.id);
      }

      return JSON.stringify(
        {
          id: updatedPlan.id,
          slug: updatedPlan.slug,
          title: updatedPlan.title,
          label: updatedPlan.label ?? null,
          display_name: getArchitectPlanDisplayName(updatedPlan),
          status: updatedPlan.status,
          target_branch: updatedPlan.targetBranch,
          active: resolveActivePlanId() === updatedPlan.id,
        },
        null,
        2
      );
    }

    if (normalizedToolName === 'plan_delete') {
      return 'plan_delete is disabled in Architect chat. Ask the user to delete or archive the plan from the plan selector if needed.';
    }

    if (normalizedToolName === 'plan_restore') {
      return 'plan_restore is disabled in Architect chat. Ask the user to restore the plan from the plan selector if needed.';
    }

    if (normalizedToolName === 'plan_set_active') {
      return 'plan_set_active is disabled in Architect chat. Ask the user to select the plan from the plan selector.';
    }

    if (normalizedToolName === 'strategy_generate') {
      const targetBranch = resolveArchitectTargetBranch(args.target_branch);
      const activePlanId = resolveActivePlanId();
      if (!activePlanId) {
        return 'Cannot generate strategy without an active plan. Create or select a plan first.';
      }

      const rawNodes = Array.isArray(args.nodes) ? args.nodes : [];
      const inputPlanId = typeof args.plan_id === 'string' ? args.plan_id.trim() : '';
      if (inputPlanId && inputPlanId !== activePlanId) {
        return `strategy_generate can only update the active plan (${activePlanId}).`;
      }

      const strategy = await resolveStrategyForPlan({
        targetBranch,
        activePlanId,
        nodesInput: rawNodes,
      });

      const activePlan = await getArchitectPlan(targetBranch, activePlanId);
      const requestedPlanTitleAlias =
        typeof args.plan_title === 'string' ? args.plan_title.trim() : undefined;
      const inputDescription = typeof args.plan_description === 'string'
        ? args.plan_description
        : activePlan?.description || '';

      await updateArchitectPlan({
        branchName: targetBranch,
        planId: activePlanId,
        ...(activePlan && requestedPlanTitleAlias !== undefined
          ? isCanonicalArchitectPlan(activePlan)
            ? { label: requestedPlanTitleAlias }
            : { title: requestedPlanTitleAlias }
          : {}),
        description: inputDescription,
        status: 'draft',
        nodes: strategy.planNodes,
        predictedBranches: strategy.predictedBranches,
        projectId: strategy.resolvedProjectId,
        setActive: true,
      });

      await hydratePlanContext(targetBranch, activePlanId);

      return `Successfully generated strategy with ${strategy.planNodes.length} nodes across ${strategy.predictedBranches.length} branches for active plan ${activePlanId}.`;
    }

    if (normalizedToolName === 'strategy_get') {
      const targetBranch = resolveArchitectTargetBranch(args.target_branch);
      const activePlanId = resolveActivePlanId();
      if (!activePlanId) {
        return 'Cannot get strategy without an active plan. Create or select a plan first.';
      }
      const plan = await getArchitectPlan(targetBranch, activePlanId);
      if (!plan || plan.status === 'deleted') {
        return `Active plan ${activePlanId} is unavailable.`;
      }

      const branchCount = plan.predictedBranches.length;
      const nodeCount = plan.nodes.length;
      const rootCount = plan.nodes.filter((node) => node.dependencies.length === 0).length;
      const maxDependencyDepth = plan.nodes.reduce((max, node) => Math.max(max, node.dependencies.length), 0);

      return JSON.stringify(
        {
          macro_branch: '@macro',
          plan_id: plan.id,
          strategy: {
            node_count: nodeCount,
            branch_count: branchCount,
            root_count: rootCount,
            max_dependencies_per_node: maxDependencyDepth,
            nodes: plan.nodes,
            predicted_branches: plan.predictedBranches,
          },
        },
        null,
        2
      );
    }

    if (normalizedToolName === 'strategy_update') {
      const targetBranch = resolveArchitectTargetBranch(args.target_branch);
      const activePlanId = resolveActivePlanId();
      if (!activePlanId) {
        return 'Cannot update strategy without an active plan. Create or select a plan first.';
      }

      const activePlan = await getArchitectPlan(targetBranch, activePlanId);
      if (!activePlan || activePlan.status === 'deleted') {
        return `Active plan ${activePlanId} is unavailable.`;
      }

      const replace = args.replace === true;
      const rawNodes = Array.isArray(args.nodes) ? args.nodes : [];
      const rawOperations = Array.isArray(args.operations) ? args.operations : [];

      let nodesInput: unknown[] = [];
      if (replace || rawNodes.length > 0) {
        if (rawNodes.length === 0) {
          return 'strategy_update with replace=true requires non-empty nodes.';
        }
        nodesInput = rawNodes;
      } else {
        if (rawOperations.length === 0) {
          return 'strategy_update requires either nodes or operations.';
        }

        const working = [...activePlan.nodes];
        let idCounter = 0;
        for (const [index, rawOperation] of rawOperations.entries()) {
          const operation = (rawOperation && typeof rawOperation === 'object' ? rawOperation : {}) as Record<string, unknown>;
          const action = typeof operation.action === 'string' ? operation.action.trim().toLowerCase() : '';
          const nodeId = typeof operation.node_id === 'string' ? operation.node_id.trim() : '';
          const titleRef = typeof operation.title === 'string' ? operation.title.trim() : '';
          const locateIndex = nodeId
            ? working.findIndex((node) => node.id === nodeId)
            : titleRef
              ? working.findIndex((node) => node.title === titleRef)
              : -1;

          if (action === 'remove') {
            if (locateIndex < 0) {
              return `strategy_update remove failed at operation ${index + 1}: node not found.`;
            }
            const removedNode = working[locateIndex];
            working.splice(locateIndex, 1);
            working.forEach((node) => {
              node.dependencies = node.dependencies.filter((dependencyId) => dependencyId !== removedNode.id);
            });
            continue;
          }

          if (action === 'update') {
            if (locateIndex < 0) {
              return `strategy_update update failed at operation ${index + 1}: node not found.`;
            }
            const target = working[locateIndex];
            const nextTitle = typeof operation.title === 'string' ? operation.title.trim() : target.title;
            const nextDescription = typeof operation.description === 'string' ? operation.description : target.description || '';
            const nextTypeRaw = typeof operation.type === 'string' ? operation.type.trim().toLowerCase() : target.type;
            const nextStatusRaw = typeof operation.status === 'string' ? operation.status.trim().toLowerCase() : target.status;
            const nextBranchRaw = typeof operation.assignedBranch === 'string' ? operation.assignedBranch.trim() : target.assignedBranch || 'work';
            const nextDependencies = Array.isArray(operation.dependencies)
              ? operation.dependencies.filter((dep): dep is string => typeof dep === 'string').map((dep) => dep.trim()).filter(Boolean)
              : target.dependencies;

            if (!allowedNodeTypes.has(nextTypeRaw as PlanNodeType)) {
              return `strategy_update update failed at operation ${index + 1}: invalid type ${nextTypeRaw}.`;
            }
            if (!allowedNodeStatuses.has(nextStatusRaw as PlanNodeStatus)) {
              return `strategy_update update failed at operation ${index + 1}: invalid status ${nextStatusRaw}.`;
            }

            working[locateIndex] = {
              ...target,
              title: nextTitle || target.title,
              description: nextDescription,
              type: nextTypeRaw as PlanNodeType,
              status: nextStatusRaw as PlanNodeStatus,
              assignedBranch: nextBranchRaw || 'work',
              dependencies: Array.from(new Set(nextDependencies)),
            };
            continue;
          }

          if (action === 'add') {
            const normalized = normalizeNodeInput(operation, index);
            idCounter += 1;
            working.push({
              id: `node-${Date.now()}-${idCounter}`,
              title: normalized.title,
              description: normalized.description,
              type: normalized.type,
              status: normalized.status,
              assignedBranch: normalized.assignedBranch,
              dependencies: normalized.dependencies,
              projectId: activePlan.projectId,
            });
            continue;
          }

          return `strategy_update failed at operation ${index + 1}: unsupported action "${action}".`;
        }

        nodesInput = working.map((node) => ({
          id: node.id,
          title: node.title,
          description: node.description,
          type: node.type,
          status: node.status,
          assignedBranch: node.assignedBranch,
          dependencies: node.dependencies,
        }));
      }

      const strategy = await resolveStrategyForPlan({
        targetBranch,
        activePlanId,
        nodesInput,
        reuseExistingIds: !replace,
        existingNodesForPatch: activePlan.nodes,
      });

      await updateArchitectPlan({
        branchName: targetBranch,
        planId: activePlanId,
        ...(isCanonicalArchitectPlan(activePlan)
          ? { label: activePlan.label }
          : { title: activePlan.title }),
        description: activePlan.description,
        status: activePlan.status,
        nodes: strategy.planNodes,
        predictedBranches: strategy.predictedBranches,
        projectId: strategy.resolvedProjectId,
        setActive: true,
      });

      await hydratePlanContext(targetBranch, activePlanId);
      return `Updated strategy for plan ${activePlanId}: ${strategy.planNodes.length} nodes, ${strategy.predictedBranches.length} branches.`;
    }

    if (normalizedToolName === 'strategy_delete') {
      const targetBranch = resolveArchitectTargetBranch(args.target_branch);
      const activePlanId = resolveActivePlanId();
      if (!activePlanId) {
        return 'Cannot delete strategy without an active plan. Create or select a plan first.';
      }

      if (args.confirm !== true) {
        return 'strategy_delete requires confirm=true to proceed.';
      }

      const activePlan = await getArchitectPlan(targetBranch, activePlanId);
      if (!activePlan || activePlan.status === 'deleted') {
        return `Active plan ${activePlanId} is unavailable.`;
      }

      await updateArchitectPlan({
        branchName: targetBranch,
        planId: activePlanId,
        ...(isCanonicalArchitectPlan(activePlan)
          ? { label: activePlan.label }
          : { title: activePlan.title }),
        description: activePlan.description,
        status: activePlan.status,
        nodes: [],
        predictedBranches: [],
        projectId: activePlan.projectId,
        setActive: true,
      });

      await hydratePlanContext(targetBranch, activePlanId);
      return `Deleted strategy for active plan ${activePlanId}.`;
    }

    if (
      normalizedToolName === 'list' ||
      normalizedToolName === 'read' ||
      normalizedToolName === 'write' ||
      normalizedToolName === 'edit' ||
      normalizedToolName === 'glob' ||
      normalizedToolName === 'grep' ||
      normalizedToolName === 'terminal_create_session' ||
      normalizedToolName === 'terminal_run' ||
      normalizedToolName === 'terminal_read' ||
      normalizedToolName === 'terminal_kill' ||
      normalizedToolName.startsWith('git_')
    ) {
      const mode = useAppStore.getState().mode;
      const appState = useAppStore.getState();
      const taskState = useTaskStore.getState();
      const executionContext = resolveProjectExecutionContext({
        mode,
        projects: appState.projectGroups.flatMap((group) => group.projects),
        projectGroups: appState.projectGroups,
        tasks: taskState.tasks,
        conversations: get().conversations,
        conversationId,
        selectedGroupId: appState.selectedGroupId,
        selectedProjectId: appState.selectedProjectId,
        selectedTaskId: appState.selectedTaskId,
        activeRepositoryPath: taskState.activeRepositoryPath,
        branchWorktrees: taskState.branchWorktrees,
      });

      if (normalizedToolName === 'terminal_create_session') {
        const projectId =
          (typeof args.project_id === 'string' && args.project_id.trim()) ||
          executionContext.focusedProjectId ||
          executionContext.projectId;

        if (!projectId) {
          return 'Missing project_id argument for terminal_create_session.';
        }

        const session = await useTerminalStore.getState().createSession({
          projectId,
          cwd: typeof args.cwd === 'string' ? args.cwd : null,
        });
        return JSON.stringify(session, null, 2);
      }

      if (normalizedToolName === 'terminal_run') {
        const sessionId = typeof args.session_id === 'string' ? args.session_id.trim() : '';
        const command = typeof args.command === 'string' ? args.command : '';
        if (!sessionId) return 'Missing session_id argument for terminal_run.';
        if (!command.trim()) return 'Missing command argument for terminal_run.';

        const session = await useTerminalStore.getState().runCommand({
          sessionId,
          command,
          timeoutMs:
            typeof args.timeout_ms === 'number' ? Math.max(1, Math.floor(args.timeout_ms)) : null,
        });
        return JSON.stringify(session, null, 2);
      }

      if (normalizedToolName === 'terminal_read') {
        const sessionId = typeof args.session_id === 'string' ? args.session_id.trim() : '';
        if (!sessionId) return 'Missing session_id argument for terminal_read.';

        const session = await useTerminalStore.getState().readSession(sessionId);
        return JSON.stringify(session, null, 2);
      }

      if (normalizedToolName === 'terminal_kill') {
        const sessionId = typeof args.session_id === 'string' ? args.session_id.trim() : '';
        if (!sessionId) return 'Missing session_id argument for terminal_kill.';

        const session = await useTerminalStore.getState().killSession(sessionId);
        return JSON.stringify(session, null, 2);
      }

      return executeWorkspaceTool(normalizedToolName, args, mode, {
        workspacePath: executionContext.workspacePath,
        defaultWorkspacePath: executionContext.defaultWorkspacePath,
        projectId: executionContext.projectId,
        focusedProjectId: executionContext.focusedProjectId,
        groupId: executionContext.groupId,
        projectMounts: executionContext.projectMounts,
        virtualRootEnabled: executionContext.virtualRootEnabled,
        workspacePathsByProjectId: executionContext.workspacePathsByProjectId,
      });
    }
  };

  const getOrderedConversationMessages = (conversationId: string) => {
    const state = get();
    return state.messages
      .filter((msg) => msg.conversation_id === conversationId)
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  };

  const prepareMessagesForRequest = async (
    conversationId: string,
    allowedToolIds: string[],
    messageWithImagesId?: string,
    providerType?: string
  ) => {
    const appState = useAppStore.getState();
    const taskState = useTaskStore.getState();
    const executionContext = resolveProjectExecutionContext({
      mode: appState.mode,
      projects: appState.projectGroups.flatMap((group) => group.projects),
      projectGroups: appState.projectGroups,
      tasks: taskState.tasks,
      conversations: get().conversations,
      conversationId,
      selectedGroupId: appState.selectedGroupId,
      selectedProjectId: appState.selectedProjectId,
      selectedTaskId: appState.selectedTaskId,
      activeRepositoryPath: taskState.activeRepositoryPath,
      branchWorktrees: taskState.branchWorktrees,
    });
    const contextCitations = useCitationsStore.getState().getConversationContextCitations(conversationId);
    const sourceCitations = useCitationsStore.getState().getConversationSourceCitations(conversationId);
    const citations = allowedToolIds.includes('mark_source_passage')
      ? [...contextCitations, ...sourceCitations]
      : contextCitations;
    const fileCitations = contextCitations.filter((c) => c.type === 'file' || c.type === 'document');
    const availableFiles = fileCitations
      .map((c) => c.path || c.title || c.source)
      .filter(Boolean)
      .join(', ');
    const orderedMessages = getOrderedConversationMessages(conversationId);
    const lastUserIndex = orderedMessages.map(m => m.role).lastIndexOf('user');
    const messageImagesByMessageId = get().messageImagesByMessageId;

    const preparedMessages = orderedMessages.map((message, index) => {
      let messageContent = message.content;
      if (message.role === 'assistant') {
        const sanitizedVisibleContent = sanitizeAssistantContentForModel(messageContent);
        messageContent = [sanitizedVisibleContent, message.hidden_context || '']
          .filter((value) => value.trim().length > 0)
          .join('\n\n')
          .trim();
      }

      // Inject context into the last user message
      if (index === lastUserIndex) {
        const blocks: string[] = [];

        if (citations.length > 0) {
          const contextBlock = citations
            .map((c, i) => {
              const kind = c.scope === 'source' ? 'Important Source' : 'Context';
              return `[${kind} ${i + 1}: ${c.title}]\n${c.snippet || c.source || ''}`;
            })
            .join('\n\n---\n\n');
          blocks.push(`CONTEXT INFORMATION:\n\n${contextBlock}`);
        }

        const contextRefs = get().composerContextRefs;
        if (contextRefs.length > 0) {
          const refsBlock = contextRefs
            .map((ref) => {
              const lines: string[] = [`[${ref.kind}: ${ref.title}]`];
              if (ref.subtitle) lines.push(`Category: ${ref.subtitle}`);
              if ('description' in ref.data && ref.data.description) {
                lines.push(`Description: ${ref.data.description}`);
              }
              if ('status' in ref.data && ref.data.status) {
                lines.push(`Status: ${ref.data.status}`);
              }
              if ('priority' in ref.data && ref.data.priority) {
                lines.push(`Priority: ${ref.data.priority}`);
              }
              if ('tags' in ref.data && Array.isArray(ref.data.tags) && ref.data.tags.length > 0) {
                lines.push(`Tags: ${ref.data.tags.join(', ')}`);
              }
              if ('type' in ref.data && ref.data.type) {
                lines.push(`Type: ${ref.data.type}`);
              }
              if ('dependencies' in ref.data && Array.isArray(ref.data.dependencies) && ref.data.dependencies.length > 0) {
                lines.push(`Dependencies: ${ref.data.dependencies.join(', ')}`);
              }
              return lines.join('\n');
            })
            .join('\n\n---\n\n');
          blocks.push(`REFERENCED ITEMS:\n\n${refsBlock}`);
        }

        if (blocks.length > 0) {
          messageContent = `${blocks.join('\n\n')}\n\nUSER REQUEST: ${message.content}`;
        }
      }

      if (message.role === 'user' && messageWithImagesId && message.id === messageWithImagesId) {
        const images = messageImagesByMessageId[message.id] || [];
        if (images.length > 0) {
          return {
            role: 'user' as const,
            content: [
              { type: 'text' as const, text: messageContent },
              ...images.map((image) => ({
                type: 'image_url' as const,
                image_url: { url: image.dataUrl },
              })),
            ],
          };
        }
      }

      return {
        role: message.role as 'user' | 'assistant',
        content: messageContent,
      };
    });

    const systemInstructions: string[] = [];
    if (allowedToolIds.includes('read_file')) {
      systemInstructions.push(
        `When the user asks to inspect or analyze an attached file, call read_file first using the file name/path. Available files: ${availableFiles || 'none'}.`
      );
    }
    if (allowedToolIds.includes('mark_source_passage')) {
      systemInstructions.push(
        'Use mark_source_passage for source tracking. Use kind="interesting" for key excerpts worth keeping while analyzing sources. Use kind="used" only for excerpts you actually used in your final answer. Always include concise title and exact passage. Add source or url when available, and reason when helpful. Only mark genuinely important passages.'
      );
    }
    if (allowedToolIds.includes('read_sources')) {
      systemInstructions.push(
        'Use read_sources when you need to review previously saved source passages before answering or editing citations.'
      );
    }
    if (allowedToolIds.includes('edit_source_passage')) {
      systemInstructions.push(
        'Use edit_source_passage only when the user asks to update, reclassify, or delete saved source passages.'
      );
    }
    if (providerType === 'chatgpt' && allowedToolIds.length > 0) {
      systemInstructions.push(
        'This provider does not support native tool calls. When you need a tool, emit exactly one inline tag in the form <tool_call>{"name":"tool_name","arguments":{...}}</tool_call> with valid JSON and no markdown code fence inside the tag.'
      );
    }
    if (useAppStore.getState().mode === 'Debug') {
      systemInstructions.push(
        'In Debug mode, for any question about current directory, file existence, path, or file content, you MUST call workspace tools first (list/read). ' +
        'If filename is ambiguous (example: "readme"), list the directory first and then read the exact matched filename (example: README.md). ' +
        'If a read fails, report the exact tool error and ask for a precise path. Never invent file content or project paths.'
      );
    }

    const appMode = appState.mode;
    const agentType = appMode === 'Architect' ? 'plan' : appState.agentType;
    let modePrompt = '';

    switch (appMode) {
      case 'Architect':
        modePrompt = await loadPreference<string>(PREF_KEYS.PROMPT_ARCHITECT);
        break;
      case 'Implement':
        modePrompt = await loadPreference<string>(PREF_KEYS.PROMPT_IMPLEMENT);
        break;
      case 'Chat':
        modePrompt = await loadPreference<string>(PREF_KEYS.PROMPT_CHAT);
        break;
      case 'Debug':
        modePrompt = await loadPreference<string>(PREF_KEYS.PROMPT_DEBUG);
        break;
    }

    if (modePrompt) {
      systemInstructions.unshift(modePrompt);
    }

    if (agentType === 'plan') {
      systemInstructions.push(
        'Agent type is PLAN. Focus on planning before execution: clarify goals, propose a step-by-step implementation plan, identify risks/dependencies, and ask for confirmation before suggesting direct file edits. Do not claim code was changed unless a tool call actually performed the change.'
      );
    }

    if (
      executionContext.groupName ||
      executionContext.projectName ||
      executionContext.workspacePath ||
      executionContext.taskId ||
      executionContext.branchName
    ) {
      const scopedProjects = executionContext.projectIds
        .map((projectId) => appState.getProjectById(projectId)?.name || projectId)
        .join(', ') || 'none';
      const mountSummary = executionContext.projectMounts
        .map((mount) => `${mount.mountName}=>${mount.displayName}`)
        .join(', ') || 'none';
      systemInstructions.push(
        `[Execution Context] global_project="${executionContext.groupName || executionContext.groupId || 'none'}", default_subproject="${executionContext.projectName || executionContext.projectId || 'none'}", focused_subproject="${executionContext.focusedProjectId || 'none'}", scoped_projects="${scopedProjects}", task="${executionContext.taskId || 'none'}", branch="${executionContext.branchName || 'none'}", virtual_root="${executionContext.virtualRootEnabled ? 'enabled' : 'disabled'}", project_mounts="${mountSummary}". When virtual_root is enabled, the visible workspace root is virtual and its first level contains only subproject mounts such as \`api/\` or \`web/\`. Use virtual paths like \`api/src/server.ts\` for filesystem tools, or pass \`project_id\` to target one subproject explicitly. Git and terminal operations must target exactly one subproject; there is no git or terminal at the virtual root.`
      );
    }

    if (appMode === 'Architect') {
      systemInstructions.push(
        'In Architect mode, do not call `strategy_generate` automatically. Only call it after an explicit user request to generate/regenerate strategy (for example via the Generate Strategy button or a direct instruction in chat).'
      );
      systemInstructions.push(
        'In Architect mode, never call `plan_create`. The AI may only inspect, update, or activate existing plans. If no suitable plan exists, ask the user to create one from the plan selector before continuing.'
      );
      systemInstructions.push(
        'In Architect mode, never call `plan_delete` or `plan_restore`. If a plan should be removed, archived, or restored, ask the user to do it from the plan selector.'
      );
      systemInstructions.push(
        'In Architect mode, `plan_update` may only change the optional label/title alias and description. Never use it to change plan status or activate a plan.'
      );
      systemInstructions.push(
        'In Architect mode, never call `plan_set_active`. If another plan should become active, ask the user to select it from the plan selector.'
      );
      systemInstructions.push(
        'Git workflow for plans is strict: each new plan gets a generated identifier and uses that identifier as its canonical slug. Integration branch is `plan/<plan-id>` from `develop`; strategy branches must be `feature/<plan-id>/<feature-slug>` and merge into the plan branch in dependency order. Optional labels must never change git branch identity.'
      );
      const activePlanContext = useAppStore.getState().activePlanContext;
      if (activePlanContext) {
        systemInstructions.push(
          `[Active Plan] id="${activePlanContext.id}", slug="${activePlanContext.slug || activePlanContext.id}", title="${activePlanContext.title}", label="${activePlanContext.label || 'none'}", description="${activePlanContext.description || 'none'}", status="${activePlanContext.status}", targetBranch="${activePlanContext.targetBranch}". New plans are identifier-first. Use plan_update.label (or title as legacy alias) only for the optional secondary label, and never rename the canonical id/slug of a new plan.`
        );
      }
    }

    return [
      {
        role: 'system' as const,
        content: systemInstructions.join(' ') || 'Use context information when it is provided.',
      },
      ...preparedMessages,
    ];
  };

  const recalcConversation = (conversationId: string, messages: ChatMessage[]) => {
    const conversationMessages = messages.filter(
      (message) => message.conversation_id === conversationId
    );
    const lastMessage = conversationMessages[conversationMessages.length - 1];
    return {
      message_count: conversationMessages.length,
      last_message: lastMessage?.content ?? '',
      updated_at: new Date().toISOString(),
    };
  };

  const getConversationGroupId = (conversation: Conversation): string | null => {
    if (conversation.group_id) {
      return conversation.group_id;
    }

    return getProjectGroupByProjectId(
      useAppStore.getState().projectGroups,
      conversation.project_id
    )?.id ?? null;
  };

  const isConversationAllowedForMode = (
    conversation: Conversation,
    mode: AppMode,
    selectedGroupId: string | null,
    selectedProjectId: string | null,
    selectedTaskId: string | null
  ): boolean => {
    if (mode === 'Chat' || mode === 'Debug') {
      return !conversation.group_id && !conversation.project_id && !conversation.task_id;
    }

    if (mode === 'Architect') {
      if (selectedGroupId) {
        return getConversationGroupId(conversation) === selectedGroupId && !conversation.task_id;
      }
      if (selectedProjectId) {
        return conversation.project_id === selectedProjectId && !conversation.task_id;
      }
      return !conversation.task_id;
    }

    if (mode === 'Implement') {
      if (!selectedTaskId) return false;
      return conversation.task_id === selectedTaskId;
    }

    return false;
  };

  const getFallbackConversationIdForMode = (
    conversations: Conversation[],
    mode: AppMode,
    selectedGroupId: string | null,
    selectedProjectId: string | null,
    selectedTaskId: string | null
  ): string | null => {
    const scoped = conversations
      .filter((conversation) =>
        isConversationAllowedForMode(
          conversation,
          mode,
          selectedGroupId,
          selectedProjectId,
          selectedTaskId
        )
      )
      .sort((a, b) =>
        new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
      );

    return scoped[0]?.id ?? null;
  };

  const getAllowedToolIdsForCurrentMode = async (): Promise<string[]> => {
    const mode = useAppStore.getState().mode;
    const modePolicy = await getModePolicyForCurrentMode();
    const toolsState = useToolsStore.getState();

    if (mode === 'Chat') {
      const enabledChatTools = toolsState.getEnabledChatToolIds();
      return enabledChatTools.filter((toolId) => modePolicy.allowedToolIds.includes(toolId));
    }

    if (mode === 'Debug') {
      const enabledTools = Object.values(toolsState.internalTools)
        .filter((tool) => toolsState.isToolEnabled(tool.id))
        .map((tool) => tool.id);
      return enabledTools.filter((toolId) => modePolicy.allowedToolIds.includes(toolId));
    }

    const enabledTools = Object.values(toolsState.internalTools)
      .filter((tool) => toolsState.isToolEnabled(tool.id))
      .map((tool) => tool.id);

    return enabledTools.filter((toolId) => modePolicy.allowedToolIds.includes(toolId));
  };

  const prepareMetadataMessages = (firstUserContent: string) => [
    {
      role: 'system' as const,
      content:
        'Generate concise metadata for this conversation. Return ONLY valid JSON with keys: title, description. ' +
        'title: 3-7 words, specific and action-oriented. description: one clear sentence under 180 characters.',
    },
    {
      role: 'user' as const,
      content: firstUserContent,
    },
  ];

  const updateConversationMetadataLocally = (
    conversationId: string,
    metadata: { title: string; description: string }
  ) => {
    set((state) => ({
      conversations: state.conversations.map((conversation) =>
        conversation.id === conversationId
          ? {
            ...conversation,
            title: metadata.title,
            description: metadata.description,
            updated_at: new Date().toISOString(),
          }
          : conversation
      ),
    }));
  };

  const maybeGenerateConversationMetadata = async (params: {
    conversationId: string;
    firstUserContent: string;
    providerId: string;
    providerType: string;
    baseUrl: string;
    apiKey?: string;
    modelId: string;
  }) => {
    const { conversationId, firstUserContent, providerId, providerType, baseUrl, apiKey, modelId } = params;

    if (metadataGenerationInFlight.has(conversationId)) return;
    metadataGenerationInFlight.add(conversationId);

    try {
      const output = await sendChatNonStreaming({
        providerId,
        providerType,
        baseUrl,
        apiKey,
        modelId,
        messages: prepareMetadataMessages(firstUserContent),
        onComplete: () => { },
        onError: () => { },
      });

      let metadata: { title: string; description: string };
      try {
        metadata = extractMetadataFromModelOutput(output);
      } catch {
        metadata = {
          title: getConversationFallbackTitle(firstUserContent),
          description: getConversationFallbackDescription(firstUserContent),
        };
      }

      updateConversationMetadataLocally(conversationId, metadata);

      if (tauriIpc.isTauriAvailable()) {
        tauriIpc
          .updateConversationDetails({
            id: conversationId,
            title: metadata.title,
            description: metadata.description,
          })
          .catch(console.error);
      }
    } catch {
      const metadata = {
        title: getConversationFallbackTitle(firstUserContent),
        description: getConversationFallbackDescription(firstUserContent),
      };
      updateConversationMetadataLocally(conversationId, metadata);
      if (tauriIpc.isTauriAvailable()) {
        tauriIpc
          .updateConversationDetails({
            id: conversationId,
            title: metadata.title,
            description: metadata.description,
          })
          .catch(console.error);
      }
    } finally {
      metadataGenerationInFlight.delete(conversationId);
    }
  };

  const applyStreamCompletion = (messageId: string, result: StreamCompletionResult) => {
    get().updateMessageFields(messageId, {
      tool_traces: result.toolTraces,
      hidden_context: result.hiddenContext,
    });
    get().updateMessageContent(messageId, result.visibleContent);
  };

  const persistAssistantStreamResult = (
    conversationId: string,
    result: StreamCompletionResult
  ) => {
    if (!tauriIpc.isTauriAvailable()) return;
    tauriIpc
      .createMessage(conversationId, 'assistant', result.visibleContent, {
        toolTraces: result.toolTraces,
        hiddenContext: result.hiddenContext,
      })
      .catch(console.error);
  };

  return {
    messages: [],
    conversations: [],
    selectedConversationId: null,
    selectedConversationIdsByMode: {},
    isLoading: false,
    isStreaming: false,
    lastError: null,
    abortController: null,
    messageImagesByMessageId: {},
    composerContextRefs: [],

    addMessage: (message) =>
      set((state) => {
        const conversations = state.conversations.map((conv) =>
          conv.id === message.conversation_id
            ? {
              ...conv,
              last_message: message.content,
              message_count: conv.message_count + 1,
              updated_at: new Date().toISOString(),
              is_unread: message.role === 'assistant' ? true : conv.is_unread,
            }
            : conv
        );
        return {
          messages: [...state.messages, message],
          conversations,
        };
      }),

    updateMessageContent: (messageId, content) =>
      set((state) => {
        const updatedMessage = state.messages.find((message) => message.id === messageId);
        const parsedContent =
          updatedMessage?.role === 'assistant'
            ? parseMessageQuickReplies(content)
            : { content };
        const updatedMessages = state.messages.map((message) =>
          message.id === messageId
            ? {
              ...message,
              content: parsedContent.content,
              choices: parsedContent.choices,
              allow_free_response: parsedContent.allowFreeResponse,
            }
            : message
        );

        if (!updatedMessage) {
          return { messages: updatedMessages };
        }

        const conversationMeta = recalcConversation(
          updatedMessage.conversation_id,
          updatedMessages
        );

        const conversations = state.conversations.map((conv) =>
          conv.id === updatedMessage.conversation_id
            ? { ...conv, ...conversationMeta }
            : conv
        );

        return { messages: updatedMessages, conversations };
      }),

    updateMessageFields: (messageId, patch) =>
      set((state) => ({
        messages: state.messages.map((message) =>
          message.id === messageId
            ? { ...message, ...patch }
            : message
        ),
      })),

    updateLastMessage: (content) =>
      set((state) => {
        const updatedMessages = [...state.messages];
        if (updatedMessages.length > 0) {
          const lastIndex = updatedMessages.length - 1;
          updatedMessages[lastIndex] = {
            ...updatedMessages[lastIndex],
            content,
          };
        }
        return { messages: updatedMessages };
      }),

    appendToLastMessage: (token) =>
      set((state) => {
        const updatedMessages = [...state.messages];
        if (updatedMessages.length > 0) {
          const lastIndex = updatedMessages.length - 1;
          updatedMessages[lastIndex] = {
            ...updatedMessages[lastIndex],
            content: updatedMessages[lastIndex].content + token,
          };
        }
        return { messages: updatedMessages };
      }),

    appendToMessage: (messageId, tokenChunk) =>
      set((state) => {
        const updatedMessages = state.messages.map((message) =>
          message.id === messageId
            ? { ...message, content: message.content + tokenChunk }
            : message
        );
        return { messages: updatedMessages };
      }),

    clearMessages: () => set({ messages: [] }),

    setMessageImages: (messageId, images) =>
      set((state) => {
        const next = { ...state.messageImagesByMessageId };
        if (images.length > 0) {
          next[messageId] = images;
        } else {
          delete next[messageId];
        }
        saveMessageImagesToStorage(next);
        return { messageImagesByMessageId: next };
      }),

    getMessageImages: (messageId) => {
      const state = get();
      return state.messageImagesByMessageId[messageId] || [];
    },

    addComposerContextRef: (ref) =>
      set((state) => {
        const exists = state.composerContextRefs.some(
          (r) => r.id === ref.id && r.kind === ref.kind
        );
        if (exists) return state;
        return { composerContextRefs: [...state.composerContextRefs, ref] };
      }),

    removeComposerContextRef: (id, kind) =>
      set((state) => ({
        composerContextRefs: state.composerContextRefs.filter(
          (r) => !(r.id === id && r.kind === kind)
        ),
      })),

    clearComposerContextRefs: () => set({ composerContextRefs: [] }),

    reconcileProjectRegistry: (validGroupIds, validProjectIds) => {
      const validGroupIdSet = new Set(validGroupIds);
      const validProjectIdSet = new Set(validProjectIds);
      set((state) => ({
        conversations: state.conversations.map((conversation) => ({
          ...conversation,
          group_id:
            conversation.group_id && validGroupIdSet.has(conversation.group_id)
              ? conversation.group_id
              : null,
          project_id:
            conversation.project_id && validProjectIdSet.has(conversation.project_id)
              ? conversation.project_id
              : null,
        })),
      }));
    },

    selectConversation: (conversationId) => {
      set((state) => {
        const appState = useAppStore.getState();
        const conversation = state.conversations.find((conv) => conv.id === conversationId);
        if (!conversation) {
          return {};
        }

        if (
          !isConversationAllowedForMode(
            conversation,
            appState.mode,
            appState.selectedGroupId,
            appState.selectedProjectId,
            appState.selectedTaskId
          )
        ) {
          return {};
        }

        const updatedConversations = state.conversations.map((conv) =>
          conv.id === conversationId ? { ...conv, is_unread: false } : conv
        );
        return {
          selectedConversationId: conversationId,
          selectedConversationIdsByMode: {
            ...state.selectedConversationIdsByMode,
            [appState.mode]: conversationId,
          },
          conversations: updatedConversations,
        };
      });

      const appState = useAppStore.getState();
      void applySelectionForContext(appState.mode, conversationId);
    },

    createConversation: async (title, taskId, projectId, groupId) => {
      let newConversation: Conversation;
      const mode = useAppStore.getState().mode;

      if (tauriIpc.isTauriAvailable()) {
        try {
          const dbConv = await tauriIpc.createConversation({
            title,
            taskId,
            groupId,
            projectId,
          });
          newConversation = {
            id: dbConv.id,
            title: dbConv.title,
            description: dbConv.description || '',
            task_id: dbConv.task_id,
            group_id: dbConv.group_id,
            project_id: dbConv.project_id,
            last_message: dbConv.last_message || '',
            message_count: dbConv.message_count,
            updated_at: dbConv.updated_at,
            is_unread: true,
          };
        } catch (error) {
          console.error('Failed to create conversation in DB:', error);
          // Fallback to local creation
          newConversation = {
            id: `conv-${Date.now()}`,
            title,
            description: '',
            task_id: taskId,
            group_id: groupId ?? null,
            project_id: projectId,
            last_message: '',
            message_count: 0,
            updated_at: new Date().toISOString(),
            is_unread: true,
          };
        }
      } else {
        newConversation = {
          id: `conv-${Date.now()}`,
          title,
          description: '',
          task_id: taskId,
          group_id: groupId ?? null,
          project_id: projectId,
          last_message: '',
          message_count: 0,
          updated_at: new Date().toISOString(),
          is_unread: true,
        };
      }

      set((state) => ({
        conversations: [newConversation, ...state.conversations],
        selectedConversationId: newConversation.id,
        selectedConversationIdsByMode: {
          ...state.selectedConversationIdsByMode,
          [mode]: newConversation.id,
        },
      }));
      persistSelectionForContext(mode, newConversation.id);
      return newConversation;
    },

    ensureArchitectConversationForPlan: async ({
      plan,
      targetBranch,
      fallbackProjectId,
      fallbackGroupId,
      sharedConversation = false,
    }) => {
      const existingConversation = plan.conversationId
        ? get().conversations.find((conversation) => conversation.id === plan.conversationId) ?? null
        : null;
      const transcript = await getArchitectPlanChatMessages(targetBranch, plan.id).catch(() => []);

      let conversation = existingConversation && !sharedConversation
        ? existingConversation
        : null;
      let createdConversation = false;
      let restoredTranscript = false;

      if (!conversation) {
        conversation = await get().createConversation(
          getArchitectPlanConversationTitle(plan),
          null,
          fallbackProjectId ?? null,
          fallbackGroupId ?? null
        );
        createdConversation = true;
      }

      const localMessages = get().getConversationMessages(conversation.id);
      if (localMessages.length === 0 && transcript.length > 0) {
        const restoredMessages: ChatMessage[] = [];
        for (const message of transcript) {
          if (tauriIpc.isTauriAvailable()) {
            try {
              const dbMessage = await tauriIpc.createMessage(conversation.id, message.role, message.content);
              restoredMessages.push({
                id: dbMessage.id,
                task_id: '',
                conversation_id: dbMessage.conversation_id,
                role: dbMessage.role as 'user' | 'assistant',
                content: dbMessage.content,
                timestamp: dbMessage.created_at,
              });
              continue;
            } catch {
              // Fall through to local-only restoration.
            }
          }

          restoredMessages.push({
            id: message.id,
            task_id: '',
            conversation_id: conversation.id,
            role: message.role,
            content: message.content,
            timestamp: message.createdAt,
          });
        }

        if (restoredMessages.length > 0) {
          restoredTranscript = true;
          set((state) => ({
            messages: [...state.messages, ...restoredMessages],
            conversations: state.conversations.map((candidate) =>
              candidate.id === conversation!.id
                ? {
                    ...candidate,
                    last_message: restoredMessages[restoredMessages.length - 1]?.content ?? candidate.last_message,
                    message_count: restoredMessages.length,
                    updated_at: new Date().toISOString(),
                  }
                : candidate
            ),
          }));
        }
      }

      if (conversation.id !== plan.conversationId) {
        try {
          await updateArchitectPlan({
            branchName: targetBranch,
            planId: plan.id,
            conversationId: conversation.id,
          });
        } catch {
          // Keep local conversation even if metadata cannot be rewritten right now.
        }
      }

      get().selectConversation(conversation.id);
      return {
        conversationId: conversation.id,
        restoredTranscript,
        createdConversation,
      };
    },

    ensureConversationForCurrentMode: async () => {
      const appState = useAppStore.getState();
      const state = get();
      const mode = appState.mode;
      const selectedGroupId = appState.selectedGroupId;
      const selectedProjectId = appState.selectedProjectId;
      const selectedTaskId = appState.selectedTaskId;

      if (mode === 'Debug') {
        const debugFallback = getFallbackConversationIdForMode(
          state.conversations,
          'Debug',
          selectedGroupId,
          selectedProjectId,
          selectedTaskId
        );

        if (
          state.selectedConversationId !== debugFallback ||
          state.selectedConversationIdsByMode.Debug !== debugFallback
        ) {
          set((current) => ({
            selectedConversationId: debugFallback,
            selectedConversationIdsByMode: {
              ...current.selectedConversationIdsByMode,
              Debug: debugFallback,
            },
          }));
        }

        void applySelectionForContext(mode, debugFallback);

        return debugFallback;
      }

      if (mode === 'Architect' && appState.activeArchitectPlanId) {
        try {
          const targetBranch = resolveTargetBranch(appState.activePlanContext?.targetBranch);
          const activePlan = await getArchitectPlan(targetBranch, appState.activeArchitectPlanId);
          if (activePlan && activePlan.status !== 'deleted') {
            const plansSnapshot = await listArchitectPlans(targetBranch, true, true);
            const conversationId = activePlan.conversationId;
            const hasSharedConversation = Boolean(
              conversationId &&
              plansSnapshot.plans.some(
                (candidate) => candidate.id !== activePlan.id && candidate.conversationId === conversationId
              )
            );
            const fallbackProjectId =
              resolvePlanProjectContextId(activePlan, selectedProjectId) ||
              getArchitectPlanProjectIds(activePlan)[0] ||
              selectedProjectId ||
              appState.projectGroups.flatMap((group) => group.projects)[0]?.id ||
              null;
            const ensured = await get().ensureArchitectConversationForPlan({
              plan: activePlan,
              targetBranch,
              fallbackProjectId: fallbackProjectId ?? undefined,
              fallbackGroupId: selectedGroupId ?? undefined,
              sharedConversation: hasSharedConversation,
            });
            if (ensured.conversationId) {
              return ensured.conversationId;
            }
          }
        } catch {
          // Fall back to project-scoped Architect conversation selection below.
        }
      }

      const localProjectContext = selectedGroupId
        ? await getLocalProjectContextState(selectedGroupId)
        : null;
      const localContextConversationId =
        mode === 'Architect'
          ? localProjectContext?.architectConversationId
          : mode === 'Implement'
            ? localProjectContext?.implementConversationId
            : null;
      const localContextConversation = localContextConversationId
        ? state.conversations.find((conversation) => conversation.id === localContextConversationId)
        : null;

      if (
        localContextConversation &&
        isConversationAllowedForMode(
          localContextConversation,
          mode,
          selectedGroupId,
          selectedProjectId,
          selectedTaskId
        )
      ) {
        if (state.selectedConversationId !== localContextConversation.id) {
          get().selectConversation(localContextConversation.id);
        } else {
          void applySelectionForContext(mode, localContextConversation.id);
        }
        return localContextConversation.id;
      }

      const rememberedId = state.selectedConversationIdsByMode[mode] ?? null;
      const rememberedConversation = rememberedId
        ? state.conversations.find((conversation) => conversation.id === rememberedId)
        : null;

      if (
        rememberedConversation &&
        isConversationAllowedForMode(
          rememberedConversation,
          mode,
          selectedGroupId,
          selectedProjectId,
          selectedTaskId
        )
      ) {
        if (state.selectedConversationId !== rememberedConversation.id) {
          get().selectConversation(rememberedConversation.id);
        } else {
          void applySelectionForContext(mode, rememberedConversation.id);
        }
        return rememberedConversation.id;
      }

      const fallbackConversationId = getFallbackConversationIdForMode(
        state.conversations,
        mode,
        selectedGroupId,
        selectedProjectId,
        selectedTaskId
      );

      if (fallbackConversationId) {
        if (state.selectedConversationId !== fallbackConversationId) {
          get().selectConversation(fallbackConversationId);
        } else {
          void applySelectionForContext(mode, fallbackConversationId);
        }
        return fallbackConversationId;
      }

      if (mode === 'Architect' && selectedGroupId) {
        const globalProject = getGlobalProjectById(appState.projectGroups, selectedGroupId);
        const fallbackProjectId =
          getFocusedProjectForGroup(
            appState.projectGroups,
            selectedGroupId,
            selectedProjectId,
            localProjectContext
          )?.id ??
          globalProject?.primarySubProjectId ??
          selectedProjectId ??
          null;
        const project = globalProject;
        const title = project ? `Architect - ${project.name}` : 'Architect Session';
        const created = await get().createConversation(
          title,
          null,
          fallbackProjectId,
          selectedGroupId
        );
        return created.id;
      }

      if (mode === 'Implement' && selectedTaskId) {
        const task = useTaskStore.getState().getTaskById(selectedTaskId);
        const title = task ? `Task - ${task.title}` : 'Task Session';
        const projectId =
          task?.project_id ??
          getFocusedProjectForGroup(
            appState.projectGroups,
            selectedGroupId,
            selectedProjectId,
            localProjectContext
          )?.id ??
          selectedProjectId;
        const created = await get().createConversation(
          title,
          selectedTaskId,
          projectId ?? null,
          selectedGroupId
        );
        return created.id;
      }

      set((current) => ({
        selectedConversationId: null,
        selectedConversationIdsByMode: {
          ...current.selectedConversationIdsByMode,
          [mode]: null,
        },
      }));
      void applySelectionForContext(mode, null);
      return null;
    },

    renameConversation: async (conversationId, title) => {
      if (tauriIpc.isTauriAvailable()) {
        await tauriIpc.renameConversation(conversationId, title);
      }
      set((state) => ({
        conversations: state.conversations.map((conv) =>
          conv.id === conversationId ? { ...conv, title } : conv
        ),
      }));
    },

    deleteConversation: async (conversationId, confirmation) => {
      const conversation = get().conversations.find((candidate) => candidate.id === conversationId);
      if (!conversation) {
        throw new Error('Conversation introuvable.');
      }

      if (conversation.task_id) {
        if (confirmation?.mode !== 'implement') {
          throw new Error(
            'Suppression bloquée: une conversation Implement nécessite une confirmation explicite.'
          );
        }
      } else if (conversation.group_id || conversation.project_id) {
        const appState = useAppStore.getState();
        const projectName =
          (conversation.group_id
            ? getGlobalProjectById(appState.projectGroups, conversation.group_id)?.name?.trim()
            : null) ||
          (conversation.project_id
            ? appState.getProjectById(conversation.project_id)?.name?.trim()
            : null) ||
          null;

        if (confirmation?.mode !== 'architect') {
          throw new Error(
            'Suppression bloquée: une conversation Architect nécessite de confirmer le nom du projet.'
          );
        }

        if (projectName && confirmation.typedProjectName?.trim() !== projectName) {
          throw new Error('Le nom du projet ne correspond pas.');
        }
      } else if (confirmation && confirmation.mode !== 'chat') {
        throw new Error('Type de confirmation invalide pour une conversation Chat.');
      }

      if (tauriIpc.isTauriAvailable()) {
        await tauriIpc.deleteConversation(conversationId);
      }
      removeConversationSelection(conversationId);
      set((state) => {
        const appState = useAppStore.getState();
        const newConversations = state.conversations.filter((c) => c.id !== conversationId);
        const newMessages = state.messages.filter((m) => m.conversation_id !== conversationId);
        const removedMessageIds = new Set(
          state.messages
            .filter((m) => m.conversation_id === conversationId)
            .map((m) => m.id)
        );
        const nextImages = { ...state.messageImagesByMessageId };
        removedMessageIds.forEach((id) => {
          delete nextImages[id];
        });
        saveMessageImagesToStorage(nextImages);

        const nextByMode = { ...state.selectedConversationIdsByMode };
        (Object.keys(nextByMode) as AppMode[]).forEach((modeKey) => {
          if (nextByMode[modeKey] === conversationId) {
            nextByMode[modeKey] = null;
          }
        });

        const fallbackForCurrentMode = getFallbackConversationIdForMode(
          newConversations,
          appState.mode,
          appState.selectedGroupId,
          appState.selectedProjectId,
          appState.selectedTaskId
        );

        const newSelectedId =
          state.selectedConversationId === conversationId
            ? fallbackForCurrentMode
            : state.selectedConversationId;

        nextByMode[appState.mode] =
          newSelectedId &&
            newConversations.some((conversation) => conversation.id === newSelectedId)
            ? newSelectedId
            : fallbackForCurrentMode;

        return {
          conversations: newConversations,
          messages: newMessages,
          messageImagesByMessageId: nextImages,
          selectedConversationId: newSelectedId,
          selectedConversationIdsByMode: nextByMode,
        };
      });
    },

    markAsRead: (conversationId) =>
      set((state) => ({
        conversations: state.conversations.map((conv) =>
          conv.id === conversationId ? { ...conv, is_unread: false } : conv
        ),
      })),

    getConversationByTask: (taskId) => {
      const state = get();
      return state.conversations
        .filter((conv) => conv.task_id === taskId)
        .sort((a, b) =>
          new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
        )[0];
    },

    getConversationMessages: (conversationId) => {
      const state = get();
      return state.messages.filter((msg) => msg.conversation_id === conversationId);
    },

    sendMessage: async ({ conversationId, content, taskId, images }) => {
      const { selectedProviderId, selectedModelId, providerConfigs } = useProviderStore.getState();
      const modeAtSend = useAppStore.getState().mode;
      persistSelectionForContext(modeAtSend, conversationId);

      const conversationTaskId =
        get().conversations.find((conversation) => conversation.id === conversationId)?.task_id ?? null;
      const resolvedTaskId =
        taskId ?? conversationTaskId ?? useAppStore.getState().selectedTaskId ?? '';

      if (!selectedProviderId || !selectedModelId) {
        set({ lastError: 'Select a provider and model before sending a message.' });
        return;
      }

      const providerConfig = providerConfigs.find((p) => p.id === selectedProviderId);
      if (!providerConfig) {
        set({ lastError: 'Provider configuration not found.' });
        return;
      }

      const userMessageCountBeforeSend = getOrderedConversationMessages(conversationId).filter(
        (message) => message.role === 'user'
      ).length;

      let userMessage: ChatMessage = {
        id: `msg-${Date.now()}`,
        task_id: resolvedTaskId,
        conversation_id: conversationId,
        role: 'user',
        content,
        timestamp: new Date().toISOString(),
      };

      if (tauriIpc.isTauriAvailable()) {
        try {
          const dbMessage = await tauriIpc.createMessage(conversationId, 'user', content);
          userMessage = {
            id: dbMessage.id,
            task_id: resolvedTaskId,
            conversation_id: dbMessage.conversation_id,
            role: 'user',
            content: dbMessage.content,
            timestamp: dbMessage.created_at,
          };
        } catch (error) {
          console.error('Failed to create user message in DB:', error);
        }
      }

      set({ lastError: null });
      get().addMessage(userMessage);
      if (images && images.length > 0) {
        get().setMessageImages(userMessage.id, images);
      }
      // Clear context refs after they've been captured for this message
      get().clearComposerContextRefs();

      if (userMessageCountBeforeSend === 0) {
        void maybeGenerateConversationMetadata({
          conversationId,
          firstUserContent: content,
          providerId: selectedProviderId,
          providerType: providerConfig.providerType,
          baseUrl: providerConfig.baseUrl,
          apiKey: providerConfig.apiKey,
          modelId: selectedModelId,
        });
      }

      try {
        await ensureToolsLoaded();
      } catch {
        // Continue with currently available tool state (safe default is no tools)
      }
      const allowedToolIds = await getAllowedToolIdsForCurrentMode();
      const showToolTraces = useAppStore.getState().mode === 'Debug';
      const messagesForRequest = await prepareMessagesForRequest(
        conversationId,
        allowedToolIds,
        userMessage.id,
        providerConfig.providerType
      );
      const fileToolContext = useCitationsStore
        .getState()
        .getConversationContextCitations(conversationId)
        .filter((c) => c.type === 'file' || c.type === 'document')
        .map((c) => ({
          title: c.title,
          source: c.source,
          path: c.path,
          snippet: c.snippet,
        }));
      const { enableWebSearch, enableWebFetch, webSearchOptions } = getStreamingWebSearchConfig();

      const assistantMessage: ChatMessage = {
        id: `msg-${Date.now()}-assistant`,
        task_id: resolvedTaskId,
        conversation_id: conversationId,
        role: 'assistant',
        content: '',
        tool_traces: [],
        timestamp: new Date().toISOString(),
      };

      get().addMessage(assistantMessage);

      const abortController = new AbortController();
      set({ isLoading: true, isStreaming: true, abortController });
      const tokenBatcher = createTokenBatcher((tokenChunk) => {
        get().appendToMessage(assistantMessage.id, tokenChunk);
      });

      try {
        await streamChat({
          providerId: selectedProviderId,
          providerType: providerConfig.providerType,
          baseUrl: providerConfig.baseUrl,
          apiKey: providerConfig.apiKey,
          modelId: selectedModelId,
          messages: messagesForRequest,
          fileToolContext,
          allowedToolIds,
          showToolTraces,
          enableWebSearch,
          enableWebFetch,
          webSearchOptions,
          signal: abortController.signal,
          onToken: (token) => {
            tokenBatcher.push(token);
          },
          onToolTracesUpdate: (toolTraces: ToolTrace[]) => {
            get().updateMessageFields(assistantMessage.id, { tool_traces: toolTraces });
          },
          onComplete: (result) => {
            tokenBatcher.flushNow();
            applyStreamCompletion(assistantMessage.id, result);

            // Update conversation metadata
            set((state) => {
              const conversations = state.conversations.map((conv) =>
                conv.id === conversationId
                  ? {
                    ...conv,
                    last_message:
                      result.visibleContent.slice(0, 100) +
                      (result.visibleContent.length > 100 ? '...' : ''),
                    updated_at: new Date().toISOString(),
                  }
                  : conv
              );
              return { conversations, isLoading: false, isStreaming: false, abortController: null };
            });

            persistAssistantStreamResult(conversationId, result);
            void syncMacroMetadataAfterStreamService({
              mode: modeAtSend,
              conversationId,
              trigger: 'send',
            });
            tokenBatcher.dispose();
          },
          onError: (error) => {
            tokenBatcher.dispose();
            get().updateMessageContent(
              assistantMessage.id,
              `Error: ${error.message}`
            );
            set({ isLoading: false, isStreaming: false, lastError: error.message, abortController: null });
          },
          onToolCall: (toolName, args) => {
            return handleToolCall(conversationId, assistantMessage.id, toolName, args);
          },
        });
      } catch (error) {
        tokenBatcher.dispose();
        const normalized = toServiceError(error);
        get().updateMessageContent(
          assistantMessage.id,
          `Error: ${normalized.message}`
        );
        set({ isLoading: false, isStreaming: false, lastError: normalized.message, abortController: null });
      }
    },

    stopStreaming: () => {
      const { abortController } = get();
      if (abortController) {
        abortController.abort();
      }
      // Cancel the active reader and stream
      cancelStream();
      set({ isStreaming: false, isLoading: false, abortController: null });
    },

    editMessage: async (messageId, newContent) => {
      const { selectedProviderId, selectedModelId, providerConfigs } = useProviderStore.getState();
      const modeAtEdit = useAppStore.getState().mode;
      if (!selectedProviderId || !selectedModelId) {
        set({ lastError: 'Select a provider and model before sending a message.' });
        return;
      }

      const providerConfig = providerConfigs.find((p) => p.id === selectedProviderId);
      if (!providerConfig) {
        set({ lastError: 'Provider configuration not found.' });
        return;
      }

      const state = get();
      const target = state.messages.find((message) => message.id === messageId);
      if (!target) return;

      const conversationId = target.conversation_id;

      if (tauriIpc.isTauriAvailable()) {
        tauriIpc.deleteMessagesAfter(conversationId, messageId).catch(console.error);
      }

      set((current) => {
        const updatedMessages = current.messages.map((message) =>
          message.id === messageId ? { ...message, content: newContent } : message
        );

        const conversationMessages = updatedMessages
          .filter((message) => message.conversation_id === conversationId)
          .sort((a, b) =>
            new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
          );

        const targetIndex = conversationMessages.findIndex(
          (message) => message.id === messageId
        );

        const allowedIds = new Set(
          conversationMessages.slice(0, targetIndex + 1).map((message) => message.id)
        );

        const trimmedMessages = updatedMessages.filter((message) =>
          message.conversation_id === conversationId ? allowedIds.has(message.id) : true
        );

        const conversationMeta = recalcConversation(conversationId, trimmedMessages);

        const conversations = current.conversations.map((conv) =>
          conv.id === conversationId ? { ...conv, ...conversationMeta } : conv
        );

        const keptConversationMessageIds = new Set(
          trimmedMessages
            .filter((message) => message.conversation_id === conversationId)
            .map((message) => message.id)
        );
        const nextImages = { ...current.messageImagesByMessageId };
        Object.keys(nextImages).forEach((messageIdKey) => {
          const message = trimmedMessages.find((m) => m.id === messageIdKey);
          if (!message || (message.conversation_id === conversationId && !keptConversationMessageIds.has(messageIdKey))) {
            delete nextImages[messageIdKey];
          }
        });
        saveMessageImagesToStorage(nextImages);

        return {
          messages: trimmedMessages,
          conversations,
          messageImagesByMessageId: nextImages,
          lastError: null,
        };
      });

      // Keep manual context, but drop source passages produced by assistant messages that were trimmed.
      const keptConversationMessageIds = get()
        .messages
        .filter((message) => message.conversation_id === conversationId)
        .map((message) => message.id);
      useCitationsStore
        .getState()
        .pruneConversationSourceCitations(conversationId, keptConversationMessageIds);

      try {
        await ensureToolsLoaded();
      } catch {
        // Continue with currently available tool state (safe default is no tools)
      }
      const allowedToolIds = await getAllowedToolIdsForCurrentMode();
      const showToolTraces = useAppStore.getState().mode === 'Debug';
      const messagesForRequest = await prepareMessagesForRequest(
        conversationId,
        allowedToolIds,
        messageId,
        providerConfig.providerType
      );
      const fileToolContext = useCitationsStore
        .getState()
        .getConversationContextCitations(conversationId)
        .filter((c) => c.type === 'file' || c.type === 'document')
        .map((c) => ({
          title: c.title,
          source: c.source,
          path: c.path,
          snippet: c.snippet,
        }));
      const { enableWebSearch, enableWebFetch, webSearchOptions } = getStreamingWebSearchConfig();

      const assistantMessage: ChatMessage = {
        id: `msg-${Date.now()}-assistant`,
        task_id: target.task_id,
        conversation_id: conversationId,
        role: 'assistant',
        content: '',
        tool_traces: [],
        timestamp: new Date().toISOString(),
      };

      get().addMessage(assistantMessage);

      const abortController = new AbortController();
      set({ isLoading: true, isStreaming: true, abortController });
      const tokenBatcher = createTokenBatcher((tokenChunk) => {
        get().appendToMessage(assistantMessage.id, tokenChunk);
      });

      try {
        await streamChat({
          providerId: selectedProviderId,
          providerType: providerConfig.providerType,
          baseUrl: providerConfig.baseUrl,
          apiKey: providerConfig.apiKey,
          modelId: selectedModelId,
          messages: messagesForRequest,
          fileToolContext,
          allowedToolIds,
          showToolTraces,
          enableWebSearch,
          enableWebFetch,
          webSearchOptions,
          signal: abortController.signal,
          onToken: (token) => {
            tokenBatcher.push(token);
          },
          onToolTracesUpdate: (toolTraces: ToolTrace[]) => {
            get().updateMessageFields(assistantMessage.id, { tool_traces: toolTraces });
          },
          onComplete: (result) => {
            tokenBatcher.flushNow();
            applyStreamCompletion(assistantMessage.id, result);

            set((state) => {
              const conversations = state.conversations.map((conv) =>
                conv.id === conversationId
                  ? {
                    ...conv,
                    last_message:
                      result.visibleContent.slice(0, 100) +
                      (result.visibleContent.length > 100 ? '...' : ''),
                    updated_at: new Date().toISOString(),
                  }
                  : conv
              );
              return { conversations, isLoading: false, isStreaming: false, abortController: null };
            });
            persistAssistantStreamResult(conversationId, result);
            void syncMacroMetadataAfterStreamService({
              mode: modeAtEdit,
              conversationId,
              trigger: 'edit',
            });
            tokenBatcher.dispose();
          },
          onError: (error) => {
            tokenBatcher.dispose();
            get().updateMessageContent(
              assistantMessage.id,
              `Error: ${error.message}`
            );
            set({ isLoading: false, isStreaming: false, lastError: error.message, abortController: null });
          },
          onToolCall: (toolName, args) => {
            return handleToolCall(conversationId, assistantMessage.id, toolName, args);
          },
        });
      } catch (error) {
        tokenBatcher.dispose();
        const normalized = toServiceError(error);
        get().updateMessageContent(
          assistantMessage.id,
          `Error: ${normalized.message}`
        );
        set({ isLoading: false, isStreaming: false, lastError: normalized.message, abortController: null });
      }
    },

    initialize: async () => {
      set({ isLoading: true, lastError: null });
      try {
        aiSelections = normalizeAIContextSelections(
          await loadPreference<PersistedAIContextSelections>(PREF_KEYS.AI_CONTEXT_SELECTIONS)
        );
        aiSelectionsLoaded = true;
        ensureProviderSelectionSync();
        ensureModeSelectionSync();

        // Try to load from Tauri DB if available
        if (tauriIpc.isTauriAvailable()) {
          const dbConversations = await tauriIpc.listConversations();
          const conversations: Conversation[] = dbConversations.map((c) => ({
            id: c.id,
            title: c.title,
            description: c.description || '',
            task_id: c.task_id,
            group_id: c.group_id,
            project_id: c.project_id,
            last_message: c.last_message || '',
            message_count: c.message_count,
            updated_at: c.updated_at,
            is_unread: false,
          }));

          const existingConversationIds = new Set(conversations.map((conversation) => conversation.id));
          const nextConversationSelections: Record<string, PersistedAISelection> = {};
          Object.entries(aiSelections.conversationSelections).forEach(([conversationId, selection]) => {
            if (existingConversationIds.has(conversationId)) {
              nextConversationSelections[conversationId] = selection;
            }
          });
          if (
            Object.keys(nextConversationSelections).length !==
            Object.keys(aiSelections.conversationSelections).length
          ) {
            aiSelections = {
              ...aiSelections,
              conversationSelections: nextConversationSelections,
            };
            persistAiSelections();
          }

          const conversationById = new Map(conversations.map((conversation) => [conversation.id, conversation]));

          // Load messages for all conversations
          const allMessages: ChatMessage[] = [];
          for (const conv of dbConversations) {
            const dbMessages = await tauriIpc.listMessages(conv.id);
            allMessages.push(
              ...dbMessages.map((m) => ({
                ...(m.role === 'assistant'
                  ? (() => {
                    const parsed = parseMessageQuickReplies(m.content);
                    return {
                      id: m.id,
                      task_id: conversationById.get(m.conversation_id)?.task_id ?? '',
                      conversation_id: m.conversation_id,
                      role: m.role as 'user' | 'assistant',
                      content: parsed.content,
                      timestamp: m.created_at,
                      choices: parsed.choices,
                      allow_free_response: parsed.allowFreeResponse,
                    };
                  })()
                  : {
                    id: m.id,
                    task_id: conversationById.get(m.conversation_id)?.task_id ?? '',
                    conversation_id: m.conversation_id,
                    role: m.role as 'user' | 'assistant',
                    content: m.content,
                    timestamp: m.created_at,
                  }),
              }))
            );
          }

          set({
            conversations,
            messages: allMessages,
            messageImagesByMessageId: (() => {
              const loaded = loadMessageImagesFromStorage();
              const existingMessageIds = new Set(allMessages.map((m) => m.id));
              const pruned: Record<string, MessageImageAttachment[]> = {};
              Object.entries(loaded).forEach(([messageId, items]) => {
                if (existingMessageIds.has(messageId) && Array.isArray(items) && items.length > 0) {
                  pruned[messageId] = items;
                }
              });
              saveMessageImagesToStorage(pruned);
              return pruned;
            })(),
            selectedConversationId: null,
            selectedConversationIdsByMode: {},
            isLoading: false,
          });

          const appState = useAppStore.getState();
          void applySelectionForContext(appState.mode, null);
        } else {
          // Development mode without Tauri - start with empty state
          set({
            conversations: [],
            messages: [],
            messageImagesByMessageId: loadMessageImagesFromStorage(),
            selectedConversationId: null,
            selectedConversationIdsByMode: {},
            isLoading: false,
          });

          const appState = useAppStore.getState();
          void applySelectionForContext(appState.mode, null);
        }
      } catch (error) {
        const normalized = toServiceError(error);
        console.error('Failed to initialize chat store:', normalized.message);
        // Fallback to empty state
        set({
          conversations: [],
          messages: [],
          messageImagesByMessageId: loadMessageImagesFromStorage(),
          selectedConversationId: null,
          selectedConversationIdsByMode: {},
          isLoading: false,
          lastError: normalized.message,
        });

        aiSelectionsLoaded = true;
        ensureProviderSelectionSync();
        ensureModeSelectionSync();
      }
    },
  };
});



