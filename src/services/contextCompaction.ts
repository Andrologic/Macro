import type {
  ChatMessage,
  CompactionPass,
  ContextCompactionKind,
  ContextFootprint,
  ContextFootprintReason,
  ContextFootprintThreshold,
  ConversationCompactionState,
  CompactionSummarySource,
  ToolContextDigestEntry,
  ToolContextDigestKind,
} from '../types';
import type { Citation } from '../stores/useCitationsStore';
import type { StreamMessage, StreamMessageContent } from './streamingChat';
import type { MacroToolRegistryEntry } from '../shared/macroToolRegistry';

const CHARS_PER_TOKEN = 4;
const SOURCE_PASSAGE_VERSION = 1;
export const COMPACTION_SUMMARY_FORMAT_VERSION = 2;
const EMERGENCY_TOOL_CONTEXT_CHARS = 1200;
const MAX_DIGEST_ITEMS = 18;
const MAX_DIGEST_EVIDENCE_CHARS = 220;
const MAX_SUMMARY_CHARS = 9000;
const NORMAL_PROVIDER_ITEM_TARGET_CHARS = 2400;
const FORCED_PROVIDER_ITEM_TARGET_CHARS = 1200;
const ULTRA_PROVIDER_ITEM_TARGET_CHARS = 520;

type CompactionMode = ContextCompactionKind | 'after_compaction';
export type { CompactionPass } from '../types';
export type ContextCompactionDecision = 'send' | 'retry_after_compaction' | 'hard_stop';

interface PreparedCompactionPassResult {
  messages: StreamMessage[];
  prunedMessageIds: string[];
}

interface CompactionThresholds {
  backgroundRatio: number;
  blockingRatio: number;
  hiddenContextRatio: number;
  toolTurnCount: number;
  degradedRatio: number;
}

export interface ContextBudgetPolicy {
  auto?: boolean;
  prune?: boolean;
  reservedTokens?: number | null;
  hardStopRatio?: number;
}

export interface ResolvedContextBudgetPolicy {
  reservedTokens: number;
  usableContextTokens: number;
  hardStopRatio: number;
}

export interface EstimateConversationFootprintParams {
  systemMessage: string;
  preparedMessages: StreamMessage[];
  orderedMessages: ChatMessage[];
  citations: Citation[];
  toolDefinitions: MacroToolRegistryEntry[];
  modelContextWindowTokens: number;
  estimateSerializedPayloadTokens?: (messages: StreamMessage[]) => number | null | undefined;
  mode?: CompactionMode;
  thresholds?: Partial<CompactionThresholds>;
  budgetPolicy?: ContextBudgetPolicy;
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
  estimateSerializedPayloadTokens?: (messages: StreamMessage[]) => number | null | undefined;
  mode: ContextCompactionKind;
  budgetPolicy?: ContextBudgetPolicy;
  forceCompaction?: boolean;
  forcePrune?: boolean;
  generateSummary?: (input: SummaryGenerationInput) => Promise<string | null>;
  onCompactionStarted?: () => void;
}

export interface MaybeCompactConversationResult {
  compactionState: ConversationCompactionState | null;
  footprintBefore: ContextFootprint;
  footprintAfter: ContextFootprint;
  messages: StreamMessage[];
  usedExistingCompaction: boolean;
  degraded: boolean;
  decision: ContextCompactionDecision;
}

export interface ProviderCompactionAdapter {
  compact(
    params: MaybeCompactConversationParams
  ): Promise<MaybeCompactConversationResult>;
}

export const buildContextTooLargeErrorMessage = (
  footprint?: ContextFootprint
): string => {
  const base =
    'The conversation is still too large for the selected model after aggressive compaction. Macro kept the latest message; switch to a larger-context model or continue from the compacted summary.';
  if (!footprint) {
    return base;
  }

  const formatTokens = (value?: number): string =>
    typeof value === 'number' && Number.isFinite(value)
      ? `${Math.round(value).toLocaleString()} tokens`
      : 'unknown';
  const contributors = [
    ['messages', footprint.visibleMessageTokens],
    ['provider history', footprint.providerInputTokens],
    ['serialized payload', footprint.serializedPayloadTokens],
    ['system', footprint.systemTokens],
    ['tools', footprint.toolSchemaTokens],
    ['summary', footprint.summaryTokens],
    ['latest request', footprint.latestUserContextTokens],
  ]
    .filter((entry): entry is [string, number] =>
      typeof entry[1] === 'number' && entry[1] > 0
    )
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([label, value]) => `${label}: ${formatTokens(value)}`)
    .join(', ');

  return `${base} Estimated payload: ${formatTokens(
    footprint.totalEstimatedTokens
  )} / ${formatTokens(footprint.modelContextWindowTokens)}. Largest parts: ${
    contributors || 'unknown'
  }.`;
};

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
const PROTECTED_TOOL_CONTEXT_NAMES = new Set([
  'question',
  'task_todo_get',
  'task_todo_update',
]);
const PROTECTED_TOOL_CONTEXT_PREFIXES = ['need_', 'strategy_', 'plan_'];

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
  usableRatio: number,
  hiddenRatio: number,
  toolTurnCount: number,
  mode: CompactionMode,
  thresholds: CompactionThresholds,
  isHardStop: boolean
): { threshold: ContextFootprintThreshold; reason: ContextFootprintReason } => {
  if (isHardStop) {
    return { threshold: 'degraded', reason: 'hard_stop_ratio' };
  }
  if (mode === 'after_compaction' && usableRatio >= thresholds.degradedRatio) {
    return { threshold: 'degraded', reason: 'post_compaction_overflow' };
  }
  if (usableRatio >= thresholds.degradedRatio) {
    return { threshold: 'degraded', reason: 'total_context_ratio' };
  }
  if (usableRatio >= thresholds.blockingRatio) {
    return { threshold: 'blocking', reason: 'total_context_ratio' };
  }
  if (usableRatio >= thresholds.backgroundRatio) {
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

const exceedsUsableContext = (footprint: ContextFootprint): boolean =>
  footprint.isHardStop || footprint.usableContextRatio >= 1;

export const resolveContextBudgetPolicy = (
  modelContextWindowTokens: number,
  policy?: ContextBudgetPolicy
): ResolvedContextBudgetPolicy => {
  const contextWindow = Math.max(1, Math.trunc(modelContextWindowTokens || 1));
  const automaticReservedTokens = Math.min(
    20_000,
    Math.floor(contextWindow * 0.2)
  );
  const explicitReservedTokens =
    typeof policy?.reservedTokens === 'number' &&
    Number.isFinite(policy.reservedTokens) &&
    policy.reservedTokens >= 0
      ? Math.trunc(policy.reservedTokens)
      : null;
  const reservedTokens = Math.min(
    contextWindow - 1,
    Math.max(0, explicitReservedTokens ?? automaticReservedTokens)
  );
  const hardStopRatio =
    typeof policy?.hardStopRatio === 'number' &&
    Number.isFinite(policy.hardStopRatio) &&
    policy.hardStopRatio > 0 &&
    policy.hardStopRatio <= 1
      ? policy.hardStopRatio
      : 0.98;

  return {
    reservedTokens,
    usableContextTokens: Math.max(1, contextWindow - reservedTokens),
    hardStopRatio,
  };
};

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const deepCloneJsonValue = <T,>(value: T): T => {
  if (!isRecord(value) && !Array.isArray(value)) return value;
  return JSON.parse(JSON.stringify(value)) as T;
};

const streamContentToText = (content: StreamMessageContent): string => {
  if (typeof content === 'string') return content;
  return content
    .map((part) => {
      if (part.type === 'text') return part.text || '';
      if (part.type === 'image_url') return '[image attachment]';
      return '';
    })
    .filter(Boolean)
    .join('\n');
};

const getProviderItemText = (item: Record<string, unknown>): string => {
  const visibleContent =
    typeof item.visible_content === 'string' ? item.visible_content : '';
  const content = item.content;
  if (visibleContent.trim()) return visibleContent;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .flatMap((part) => {
        if (!isRecord(part)) return [];
        if (typeof part.text === 'string') return [part.text];
        if (typeof part.image_url === 'string') return ['[image attachment]'];
        return [];
      })
      .join('\n');
  }
  return '';
};

const getProviderCompactionTargetChars = (pass: CompactionPass): number => {
  if (pass === 'ultra') return ULTRA_PROVIDER_ITEM_TARGET_CHARS;
  if (pass === 'forced') return FORCED_PROVIDER_ITEM_TARGET_CHARS;
  return NORMAL_PROVIDER_ITEM_TARGET_CHARS;
};

const isAggressiveCompactionPass = (pass: CompactionPass): boolean =>
  pass === 'forced' || pass === 'ultra';

const resolveInitialCompactionPass = (
  mode: ContextCompactionKind,
  forcePrune?: boolean
): CompactionPass =>
  mode === 'overflow_recovery' || forcePrune ? 'forced' : 'normal';

const mergeMessageIds = (...idGroups: string[][]): string[] =>
  Array.from(new Set(idGroups.flat()));

const summarizeProviderToolCalls = (toolCalls: unknown): string => {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return '';
  return toolCalls
    .flatMap((toolCall) => {
      if (!isRecord(toolCall)) return [];
      const fn = isRecord(toolCall.function) ? toolCall.function : null;
      const name = typeof fn?.name === 'string' ? fn.name : 'tool';
      const args = typeof fn?.arguments === 'string' ? fn.arguments : '';
      return [`${name}(${truncateMiddle(normalizeWhitespace(args), 160)})`];
    })
    .slice(0, 6)
    .join(', ');
};

const compactProviderInputItem = (
  item: unknown,
  pass: CompactionPass,
  fallbackContent: StreamMessageContent
): unknown | null => {
  if (!isRecord(item)) return item;

  const targetChars = getProviderCompactionTargetChars(pass);
  if (item.type === 'chat_completion_message') {
    const role = item.role === 'tool' ? 'tool' : 'assistant';
    const sourceText =
      getProviderItemText(item) ||
      (typeof item.reasoning_content === 'string'
        ? item.reasoning_content
        : '') ||
      streamContentToText(fallbackContent);
    const toolCallSummary = summarizeProviderToolCalls(item.tool_calls);
    const compactedText = truncateMiddle(
      normalizeWhitespace(
        [sourceText, toolCallSummary ? `Tool calls preserved as fact: ${toolCallSummary}` : '']
          .filter(Boolean)
          .join('\n')
      ),
      targetChars
    );

    if (role === 'tool') {
      if (typeof item.tool_call_id !== 'string' || !item.tool_call_id.trim()) {
        return null;
      }
      return {
        type: 'chat_completion_message',
        role: 'tool',
        content: compactedText,
        tool_call_id: item.tool_call_id,
        ...(typeof item.tool_name === 'string' && item.tool_name.trim()
          ? { tool_name: item.tool_name }
          : {}),
      };
    }

    return {
      type: 'chat_completion_message',
      role: 'assistant',
      content: compactedText,
      visible_content: compactedText,
    };
  }

  if (item.type === 'message') {
    const role = item.role === 'assistant' ? 'assistant' : 'user';
    const sourceText = getProviderItemText(item) || streamContentToText(fallbackContent);
    return {
      type: 'message',
      role,
      content: [
        {
          type: role === 'user' ? 'input_text' : 'output_text',
          text: truncateMiddle(normalizeWhitespace(sourceText), targetChars),
        },
      ],
    };
  }

  const serialized = JSON.stringify(item);
  if (serialized.length <= targetChars) return deepCloneJsonValue(item);
  return {
    type: 'compacted_provider_item',
    excerpt: truncateMiddle(normalizeWhitespace(serialized), targetChars),
    hash: simpleHash(serialized),
  };
};

const getMessageContentForFingerprint = (message: ChatMessage): string =>
  `${message.role}:${message.content}\n${message.hidden_context || ''}`;

const findMessageIndexById = (messages: ChatMessage[], messageId: string): number =>
  messages.findIndex((message) => message.id === messageId);

const getCompactionBoundaryIndex = (
  orderedMessages: ChatMessage[],
  retainedUserTurns = 2
): number => {
  const userIndexes = orderedMessages.reduce<number[]>((indexes, message, index) => {
    if (message.role === 'user') {
      indexes.push(index);
    }
    return indexes;
  }, []);

  const retainedTurns = Math.max(1, Math.trunc(retainedUserTurns));
  if (userIndexes.length <= retainedTurns) {
    return -1;
  }

  let candidateIndex = userIndexes[userIndexes.length - retainedTurns]! - 1;
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

const isProtectedToolContext = (toolName: string): boolean => {
  const normalized = toolName.trim();
  return (
    PROTECTED_TOOL_CONTEXT_NAMES.has(normalized) ||
    PROTECTED_TOOL_CONTEXT_PREFIXES.some((prefix) =>
      normalized.startsWith(prefix)
    )
  );
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
      timestamp: attrs.timestamp || undefined,
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

const estimateHiddenContextTokensFromPreparedMessages = (
  messages: StreamMessage[]
): number => {
  let hiddenTokens = 0;
  for (const message of messages) {
    if (typeof message.content !== 'string') continue;
    for (const match of message.content.matchAll(TOOL_CONTEXT_BLOCK_REGEX)) {
      hiddenTokens += estimateTokensForText(match[0] || '');
    }
  }
  return hiddenTokens;
};

const getRecentUserTurnStartIndex = (orderedMessages: ChatMessage[]): number => {
  const userIndexes = orderedMessages.reduce<number[]>((indexes, message, index) => {
    if (message.role === 'user') {
      indexes.push(index);
    }
    return indexes;
  }, []);

  if (userIndexes.length < 2) return 0;
  return userIndexes[userIndexes.length - 2] ?? 0;
};

const buildPrunedToolContextPlaceholder = (params: {
  attrs: string;
  toolName: string;
  detail: string;
  body: string;
  sourceMessageId: string;
}): string => {
  const hash = simpleHash(`${params.toolName}|${params.detail}|${params.body}`);
  const target = inferToolDigestTarget(params.toolName, params.detail, params.body);
  const excerpt = buildDigestEvidence(params.body);
  const suffix = ` compacted="true" source_message_id="${params.sourceMessageId}" hash="${hash}"`;
  return `<tool_context ${params.attrs}${suffix}>
[pruned tool context]
tool: ${params.toolName}
target: ${target}
excerpt: ${excerpt}
hash: ${hash}
</tool_context>`;
};

export const pruneToolContextBlocks = (
  preparedMessages: StreamMessage[],
  orderedMessages: ChatMessage[],
  options: {
    force?: boolean;
    minBodyTokens?: number;
  } = {}
): { messages: StreamMessage[]; prunedMessageIds: string[] } => {
  const recentTurnStartIndex = getRecentUserTurnStartIndex(orderedMessages);
  const prunedMessageIds = new Set<string>();
  const minBodyTokens = Math.max(1, options.minBodyTokens ?? 200);

  const messages = preparedMessages.map((message, index) => {
    const orderedMessage = orderedMessages[index];
    if (
      !orderedMessage ||
      orderedMessage.role !== 'assistant' ||
      index >= recentTurnStartIndex ||
      typeof message.content !== 'string' ||
      !message.content.includes('<tool_context')
    ) {
      return message;
    }

    let changed = false;
    const content = message.content.replace(
      TOOL_CONTEXT_BLOCK_REGEX,
      (match, rawAttrs: string, rawBody: string) => {
        const attrs = parseToolContextAttributes(rawAttrs || '');
        const toolName = attrs.tool || 'tool';
        const body = (rawBody || '').trim();
        if (!body || (isProtectedToolContext(toolName) && !options.force)) {
          return match;
        }
        if (!options.force && estimateTokensForText(body) < minBodyTokens) {
          return match;
        }

        changed = true;
        return buildPrunedToolContextPlaceholder({
          attrs: rawAttrs,
          toolName,
          detail: attrs.detail || '',
          body,
          sourceMessageId: orderedMessage.id,
        });
      }
    );

    if (!changed) return message;
    prunedMessageIds.add(orderedMessage.id);
    return {
      ...message,
      content,
    };
  });

  return {
    messages,
    prunedMessageIds: Array.from(prunedMessageIds),
  };
};

export const compactProviderInputItemsForContext = (
  preparedMessages: StreamMessage[],
  orderedMessages: ChatMessage[],
  pass: CompactionPass
): { messages: StreamMessage[]; compactedMessageIds: string[] } => {
  const recentTurnStartIndex = getRecentUserTurnStartIndex(orderedMessages);
  const latestUserMessage = [...orderedMessages]
    .reverse()
    .find((message) => message.role === 'user');
  const compactedMessageIds = new Set<string>();

  const messages = preparedMessages.map((message, index) => {
    const orderedMessage = orderedMessages[index];
    if (!orderedMessage || !Array.isArray(message.provider_input_items)) {
      return message;
    }
    if (latestUserMessage && orderedMessage.id === latestUserMessage.id) {
      return message;
    }

    const shouldCompact =
      pass === 'ultra' ||
      pass === 'forced' ||
      index < recentTurnStartIndex ||
      estimateTokensForProviderInputItems(message.provider_input_items) >
        estimateTokensForStreamContent(message.content) + 200;

    if (!shouldCompact) {
      return message;
    }

    const compactedItems = message.provider_input_items
      .map((item) => compactProviderInputItem(item, pass, message.content))
      .filter((item): item is unknown => item !== null);
    const before = estimateTokensForProviderInputItems(message.provider_input_items);
    const after = estimateTokensForProviderInputItems(compactedItems);
    if (compactedItems.length === 0 || after >= before) {
      compactedMessageIds.add(orderedMessage.id);
      return {
        ...message,
        provider_input_items: undefined,
      };
    }

    compactedMessageIds.add(orderedMessage.id);
    return {
      ...message,
      provider_input_items: compactedItems,
    };
  });

  return {
    messages,
    compactedMessageIds: Array.from(compactedMessageIds),
  };
};

const runPreparedCompactionPass = (params: {
  preparedMessages: StreamMessage[];
  orderedMessages: ChatMessage[];
  pass: CompactionPass;
  shouldPrune: boolean;
  forcePrune?: boolean;
  mode: ContextCompactionKind;
}): PreparedCompactionPassResult => {
  const pruned =
    params.shouldPrune
      ? pruneToolContextBlocks(params.preparedMessages, params.orderedMessages, {
          force:
            params.forcePrune ||
            isAggressiveCompactionPass(params.pass) ||
            params.mode === 'overflow_recovery',
        })
      : { messages: params.preparedMessages, prunedMessageIds: [] };
  const providerCompacted =
    params.shouldPrune
      ? compactProviderInputItemsForContext(
          pruned.messages,
          params.orderedMessages,
          params.pass
        )
      : { messages: pruned.messages, compactedMessageIds: [] };

  return {
    messages: providerCompacted.messages,
    prunedMessageIds: mergeMessageIds(
      pruned.prunedMessageIds,
      providerCompacted.compactedMessageIds
    ),
  };
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
  const latestRetainedUserRequest = [...input.retainedMessages]
    .reverse()
    .find((message) => message.role === 'user');
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
    'Current objective:',
    latestRetainedUserRequest
      ? truncateMiddle(normalizeWhitespace(latestRetainedUserRequest.content), 220)
      : 'Continue the current conversation from the retained recent turns.',
    '',
    'User instructions:',
    earlierUserRequests || '- No older user instruction survived deterministic extraction.',
    '',
    'Decisions:',
    '- Preserve recent visible conversation turns verbatim and rely on this compacted state for older context.',
    '',
    'Discoveries:',
    toolFacts || '- No deterministic discoveries captured beyond retained recent turns.',
    '',
    'Open questions:',
    '- None captured deterministically.',
    '',
    'Active files:',
    '- See tool facts for referenced paths and targets.',
    '',
    'Tool facts:',
    toolFacts || '- No older tool facts captured.',
    '',
    'Remaining work:',
    '- Continue from the latest retained user turn using this compacted context.',
    '',
    'Summary:',
    earlierUserRequests ? `Earlier user requests:\n${earlierUserRequests}` : '',
    earlierAssistantOutputs
      ? `Earlier assistant outputs:\n${earlierAssistantOutputs}`
      : '',
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
    `Summary schema: v${state.summaryFormatVersion ?? 1}; source: ${
      state.summarySource ?? 'unknown'
    }; pass: ${state.compactionPass ?? 'normal'}.`,
    truncateMiddle(state.summaryText.trim(), MAX_SUMMARY_CHARS),
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

const applyEmergencyMessageCompaction = (
  messages: StreamMessage[],
  pass: CompactionPass = 'forced',
  options: { preserveLatestUser?: boolean } = { preserveLatestUser: true }
): StreamMessage[] => {
  const latestUserIndex =
    options.preserveLatestUser === false
      ? -1
      : messages.reduce(
          (latestIndex, candidate, candidateIndex) =>
            candidate.role === 'user' ? candidateIndex : latestIndex,
          -1
        );

  return messages.map((message, index) => {
    if (index === latestUserIndex) {
      return message;
    }

    let nextMessage = message;
    if (typeof nextMessage.content === 'string' && nextMessage.content.includes('<tool_context')) {
      nextMessage = {
        ...nextMessage,
        content: trimToolContextBlocks(nextMessage.content),
      };
    }

    if (Array.isArray(nextMessage.provider_input_items)) {
      const compactedItems = nextMessage.provider_input_items
        .map((item) => compactProviderInputItem(item, pass, nextMessage.content))
        .filter((item): item is unknown => item !== null);
      nextMessage = {
        ...nextMessage,
        provider_input_items: compactedItems.length > 0 ? compactedItems : undefined,
      };
    }

    return nextMessage;
  });
};

export const validateCompactionState = (
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

export const buildMessagesWithCompactionState = (
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
  providerId?: string | null;
  baseUrl?: string | null;
  modelId?: string | null;
  modelContextWindowTokens?: number | null;
}): number => {
  if (
    typeof params.modelContextWindowTokens === 'number' &&
    Number.isFinite(params.modelContextWindowTokens) &&
    params.modelContextWindowTokens > 0
  ) {
    return Math.trunc(params.modelContextWindowTokens);
  }

  const providerType = (params.providerType || '').trim().toLowerCase();
  const providerId = (params.providerId || '').trim().toLowerCase();
  const baseUrl = (params.baseUrl || '').trim().toLowerCase();
  const modelId = (params.modelId || '').trim().toLowerCase();
  const isOpenCodeGo =
    providerId === 'opencode-go' ||
    baseUrl.includes('opencode.ai/zen/go') ||
    baseUrl.includes('opencode.ai/zen/v1');
  if (isOpenCodeGo && (modelId.includes('kimi') || modelId.includes('k2'))) {
    return 128_000;
  }

  switch (providerType) {
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
  const budget = resolveContextBudgetPolicy(
    params.modelContextWindowTokens,
    params.budgetPolicy
  );
  const mode = params.mode || 'blocking';
  const systemTokens = estimateTokensForText(params.systemMessage);
  const toolSchemaTokens = estimateTokensForText(
    JSON.stringify(params.toolDefinitions || [])
  );
  const imagePlaceholderTokens = countImagePlaceholderTokens(params.preparedMessages);
  const visibleMessageTokens = params.preparedMessages.reduce(
    (total, message) => total + estimateTokensForStreamContent(message.content),
    0
  );
  const providerInputTokens = params.preparedMessages.reduce(
    (total, message) =>
      total + estimateTokensForProviderInputItems(message.provider_input_items),
    0
  );
  const totalPreparedTokens = params.preparedMessages.reduce(
    (total, message) => total + estimateTokensForStreamMessage(message),
    0
  );
  const preparedHiddenContextTokens =
    estimateHiddenContextTokensFromPreparedMessages(params.preparedMessages);
  const originalHiddenContextTokens = params.orderedMessages.reduce(
    (total, message) => total + estimateTokensForText(message.hidden_context || ''),
    0
  );
  const hiddenContextTokens =
    preparedHiddenContextTokens > 0
      ? preparedHiddenContextTokens
      : originalHiddenContextTokens;
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
  const summaryTokens = params.preparedMessages
    .filter(
      (message) =>
        message.role === 'system' &&
        typeof message.content === 'string' &&
        message.content.includes('[COMPACTED CONVERSATION STATE]')
    )
    .reduce((total, message) => total + estimateTokensForStreamContent(message.content), 0);
  const latestPreparedUserMessage = [...params.preparedMessages]
    .reverse()
    .find((message) => message.role === 'user');
  const latestUserContextTokens = latestPreparedUserMessage
    ? estimateTokensForStreamMessage(latestPreparedUserMessage)
    : 0;
  let serializedPayloadTokens: number | undefined;
  try {
    const serializedEstimate = params.estimateSerializedPayloadTokens?.([
      { role: 'system', content: params.systemMessage },
      ...params.preparedMessages,
    ]);
    if (
      typeof serializedEstimate === 'number' &&
      Number.isFinite(serializedEstimate) &&
      serializedEstimate > 0
    ) {
      serializedPayloadTokens = Math.ceil(serializedEstimate);
    }
  } catch {
    serializedPayloadTokens = undefined;
  }
  const structuralEstimatedTokens =
    totalPreparedTokens + systemTokens + toolSchemaTokens;
  const totalEstimatedTokens =
    serializedPayloadTokens === undefined
      ? structuralEstimatedTokens
      : Math.max(structuralEstimatedTokens, serializedPayloadTokens + toolSchemaTokens);
  const messageTokens = Math.max(totalPreparedTokens - hiddenContextTokens, 0);
  const totalContextRatio =
    params.modelContextWindowTokens > 0
      ? totalEstimatedTokens / params.modelContextWindowTokens
      : 0;
  const usableContextRatio =
    budget.usableContextTokens > 0
      ? totalEstimatedTokens / budget.usableContextTokens
      : 0;
  const hiddenContextRatio =
    budget.usableContextTokens > 0
      ? hiddenContextTokens / budget.usableContextTokens
      : 0;
  const isHardStop = totalContextRatio >= budget.hardStopRatio;
  const { threshold, reason } = resolveThreshold(
    usableContextRatio,
    hiddenContextRatio,
    toolTurnCount,
    mode,
    thresholds,
    isHardStop
  );

  return {
    totalEstimatedTokens,
    serializedPayloadTokens,
    messageTokens,
    visibleMessageTokens,
    providerInputTokens,
    hiddenContextTokens,
    systemTokens,
    toolSchemaTokens,
    imagePlaceholderTokens,
    citationTokens,
    summaryTokens,
    latestUserContextTokens,
    modelContextWindowTokens: params.modelContextWindowTokens,
    reservedTokens: budget.reservedTokens,
    usableContextTokens: budget.usableContextTokens,
    threshold,
    reason,
    totalContextRatio,
    usableContextRatio,
    hiddenContextRatio,
    hardStopRatio: budget.hardStopRatio,
    isHardStop,
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
  estimateSerializedPayloadTokens?: (messages: StreamMessage[]) => number | null | undefined;
  budgetPolicy?: ContextBudgetPolicy;
  currentCompactionState?: ConversationCompactionState | null;
  prunedToolContextMessageIds?: string[];
  footprintBefore?: ContextFootprint;
  compactionKind: ContextCompactionKind;
  compactionPass?: CompactionPass;
  retainedUserTurns?: number;
  generateSummary?: (input: SummaryGenerationInput) => Promise<string | null>;
}): Promise<ConversationCompactionState | null> => {
  const boundaryIndex = getCompactionBoundaryIndex(
    params.orderedMessages,
    params.retainedUserTurns
  );
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

  const modelSummary = summaryText?.trim() || '';
  const summarySource: CompactionSummarySource = modelSummary ? 'model' : 'fallback';
  const summary = (modelSummary || buildFallbackSummary({
    compactableMessages,
    retainedMessages,
    toolDigest,
    usedSourcePassages,
    interestingSourcePassages,
  }))
    .trim();
  const boundedSummary = truncateMiddle(summary, MAX_SUMMARY_CHARS);

  const provisionalState: ConversationCompactionState = {
    conversationId: compactableMessages[0]?.conversation_id || '',
    upToMessageId: boundaryMessage.id,
    summaryText: boundedSummary,
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
      estimateSerializedPayloadTokens: params.estimateSerializedPayloadTokens,
      budgetPolicy: params.budgetPolicy,
      mode: 'blocking',
    }).totalEstimatedTokens,
    estimatedTokensAfter: 0,
    fingerprint: '',
    version: SOURCE_PASSAGE_VERSION,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    prunedToolContextMessageIds: params.prunedToolContextMessageIds ?? [],
    reservedTokens: resolveContextBudgetPolicy(
      params.modelContextWindowTokens,
      params.budgetPolicy
    ).reservedTokens,
    footprintBefore: params.footprintBefore,
    degradedReason: null,
    compactionKind: params.compactionKind,
    compactionPass: params.compactionPass ?? 'normal',
    summaryFormatVersion: COMPACTION_SUMMARY_FORMAT_VERSION,
    summarySource,
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
  const estimateFootprint = (
    preparedMessages: StreamMessage[],
    mode: CompactionMode
  ): ContextFootprint => estimateConversationFootprint({
    systemMessage: params.systemMessage,
    preparedMessages,
    orderedMessages: params.orderedMessages,
    citations: params.citations,
    toolDefinitions: params.toolDefinitions,
    modelContextWindowTokens: params.modelContextWindowTokens,
    estimateSerializedPayloadTokens: params.estimateSerializedPayloadTokens,
    mode,
    budgetPolicy: params.budgetPolicy,
  });

  const footprintBefore = estimateFootprint(params.preparedMessages, params.mode);
  const shouldPrune =
    params.budgetPolicy?.prune !== false &&
    (params.budgetPolicy?.auto !== false ||
      params.mode === 'manual' ||
      params.mode === 'overflow_recovery' ||
      Boolean(params.forcePrune));

  const runPass = (pass: CompactionPass): PreparedCompactionPassResult =>
    runPreparedCompactionPass({
      preparedMessages: params.preparedMessages,
      orderedMessages: params.orderedMessages,
      pass,
      shouldPrune,
      forcePrune: params.forcePrune,
      mode: params.mode,
    });

  let compactionPass = resolveInitialCompactionPass(params.mode, params.forcePrune);
  let pruned = runPass(compactionPass);
  let preparedMessages = pruned.messages;
  const footprintAfterPruning = estimateFootprint(preparedMessages, params.mode);

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
    preparedMessages,
    params.orderedMessages,
    params.citations,
    activeState
  );

  let footprintAfter = estimateFootprint(messages.slice(1), 'after_compaction');

  const compactionAllowed =
    params.budgetPolicy?.auto !== false ||
    params.mode === 'manual' ||
    params.mode === 'overflow_recovery' ||
    Boolean(params.forceCompaction);
  const shouldCreateNewCompaction =
    params.forceCompaction ||
    params.mode === 'manual' ||
    params.mode === 'overflow_recovery' ||
    (params.mode === 'blocking' && exceedsUsableContext(footprintAfterPruning));
  const needsNewCompaction =
    compactionAllowed &&
    !activeState &&
    shouldCreateNewCompaction;

  const existingCompactionInsufficient =
    compactionAllowed &&
    Boolean(activeState) &&
    (params.mode === 'blocking' ||
      params.mode === 'overflow_recovery' ||
      params.mode === 'manual') &&
    (exceedsUsableContext(footprintAfter) ||
      Boolean(params.forceCompaction));

  let notifiedCompactionStarted = false;
  const notifyCompactionStarted = () => {
    if (notifiedCompactionStarted) {
      return;
    }
    notifiedCompactionStarted = true;
    params.onCompactionStarted?.();
  };

  if (needsNewCompaction || existingCompactionInsufficient) {
    notifyCompactionStarted();
    const nextState = await buildCompactionState({
      orderedMessages: params.orderedMessages,
      citations: params.citations,
      systemMessage: params.systemMessage,
      preparedMessages,
      toolDefinitions: params.toolDefinitions,
      modelContextWindowTokens: params.modelContextWindowTokens,
      estimateSerializedPayloadTokens: params.estimateSerializedPayloadTokens,
      budgetPolicy: params.budgetPolicy,
      currentCompactionState: params.forceCompaction ? null : activeState,
      prunedToolContextMessageIds: pruned.prunedMessageIds,
      footprintBefore,
      compactionKind: params.mode,
      compactionPass,
      generateSummary: params.generateSummary,
    });

    if (nextState) {
      activeState = nextState;
      usedExistingCompaction = Boolean(
        validCurrentState && validCurrentState.upToMessageId === nextState.upToMessageId
      );
      messages = buildMessagesWithCompactionState(
        params.systemMessage,
        preparedMessages,
        params.orderedMessages,
        params.citations,
        nextState
      );
      footprintAfter = estimateFootprint(messages.slice(1), 'after_compaction');
      activeState = {
        ...nextState,
        estimatedTokensAfter: footprintAfter.totalEstimatedTokens,
        footprintAfter,
        updatedAt: new Date().toISOString(),
      };
    }
  }

  let degraded = false;
  if (exceedsUsableContext(footprintAfter) && activeState) {
    degraded = true;
    messages = applyEmergencyMessageCompaction(messages, compactionPass);
    footprintAfter = estimateFootprint(messages.slice(1), 'after_compaction');
  }

  if (footprintAfter.isHardStop && compactionAllowed && params.mode !== 'background') {
    notifyCompactionStarted();
    compactionPass = 'ultra';
    pruned = runPass(compactionPass);
    preparedMessages = pruned.messages;

    const ultraState = await buildCompactionState({
      orderedMessages: params.orderedMessages,
      citations: params.citations,
      systemMessage: params.systemMessage,
      preparedMessages,
      toolDefinitions: params.toolDefinitions,
      modelContextWindowTokens: params.modelContextWindowTokens,
      estimateSerializedPayloadTokens: params.estimateSerializedPayloadTokens,
      budgetPolicy: params.budgetPolicy,
      currentCompactionState: null,
      prunedToolContextMessageIds: pruned.prunedMessageIds,
      footprintBefore,
      compactionKind: params.mode,
      compactionPass,
      retainedUserTurns: 1,
      generateSummary: params.generateSummary,
    });

    activeState = ultraState;
    usedExistingCompaction = false;
    messages = buildMessagesWithCompactionState(
      params.systemMessage,
      preparedMessages,
      params.orderedMessages,
      params.citations,
      activeState
    );
    degraded = true;
    messages = applyEmergencyMessageCompaction(messages, compactionPass);
    footprintAfter = estimateFootprint(messages.slice(1), 'after_compaction');

    if (activeState) {
      activeState = {
        ...activeState,
        estimatedTokensAfter: footprintAfter.totalEstimatedTokens,
        footprintAfter,
        updatedAt: new Date().toISOString(),
      };
    }
  }

  if (activeState) {
    const prunedToolContextMessageIds = mergeMessageIds(
      activeState.prunedToolContextMessageIds ?? [],
      pruned.prunedMessageIds
    );
    activeState = {
      ...activeState,
      estimatedTokensBefore: footprintBefore.totalEstimatedTokens,
      estimatedTokensAfter: footprintAfter.totalEstimatedTokens,
      prunedToolContextMessageIds,
      reservedTokens: footprintAfter.reservedTokens,
      footprintBefore,
      footprintAfter,
      degradedReason: degraded ? footprintAfter.reason : null,
      compactionKind: params.mode,
      compactionPass,
      updatedAt: new Date().toISOString(),
    };
  }

  const decision: ContextCompactionDecision = footprintAfter.isHardStop
    ? 'hard_stop'
    : params.mode === 'overflow_recovery'
      ? 'retry_after_compaction'
      : 'send';

  return {
    compactionState: activeState,
    footprintBefore,
    footprintAfter,
    messages,
    usedExistingCompaction,
    degraded,
    decision,
  };
};

export const buildCompactedMessagesForRequest = async (
  params: MaybeCompactConversationParams
): Promise<MaybeCompactConversationResult> =>
  maybeCompactConversation(params);

export const LocalCompactionAdapter: ProviderCompactionAdapter = {
  compact: maybeCompactConversation,
};
