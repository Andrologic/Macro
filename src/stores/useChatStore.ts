import { create } from 'zustand';
import { AppMode, ChatMessage, ContextRefKind, ContextReference, Conversation, PlanNode, PlanNodeStatus, PlanNodeType, PredictedBranch, ToolTrace } from '../types';
import { toServiceError } from '../services/contracts/errors';
import { useProviderStore } from './useProviderStore';
import { useCitationsStore } from './useCitationsStore';
import { streamChat, cancelStream, sendChatNonStreaming, type StreamCompletionResult, type StreamMessage } from '../services/streamingChat';
import { getStreamingWebSearchConfig } from '../services/webSearchSettings';
import { useToolsStore } from './useToolsStore';
import { useAppStore } from './useAppStore';
import { useTaskStore, type ImplementTask } from './useTaskStore';
import { getToolModePolicy as getLocalToolModePolicy } from '../services/toolModePolicy';
import { executeWorkspaceTool } from '../services/workspaceToolExecutor';
import { loadPreference, PREF_KEYS, savePreference } from '../services/preferences';
import { useNeedsStore } from './useNeedsStore';
import { useTerminalStore } from './useTerminalStore';
import { devLogger } from '../utils/devLogger';
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
  syncArchitectPlanChatFromConversation,
  toPlanIntegrationBranch,
  toPlanScopedFeatureBranch,
  updateArchitectPlan,
} from '../services/architectPlanService';
import {
  getArchitectPlanConversationTitle,
  getArchitectPlanDisplayName,
  isDefaultNewPlanFamilyLabel,
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
import { filterCopilotSupportedToolIds } from '../shared/macroToolRegistry';

const METADATA_MAX_TITLE_LENGTH = 72;
const METADATA_MAX_DESCRIPTION_LENGTH = 180;
const MANUAL_FEATURE_MAX_SLUG_LENGTH = 64;
const MANUAL_FEATURE_METADATA_ATTEMPT_LIMIT = 4;
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

const extractJsonObjectFromModelOutput = (raw: string): Record<string, unknown> => {
  const noThinking = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const firstBrace = noThinking.indexOf('{');
  const lastBrace = noThinking.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace <= firstBrace) {
    throw new Error('No JSON object found');
  }

  return JSON.parse(noThinking.slice(firstBrace, lastBrace + 1)) as Record<string, unknown>;
};

const extractMetadataFromModelOutput = (raw: string): { title: string; description: string } => {
  const parsed = extractJsonObjectFromModelOutput(raw) as {
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

const normalizeManualFeatureSlugInput = (value: string): string => {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^refs\/heads\//, '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '');
  const leaf = normalized.split('/').filter(Boolean).pop() || normalized;
  return (
    leaf
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+/, '')
      .replace(/-+$/, '')
      .slice(0, MANUAL_FEATURE_MAX_SLUG_LENGTH) || 'work'
  );
};

const extractManualFeatureMetadataFromModelOutput = (raw: string): {
  title: string;
  description: string;
  featureSlug: string;
} => {
  const parsed = extractJsonObjectFromModelOutput(raw) as {
    title?: unknown;
    description?: unknown;
    featureSlug?: unknown;
  };

  if (
    typeof parsed.title !== 'string' ||
    typeof parsed.description !== 'string' ||
    typeof parsed.featureSlug !== 'string'
  ) {
    throw new Error('Invalid manual feature metadata shape');
  }

  const title = parsed.title.replace(/\s+/g, ' ').trim().slice(0, METADATA_MAX_TITLE_LENGTH);
  const description = parsed.description
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, METADATA_MAX_DESCRIPTION_LENGTH);
  const featureSlug = normalizeManualFeatureSlugInput(parsed.featureSlug);

  if (!title || !description || !featureSlug) {
    throw new Error('Empty manual feature metadata values');
  }

  return { title, description, featureSlug };
};

const buildManualFeatureFallbackMetadata = (content: string) => {
  const title = getConversationFallbackTitle(content);
  const description = getConversationFallbackDescription(content);
  const featureSlug = normalizeManualFeatureSlugInput(title || content);
  return { title, description, featureSlug };
};

const normalizeComparableBranchName = (value: string): string =>
  value
    .trim()
    .replace(/^refs\/heads\//, '')
    .replace(/^refs\/remotes\//, '');

const branchNameMatchesCandidate = (existingBranchName: string, candidateBranchName: string): boolean => {
  const normalizedExisting = normalizeComparableBranchName(existingBranchName);
  return (
    normalizedExisting === candidateBranchName ||
    normalizedExisting.endsWith(`/${candidateBranchName}`)
  );
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

type ChatHydrationStatus = 'idle' | 'hydrating' | 'ready' | 'error';
type ChatRestoreStatus = 'idle' | 'resolving' | 'ready' | 'error';
type ChatContextKey = string;
type ChatSendState = 'idle' | 'preparing' | 'streaming' | 'error';

interface ChatSendResult {
  status: 'sent';
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
}

interface ArchitectTranscriptState {
  dbCount: number;
  metadataCount: number;
  relation: 'equal' | 'db_prefix' | 'metadata_prefix' | 'diverged';
}

interface ChatStore {
  messages: ChatMessage[];
  conversations: Conversation[];
  selectedConversationId: string | null;
  selectedConversationIdsByMode: Partial<Record<AppMode, string | null>>;
  hydrationStatus: ChatHydrationStatus;
  restoreStatus: ChatRestoreStatus;
  activeContextKey: ChatContextKey | null;
  selectionRequestId: number;
  isLoading: boolean;
  isStreaming: boolean;
  sendState: ChatSendState;
  lastError: string | null;
  abortController: AbortController | null;
  messageImagesByMessageId: Record<string, MessageImageAttachment[]>;
  addMessage: (message: ChatMessage) => void;
  clearLastError: () => void;
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
  deleteChatConversations: (conversationIds: string[]) => Promise<void>;
  markAsRead: (conversationId: string) => void;
  getConversationByTask: (taskId: string) => Conversation | undefined;
  getConversationMessages: (conversationId: string) => ChatMessage[];
  sendMessage: (payload: {
    conversationId: string;
    content: string;
    taskId?: string | null;
    images?: MessageImageAttachment[];
  }) => Promise<ChatSendResult>;
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

interface TranscriptComparableMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}

const mapDbConversationToConversation = (conversation: tauriIpc.DbConversation): Conversation => ({
  id: conversation.id,
  title: conversation.title,
  description: conversation.description || '',
  task_id: conversation.task_id,
  group_id: conversation.group_id,
  project_id: conversation.project_id,
  last_message: conversation.last_message || '',
  message_count: conversation.message_count,
  updated_at: conversation.updated_at,
  is_unread: false,
});

const mapDbMessageToChatMessage = (
  message: tauriIpc.DbMessage,
  conversationById: Map<string, Conversation>
): ChatMessage => {
  const taskId = conversationById.get(message.conversation_id)?.task_id ?? '';
  if (message.role === 'assistant') {
    const parsed = parseMessageQuickReplies(message.content);
    return {
      id: message.id,
      task_id: taskId,
      conversation_id: message.conversation_id,
      role: message.role as 'user' | 'assistant',
      content: parsed.content,
      timestamp: message.created_at,
      choices: parsed.choices,
      allow_free_response: parsed.allowFreeResponse,
    };
  }

  return {
    id: message.id,
    task_id: taskId,
    conversation_id: message.conversation_id,
    role: message.role as 'user' | 'assistant',
    content: message.content,
    timestamp: message.created_at,
  };
};

const buildChatContextKey = (appState: Pick<
  ReturnType<typeof useAppStore.getState>,
  'mode' | 'selectedGroupId' | 'selectedProjectId' | 'selectedTaskId' | 'activeArchitectPlanId' | 'activePlanContext'
>): ChatContextKey => {
  return [
    appState.mode,
    appState.selectedGroupId || 'none',
    appState.selectedProjectId || 'none',
    appState.selectedTaskId || 'none',
    appState.activeArchitectPlanId || 'none',
    appState.activePlanContext?.targetBranch || 'none',
  ].join('::');
};

const toComparableChatMessage = (message: ChatMessage): TranscriptComparableMessage => ({
  id: message.id,
  role: message.role,
  content: message.content,
  createdAt: message.timestamp,
});

const getStrictTranscriptFingerprint = (message: TranscriptComparableMessage): string => {
  const trimmedId = message.id.trim();
  if (trimmedId.length > 0) {
    return `id:${trimmedId}`;
  }
  return `f:${message.role}:${message.content}:${message.createdAt}`;
};

const getSemanticTranscriptFingerprint = (message: TranscriptComparableMessage): string =>
  `s:${message.role}:${message.content}`;

const compareTranscriptSequence = (
  dbMessages: TranscriptComparableMessage[],
  metadataMessages: TranscriptComparableMessage[],
  fingerprintFor: (message: TranscriptComparableMessage) => string
): ArchitectTranscriptState => {
  const sharedLength = Math.min(dbMessages.length, metadataMessages.length);

  for (let index = 0; index < sharedLength; index += 1) {
    if (fingerprintFor(dbMessages[index]!) !== fingerprintFor(metadataMessages[index]!)) {
      return {
        dbCount: dbMessages.length,
        metadataCount: metadataMessages.length,
        relation: 'diverged',
      };
    }
  }

  if (dbMessages.length === metadataMessages.length) {
    return {
      dbCount: dbMessages.length,
      metadataCount: metadataMessages.length,
      relation: 'equal',
    };
  }

  return {
    dbCount: dbMessages.length,
    metadataCount: metadataMessages.length,
    relation: dbMessages.length < metadataMessages.length ? 'db_prefix' : 'metadata_prefix',
  };
};

const compareArchitectTranscriptState = (
  dbMessages: TranscriptComparableMessage[],
  metadataMessages: TranscriptComparableMessage[]
): ArchitectTranscriptState => {
  const strictState = compareTranscriptSequence(
    dbMessages,
    metadataMessages,
    getStrictTranscriptFingerprint
  );
  if (strictState.relation !== 'diverged') {
    return strictState;
  }

  return compareTranscriptSequence(
    dbMessages,
    metadataMessages,
    getSemanticTranscriptFingerprint
  );
};

export const useChatStore = create<ChatStore>((set, get) => {
  let aiSelections = { ...EMPTY_AI_CONTEXT_SELECTIONS };
  let aiSelectionsLoaded = false;
  let providerSelectionUnsubscribe: (() => void) | null = null;
  let contextSelectionUnsubscribe: (() => void) | null = null;
  let hydrationPromise: Promise<void> | null = null;

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
    if (provider.providerType === 'chatgpt') {
      return ['authenticated', 'refreshing', 'expired'].includes(provider.authStatus ?? '');
    }

    if (provider.providerType === 'copilot') {
      return provider.authStatus === 'connected';
    }

    return false;
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

  const pruneConversationSelections = (conversations: Conversation[]) => {
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
  };

  const waitForHydration = async (): Promise<void> => {
    if (get().hydrationStatus !== 'hydrating' || !hydrationPromise) {
      return;
    }

    try {
      await hydrationPromise;
    } catch {
      // A failed hydration already updates store state.
    }
  };

  const buildSendError = (message: string): Error => new Error(message);

  const assertImplementTaskReadyForSend = async (taskId: string): Promise<ImplementTask> => {
    const taskStore = useTaskStore.getState();
    const task = taskStore.getTaskById(taskId);

    if (!task) {
      throw buildSendError(`Unknown task: ${taskId}`);
    }

    if (task.draft) {
      return task;
    }

    if (task.status === 'Pending') {
      await taskStore.startTask(taskId);
    } else if (task.status === 'AwaitingResponse' || task.status === 'Failed') {
      await taskStore.retryTask(taskId);
    }

    const refreshedTask = useTaskStore.getState().getTaskById(taskId);
    if (!refreshedTask) {
      throw buildSendError(`Unknown task: ${taskId}`);
    }

    if (refreshedTask.draft) {
      throw buildSendError(
        useTaskStore.getState().lastError || 'Task is still in draft mode and cannot receive messages yet.'
      );
    }

    if (refreshedTask.status !== 'InProgress') {
      throw buildSendError(
        useTaskStore.getState().lastError ||
          `Task ${taskId} is not ready to receive a message (current status: ${refreshedTask.status}).`
      );
    }

    return refreshedTask;
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

  const ensureContextSelectionSync = () => {
    if (contextSelectionUnsubscribe) return;

    contextSelectionUnsubscribe = useAppStore.subscribe((nextState, previousState) => {
      if (buildChatContextKey(nextState) === buildChatContextKey(previousState)) {
        return;
      }
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
    messageWithImagesId?: string
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
    if (useAppStore.getState().mode === 'Debug') {
      systemInstructions.push(
        'In Debug mode, for any question about current directory, file existence, path, or file content, you MUST call workspace tools first (list/read). ' +
        'If filename is ambiguous (example: "readme"), list the directory first and then read the exact matched filename (example: README.md). ' +
        'If a read fails, report the exact tool error and ask for a precise path. Never invent file content or project paths.'
      );
    }

    const appMode = appState.mode;
    const agentType =
      appMode === 'Architect'
        ? 'plan'
        : appMode === 'Implement'
          ? appState.agentType
          : null;
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

    return {
      messages: [
        {
          role: 'system' as const,
          content: systemInstructions.join(' ') || 'Use context information when it is provided.',
        },
        ...preparedMessages,
      ],
      executionContext,
    };
  };

  const recalcConversation = (
    conversationId: string,
    messages: ChatMessage[],
    updatedAt?: string
  ) => {
    const conversationMessages = messages.filter(
      (message) => message.conversation_id === conversationId
    );
    const lastMessage = conversationMessages[conversationMessages.length - 1];
    return {
      message_count: conversationMessages.length,
      last_message: lastMessage?.content ?? '',
      updated_at: updatedAt ?? new Date().toISOString(),
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

  const getLatestConversationForTask = (
    taskId: string,
    conversations: Conversation[] = get().conversations
  ): Conversation | null =>
    conversations
      .filter((conversation) => conversation.task_id === taskId)
      .sort((a, b) =>
        new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
      )[0] ?? null;

  type ConversationRemovalSnapshot = Pick<
    ChatStore,
    | 'conversations'
    | 'messages'
    | 'messageImagesByMessageId'
    | 'selectedConversationId'
    | 'selectedConversationIdsByMode'
  >;

  const buildConversationRemovalSnapshot = (): ConversationRemovalSnapshot => {
    const state = get();
    return {
      conversations: state.conversations,
      messages: state.messages,
      messageImagesByMessageId: state.messageImagesByMessageId,
      selectedConversationId: state.selectedConversationId,
      selectedConversationIdsByMode: state.selectedConversationIdsByMode,
    };
  };

  const buildConversationRemovalState = (
    state: ConversationRemovalSnapshot,
    conversationIds: string[]
  ): ConversationRemovalSnapshot => {
    const idsToRemove = new Set(conversationIds);
    const appState = useAppStore.getState();
    const nextConversations = state.conversations.filter(
      (conversation) => !idsToRemove.has(conversation.id)
    );
    const nextMessages = state.messages.filter(
      (message) => !idsToRemove.has(message.conversation_id)
    );
    const remainingMessageIds = new Set(nextMessages.map((message) => message.id));
    const nextImages = Object.fromEntries(
      Object.entries(state.messageImagesByMessageId).filter(([messageId]) =>
        remainingMessageIds.has(messageId)
      )
    );
    saveMessageImagesToStorage(nextImages);

    const nextByMode = { ...state.selectedConversationIdsByMode };
    (Object.keys(nextByMode) as AppMode[]).forEach((modeKey) => {
      if (nextByMode[modeKey] && idsToRemove.has(nextByMode[modeKey]!)) {
        nextByMode[modeKey] = null;
      }
    });

    const fallbackForCurrentMode = getFallbackConversationIdForMode(
      nextConversations,
      appState.mode,
      appState.selectedGroupId,
      appState.selectedProjectId,
      appState.selectedTaskId
    );

    const nextSelectedConversationId =
      state.selectedConversationId && idsToRemove.has(state.selectedConversationId)
        ? fallbackForCurrentMode
        : state.selectedConversationId;

    nextByMode[appState.mode] =
      nextSelectedConversationId &&
      nextConversations.some((conversation) => conversation.id === nextSelectedConversationId)
        ? nextSelectedConversationId
        : fallbackForCurrentMode;

    return {
      conversations: nextConversations,
      messages: nextMessages,
      messageImagesByMessageId: nextImages,
      selectedConversationId: nextSelectedConversationId,
      selectedConversationIdsByMode: nextByMode,
    };
  };

  const applyLocalConversationRemoval = (conversationIds: string[]) => {
    if (conversationIds.length === 0) {
      return;
    }
    set((state) => buildConversationRemovalState(state, conversationIds));
  };

  const restoreConversationRemovalSnapshot = (snapshot: ConversationRemovalSnapshot) => {
    saveMessageImagesToStorage(snapshot.messageImagesByMessageId);
    set(snapshot);
  };

  const getAllowedToolIdsForCurrentMode = async (): Promise<string[]> => {
    if (!useProviderStore.getState().selectedSupportsNativeToolCalling()) {
      return [];
    }

    const providerState = useProviderStore.getState();
    const selectedProvider = providerState.providerConfigs.find(
      (provider) => provider.id === providerState.selectedProviderId
    );
    const filterForSelectedProvider = (toolIds: string[]): string[] =>
      selectedProvider?.providerType === 'copilot'
        ? filterCopilotSupportedToolIds(toolIds)
        : toolIds;

    const mode = useAppStore.getState().mode;
    const modePolicy = await getModePolicyForCurrentMode();
    const toolsState = useToolsStore.getState();

    if (mode === 'Chat') {
      const enabledChatTools = toolsState.getEnabledChatToolIds();
      return filterForSelectedProvider(
        enabledChatTools.filter((toolId) => modePolicy.allowedToolIds.includes(toolId))
      );
    }

    if (mode === 'Debug') {
      const enabledTools = Object.values(toolsState.internalTools)
        .filter((tool) => toolsState.isToolEnabled(tool.id))
        .map((tool) => tool.id);
      return filterForSelectedProvider(
        enabledTools.filter((toolId) => modePolicy.allowedToolIds.includes(toolId))
      );
    }

    const enabledTools = Object.values(toolsState.internalTools)
      .filter((tool) => toolsState.isToolEnabled(tool.id))
      .map((tool) => tool.id);

    return filterForSelectedProvider(
      enabledTools.filter((toolId) => modePolicy.allowedToolIds.includes(toolId))
    );
  };

  const buildGuidedToolRetryPolicy = (params: {
    userContent: string;
    allowedToolIds: string[];
    fileToolContext: Array<{ title: string; source: string; path?: string; snippet?: string }>;
  }) => {
    if (!useProviderStore.getState().selectedSupportsNativeToolCalling()) {
      return undefined;
    }

    if (params.fileToolContext.length > 0 && params.allowedToolIds.includes('read_file')) {
      return {
        requiredToolNames: ['read_file'],
        retrySystemPrompt:
          'You must call read_file before answering about attached files or document context. ' +
          'Do not summarize, infer, or quote file contents until read_file has been used with the exact file name or path. ' +
          'If the filename is ambiguous, say so only after attempting the appropriate tool call.',
        maxRetries: 1,
      };
    }

    const debugLikeQuestion =
      useAppStore.getState().mode === 'Debug' &&
      (params.allowedToolIds.includes('list') || params.allowedToolIds.includes('read')) &&
      /\b(file|files|path|paths|directory|folder|cwd|workspace|readme|package\.json|current directory|content|contents|fichier|fichiers|chemin|dossier|répertoire|contenu)\b/i.test(
        params.userContent
      );

    if (debugLikeQuestion) {
      return {
        requiredToolNames: ['list', 'read'],
        retrySystemPrompt:
          'In Debug mode, you must call list or read before answering questions about files, paths, directories, current working directory, or file contents. ' +
          'Do not invent filenames, paths, or source contents. Use the appropriate workspace tool first, then answer from the exact tool output.',
        maxRetries: 1,
      };
    }

    return undefined;
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

  const prepareManualFeatureMetadataMessages = (
    firstUserContent: string,
    unavailableBranchNames: string[] = []
  ) => {
    const unavailableBranchSummary =
      unavailableBranchNames.length > 0
        ? ` These branch names are already taken and must not be reused: ${unavailableBranchNames.join(', ')}. Return a different featureSlug.`
        : '';

    return [
      {
        role: 'system' as const,
        content:
          'Generate concise metadata for a standalone implementation feature. Return ONLY valid JSON with keys: title, description, featureSlug. ' +
          'title: 3-7 words, specific and action-oriented. description: one clear sentence under 180 characters. ' +
          'featureSlug: lowercase kebab-case branch slug without the "feature/" prefix.' +
          unavailableBranchSummary,
      },
      {
        role: 'user' as const,
        content: firstUserContent,
      },
    ];
  };

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

  const finalizeManualFeatureDraftIfNeeded = async (params: {
    conversationId: string;
    taskId: string;
    firstUserContent: string;
    providerId: string;
    providerType: string;
    baseUrl: string;
    apiKey?: string;
    modelId: string;
    }) => {
    const taskStore = useTaskStore.getState();
    const task = taskStore.getTaskById(params.taskId);
    if (
      !task ||
      task.task_source !== 'standalone' ||
      task.standalone_kind !== 'manual_feature' ||
      task.draft !== true
    ) {
      return;
    }

    const appState = useAppStore.getState();
    const projectIds = Array.from(
      new Set(
        [
          ...(task.project_ids || []),
          task.project_id,
        ].filter((projectId): projectId is string => typeof projectId === 'string' && projectId.trim().length > 0)
      )
    );

    const findConflictingProjectsForBranchName = async (branchName: string): Promise<string[]> => {
      if (!tauriIpc.isTauriAvailable()) {
        return [];
      }

      const projectIdsToCheck = projectIds.length > 0
        ? projectIds
        : (appState.selectedGroupId
          ? getScopedProjectIds(appState.projectGroups, appState.selectedGroupId, null)
          : []);

      const conflictResults = await Promise.all(
        projectIdsToCheck.map(async (projectId) => {
          const repoPath = appState.getProjectById(projectId)?.path?.trim();
          if (!repoPath) {
            return null;
          }

          const branches = await tauriIpc.gitBranchList(repoPath);
          const branchTaken = [...branches.local, ...branches.remote].some((branch) =>
            branchNameMatchesCandidate(branch.name, branchName)
          );

          return branchTaken ? projectId : null;
        })
      );

      return conflictResults.filter((projectId): projectId is string => Boolean(projectId));
    };

    const requestManualFeatureMetadata = async (unavailableBranchNames: string[]) => {
      const output = await sendChatNonStreaming({
        providerId: params.providerId,
        providerType: params.providerType,
        baseUrl: params.baseUrl,
        apiKey: params.apiKey,
        modelId: params.modelId,
        messages: prepareManualFeatureMetadataMessages(
          params.firstUserContent,
          unavailableBranchNames
        ),
        onComplete: () => { },
        onError: () => { },
      });
      return extractManualFeatureMetadataFromModelOutput(output);
    };

    const resolveAvailableFallbackSlug = async (baseSlug: string): Promise<string> => {
      const normalizedBaseSlug = normalizeManualFeatureSlugInput(baseSlug);

      for (let suffix = 0; suffix < 50; suffix += 1) {
        const candidateSlug =
          suffix === 0 ? normalizedBaseSlug : normalizeManualFeatureSlugInput(`${normalizedBaseSlug}-${suffix + 1}`);
        const candidateBranchName = `feature/${candidateSlug}`;
        const conflictingProjectIds = await findConflictingProjectsForBranchName(candidateBranchName);
        if (conflictingProjectIds.length === 0) {
          return candidateSlug;
        }
      }

      return `work-${Date.now().toString(36)}`;
    };

    let metadata = buildManualFeatureFallbackMetadata(params.firstUserContent);
    let unavailableBranchNames: string[] = [];

    for (let attempt = 0; attempt < MANUAL_FEATURE_METADATA_ATTEMPT_LIMIT; attempt += 1) {
      if (attempt === 0) {
        try {
          metadata = await requestManualFeatureMetadata(unavailableBranchNames);
        } catch {
          metadata = buildManualFeatureFallbackMetadata(params.firstUserContent);
        }
      } else {
        try {
          metadata = await requestManualFeatureMetadata(unavailableBranchNames);
        } catch {
          metadata = {
            ...metadata,
            featureSlug: await resolveAvailableFallbackSlug(metadata.featureSlug),
          };
        }
      }

      const branchName = `feature/${metadata.featureSlug}`;
      const conflictingProjectIds = await findConflictingProjectsForBranchName(branchName);
      if (conflictingProjectIds.length === 0) {
        break;
      }

      unavailableBranchNames = Array.from(new Set([...unavailableBranchNames, branchName]));
      if (attempt === MANUAL_FEATURE_METADATA_ATTEMPT_LIMIT - 1) {
        metadata = {
          ...metadata,
          featureSlug: await resolveAvailableFallbackSlug(metadata.featureSlug),
        };
        break;
      }
    }

    updateConversationMetadataLocally(params.conversationId, metadata);

    if (tauriIpc.isTauriAvailable()) {
      await tauriIpc.updateConversationDetails({
        id: params.conversationId,
        title: metadata.title,
        description: metadata.description,
      });
    }

    await taskStore.finalizeManualFeatureDraft({
      taskId: params.taskId,
      conversationId: params.conversationId,
      title: metadata.title,
      description: metadata.description,
      featureSlug: metadata.featureSlug,
    });
    await taskStore.startTask(params.taskId);

    const refreshedTask = useTaskStore.getState().getTaskById(params.taskId);
    if (!refreshedTask || refreshedTask.draft || refreshedTask.status !== 'InProgress') {
      const failureMessage =
        useTaskStore.getState().lastError ||
        'Failed to initialize the manual feature execution context.';
      throw new Error(failureMessage);
    }
  };

  const maybeGenerateConversationMetadata = async (params: {
    conversationId: string;
    firstUserContent: string;
    providerId: string;
    providerType: string;
    baseUrl: string;
    apiKey?: string;
    modelId: string;
    architectPlan?: {
      planId: string;
      targetBranch: string;
    };
  }) => {
    const {
      conversationId,
      firstUserContent,
      providerId,
      providerType,
      baseUrl,
      apiKey,
      modelId,
      architectPlan,
    } = params;

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

      if (architectPlan) {
        try {
          const plan = await getArchitectPlan(architectPlan.targetBranch, architectPlan.planId);
          const shouldAdoptMetadata = Boolean(
            plan &&
            plan.status !== 'deleted' &&
            plan.conversationId === conversationId &&
            isCanonicalArchitectPlan(plan) &&
            isDefaultNewPlanFamilyLabel(plan.label) &&
            plan.nodes.length === 0 &&
            plan.predictedBranches.length === 0
          );

          if (shouldAdoptMetadata && plan) {
            const nextDescription = plan.description.trim() || metadata.description;
            const updatedPlan = await updateArchitectPlan({
              branchName: architectPlan.targetBranch,
              planId: plan.id,
              label: metadata.title,
              description: nextDescription,
            });

            const conversationMetadata = {
              title: getArchitectPlanConversationTitle(updatedPlan),
              description: nextDescription,
            };
            updateConversationMetadataLocally(conversationId, conversationMetadata);

            if (tauriIpc.isTauriAvailable()) {
              tauriIpc
                .updateConversationDetails({
                  id: conversationId,
                  title: conversationMetadata.title,
                  description: conversationMetadata.description,
                })
                .catch(console.error);
            }

            const appState = useAppStore.getState();
            if (
              appState.activeArchitectPlanId === updatedPlan.id &&
              resolveTargetBranch(appState.activePlanContext?.targetBranch) ===
                architectPlan.targetBranch
            ) {
              appState.setPlanNodes(updatedPlan.nodes || []);
              appState.setPredictedBranches(updatedPlan.predictedBranches || []);
              appState.setActivePlanContext({
                id: updatedPlan.id,
                slug: updatedPlan.slug,
                title: updatedPlan.title,
                label: updatedPlan.label,
                description: updatedPlan.description,
                status: updatedPlan.status,
                targetBranch: updatedPlan.targetBranch,
              });

              const planNeeds = await getArchitectPlanNeeds(
                architectPlan.targetBranch,
                updatedPlan.id
              );
              useNeedsStore.getState().replaceNeedsForPlan(updatedPlan.id, planNeeds);
            }
          }
        } catch (error) {
          console.warn('Failed to sync architect plan metadata from first message:', error);
        }
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

  const buildUserMessageForSend = async (params: {
    conversationId: string;
    taskId: string;
    content: string;
  }): Promise<ChatMessage> => {
    let userMessage: ChatMessage = {
      id: `msg-${Date.now()}`,
      task_id: params.taskId,
      conversation_id: params.conversationId,
      role: 'user',
      content: params.content,
      timestamp: new Date().toISOString(),
    };

    if (tauriIpc.isTauriAvailable()) {
      try {
        const dbMessage = await tauriIpc.createMessage(params.conversationId, 'user', params.content);
        userMessage = {
          id: dbMessage.id,
          task_id: params.taskId,
          conversation_id: dbMessage.conversation_id,
          role: 'user',
          content: dbMessage.content,
          timestamp: dbMessage.created_at,
        };
      } catch (error) {
        console.error('Failed to create user message in DB:', error);
      }
    }

    return userMessage;
  };

  const prepareAssistantStreamLaunch = async (params: {
    conversationId: string;
    replyToMessageId: string;
    userContent: string;
  }) => {
    try {
      await ensureToolsLoaded();
    } catch {
      // Continue with currently available tool state (safe default is no tools)
    }

    const allowedToolIds = await getAllowedToolIdsForCurrentMode();
    const showToolTraces = useAppStore.getState().mode === 'Debug';
    const preparedRequest = await prepareMessagesForRequest(
      params.conversationId,
      allowedToolIds,
      params.replyToMessageId
    );
    const fileToolContext = useCitationsStore
      .getState()
      .getConversationContextCitations(params.conversationId)
      .filter((c) => c.type === 'file' || c.type === 'document')
      .map((c) => ({
        title: c.title,
        source: c.source,
        path: c.path,
        snippet: c.snippet,
      }));
    const { enableWebSearch, enableWebFetch, webSearchOptions } = getStreamingWebSearchConfig();
    const guidedToolRetry = buildGuidedToolRetryPolicy({
      userContent: params.userContent,
      allowedToolIds,
      fileToolContext,
    });

    return {
      allowedToolIds,
      showToolTraces,
      messagesForRequest: preparedRequest.messages,
      executionContext: preparedRequest.executionContext,
      fileToolContext,
      enableWebSearch,
      enableWebFetch,
      webSearchOptions,
      guidedToolRetry,
    };
  };

  const applyAssistantLaunchError = (
    assistantMessageId: string,
    error: unknown,
    options?: { setSendState?: boolean }
  ) => {
    const normalized = toServiceError(error);
    get().updateMessageContent(
      assistantMessageId,
      `Error: ${normalized.message}`
    );
    set({
      lastError: normalized.message,
      isLoading: false,
      isStreaming: false,
      abortController: null,
      ...(options?.setSendState ? { sendState: 'error' as const } : {}),
    });
    return normalized;
  };

  const startAssistantStream = (params: {
    assistantMessage: ChatMessage;
    conversationId: string;
    modeAtSend: AppMode;
    resolvedTaskId: string;
    selectedProviderId: string;
    selectedModelId: string;
    providerConfig: NonNullable<ReturnType<typeof useProviderStore.getState>['providerConfigs'][number]>;
    messagesForRequest: StreamMessage[];
    executionContext: {
      workspacePath: string | null;
      defaultWorkspacePath: string | null;
      projectMounts: ReturnType<typeof resolveProjectExecutionContext>['projectMounts'];
      virtualRootEnabled: boolean;
      focusedProjectId: string | null;
    };
    fileToolContext: Array<{ title: string; source: string; path?: string; snippet?: string }>;
    allowedToolIds: string[];
    guidedToolRetry?: {
      requiredToolNames: string[];
      retrySystemPrompt: string;
      maxRetries?: number;
    };
    showToolTraces: boolean;
    enableWebSearch: boolean;
    enableWebFetch: boolean;
    webSearchOptions: ReturnType<typeof getStreamingWebSearchConfig>['webSearchOptions'];
  }) => {
    const abortController = new AbortController();
    set({
      isLoading: true,
      isStreaming: true,
      sendState: 'streaming',
      abortController,
      lastError: null,
    });
    const tokenBatcher = createTokenBatcher((tokenChunk) => {
      get().appendToMessage(params.assistantMessage.id, tokenChunk);
    });

    void (async () => {
      try {
        await streamChat({
          providerId: params.selectedProviderId,
          providerType: params.providerConfig.providerType,
          baseUrl: params.providerConfig.baseUrl,
          apiKey: params.providerConfig.apiKey,
          modelId: params.selectedModelId,
          messages: params.messagesForRequest,
          fileToolContext: params.fileToolContext,
          allowedToolIds: params.allowedToolIds,
          workspacePath: params.executionContext.workspacePath,
          defaultWorkspacePath: params.executionContext.defaultWorkspacePath,
          projectMounts: params.executionContext.projectMounts,
          virtualRootEnabled: params.executionContext.virtualRootEnabled,
          focusedProjectId: params.executionContext.focusedProjectId,
          guidedToolRetry: params.guidedToolRetry,
          showToolTraces: params.showToolTraces,
          enableWebSearch: params.enableWebSearch,
          enableWebFetch: params.enableWebFetch,
          webSearchOptions: params.webSearchOptions,
          signal: abortController.signal,
          onToken: (token) => {
            tokenBatcher.push(token);
          },
          onToolTracesUpdate: (toolTraces: ToolTrace[]) => {
            get().updateMessageFields(params.assistantMessage.id, { tool_traces: toolTraces });
          },
          onComplete: (result) => {
            tokenBatcher.flushNow();
            applyStreamCompletion(params.assistantMessage.id, result);

            set((state) => {
              const conversations = state.conversations.map((conv) =>
                conv.id === params.conversationId
                  ? {
                    ...conv,
                    last_message:
                      result.visibleContent.slice(0, 100) +
                      (result.visibleContent.length > 100 ? '...' : ''),
                    updated_at: new Date().toISOString(),
                  }
                  : conv
              );
              return {
                conversations,
                isLoading: false,
                isStreaming: false,
                sendState: 'idle',
                abortController: null,
              };
            });

            persistAssistantStreamResult(params.conversationId, result);
            const taskAfterStream = params.resolvedTaskId
              ? useTaskStore.getState().getTaskById(params.resolvedTaskId)
              : undefined;
            const parsedCompletion = parseMessageQuickReplies(result.visibleContent);
            if (
              params.modeAtSend === 'Implement' &&
              params.resolvedTaskId &&
              taskAfterStream?.status === 'InProgress' &&
              parsedCompletion.requiresUserReply
            ) {
              void useTaskStore.getState().markTaskAwaitingResponse(params.resolvedTaskId);
            }
            void syncMacroMetadataAfterStreamService({
              mode: params.modeAtSend,
              conversationId: params.conversationId,
              trigger: 'send',
            });
            tokenBatcher.dispose();
          },
          onError: (error) => {
            tokenBatcher.dispose();
            get().updateMessageContent(
              params.assistantMessage.id,
              `Error: ${error.message}`
            );
            set({
              isLoading: false,
              isStreaming: false,
              sendState: 'error',
              lastError: error.message,
              abortController: null,
            });
          },
          onToolCall: (toolName, args) => {
            return handleToolCall(params.conversationId, params.assistantMessage.id, toolName, args);
          },
        });
      } catch (error) {
        tokenBatcher.dispose();
        const normalized = toServiceError(error);
        get().updateMessageContent(
          params.assistantMessage.id,
          `Error: ${normalized.message}`
        );
        set({
          isLoading: false,
          isStreaming: false,
          sendState: 'error',
          lastError: normalized.message,
          abortController: null,
        });
      }
    })();
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

  const logArchitectTranscriptEvent = (
    level: 'info' | 'warn',
    event: string,
    payload: Record<string, unknown>
  ) => {
    const entry = {
      event,
      at: new Date().toISOString(),
      ...payload,
    };

    if (level === 'warn') {
      console.warn(JSON.stringify(entry));
      return;
    }

    devLogger.info(JSON.stringify(entry));
  };

  const applyConversationSelection = (
    conversationId: string,
    mode: AppMode = useAppStore.getState().mode
  ): boolean => {
    const appState = useAppStore.getState();
    const state = get();
    const conversation = state.conversations.find((candidate) => candidate.id === conversationId);
    if (!conversation) {
      return false;
    }

    if (
      !isConversationAllowedForMode(
        conversation,
        mode,
        appState.selectedGroupId,
        appState.selectedProjectId,
        appState.selectedTaskId
      )
    ) {
      return false;
    }

    set((current) => ({
      selectedConversationId: conversationId,
      selectedConversationIdsByMode: {
        ...current.selectedConversationIdsByMode,
        [mode]: conversationId,
      },
      conversations: current.conversations.map((candidate) =>
        candidate.id === conversationId
          ? { ...candidate, is_unread: false }
          : candidate
      ),
    }));
    return true;
  };

  const clearConversationSelection = (mode: AppMode) => {
    set((current) => ({
      selectedConversationId: null,
      selectedConversationIdsByMode: {
        ...current.selectedConversationIdsByMode,
        [mode]: null,
      },
    }));
  };

  const createConversationRecord = async (params: {
    title: string;
    taskId: string | null;
    projectId: string | null;
    groupId?: string | null;
    selectConversation?: boolean;
  }): Promise<Conversation> => {
    const { title, taskId, projectId, groupId, selectConversation = true } = params;
    const appState = useAppStore.getState();
    const mode = appState.mode;
    const effectiveTaskId =
      mode === 'Implement'
        ? appState.selectedTaskId ?? taskId
        : taskId;
    const linkedTask = effectiveTaskId
      ? useTaskStore.getState().getTaskById(effectiveTaskId)
      : undefined;
    const resolvedTitle =
      mode === 'Implement' && linkedTask?.title
        ? `Task - ${linkedTask.title}`
        : title.trim() || 'New Conversation';
    const resolvedTaskId =
      mode === 'Chat'
        ? null
        : mode === 'Implement'
          ? effectiveTaskId
          : taskId;
    const resolvedProjectId =
      mode === 'Chat'
        ? null
        : mode === 'Implement'
        ? projectId ?? linkedTask?.project_id ?? appState.selectedProjectId ?? null
        : projectId;
    const resolvedGroupId =
      mode === 'Chat'
        ? null
        : mode === 'Implement'
        ? groupId ?? appState.selectedGroupId ?? null
        : groupId ?? null;

    if (mode === 'Implement' && !resolvedTaskId) {
      throw new Error('Implement conversations must be linked to a task.');
    }

    if (mode === 'Implement' && resolvedTaskId) {
      const existingConversation = getLatestConversationForTask(resolvedTaskId);
      if (existingConversation) {
        if (selectConversation && applyConversationSelection(existingConversation.id, mode)) {
          persistSelectionForContext(mode, existingConversation.id);
          void applySelectionForContext(mode, existingConversation.id);
        }
        return existingConversation;
      }
    }

    let newConversation: Conversation;

    if (tauriIpc.isTauriAvailable()) {
      try {
        const dbConversation = await tauriIpc.createConversation({
          title: resolvedTitle,
          taskId: resolvedTaskId,
          groupId: resolvedGroupId,
          projectId: resolvedProjectId,
        });
        newConversation = mapDbConversationToConversation(dbConversation);
      } catch (error) {
        console.error('Failed to create conversation in DB:', error);
        newConversation = {
          id: `conv-${Date.now()}`,
          title: resolvedTitle,
          description: '',
          task_id: resolvedTaskId,
          group_id: resolvedGroupId,
          project_id: resolvedProjectId,
          last_message: '',
          message_count: 0,
          updated_at: new Date().toISOString(),
          is_unread: true,
        };
      }
    } else {
      newConversation = {
        id: `conv-${Date.now()}`,
        title: resolvedTitle,
        description: '',
        task_id: resolvedTaskId,
        group_id: resolvedGroupId,
        project_id: resolvedProjectId,
        last_message: '',
        message_count: 0,
        updated_at: new Date().toISOString(),
        is_unread: true,
      };
    }

    set((state) => ({
      conversations: [newConversation, ...state.conversations],
    }));

    if (selectConversation && applyConversationSelection(newConversation.id, mode)) {
      persistSelectionForContext(mode, newConversation.id);
      void applySelectionForContext(mode, newConversation.id);
    }

    return newConversation;
  };

  const appendImportedMessagesToState = (
    conversationId: string,
    importedMessages: tauriIpc.DbMessage[] | TranscriptComparableMessage[]
  ): number => {
    if (importedMessages.length === 0) {
      return 0;
    }

    const state = get();
    const existingMessageIds = new Set(state.messages.map((message) => message.id));
    const conversationById = new Map(state.conversations.map((conversation) => [conversation.id, conversation]));
    const normalizedMessages = importedMessages
      .map((message) => {
        if ('conversation_id' in message) {
          return mapDbMessageToChatMessage(message, conversationById);
        }
        return {
          id: message.id,
          task_id: conversationById.get(conversationId)?.task_id ?? '',
          conversation_id: conversationId,
          role: message.role,
          content: message.content,
          timestamp: message.createdAt,
        } satisfies ChatMessage;
      })
      .filter((message) => !existingMessageIds.has(message.id));

    if (normalizedMessages.length === 0) {
      return 0;
    }

    const mergedMessages = [...state.messages, ...normalizedMessages];
    const latestImportedTimestamp =
      normalizedMessages[normalizedMessages.length - 1]?.timestamp ?? new Date().toISOString();
    const conversationMeta = recalcConversation(
      conversationId,
      mergedMessages,
      latestImportedTimestamp
    );

    set({
      messages: mergedMessages,
      conversations: state.conversations.map((conversation) =>
        conversation.id === conversationId
          ? { ...conversation, ...conversationMeta }
          : conversation
      ),
    });

    return normalizedMessages.length;
  };

  const importTranscriptSuffix = async (
    conversationId: string,
    transcript: TranscriptComparableMessage[]
  ): Promise<number> => {
    if (transcript.length === 0) {
      return 0;
    }

    if (tauriIpc.isTauriAvailable()) {
      try {
        const imported = await tauriIpc.importMessages(
          conversationId,
          transcript.map((message) => ({
            id: message.id,
            role: message.role,
            content: message.content,
            created_at: message.createdAt,
          }))
        );
        return appendImportedMessagesToState(conversationId, imported);
      } catch (error) {
        console.error('Failed to import architect transcript into DB:', error);
      }
    }

    return appendImportedMessagesToState(conversationId, transcript);
  };

  const syncArchitectMetadataFromDb = async (params: {
    branchName: string;
    planId: string;
    conversationId: string;
    reason: ArchitectTranscriptState['relation'];
  }) => {
    try {
      await syncArchitectPlanChatFromConversation({
        branchName: params.branchName,
        planId: params.planId,
        conversationId: params.conversationId,
      });
      logArchitectTranscriptEvent('info', 'architect_transcript_metadata_synced', params);
    } catch (error) {
      logArchitectTranscriptEvent('warn', 'architect_transcript_metadata_sync_failed', {
        ...params,
        error: toServiceError(error).message,
      });
    }
  };

  const reconcileArchitectPlanConversation = async (params: {
    plan: ArchitectPlanRecord;
    targetBranch: string;
    fallbackProjectId?: string;
    fallbackGroupId?: string;
    sharedConversation?: boolean;
  }): Promise<{
    conversationId: string | null;
    restoredTranscript: boolean;
    createdConversation: boolean;
  }> => {
    const {
      plan,
      targetBranch,
      fallbackProjectId,
      fallbackGroupId,
      sharedConversation = false,
    } = params;
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
      conversation = await createConversationRecord({
        title: getArchitectPlanConversationTitle(plan),
        taskId: null,
        projectId: fallbackProjectId ?? null,
        groupId: fallbackGroupId ?? null,
        selectConversation: false,
      });
      createdConversation = true;
    }

    const localMessages = getOrderedConversationMessages(conversation.id).map(toComparableChatMessage);
    const transcriptMessages = transcript.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt,
    }));
    const transcriptState = compareArchitectTranscriptState(localMessages, transcriptMessages);

    if (transcriptState.relation === 'db_prefix') {
      const importedCount = await importTranscriptSuffix(
        conversation.id,
        transcriptMessages.slice(localMessages.length)
      );
      restoredTranscript = importedCount > 0;
      if (importedCount > 0) {
        logArchitectTranscriptEvent('info', 'architect_transcript_restored_suffix', {
          planId: plan.id,
          conversationId: conversation.id,
          importedCount,
          dbCount: transcriptState.dbCount,
          metadataCount: transcriptState.metadataCount,
        });
      }
    } else if (transcriptState.relation === 'metadata_prefix') {
      await syncArchitectMetadataFromDb({
        branchName: targetBranch,
        planId: plan.id,
        conversationId: conversation.id,
        reason: transcriptState.relation,
      });
    } else if (transcriptState.relation === 'diverged') {
      logArchitectTranscriptEvent('warn', 'architect_transcript_diverged', {
        planId: plan.id,
        conversationId: conversation.id,
        dbCount: transcriptState.dbCount,
        metadataCount: transcriptState.metadataCount,
      });
      await syncArchitectMetadataFromDb({
        branchName: targetBranch,
        planId: plan.id,
        conversationId: conversation.id,
        reason: transcriptState.relation,
      });
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

    return {
      conversationId: conversation.id,
      restoredTranscript,
      createdConversation,
    };
  };

  const hydrateChatSnapshot = async (): Promise<void> => {
    let conversations: Conversation[] = [];
    let messages: ChatMessage[] = [];

    if (tauriIpc.isTauriAvailable()) {
      try {
        const snapshot = await tauriIpc.getChatSnapshot();
        conversations = snapshot.conversations.map(mapDbConversationToConversation);
        const conversationById = new Map(
          conversations.map((conversation) => [conversation.id, conversation])
        );
        messages = snapshot.messages.map((message) =>
          mapDbMessageToChatMessage(message, conversationById)
        );
      } catch (snapshotError) {
        console.warn('Falling back to legacy chat hydration path:', snapshotError);
        const dbConversations = await tauriIpc.listConversations();
        conversations = dbConversations.map(mapDbConversationToConversation);
        const conversationById = new Map(
          conversations.map((conversation) => [conversation.id, conversation])
        );
        for (const conversation of dbConversations) {
          const dbMessages = await tauriIpc.listMessages(conversation.id);
          messages.push(
            ...dbMessages.map((message) => mapDbMessageToChatMessage(message, conversationById))
          );
        }
      }
    }

    pruneConversationSelections(conversations);

    const loadedImages = loadMessageImagesFromStorage();
    const existingMessageIds = new Set(messages.map((message) => message.id));
    const prunedImages: Record<string, MessageImageAttachment[]> = {};
    Object.entries(loadedImages).forEach(([messageId, items]) => {
      if (existingMessageIds.has(messageId) && Array.isArray(items) && items.length > 0) {
        prunedImages[messageId] = items;
      }
    });
    saveMessageImagesToStorage(prunedImages);

    set({
      conversations,
      messages,
      messageImagesByMessageId: prunedImages,
      selectedConversationId: null,
      selectedConversationIdsByMode: {},
      hydrationStatus: 'ready',
      restoreStatus: 'idle',
      activeContextKey: null,
      selectionRequestId: 0,
      isLoading: false,
      sendState: 'idle',
      lastError: null,
    });
  };

  const resolveConversationForCurrentContext = async (
    requestId: number,
    contextKey: ChatContextKey
  ): Promise<string | null> => {
    const isCurrentRequest = () => {
      const state = get();
      return state.selectionRequestId === requestId && state.activeContextKey === contextKey;
    };

    const appState = useAppStore.getState();
    const { mode, selectedGroupId, selectedProjectId, selectedTaskId } = appState;
    let state = get();

    if (mode === 'Debug') {
      return getFallbackConversationIdForMode(
        state.conversations,
        'Debug',
        selectedGroupId,
        selectedProjectId,
        selectedTaskId
      );
    }

    if (mode === 'Architect' && appState.activeArchitectPlanId) {
      try {
        const targetBranch = resolveTargetBranch(appState.activePlanContext?.targetBranch);
        const activePlan = await getArchitectPlan(targetBranch, appState.activeArchitectPlanId);
        if (!isCurrentRequest()) return null;
        if (activePlan && activePlan.status !== 'deleted') {
          const conversationId = activePlan.conversationId;
          let hasSharedConversation = false;
          if (conversationId) {
            const plansSnapshot = await listArchitectPlans(targetBranch, true, true);
            if (!isCurrentRequest()) return null;
            hasSharedConversation = plansSnapshot.plans.some(
              (candidate) =>
                candidate.id !== activePlan.id && candidate.conversationId === conversationId
            );
          }
          const fallbackProjectId =
            resolvePlanProjectContextId(activePlan, selectedProjectId) ||
            getArchitectPlanProjectIds(activePlan)[0] ||
            selectedProjectId ||
            appState.projectGroups.flatMap((group) => group.projects)[0]?.id ||
            null;
          const ensuredConversation = await reconcileArchitectPlanConversation({
            plan: activePlan,
            targetBranch,
            fallbackProjectId: fallbackProjectId ?? undefined,
            fallbackGroupId: selectedGroupId ?? undefined,
            sharedConversation: hasSharedConversation,
          });
          if (!isCurrentRequest()) return null;
          if (ensuredConversation.conversationId) {
            return ensuredConversation.conversationId;
          }
        }
      } catch (error) {
        logArchitectTranscriptEvent('warn', 'architect_conversation_resolution_failed', {
          planId: appState.activeArchitectPlanId,
          error: toServiceError(error).message,
        });
      }
    }

    const localProjectContext = selectedGroupId
      ? await getLocalProjectContextState(selectedGroupId)
      : null;
    if (!isCurrentRequest()) return null;
    state = get();

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
        selectedProjectId ??
        null;
      const title = globalProject ? `Architect - ${globalProject.name}` : 'Architect Session';
      const created = await createConversationRecord({
        title,
        taskId: null,
        projectId: fallbackProjectId,
        groupId: selectedGroupId,
        selectConversation: false,
      });
      if (!isCurrentRequest()) return null;
      return created.id;
    }

    if (mode === 'Implement' && selectedTaskId) {
      const task = useTaskStore.getState().getTaskById(selectedTaskId);
      const projectId =
        task?.project_id ??
        getFocusedProjectForGroup(
          appState.projectGroups,
          selectedGroupId,
          selectedProjectId,
          localProjectContext
        )?.id ??
        selectedProjectId;
      const created = await createConversationRecord({
        title: task ? `Task - ${task.title}` : 'Task Session',
        taskId: selectedTaskId,
        projectId: projectId ?? null,
        groupId: selectedGroupId,
        selectConversation: false,
      });
      if (!isCurrentRequest()) return null;
      return created.id;
    }

    return null;
  };

  return {
    messages: [],
    conversations: [],
    selectedConversationId: null,
    selectedConversationIdsByMode: {},
    hydrationStatus: 'idle',
    restoreStatus: 'idle',
    activeContextKey: null,
    selectionRequestId: 0,
    isLoading: false,
    isStreaming: false,
    sendState: 'idle',
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

    clearLastError: () =>
      set((state) => ({
        lastError: null,
        sendState: state.isStreaming ? 'streaming' : 'idle',
      })),

    updateMessageContent: (messageId, content) =>
      set((state) => {
        const updatedMessage = state.messages.find((message) => message.id === messageId);
        const parsedContent =
          updatedMessage?.role === 'assistant'
            ? parseMessageQuickReplies(content)
            : {
                content,
                choices: undefined,
                allowFreeResponse: undefined,
                requiresUserReply: false,
              };
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
      void get().ensureConversationForCurrentMode();
    },

    selectConversation: (conversationId) => {
      const mode = useAppStore.getState().mode;
      const applied = applyConversationSelection(conversationId, mode);
      if (!applied) {
        return;
      }
      persistSelectionForContext(mode, conversationId);
      void applySelectionForContext(mode, conversationId);
    },

    createConversation: async (title, taskId, projectId, groupId) =>
      createConversationRecord({
        title,
        taskId,
        projectId,
        groupId,
      }),

    ensureArchitectConversationForPlan: async ({
      plan,
      targetBranch,
      fallbackProjectId,
      fallbackGroupId,
      sharedConversation = false,
    }) => {
      const ensuredConversation = await reconcileArchitectPlanConversation({
        plan,
        targetBranch,
        fallbackProjectId,
        fallbackGroupId,
        sharedConversation,
      });

      if (ensuredConversation.conversationId) {
        const mode = useAppStore.getState().mode;
        if (applyConversationSelection(ensuredConversation.conversationId, mode)) {
          persistSelectionForContext(mode, ensuredConversation.conversationId);
          await applySelectionForContext(mode, ensuredConversation.conversationId);
        }
      }

      return ensuredConversation;
    },

    ensureConversationForCurrentMode: async () => {
      await waitForHydration();

      const appState = useAppStore.getState();
      const mode = appState.mode;
      const contextKey = buildChatContextKey(appState);
      const requestId = get().selectionRequestId + 1;

      set({
        selectionRequestId: requestId,
        activeContextKey: contextKey,
        restoreStatus: 'resolving',
        lastError: null,
      });

      const isCurrentRequest = () => {
        const state = get();
        return state.selectionRequestId === requestId && state.activeContextKey === contextKey;
      };

      try {
        const conversationId = await resolveConversationForCurrentContext(requestId, contextKey);
        if (!isCurrentRequest()) {
          return get().selectedConversationId;
        }

        if (conversationId && applyConversationSelection(conversationId, mode)) {
          persistSelectionForContext(mode, conversationId);
          await applySelectionForContext(mode, conversationId);
          if (isCurrentRequest()) {
            set({ restoreStatus: 'ready', lastError: null });
          }
          return conversationId;
        }

        clearConversationSelection(mode);
        await applySelectionForContext(mode, null);
        if (isCurrentRequest()) {
          set({ restoreStatus: 'ready', lastError: null });
        }
        return null;
      } catch (error) {
        const normalized = toServiceError(error);
        if (isCurrentRequest()) {
          set({
            restoreStatus: 'error',
            lastError: normalized.message,
          });
        }
        return null;
      }
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
      const linkedTask = conversation.task_id
        ? useTaskStore.getState().getTaskById(conversation.task_id)
        : undefined;

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

      if (
        linkedTask &&
        linkedTask.task_source === 'standalone' &&
        linkedTask.standalone_kind === 'manual_feature' &&
        linkedTask.draft
      ) {
        await useTaskStore.getState().deleteManualFeatureDraft(linkedTask.id);
      }

      if (tauriIpc.isTauriAvailable()) {
        await tauriIpc.deleteConversation(conversationId);
      }
      removeConversationSelection(conversationId);
      applyLocalConversationRemoval([conversationId]);
    },

    deleteChatConversations: async (conversationIds) => {
      const uniqueIds = Array.from(new Set(conversationIds));
      if (uniqueIds.length === 0) {
        return;
      }

      const conversationsById = new Map(
        get().conversations.map((conversation) => [conversation.id, conversation])
      );
      uniqueIds.forEach((conversationId) => {
        const conversation = conversationsById.get(conversationId);
        if (!conversation) {
          throw new Error('Conversation introuvable.');
        }
        if (conversation.task_id || conversation.group_id || conversation.project_id) {
          throw new Error('La suppression groupée est réservée aux conversations Chat.');
        }
      });

      const snapshot = buildConversationRemovalSnapshot();
      applyLocalConversationRemoval(uniqueIds);

      try {
        if (tauriIpc.isTauriAvailable()) {
          await tauriIpc.deleteConversations(uniqueIds);
        }
        uniqueIds.forEach((conversationId) => {
          removeConversationSelection(conversationId);
        });
      } catch (error) {
        restoreConversationRemovalSnapshot(snapshot);
        throw error;
      }
    },

    markAsRead: (conversationId) =>
      set((state) => ({
        conversations: state.conversations.map((conv) =>
          conv.id === conversationId ? { ...conv, is_unread: false } : conv
        ),
      })),

    getConversationByTask: (taskId) => {
      return getLatestConversationForTask(taskId) ?? undefined;
    },

    getConversationMessages: (conversationId) => {
      return getOrderedConversationMessages(conversationId);
    },

    sendMessage: async ({ conversationId, content, taskId, images }) => {
      if (get().sendState === 'preparing') {
        const error = buildSendError('A message is already being prepared.');
        set({ sendState: 'error', lastError: error.message });
        throw error;
      }

      set({ sendState: 'preparing', lastError: null });

      try {
        const providerState = useProviderStore.getState();
        const { selectedProviderId, selectedModelId, providerConfigs } = providerState;
        const modeAtSend = useAppStore.getState().mode;
        persistSelectionForContext(modeAtSend, conversationId);

        if (!selectedProviderId || !selectedModelId) {
          throw buildSendError('Select a provider and model before sending a message.');
        }

        const providerConfig = providerConfigs.find((p) => p.id === selectedProviderId);
        if (!providerConfig) {
          throw buildSendError('Provider configuration not found.');
        }

        const conversationTaskId =
          get().conversations.find((conversation) => conversation.id === conversationId)?.task_id ?? null;
        const selectedTaskIdForMode =
          modeAtSend === 'Implement'
            ? useAppStore.getState().selectedTaskId ?? ''
            : '';
        const resolvedTaskId =
          modeAtSend === 'Chat'
            ? ''
            : taskId ?? conversationTaskId ?? selectedTaskIdForMode;
        let taskForSend = resolvedTaskId
          ? useTaskStore.getState().getTaskById(resolvedTaskId)
          : undefined;
        let finalizedManualFeatureDraft = false;

        if (modeAtSend === 'Implement') {
          if (!resolvedTaskId) {
            throw buildSendError('Select a task before sending a message in Implement mode.');
          }

          if (
            taskForSend?.task_source === 'standalone' &&
            taskForSend.standalone_kind === 'manual_feature' &&
            taskForSend.draft === true
          ) {
            finalizedManualFeatureDraft = true;
            await finalizeManualFeatureDraftIfNeeded({
              conversationId,
              taskId: resolvedTaskId,
              firstUserContent: content,
              providerId: selectedProviderId,
              providerType: providerConfig.providerType,
              baseUrl: providerConfig.baseUrl,
              apiKey: providerConfig.apiKey,
              modelId: selectedModelId,
            });
          }

          taskForSend = await assertImplementTaskReadyForSend(resolvedTaskId) ?? taskForSend;
        }

        const userMessageCountBeforeSend = getOrderedConversationMessages(conversationId).filter(
          (message) => message.role === 'user'
        ).length;

        const userMessage = await buildUserMessageForSend({
          conversationId,
          taskId: resolvedTaskId,
          content,
        });

        get().addMessage(userMessage);
        if (images && images.length > 0) {
          get().setMessageImages(userMessage.id, images);
        }
        get().clearComposerContextRefs();

        if (userMessageCountBeforeSend === 0 && !finalizedManualFeatureDraft) {
          const appState = useAppStore.getState();
          const architectPlan =
            modeAtSend === 'Architect' && appState.activeArchitectPlanId
              ? {
                planId: appState.activeArchitectPlanId,
                targetBranch: resolveTargetBranch(appState.activePlanContext?.targetBranch),
              }
              : undefined;

          void maybeGenerateConversationMetadata({
            conversationId,
            firstUserContent: content,
            providerId: selectedProviderId,
            providerType: providerConfig.providerType,
            baseUrl: providerConfig.baseUrl,
            apiKey: providerConfig.apiKey,
            modelId: selectedModelId,
            architectPlan,
          });
        }

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

        try {
          const streamLaunch = await prepareAssistantStreamLaunch({
            conversationId,
            replyToMessageId: userMessage.id,
            userContent: content,
          });

          startAssistantStream({
            assistantMessage,
            conversationId,
            modeAtSend,
            resolvedTaskId,
            selectedProviderId,
            selectedModelId,
            providerConfig,
            messagesForRequest: streamLaunch.messagesForRequest,
            executionContext: streamLaunch.executionContext,
            fileToolContext: streamLaunch.fileToolContext,
            allowedToolIds: streamLaunch.allowedToolIds,
            guidedToolRetry: streamLaunch.guidedToolRetry,
            showToolTraces: streamLaunch.showToolTraces,
            enableWebSearch: streamLaunch.enableWebSearch,
            enableWebFetch: streamLaunch.enableWebFetch,
            webSearchOptions: streamLaunch.webSearchOptions,
          });
        } catch (error) {
          applyAssistantLaunchError(assistantMessage.id, error, { setSendState: true });
        }

        return {
          status: 'sent',
          conversationId,
          userMessageId: userMessage.id,
          assistantMessageId: assistantMessage.id,
        };
      } catch (error) {
        const normalized = toServiceError(error);
        set({
          sendState: 'error',
          lastError: normalized.message,
          isLoading: false,
          isStreaming: false,
          abortController: null,
        });
        throw normalized;
      }
    },

    stopStreaming: () => {
      const { abortController } = get();
      if (abortController) {
        abortController.abort();
      }
      // Cancel the active reader and stream
      cancelStream();
      set({ isStreaming: false, isLoading: false, sendState: 'idle', abortController: null });
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
      if (modeAtEdit === 'Implement' && target.task_id) {
        try {
          await assertImplementTaskReadyForSend(target.task_id);
        } catch (error) {
          const normalized = toServiceError(error);
          set({ lastError: normalized.message });
          return;
        }
      }

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

      try {
        const streamLaunch = await prepareAssistantStreamLaunch({
          conversationId,
          replyToMessageId: messageId,
          userContent: newContent,
        });

        startAssistantStream({
          assistantMessage,
          conversationId,
          modeAtSend: modeAtEdit,
          resolvedTaskId: target.task_id ?? '',
          selectedProviderId,
          selectedModelId,
          providerConfig,
          messagesForRequest: streamLaunch.messagesForRequest,
          executionContext: streamLaunch.executionContext,
          fileToolContext: streamLaunch.fileToolContext,
          allowedToolIds: streamLaunch.allowedToolIds,
          guidedToolRetry: streamLaunch.guidedToolRetry,
          showToolTraces: streamLaunch.showToolTraces,
          enableWebSearch: streamLaunch.enableWebSearch,
          enableWebFetch: streamLaunch.enableWebFetch,
          webSearchOptions: streamLaunch.webSearchOptions,
        });
      } catch (error) {
        applyAssistantLaunchError(assistantMessage.id, error);
      }
    },

    initialize: async () => {
      set({
        isLoading: true,
        sendState: 'idle',
        lastError: null,
        hydrationStatus: 'hydrating',
        restoreStatus: 'idle',
        activeContextKey: null,
        selectionRequestId: 0,
      });
      try {
        aiSelections = normalizeAIContextSelections(
          await loadPreference<PersistedAIContextSelections>(PREF_KEYS.AI_CONTEXT_SELECTIONS)
        );
        aiSelectionsLoaded = true;
        ensureProviderSelectionSync();
        ensureContextSelectionSync();

        hydrationPromise = hydrateChatSnapshot();
        await hydrationPromise;
        hydrationPromise = null;

        await get().ensureConversationForCurrentMode();
      } catch (error) {
        hydrationPromise = null;
        const normalized = toServiceError(error);
        console.error('Failed to initialize chat store:', normalized.message);
        const messageImagesByMessageId = loadMessageImagesFromStorage();
        set({
          conversations: [],
          messages: [],
          messageImagesByMessageId,
          selectedConversationId: null,
          selectedConversationIdsByMode: {},
          hydrationStatus: 'error',
          restoreStatus: 'error',
          activeContextKey: null,
          selectionRequestId: 0,
          isLoading: false,
          sendState: 'error',
          lastError: normalized.message,
        });

        aiSelectionsLoaded = true;
        ensureProviderSelectionSync();
        ensureContextSelectionSync();
      }
    },
  };
});

