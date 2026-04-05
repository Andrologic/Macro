import type {
  ChatMessage,
  ContextFootprint,
  ContextFootprintReason,
  ContextFootprintThreshold,
  ConversationCompactionState,
  ToolContextDigestEntry,
  ToolContextDigestKind,
} from '../types';
import type { Citation } from '../stores/useCitationsStore';
import type { StreamMessage, StreamMessageContent } from './streamingChat';
import type { MacroToolRegistryEntry } from '../shared/macroToolRegistry';

const CHARS_PER_TOKEN = 4;
const SOURCE_PASSAGE_VERSION = 1;
const EMERGENCY_TOOL_CONTEXT_CHARS = 1200;
const MAX_DIGEST_ITEMS = 18;
const MAX_DIGEST_EVIDENCE_CHARS = 220;

type CompactionMode = 'background' | 'blocking' | 'after_compaction';

interface CompactionThresholds {
  backgroundRatio: number;
  blockingRatio: number;
  hiddenContextRatio: number;
  toolTurnCount: number;
  degradedRatio: number;
}

export interface EstimateConversationFootprintParams {
  systemMessage: string;
  preparedMessages: StreamMessage[];
  orderedMessages: ChatMessage[];
  citations: Citation[];
  toolDefinitions: MacroToolRegistryEntry[];
  modelContextWindowTokens: number;
  mode?: CompactionMode;
  thresholds?: Partial<CompactionThresholds>;
}

export interface SummaryGenerationInput {
  compactableMessages: ChatMessage[];
  retainedMessages: ChatMessage[];
  toolDigest: ToolContextDigestEntry[];
  usedSourcePassages: Citation[];
  interestingSourcePassages: Citation[];
}

export interface MaybeCompactConversationParams {
  systemMessage: string;
  preparedMessages: StreamMessage[];
  orderedMessages: ChatMessage[];
  citations: Citation[];
  toolDefinitions: MacroToolRegistryEntry[];
  modelContextWindowTokens: number;
  currentCompactionState?: ConversationCompactionState | null;
  mode: 'background' | 'blocking';
  generateSummary?: (input: SummaryGenerationInput) => Promise<string | null>;
}

export interface MaybeCompactConversationResult {
  compactionState: ConversationCompactionState | null;
  footprintBefore: ContextFootprint;
  footprintAfter: ContextFootprint;
  messages: StreamMessage[];
  usedExistingCompaction: boolean;
  degraded: boolean;
}

export interface ProviderCompactionAdapter {
  compact(
    params: MaybeCompactConversationParams
  ): Promise<MaybeCompactConversationResult>;
}

const DEFAULT_THRESHOLDS: CompactionThresholds = {
  backgroundRatio: 0.6,
  blockingRatio: 0.75,
  hiddenContextRatio: 0.2,
  toolTurnCount: 10,
  degradedRatio: 0.9,
};

const TOOL_CONTEXT_BLOCK_REGEX =
  /<tool_context\s+([^>]+)>\s*([\s\S]*?)\s*<\/tool_context>/gi;
const TOOL_ATTR_REGEX = /([a-z_]+)="([^"]*)"/gi;

const normalizeWhitespace = (value: string): string =>
  value.replace(/\s+/g, ' ').trim();

const estimateTokensForText = (value: string): number => {
  const normalized = value.trim();
  if (!normalized) return 0;
  return Math.max(1, Math.ceil(normalized.length / CHARS_PER_TOKEN));
};

const estimateTokensForStreamContent = (content: StreamMessageContent): number => {
  if (typeof content === 'string') {
    return estimateTokensForText(content);
  }

  return content.reduce((total, part) => {
    if (part.type === 'text') {
      return total + estimateTokensForText(part.text || '');
    }
    if (part.type === 'image_url') {
      return total + 24;
    }
    return total;
  }, 0);
};

const estimateTokensForProviderInputItems = (providerInputItems?: unknown[]): number => {
  if (!Array.isArray(providerInputItems) || providerInputItems.length === 0) {
    return 0;
  }

  return estimateTokensForText(JSON.stringify(providerInputItems));
};

const estimateTokensForStreamMessage = (message: StreamMessage): number =>
  Math.max(
    estimateTokensForStreamContent(message.content),
    estimateTokensForProviderInputItems(message.provider_input_items)
  );

const countImagePlaceholderTokens = (messages: StreamMessage[]): number =>
  messages.reduce((total, message) => {
    if (typeof message.content === 'string') return total;
    return (
      total +
      message.content.reduce(
        (sum, part) => sum + (part.type === 'image_url' ? 24 : 0),
        0
      )
    );
  }, 0);

const resolveThreshold = (
  totalRatio: number,
  hiddenRatio: number,
  toolTurnCount: number,
  mode: CompactionMode,
  thresholds: CompactionThresholds
): { threshold: ContextFootprintThreshold; reason: ContextFootprintReason } => {
  if (mode === 'after_compaction' && totalRatio >= thresholds.degradedRatio) {
    return { threshold: 'degraded', reason: 'post_compaction_overflow' };
  }
  if (totalRatio >= thresholds.blockingRatio) {
    return { threshold: 'blocking', reason: 'total_context_ratio' };
  }
  if (totalRatio >= thresholds.backgroundRatio) {
    return { threshold: 'background', reason: 'total_context_ratio' };
  }
  if (hiddenRatio >= thresholds.hiddenContextRatio) {
    return { threshold: 'background', reason: 'hidden_context_ratio' };
  }
  if (toolTurnCount > thresholds.toolTurnCount) {
    return { threshold: 'background', reason: 'tool_turn_count' };
  }
  return { threshold: 'none', reason: 'below_threshold' };
};

const getCompactionThresholds = (
  overrides?: Partial<CompactionThresholds>
): CompactionThresholds => ({
  ...DEFAULT_THRESHOLDS,
  ...overrides,
});

const simpleHash = (value: string): string => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

const truncateMiddle = (value: string, maxChars: number): string => {
  if (value.length <= maxChars) return value;
  if (maxChars <= 64) {
    return `${value.slice(0, Math.max(0, maxChars - 16))}...[truncated]`;
  }
  const marker = '\n\n[... truncated for compacted context ...]\n\n';
  const tailChars = Math.min(600, Math.max(120, Math.floor(maxChars * 0.25)));
  const headChars = Math.max(0, maxChars - marker.length - tailChars);
  return `${value.slice(0, headChars)}${marker}${value.slice(-tailChars)}`;
};

const getMessageContentForFingerprint = (message: ChatMessage): string =>
  `${message.role}:${message.content}\n${message.hidden_context || ''}`;

const findMessageIndexById = (messages: ChatMessage[], messageId: string): number =>
  messages.findIndex((message) => message.id === messageId);

const getCompactionBoundaryIndex = (orderedMessages: ChatMessage[]): number => {
  const userIndexes = orderedMessages.reduce<number[]>((indexes, message, index) => {
    if (message.role === 'user') {
      indexes.push(index);
    }
    return indexes;
  }, []);

  if (userIndexes.length < 3) {
    return -1;
  }

  let candidateIndex = userIndexes[userIndexes.length - 2]! - 1;
  while (candidateIndex >= 0 && orderedMessages[candidateIndex]?.role !== 'assistant') {
    candidateIndex -= 1;
  }
  return candidateIndex;
};

const parseToolContextAttributes = (rawAttrs: string): Record<string, string> => {
  const attrs: Record<string, string> = {};
  for (const match of rawAttrs.matchAll(TOOL_ATTR_REGEX)) {
    attrs[match[1]!] = match[2]!;
  }
  return attrs;
};

const inferToolDigestKind = (toolName: string): ToolContextDigestKind => {
  if (toolName === 'read' || toolName === 'read_file') return 'file_read';
  if (toolName === 'web_search' || toolName === 'web_fetch') return 'web_result';
  if (toolName.startsWith('git_')) return 'git_result';
  if (toolName.startsWith('terminal_')) return 'terminal_result';
  return 'tool_result';
};

const inferToolDigestTarget = (
  toolName: string,
  detail: string,
  body: string
): string => {
  const fileHeaderMatch = body.match(/^FILE:\s*(.+)$/m);
  if (fileHeaderMatch?.[1]) return normalizeWhitespace(fileHeaderMatch[1]);

  const urlMatch = body.match(/^URL:\s*(.+)$/m);
  if (urlMatch?.[1]) return normalizeWhitespace(urlMatch[1]);

  if (detail.trim()) return detail.trim();
  return toolName;
};

const buildDigestEvidence = (body: string): string => {
  const normalized = normalizeWhitespace(body);
  return truncateMiddle(normalized, MAX_DIGEST_EVIDENCE_CHARS);
};

export const parseHiddenToolContext = (
  hiddenContext: string | undefined,
  sourceMessageId: string
): ToolContextDigestEntry[] => {
  if (!hiddenContext?.trim()) return [];

  const digests: ToolContextDigestEntry[] = [];
  const seen = new Set<string>();

  for (const match of hiddenContext.matchAll(TOOL_CONTEXT_BLOCK_REGEX)) {
    const attrs = parseToolContextAttributes(match[1] || '');
    const toolName = attrs.tool || 'tool';
    const detail = attrs.detail || '';
    const body = (match[2] || '').trim();
    if (!body) continue;

    const entry: ToolContextDigestEntry = {
      tool_name: toolName,
      target: inferToolDigestTarget(toolName, detail, body),
      kind: inferToolDigestKind(toolName),
      evidence_excerpt: buildDigestEvidence(body),
      source_message_id: sourceMessageId,
      hash: simpleHash(`${toolName}|${detail}|${body}`),
    };
    if (seen.has(entry.hash)) continue;
    seen.add(entry.hash);
    digests.push(entry);
  }

  return digests;
};

const buildToolDigest = (
  messages: ChatMessage[],
  upToIndex: number
): ToolContextDigestEntry[] => {
  const deduped = new Map<string, ToolContextDigestEntry>();
  for (const message of messages.slice(0, upToIndex + 1)) {
    if (message.role !== 'assistant') continue;
    for (const digest of parseHiddenToolContext(message.hidden_context, message.id)) {
      if (!deduped.has(digest.hash)) {
        deduped.set(digest.hash, digest);
      }
    }
  }
  return Array.from(deduped.values()).slice(0, MAX_DIGEST_ITEMS);
};

const filterSourcePassagesForBoundary = (
  citations: Citation[],
  orderedMessages: ChatMessage[],
  upToIndex: number,
  kind: 'used' | 'interesting'
): Citation[] => {
  const allowedMessageIds = new Set(
    orderedMessages.slice(0, upToIndex + 1).map((message) => message.id)
  );
  return citations.filter(
    (citation) =>
      citation.scope === 'source' &&
      (citation.kind || 'used') === kind &&
      allowedMessageIds.has(citation.messageId)
  );
};

const computeCompactionFingerprint = (
  messages: ChatMessage[],
  usedSourcePassageIds: string[],
  interestingSourcePassageIds: string[]
): string =>
  simpleHash(
    JSON.stringify({
      version: SOURCE_PASSAGE_VERSION,
      messages: messages.map((message) => ({
        id: message.id,
        content: getMessageContentForFingerprint(message),
      })),
      usedSourcePassageIds: [...usedSourcePassageIds].sort(),
      interestingSourcePassageIds: [...interestingSourcePassageIds].sort(),
    })
  );

const buildFallbackSummary = (input: SummaryGenerationInput): string => {
  const earlierUserRequests = input.compactableMessages
    .filter((message) => message.role === 'user')
    .slice(-3)
    .map((message) => `- ${truncateMiddle(normalizeWhitespace(message.content), 180)}`)
    .join('\n');
  const earlierAssistantOutputs = input.compactableMessages
    .filter((message) => message.role === 'assistant')
    .slice(-2)
    .map((message) => `- ${truncateMiddle(normalizeWhitespace(message.content), 220)}`)
    .join('\n');
  const toolFacts = input.toolDigest
    .slice(0, 8)
    .map((digest) => `- [${digest.kind}] ${digest.target}: ${digest.evidence_excerpt}`)
    .join('\n');

  return [
    'Compacted prior context summary:',
    earlierUserRequests ? `Earlier user requests:\n${earlierUserRequests}` : '',
    earlierAssistantOutputs
      ? `Earlier assistant outputs:\n${earlierAssistantOutputs}`
      : '',
    toolFacts ? `Tool-derived facts:\n${toolFacts}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
    .trim();
};

const buildCompactionSystemMessage = (
  state: ConversationCompactionState,
  citations: Citation[]
): string => {
  const usedRefs = citations
    .filter((citation) => state.usedSourcePassageIds.includes(citation.id))
    .slice(0, 8)
    .map(
      (citation) =>
        `- ${citation.title}${citation.source ? ` (${citation.source})` : ''}: ${truncateMiddle(
          normalizeWhitespace(citation.snippet || ''),
          160
        )}`
    )
    .join('\n');

  const interestingRefs = citations
    .filter((citation) => state.interestingSourcePassageIds.includes(citation.id))
    .slice(0, 6)
    .map(
      (citation) =>
        `- ${citation.title}${citation.source ? ` (${citation.source})` : ''}`
    )
    .join('\n');

  const digestBlock = state.toolDigest
    .slice(0, MAX_DIGEST_ITEMS)
    .map(
      (entry) =>
        `- [${entry.kind}] ${entry.tool_name} -> ${entry.target}: ${entry.evidence_excerpt}`
    )
    .join('\n');

  return [
    '[COMPACTED CONVERSATION STATE]',
    'Use this compacted state as authoritative prior context for older turns.',
    state.summaryText.trim(),
    digestBlock ? `Tool digest:\n${digestBlock}` : '',
    usedRefs ? `Used source passages kept:\n${usedRefs}` : '',
    interestingRefs ? `Interesting source passages kept:\n${interestingRefs}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
    .trim();
};

const trimToolContextBlocks = (value: string): string =>
  value.replace(TOOL_CONTEXT_BLOCK_REGEX, (_match, attrs: string, body: string) => {
    const trimmedBody = truncateMiddle(body.trim(), EMERGENCY_TOOL_CONTEXT_CHARS);
    return `<tool_context ${attrs}>\n${trimmedBody}\n</tool_context>`;
  });

const applyEmergencyMessageCompaction = (messages: StreamMessage[]): StreamMessage[] =>
  messages.map((message) => {
    if (typeof message.content !== 'string') return message;
    if (!message.content.includes('<tool_context')) return message;
    return {
      ...message,
      content: trimToolContextBlocks(message.content),
    };
  });

const validateCompactionState = (
  state: ConversationCompactionState | null | undefined,
  orderedMessages: ChatMessage[]
): boolean => {
  if (!state) return false;
  const boundaryIndex = findMessageIndexById(orderedMessages, state.upToMessageId);
  if (boundaryIndex < 0) return false;

  const usedMessageIds = orderedMessages
    .slice(0, boundaryIndex + 1)
    .map((message) => message.id);
  if (usedMessageIds.length === 0) return false;

  const fingerprint = computeCompactionFingerprint(
    orderedMessages.slice(0, boundaryIndex + 1),
    state.usedSourcePassageIds,
    state.interestingSourcePassageIds
  );
  return fingerprint === state.fingerprint;
};

const buildMessagesWithCompactionState = (
  systemMessage: string,
  preparedMessages: StreamMessage[],
  orderedMessages: ChatMessage[],
  citations: Citation[],
  compactionState: ConversationCompactionState | null
): StreamMessage[] => {
  const baseMessages: StreamMessage[] = [
    {
      role: 'system',
      content: systemMessage,
    },
  ];

  if (!compactionState) {
    return [...baseMessages, ...preparedMessages];
  }

  const boundaryIndex = findMessageIndexById(orderedMessages, compactionState.upToMessageId);
  if (boundaryIndex < 0) {
    return [...baseMessages, ...preparedMessages];
  }

  return [
    ...baseMessages,
    {
      role: 'system',
      content: buildCompactionSystemMessage(compactionState, citations),
    },
    ...preparedMessages.slice(boundaryIndex + 1),
  ];
};

export const resolveModelContextWindowTokens = (params: {
  providerType?: string | null;
  modelContextWindowTokens?: number | null;
}): number => {
  if (
    typeof params.modelContextWindowTokens === 'number' &&
    Number.isFinite(params.modelContextWindowTokens) &&
    params.modelContextWindowTokens > 0
  ) {
    return Math.trunc(params.modelContextWindowTokens);
  }

  switch ((params.providerType || '').trim().toLowerCase()) {
    case 'chatgpt':
    case 'copilot':
      return 128_000;
    case 'openai':
    case 'openrouter':
    case 'anthropic':
      return 64_000;
    case 'ollama':
    case 'lmstudio':
    default:
      return 16_000;
  }
};

export const estimateConversationFootprint = (
  params: EstimateConversationFootprintParams
): ContextFootprint => {
  const thresholds = getCompactionThresholds(params.thresholds);
  const mode = params.mode || 'blocking';
  const systemTokens = estimateTokensForText(params.systemMessage);
  const toolSchemaTokens = estimateTokensForText(
    JSON.stringify(params.toolDefinitions || [])
  );
  const imagePlaceholderTokens = countImagePlaceholderTokens(params.preparedMessages);
  const totalPreparedTokens = params.preparedMessages.reduce(
    (total, message) => total + estimateTokensForStreamMessage(message),
    0
  );
  const hiddenContextTokens = params.orderedMessages.reduce(
    (total, message) => total + estimateTokensForText(message.hidden_context || ''),
    0
  );
  const citationTokens = params.citations.reduce(
    (total, citation) =>
      total +
      estimateTokensForText(
        `${citation.title}\n${citation.source}\n${citation.snippet || ''}`
      ),
    0
  );
  const toolTurnCount = params.orderedMessages.filter(
    (message) =>
      message.role === 'assistant' &&
      typeof message.hidden_context === 'string' &&
      message.hidden_context.includes('<tool_context')
  ).length;
  const totalEstimatedTokens =
    totalPreparedTokens + systemTokens + toolSchemaTokens;
  const messageTokens = Math.max(totalPreparedTokens - hiddenContextTokens, 0);
  const totalContextRatio =
    params.modelContextWindowTokens > 0
      ? totalEstimatedTokens / params.modelContextWindowTokens
      : 0;
  const hiddenContextRatio =
    params.modelContextWindowTokens > 0
      ? hiddenContextTokens / params.modelContextWindowTokens
      : 0;
  const { threshold, reason } = resolveThreshold(
    totalContextRatio,
    hiddenContextRatio,
    toolTurnCount,
    mode,
    thresholds
  );

  return {
    totalEstimatedTokens,
    messageTokens,
    hiddenContextTokens,
    systemTokens,
    toolSchemaTokens,
    imagePlaceholderTokens,
    citationTokens,
    modelContextWindowTokens: params.modelContextWindowTokens,
    threshold,
    reason,
    totalContextRatio,
    hiddenContextRatio,
    toolTurnCount,
  };
};

const buildCompactionState = async (params: {
  orderedMessages: ChatMessage[];
  citations: Citation[];
  systemMessage: string;
  preparedMessages: StreamMessage[];
  toolDefinitions: MacroToolRegistryEntry[];
  modelContextWindowTokens: number;
  currentCompactionState?: ConversationCompactionState | null;
  generateSummary?: (input: SummaryGenerationInput) => Promise<string | null>;
}): Promise<ConversationCompactionState | null> => {
  const boundaryIndex = getCompactionBoundaryIndex(params.orderedMessages);
  if (boundaryIndex < 0) return null;

  const boundaryMessage = params.orderedMessages[boundaryIndex];
  if (!boundaryMessage) return null;
  if (
    params.currentCompactionState &&
    params.currentCompactionState.upToMessageId === boundaryMessage.id &&
    validateCompactionState(params.currentCompactionState, params.orderedMessages)
  ) {
    return params.currentCompactionState;
  }

  const compactableMessages = params.orderedMessages.slice(0, boundaryIndex + 1);
  const retainedMessages = params.orderedMessages.slice(boundaryIndex + 1);
  const toolDigest = buildToolDigest(params.orderedMessages, boundaryIndex);
  const usedSourcePassages = filterSourcePassagesForBoundary(
    params.citations,
    params.orderedMessages,
    boundaryIndex,
    'used'
  );
  const interestingSourcePassages = filterSourcePassagesForBoundary(
    params.citations,
    params.orderedMessages,
    boundaryIndex,
    'interesting'
  );

  let summaryText: string | null = null;
  try {
    summaryText =
      (await params.generateSummary?.({
        compactableMessages,
        retainedMessages,
        toolDigest,
        usedSourcePassages,
        interestingSourcePassages,
      })) ?? null;
  } catch {
    summaryText = null;
  }

  const summary = (summaryText || buildFallbackSummary({
    compactableMessages,
    retainedMessages,
    toolDigest,
    usedSourcePassages,
    interestingSourcePassages,
  }))
    .trim();

  const provisionalState: ConversationCompactionState = {
    conversationId: compactableMessages[0]?.conversation_id || '',
    upToMessageId: boundaryMessage.id,
    summaryText: summary,
    toolDigest,
    usedSourcePassageIds: usedSourcePassages.map((citation) => citation.id),
    interestingSourcePassageIds: interestingSourcePassages.map(
      (citation) => citation.id
    ),
    estimatedTokensBefore: estimateConversationFootprint({
      systemMessage: params.systemMessage,
      preparedMessages: params.preparedMessages,
      orderedMessages: params.orderedMessages,
      citations: params.citations,
      toolDefinitions: params.toolDefinitions,
      modelContextWindowTokens: params.modelContextWindowTokens,
      mode: 'blocking',
    }).totalEstimatedTokens,
    estimatedTokensAfter: 0,
    fingerprint: '',
    version: SOURCE_PASSAGE_VERSION,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  provisionalState.fingerprint = computeCompactionFingerprint(
    compactableMessages,
    provisionalState.usedSourcePassageIds,
    provisionalState.interestingSourcePassageIds
  );

  return provisionalState;
};

export const invalidateCompactionFromMessage = (
  state: ConversationCompactionState | null | undefined,
  orderedMessages: ChatMessage[],
  changedMessageId: string
): boolean => {
  if (!state) return false;
  const boundaryIndex = findMessageIndexById(orderedMessages, state.upToMessageId);
  const changedIndex = findMessageIndexById(orderedMessages, changedMessageId);
  if (boundaryIndex < 0 || changedIndex < 0) return true;
  return changedIndex <= boundaryIndex;
};

export const maybeCompactConversation = async (
  params: MaybeCompactConversationParams
): Promise<MaybeCompactConversationResult> => {
  const footprintBefore = estimateConversationFootprint({
    systemMessage: params.systemMessage,
    preparedMessages: params.preparedMessages,
    orderedMessages: params.orderedMessages,
    citations: params.citations,
    toolDefinitions: params.toolDefinitions,
    modelContextWindowTokens: params.modelContextWindowTokens,
    mode: params.mode,
  });

  const validCurrentState = validateCompactionState(
    params.currentCompactionState,
    params.orderedMessages
  )
    ? params.currentCompactionState || null
    : null;

  let activeState = validCurrentState;
  let usedExistingCompaction = Boolean(validCurrentState);
  let messages = buildMessagesWithCompactionState(
    params.systemMessage,
    params.preparedMessages,
    params.orderedMessages,
    params.citations,
    activeState
  );

  let footprintAfter = estimateConversationFootprint({
    systemMessage: params.systemMessage,
    preparedMessages: messages.slice(1),
    orderedMessages: params.orderedMessages,
    citations: params.citations,
    toolDefinitions: params.toolDefinitions,
    modelContextWindowTokens: params.modelContextWindowTokens,
    mode: 'after_compaction',
  });

  const needsNewCompaction =
    !activeState &&
    ((params.mode === 'blocking' && footprintBefore.threshold === 'blocking') ||
      (params.mode === 'background' &&
        footprintBefore.threshold !== 'none'));

  const existingCompactionInsufficient =
    Boolean(activeState) &&
    params.mode === 'blocking' &&
    footprintAfter.threshold === 'blocking';

  if (needsNewCompaction || existingCompactionInsufficient) {
    const nextState = await buildCompactionState({
      orderedMessages: params.orderedMessages,
      citations: params.citations,
      systemMessage: params.systemMessage,
      preparedMessages: params.preparedMessages,
      toolDefinitions: params.toolDefinitions,
      modelContextWindowTokens: params.modelContextWindowTokens,
      currentCompactionState: activeState,
      generateSummary: params.generateSummary,
    });

    if (nextState) {
      activeState = nextState;
      usedExistingCompaction = Boolean(
        validCurrentState && validCurrentState.upToMessageId === nextState.upToMessageId
      );
      messages = buildMessagesWithCompactionState(
        params.systemMessage,
        params.preparedMessages,
        params.orderedMessages,
        params.citations,
        nextState
      );
      footprintAfter = estimateConversationFootprint({
        systemMessage: params.systemMessage,
        preparedMessages: messages.slice(1),
        orderedMessages: params.orderedMessages,
        citations: params.citations,
        toolDefinitions: params.toolDefinitions,
        modelContextWindowTokens: params.modelContextWindowTokens,
        mode: 'after_compaction',
      });
      activeState = {
        ...nextState,
        estimatedTokensAfter: footprintAfter.totalEstimatedTokens,
        updatedAt: new Date().toISOString(),
      };
    }
  }

  let degraded = false;
  if (footprintAfter.threshold === 'degraded') {
    degraded = true;
    messages = applyEmergencyMessageCompaction(messages);
    footprintAfter = estimateConversationFootprint({
      systemMessage: params.systemMessage,
      preparedMessages: messages.slice(1),
      orderedMessages: params.orderedMessages,
      citations: params.citations,
      toolDefinitions: params.toolDefinitions,
      modelContextWindowTokens: params.modelContextWindowTokens,
      mode: 'after_compaction',
    });
    if (activeState) {
      activeState = {
        ...activeState,
        estimatedTokensAfter: footprintAfter.totalEstimatedTokens,
      };
    }
  }

  return {
    compactionState: activeState,
    footprintBefore,
    footprintAfter,
    messages,
    usedExistingCompaction,
    degraded,
  };
};

export const buildCompactedMessagesForRequest = async (
  params: MaybeCompactConversationParams
): Promise<MaybeCompactConversationResult> =>
  maybeCompactConversation(params);

export const LocalCompactionAdapter: ProviderCompactionAdapter = {
  compact: maybeCompactConversation,
};
