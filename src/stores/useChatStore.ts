import { create } from 'zustand';
import { AppMode, ChatMessage, ContextRefKind, ContextReference, Conversation, PlanNode, PlanNodeStatus, PlanNodeType, PredictedBranch } from '../types';
import { toServiceError } from '../services/contracts/errors';
import { useProviderStore } from './useProviderStore';
import { useCitationsStore } from './useCitationsStore';
import { streamChat, cancelStream, sendChatNonStreaming } from '../services/streamingChat';
import { getStreamingWebSearchConfig } from '../services/webSearchSettings';
import { useToolsStore } from './useToolsStore';
import { useAppStore } from './useAppStore';
import { getToolModePolicy } from '../services/toolModePolicy';
import { executeWorkspaceTool } from '../services/workspaceToolExecutor';
import { loadPreference, PREF_KEYS, savePreference } from '../services/preferences';
import { useNeedsStore } from './useNeedsStore';
import * as tauriIpc from '../services/tauriIpc';
import {
  createArchitectPlan,
  getArchitectPlan,
  getArchitectPlanNeeds,
  getGitFlowBaseBranch,
  listArchitectPlans,
  resolveTargetBranch,
  restoreArchitectPlan,
  saveArchitectPlanNeeds,
  setActiveArchitectPlan,
  toPlanIntegrationBranch,
  toPlanScopedFeatureBranch,
  updateArchitectPlan,
} from '../services/architectPlanService';
import { deletePlanAndCleanupBranches, validatePlanAndProvisionBranches } from '../services/architectGitFlowService';
import { normalizeArchitectToolId } from '../services/architectToolNames';

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
  updateLastMessage: (content: string) => void;
  appendToLastMessage: (token: string) => void;
  appendToMessage: (messageId: string, tokenChunk: string) => void;
  clearMessages: () => void;
  selectConversation: (conversationId: string) => void;
  createConversation: (
    title: string,
    taskId: string | null,
    projectId: string | null
  ) => Promise<Conversation>;
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

  const hasProviderCredentials = (providerId: string): boolean => {
    const provider = useProviderStore.getState().providerConfigs.find((candidate) => candidate.id === providerId);
    if (!provider || !provider.isEnabled) return false;
    return provider.isLocal || !!provider.apiKey?.trim();
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
    if (!provider.isLocal && !provider.apiKey?.trim()) {
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
      (provider) => provider.isEnabled && (provider.isLocal || !!provider.apiKey?.trim())
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

  const isSourceToolEnabled = (toolId: string): boolean => {
    const mode = useAppStore.getState().mode;
    const modePolicy = getToolModePolicy(mode);
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

    if (!isSourceToolEnabled(normalizedToolName)) {
      return `Tool ${normalizedToolName} is disabled for the current mode.`;
    }

    const resolveActivePlanId = (): string | null => {
      const appState = useAppStore.getState();
      return appState.activeArchitectPlanId;
    };

    const hydratePlanContext = async (targetBranch: string, planId: string): Promise<void> => {
      const plan = await getArchitectPlan(targetBranch, planId);
      if (!plan || plan.status === 'deleted') return;

      const appStore = useAppStore.getState();
      if (plan.projectId && appStore.selectedProjectId !== plan.projectId) {
        appStore.setSelectedProject(plan.projectId);
      }
      appStore.setActiveArchitectPlanId(plan.id);
      appStore.setPlanNodes(plan.nodes || []);
      appStore.setPredictedBranches(plan.predictedBranches || []);

      const planNeeds = await getArchitectPlanNeeds(targetBranch, plan.id);
      useNeedsStore.getState().replaceNeedsForPlan(plan.id, planNeeds);

      const plansIndex = await listArchitectPlans(targetBranch, true);
      let conversationId = plan.conversationId;
      const hasSharedConversation = Boolean(
        conversationId &&
        plansIndex.plans.some(
          (candidate) => candidate.id !== plan.id && candidate.conversationId === conversationId
        )
      );

      if (!conversationId || hasSharedConversation) {
        const fallbackProjectId =
          plan.projectId ||
          appStore.selectedProjectId ||
          appStore.projectGroups.flatMap((group) => group.projects)[0]?.id ||
          null;
        const created = await get().createConversation(
          `Plan · ${plan.title}`,
          null,
          fallbackProjectId
        );
        conversationId = created.id;
        await updateArchitectPlan({
          branchName: targetBranch,
          planId: plan.id,
          conversationId,
        });
      }

      if (conversationId) {
        get().selectConversation(conversationId);
      }
    };

    const allowedNodeTypes = new Set<PlanNodeType>(['spec', 'feature', 'task', 'milestone']);
    const allowedNodeStatuses = new Set<PlanNodeStatus>(['pending', 'in-progress', 'completed', 'blocked']);

    const normalizeNodeInput = (rawNode: unknown, index: number): {
      id?: string;
      title: string;
      description: string;
      type: PlanNodeType;
      assignedBranch: string;
      status: PlanNodeStatus;
      dependencies: string[];
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
      };
    };

    const buildPredictedBranches = (
      nodes: PlanNode[],
      resolvedProjectId: string | undefined,
      parentBranchName: string
    ): PredictedBranch[] => {
      const branchMap = new Map<string, string[]>();
      nodes.forEach((node) => {
        const branchName = node.assignedBranch || parentBranchName;
        if (!branchMap.has(branchName)) {
          branchMap.set(branchName, []);
        }
        branchMap.get(branchName)!.push(node.id);
      });

      const colors = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4'];
      return Array.from(branchMap.entries()).map(([name, taskIds], index) => ({
        id: `branch-${Date.now()}-${index}`,
        name,
        color: colors[index % colors.length],
        parentBranch: parentBranchName,
        projectId: resolvedProjectId || '',
        taskIds,
        status: 'pending' as const,
      }));
    };

    const resolveStrategyForPlan = async (params: {
      targetBranch: string;
      activePlanId: string;
      nodesInput: unknown[];
      reuseExistingIds?: boolean;
      existingNodesForPatch?: PlanNode[];
    }): Promise<{ planNodes: PlanNode[]; predictedBranches: PredictedBranch[]; resolvedProjectId: string | undefined; activePlanTitle: string; activePlanDescription: string }> => {
      const { targetBranch, activePlanId, nodesInput, reuseExistingIds = false, existingNodesForPatch = [] } = params;

      if (nodesInput.length === 0) {
        throw new Error('No nodes provided for strategy update.');
      }
      if (nodesInput.length > 250) {
        throw new Error('Strategy too large. Maximum 250 nodes.');
      }

      const appState = useAppStore.getState();
      let resolvedProjectId = appState.selectedProjectId;
      if (!resolvedProjectId && appState.selectedGroupId) {
        const group = appState.projectGroups.find((candidate) => candidate.id === appState.selectedGroupId);
        if (group?.projects.length) {
          resolvedProjectId = group.projects[0].id;
        }
      }
      if (!resolvedProjectId) {
        const firstProject = appState.projectGroups.flatMap((group) => group.projects)[0];
        resolvedProjectId = firstProject?.id;
      }

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
        return {
          id: preferredId && preferredId.length > 0 ? preferredId : `${idBase}-${index}`,
          title: node.title,
          description: node.description,
          type: node.type,
          assignedBranch: scopeBranchName(node.assignedBranch),
          status: node.status,
          projectId: resolvedProjectId || undefined,
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
        resolvedProjectId || undefined,
        toPlanIntegrationBranch(planSlug)
      );
      return {
        planNodes,
        predictedBranches,
        resolvedProjectId: resolvedProjectId || undefined,
        activePlanTitle: activePlan.title,
        activePlanDescription: activePlan.description,
      };
    };

    if (toolName === 'mark_source_passage') {
      const title = typeof args.title === 'string' ? args.title.trim() : '';
      const passage = typeof args.passage === 'string' ? args.passage.trim() : '';
      const rawKind = typeof args.kind === 'string' ? args.kind.trim().toLowerCase() : '';
      const kind = rawKind === 'interesting' ? 'interesting' : 'used';
      const reason = typeof args.reason === 'string' ? args.reason.trim() : undefined;
      if (!title || !passage) return 'Missing title or passage for source marking.';

      useCitationsStore.getState().addSourcePassage({
        conversationId,
        messageId: assistantMessageId,
        title,
        passage,
        source: typeof args.source === 'string' ? args.source : undefined,
        url: typeof args.url === 'string' ? args.url : undefined,
        kind,
        reason,
      });
      return `Source passage marked successfully (kind=${kind}).`;
    }

    if (toolName === 'read_sources') {
      const kindArg = typeof args.kind === 'string' ? args.kind.trim().toLowerCase() : 'all';
      const kind = kindArg === 'interesting' || kindArg === 'used' ? kindArg : 'all';
      const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
      const includeSnippet = args.include_snippet !== false;
      const rawLimit = typeof args.limit === 'number' ? Math.floor(args.limit) : 10;
      const limit = Math.max(1, Math.min(50, rawLimit));

      const all = useCitationsStore.getState().getConversationSourceCitations(conversationId);
      const filtered = all.filter((citation) => {
        const citationKind = citation.kind || 'used';
        if (kind !== 'all' && citationKind !== kind) return false;
        if (!query) return true;
        return [citation.title, citation.snippet, citation.source, citation.url, citation.reason]
          .filter(Boolean)
          .some((value) => value!.toLowerCase().includes(query));
      });

      const items = filtered.slice(0, limit).map((citation) => ({
        citation_id: citation.id,
        kind: citation.kind || 'used',
        title: citation.title,
        source: citation.source,
        url: citation.url,
        reason: citation.reason,
        message_id: citation.messageId,
        timestamp: citation.timestamp,
        ...(includeSnippet ? { passage: citation.snippet || '' } : {}),
      }));

      return JSON.stringify(
        {
          total: all.length,
          matched: filtered.length,
          returned: items.length,
          items,
        },
        null,
        2
      );
    }

    if (toolName === 'edit_source_passage') {
      const citationId = typeof args.citation_id === 'string' ? args.citation_id.trim() : '';
      const action = typeof args.action === 'string' ? args.action.trim().toLowerCase() : '';
      if (!citationId || !action) return 'Missing citation_id or action for edit_source_passage.';

      const citationsStore = useCitationsStore.getState();
      const citation = citationsStore
        .getConversationSourceCitations(conversationId)
        .find((c) => c.id === citationId);
      if (!citation) return `Source citation not found: ${citationId}`;

      if (action === 'delete') {
        citationsStore.removeCitation(citationId);
        return `Deleted source citation ${citationId}.`;
      }

      if (action === 'reclassify') {
        const rawKind = typeof args.kind === 'string' ? args.kind.trim().toLowerCase() : '';
        if (rawKind !== 'interesting' && rawKind !== 'used') {
          return 'Invalid kind for reclassify. Use "interesting" or "used".';
        }
        const updated = citationsStore.updateSourcePassage({
          conversationId,
          citationId,
          kind: rawKind,
        });
        return updated
          ? `Reclassified source citation ${citationId} to ${rawKind}.`
          : `Failed to reclassify source citation ${citationId}.`;
      }

      if (action === 'update') {
        const rawKind = typeof args.kind === 'string' ? args.kind.trim().toLowerCase() : '';
        const normalizedKind = rawKind === 'interesting' || rawKind === 'used' ? rawKind : undefined;
        const updated = citationsStore.updateSourcePassage({
          conversationId,
          citationId,
          title: typeof args.title === 'string' ? args.title : undefined,
          passage: typeof args.passage === 'string' ? args.passage : undefined,
          source: typeof args.source === 'string' ? args.source : undefined,
          url: typeof args.url === 'string' ? args.url : undefined,
          reason:
            typeof args.reason === 'string'
              ? args.reason
              : args.reason === null
                ? null
                : undefined,
          kind: normalizedKind,
        });
        return updated
          ? `Updated source citation ${citationId}.`
          : `Failed to update source citation ${citationId}.`;
      }

      return `Unsupported action for edit_source_passage: ${action}`;
    }

    if (normalizedToolName === 'plan_list') {
      const targetBranch = resolveTargetBranch(args.target_branch);
      const includeDeleted = args.include_deleted === true;
      const result = await listArchitectPlans(targetBranch, includeDeleted);
      return JSON.stringify(
        {
          macro_branch: '.macro',
          target_branch: targetBranch,
          active_plan_id: result.activePlanId,
          count: result.plans.length,
          plans: result.plans,
        },
        null,
        2
      );
    }

    if (normalizedToolName === 'plan_create') {
      const title = typeof args.title === 'string' ? args.title.trim() : '';
      if (!title) {
        return 'Missing title for plan_create.';
      }

      const targetBranch = resolveTargetBranch(args.target_branch);
      const status = typeof args.status === 'string' ? args.status.trim().toLowerCase() : undefined;
      const allowedStatuses = new Set(['draft', 'validated', 'in_progress', 'archived', 'deleted']);
      const normalizedStatus = status && allowedStatuses.has(status) ? (status as any) : undefined;

      const appState = useAppStore.getState();
      const chatState = get();
      const fallbackProjectId =
        appState.selectedProjectId ||
        appState.projectGroups.flatMap((group) => group.projects)[0]?.id ||
        null;
      const created = await chatState.createConversation(`Plan · ${title}`, null, fallbackProjectId);
      const conversationId: string | undefined = created.id;

      const plan = await createArchitectPlan({
        branchName: targetBranch,
        title,
        slug: title,
        description: typeof args.description === 'string' ? args.description : '',
        conversationId,
        projectId: useAppStore.getState().selectedProjectId || undefined,
        status: normalizedStatus,
        setActive: args.set_active !== false,
      });

      if ((args.set_active !== false) && plan.status !== 'deleted') {
        await hydratePlanContext(targetBranch, plan.id);
      }

      return `Created plan "${plan.title}" (id: ${plan.id}) with dedicated conversation ${plan.conversationId || 'none'} on ${targetBranch}.`;
    }

    if (normalizedToolName === 'plan_get') {
      const planId = typeof args.plan_id === 'string' ? args.plan_id.trim() : '';
      if (!planId) {
        return 'Missing plan_id for plan_get.';
      }

      const targetBranch = resolveTargetBranch(args.target_branch);
      const plan = await getArchitectPlan(targetBranch, planId);
      if (!plan) {
        return `Plan not found: ${planId} (target branch: ${targetBranch}).`;
      }

      if (args.select === true && plan.status !== 'deleted') {
        await hydratePlanContext(targetBranch, plan.id);
      }

      const needs = await getArchitectPlanNeeds(targetBranch, plan.id);
      return JSON.stringify({ macro_branch: '.macro', plan, needs_count: needs.length }, null, 2);
    }

    if (normalizedToolName === 'plan_set_active') {
      const planId = typeof args.plan_id === 'string' ? args.plan_id.trim() : '';
      if (!planId) {
        return 'Missing plan_id for plan_set_active.';
      }

      const targetBranch = resolveTargetBranch(args.target_branch);
      await setActiveArchitectPlan(targetBranch, planId);
      await hydratePlanContext(targetBranch, planId);

      return `Active plan is now ${planId} for target branch ${targetBranch}.`;
    }

    if (normalizedToolName === 'plan_update') {
      const planId = typeof args.plan_id === 'string' ? args.plan_id.trim() : '';
      if (!planId) {
        return 'Missing plan_id for plan_update.';
      }
      const targetBranch = resolveTargetBranch(args.target_branch);
      const status = typeof args.status === 'string' ? args.status.trim().toLowerCase() : undefined;
      const allowedStatuses = new Set(['draft', 'validated', 'in_progress', 'archived', 'deleted']);
      if (status && !allowedStatuses.has(status)) {
        return `Invalid status for plan_update: ${status}.`;
      }

      const requestedTitle = typeof args.title === 'string' ? args.title : undefined;
      const requestedDescription = typeof args.description === 'string' ? args.description : undefined;
      const shouldSetActive = args.set_active === true;

      if (status === 'validated') {
        const updatedMetadata = await updateArchitectPlan({
          branchName: targetBranch,
          planId,
          title: requestedTitle,
          description: requestedDescription,
          setActive: shouldSetActive,
        });

        const { plan: validatedPlan, provision } = await validatePlanAndProvisionBranches({
          branchName: targetBranch,
          planId: updatedMetadata.id,
          setActive: shouldSetActive,
        });

        if (!shouldSetActive) {
          const appStore = useAppStore.getState();
          if (appStore.activeArchitectPlanId === validatedPlan.id && validatedPlan.status !== 'deleted') {
            appStore.setActivePlanContext({
              id: validatedPlan.id,
              title: validatedPlan.title,
              description: validatedPlan.description,
              status: validatedPlan.status,
              targetBranch: validatedPlan.targetBranch,
            });
          }
        }

        if (shouldSetActive && validatedPlan.status !== 'deleted') {
          await hydratePlanContext(targetBranch, validatedPlan.id);
        }

        const createdCount = (provision.createdPlanBranch ? 1 : 0) + provision.createdFeatureBranches.length;
        return createdCount > 0
          ? `Validated plan ${validatedPlan.id} and provisioned ${createdCount} branch${createdCount > 1 ? 'es' : ''}.`
          : `Validated plan ${validatedPlan.id}; branches were already provisioned.`;
      }

      const updatedPlan = await updateArchitectPlan({
        branchName: targetBranch,
        planId,
        title: requestedTitle,
        description: requestedDescription,
        status: status as any,
        setActive: shouldSetActive,
      });

      if (!shouldSetActive) {
        const appStore = useAppStore.getState();
        if (appStore.activeArchitectPlanId === updatedPlan.id && updatedPlan.status !== 'deleted') {
          appStore.setActivePlanContext({
            id: updatedPlan.id,
            title: updatedPlan.title,
            description: updatedPlan.description,
            status: updatedPlan.status,
            targetBranch: updatedPlan.targetBranch,
          });
        }
      }

      if (shouldSetActive && updatedPlan.status !== 'deleted') {
        await hydratePlanContext(targetBranch, updatedPlan.id);
      }

      return `Updated plan ${updatedPlan.id} (status: ${updatedPlan.status}).`;
    }

    if (normalizedToolName === 'plan_delete') {
      const planId = typeof args.plan_id === 'string' ? args.plan_id.trim() : '';
      if (!planId) {
        return 'Missing plan_id for plan_delete.';
      }
      const targetBranch = resolveTargetBranch(args.target_branch);
      const hardDelete = args.hard_delete === true;

      const { deletedBranches } = await deletePlanAndCleanupBranches({
        branchName: targetBranch,
        planId,
        hardDelete,
      });

      if (useAppStore.getState().activeArchitectPlanId === planId) {
        useAppStore.getState().setActiveArchitectPlanId(null);
        useAppStore.getState().setPlanNodes([]);
        useAppStore.getState().setPredictedBranches([]);
      }

      const action = hardDelete ? 'Purged' : 'Soft-deleted';
      return `${action} plan ${planId} on target branch ${targetBranch}. Deleted ${deletedBranches.length} associated git branch${deletedBranches.length > 1 ? 'es' : ''}.`;
    }

    if (normalizedToolName === 'plan_restore') {
      const planId = typeof args.plan_id === 'string' ? args.plan_id.trim() : '';
      if (!planId) {
        return 'Missing plan_id for plan_restore.';
      }
      const targetBranch = resolveTargetBranch(args.target_branch);
      const plan = await restoreArchitectPlan(targetBranch, planId);
      await hydratePlanContext(targetBranch, plan.id);
      return `Restored plan ${plan.id} on target branch ${targetBranch}.`;
    }

    if (normalizedToolName === 'need_add') {
      const targetBranch = getGitFlowBaseBranch();
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

      const allowedCategories = new Set(['functional', 'technical', 'ux', 'security', 'other']);
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

    if (normalizedToolName === 'strategy_generate') {
      const targetBranch = getGitFlowBaseBranch();
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
      const inputTitle = typeof args.plan_title === 'string' && args.plan_title.trim().length > 0
        ? args.plan_title.trim()
        : activePlan?.title || `Plan ${new Date().toISOString().slice(0, 10)}`;
      const inputDescription = typeof args.plan_description === 'string'
        ? args.plan_description
        : activePlan?.description || '';

      await updateArchitectPlan({
        branchName: targetBranch,
        planId: activePlanId,
        title: inputTitle,
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
      const targetBranch = getGitFlowBaseBranch();
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
          macro_branch: '.macro',
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
      const targetBranch = getGitFlowBaseBranch();
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
        title: activePlan.title,
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
      const targetBranch = getGitFlowBaseBranch();
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
        title: activePlan.title,
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
      normalizedToolName.startsWith('git_')
    ) {
      const mode = useAppStore.getState().mode;
      return executeWorkspaceTool(normalizedToolName, args, mode);
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
    messageWithImagesId?: string
  ) => {
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
        messageContent = sanitizeAssistantContentForModel(messageContent);
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
    if (useAppStore.getState().mode === 'Debug') {
      systemInstructions.push(
        'In Debug mode, for any question about current directory, file existence, path, or file content, you MUST call workspace tools first (list/read). ' +
        'If filename is ambiguous (example: "readme"), list the directory first and then read the exact matched filename (example: README.md). ' +
        'If a read fails, report the exact tool error and ask for a precise path. Never invent file content or project paths.'
      );
    }

    const appMode = useAppStore.getState().mode;
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

    if (appMode === 'Architect') {
      systemInstructions.push(
        'In Architect mode, do not call `strategy_generate` automatically. Only call it after an explicit user request to generate/regenerate strategy (for example via the Generate Strategy button or a direct instruction in chat).'
      );
      systemInstructions.push(
        'Git workflow for plans is strict: integration branch is `plan/<plan-slug>` from `develop`; strategy branches must be `feature/<plan-slug>/<feature-slug>` and are intended to merge into the plan branch in dependency order.'
      );
      const activePlanContext = useAppStore.getState().activePlanContext;
      if (activePlanContext) {
        systemInstructions.push(
          `[Active Plan] id="${activePlanContext.id}", title="${activePlanContext.title}", description="${activePlanContext.description || 'none'}", status="${activePlanContext.status}", targetBranch="${activePlanContext.targetBranch}". When the user describes their project or requests changes, first write a message proposing updated title/description, then call plan_update to apply them.`
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

  const isConversationAllowedForMode = (
    conversation: Conversation,
    mode: AppMode,
    selectedProjectId: string | null,
    selectedTaskId: string | null
  ): boolean => {
    if (mode === 'Chat' || mode === 'Debug') {
      return !conversation.project_id && !conversation.task_id;
    }

    if (mode === 'Architect') {
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
    selectedProjectId: string | null,
    selectedTaskId: string | null
  ): string | null => {
    const scoped = conversations
      .filter((conversation) =>
        isConversationAllowedForMode(conversation, mode, selectedProjectId, selectedTaskId)
      )
      .sort((a, b) =>
        new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
      );

    return scoped[0]?.id ?? null;
  };

  const getAllowedToolIdsForCurrentMode = (): string[] => {
    const mode = useAppStore.getState().mode;
    const modePolicy = getToolModePolicy(mode);
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
        const updatedMessages = state.messages.map((message) =>
          message.id === messageId ? { ...message, content } : message
        );

        const updatedMessage = state.messages.find((message) => message.id === messageId);
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

    createConversation: async (title, taskId, projectId) => {
      let newConversation: Conversation;
      const mode = useAppStore.getState().mode;

      if (tauriIpc.isTauriAvailable()) {
        try {
          const dbConv = await tauriIpc.createConversation({
            title,
            taskId,
            projectId,
          });
          newConversation = {
            id: dbConv.id,
            title: dbConv.title,
            description: dbConv.description || '',
            task_id: dbConv.task_id,
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

    ensureConversationForCurrentMode: async () => {
      const appState = useAppStore.getState();
      const state = get();
      const mode = appState.mode;
      const selectedProjectId = appState.selectedProjectId;
      const selectedTaskId = appState.selectedTaskId;

      if (mode === 'Debug') {
        const debugFallback = getFallbackConversationIdForMode(
          state.conversations,
          'Debug',
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

      const rememberedId = state.selectedConversationIdsByMode[mode] ?? null;
      const rememberedConversation = rememberedId
        ? state.conversations.find((conversation) => conversation.id === rememberedId)
        : null;

      if (
        rememberedConversation &&
        isConversationAllowedForMode(
          rememberedConversation,
          mode,
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

      if (mode === 'Architect' && selectedProjectId) {
        const project = appState.getProjectById(selectedProjectId);
        const title = project ? `Architect · ${project.name}` : 'Architect Session';
        const created = await get().createConversation(title, null, selectedProjectId);
        return created.id;
      }

      if (mode === 'Implement' && selectedTaskId) {
        const task = appState.currentPlan?.tasks.find((candidate) => candidate.id === selectedTaskId);
        const title = task ? `Task · ${task.title}` : 'Task Session';
        const projectId = task?.project_id ?? selectedProjectId;
        const created = await get().createConversation(title, selectedTaskId, projectId ?? null);
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
      } else if (conversation.project_id) {
        const projectName =
          useAppStore.getState().getProjectById(conversation.project_id)?.name?.trim() || null;

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
      persistSelectionForContext(useAppStore.getState().mode, conversationId);

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
        task_id: taskId ?? '',
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
            task_id: taskId ?? '',
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
      const allowedToolIds = getAllowedToolIdsForCurrentMode();
      const showToolTraces = useAppStore.getState().mode === 'Debug';
      const messagesForRequest = await prepareMessagesForRequest(
        conversationId,
        allowedToolIds,
        userMessage.id
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
        task_id: taskId ?? '',
        conversation_id: conversationId,
        role: 'assistant',
        content: '',
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
          onComplete: (fullContent) => {
            tokenBatcher.flushNow();
            get().updateMessageContent(assistantMessage.id, fullContent);

            // Update conversation metadata
            set((state) => {
              const conversations = state.conversations.map((conv) =>
                conv.id === conversationId
                  ? {
                    ...conv,
                    last_message: fullContent.slice(0, 100) + (fullContent.length > 100 ? '...' : ''),
                    updated_at: new Date().toISOString(),
                  }
                  : conv
              );
              return { conversations, isLoading: false, isStreaming: false, abortController: null };
            });

            // Save assistant message to DB if available
            if (tauriIpc.isTauriAvailable()) {
              tauriIpc.createMessage(conversationId, 'assistant', fullContent).catch(console.error);
            }
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
      const allowedToolIds = getAllowedToolIdsForCurrentMode();
      const showToolTraces = useAppStore.getState().mode === 'Debug';
      const messagesForRequest = await prepareMessagesForRequest(
        conversationId,
        allowedToolIds,
        messageId
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
          onComplete: (fullContent) => {
            tokenBatcher.flushNow();
            get().updateMessageContent(assistantMessage.id, fullContent);

            set((state) => {
              const conversations = state.conversations.map((conv) =>
                conv.id === conversationId
                  ? {
                    ...conv,
                    last_message: fullContent.slice(0, 100) + (fullContent.length > 100 ? '...' : ''),
                    updated_at: new Date().toISOString(),
                  }
                  : conv
              );
              return { conversations, isLoading: false, isStreaming: false, abortController: null };
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
                id: m.id,
                task_id: conversationById.get(m.conversation_id)?.task_id ?? '',
                conversation_id: m.conversation_id,
                role: m.role as 'user' | 'assistant',
                content: m.content,
                timestamp: m.created_at,
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
