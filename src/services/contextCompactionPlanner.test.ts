import { describe, expect, it } from 'bun:test';

import type { ChatMessage, ConversationCompactionState } from '../types';
import type { StreamMessage } from './streamingChat';
import { estimateConversationFootprint } from './contextCompaction';
import { evaluateContextCompaction } from './contextCompactionPlanner';

const makeMessage = (
  id: string,
  role: 'user' | 'assistant',
  content: string,
): ChatMessage => ({
  id,
  task_id: 'task-1',
  conversation_id: 'conv-1',
  role,
  content,
  timestamp: `2026-05-16T10:00:0${id.length}.000Z`,
});

const prepared = (messages: ChatMessage[]): StreamMessage[] =>
  messages.map((message) => ({
    role: message.role,
    content: message.content,
  }));

const footprint = (params: {
  messages?: ChatMessage[];
  context: number;
  output?: number;
  serialized: number;
  authoritative?: boolean;
  source?: 'provider_metadata' | 'macro_fallback' | 'provider_overflow_error';
}) => {
  const messages = params.messages ?? [makeMessage('u1', 'user', 'payload')];
  return estimateConversationFootprint({
    systemMessage: 'You are Macro.',
    preparedMessages: prepared(messages),
    orderedMessages: messages,
    citations: [],
    toolDefinitions: [],
    modelContextWindowTokens: params.context,
    outputLimitTokens: params.output,
    contextLimitSource: params.source ?? 'provider_metadata',
    isContextLimitAuthoritative: params.authoritative ?? true,
    contextLimitConfidence:
      params.source === 'macro_fallback'
        ? 'fallback'
        : params.source === 'provider_overflow_error'
          ? 'learned'
          : 'verified',
    estimateSerializedPayloadTokens: () => params.serialized,
    mode: 'blocking',
  });
};

const checkpoint: ConversationCompactionState = {
  conversationId: 'conv-1',
  upToMessageId: 'a1',
  summaryText: 'summary',
  toolDigest: [],
  usedSourcePassageIds: [],
  interestingSourcePassageIds: [],
  estimatedTokensBefore: 100,
  estimatedTokensAfter: 50,
  fingerprint: 'fp',
  version: 1,
  createdAt: '2026-05-16T10:00:00.000Z',
  updatedAt: '2026-05-16T10:00:00.000Z',
};

describe('evaluateContextCompaction', () => {
  it('compacts at the usable 120k threshold for a 128k model with 8k output reserve', () => {
    const fp = footprint({ context: 128_000, output: 8_000, serialized: 120_000 });
    const result = evaluateContextCompaction({
      boundary: 'pre_send',
      footprint: fp,
      providerId: 'provider-1',
      providerType: 'openai',
      modelId: 'small-model',
    });

    expect(result.decision).toBe('compact');
    expect(result.trigger).toBe('safety_prestream');
    expect(result.budget.usableContextTokens).toBe(120_000);
    expect(result.audit.formula).toBe('128k context - 8k output reserve = 120k usable');
  });

  it('does not compact at 120k for a 400k model', () => {
    const result = evaluateContextCompaction({
      boundary: 'pre_send',
      footprint: footprint({ context: 400_000, output: 8_000, serialized: 120_000 }),
    });

    expect(result.decision).toBe('send');
    expect(result.shouldCreateOrRefreshCheckpoint).toBe(false);
  });

  it('does not auto-compact from a non-authoritative Macro fallback limit', () => {
    const result = evaluateContextCompaction({
      boundary: 'pre_send',
      footprint: footprint({
        context: 64_000,
        output: 8_000,
        serialized: 90_000,
        source: 'macro_fallback',
        authoritative: false,
      }),
    });

    expect(result.decision).toBe('send');
    expect(result.budget.source).toBe('macro_fallback');
    expect(result.budget.isAuthoritative).toBe(false);
  });

  it('requires manual compaction when auto compaction is disabled', () => {
    const result = evaluateContextCompaction({
      boundary: 'pre_send',
      footprint: footprint({ context: 128_000, output: 8_000, serialized: 130_000 }),
      budgetPolicy: { auto: false },
    });

    expect(result.decision).toBe('manual_required');
    expect(result.reason).toBe('auto_compaction_disabled');
  });

  it('reuses an existing checkpoint when projected payload is inside budget', () => {
    const result = evaluateContextCompaction({
      boundary: 'pre_send',
      footprint: footprint({ context: 400_000, output: 8_000, serialized: 120_000 }),
      currentCompactionState: checkpoint,
    });

    expect(result.decision).toBe('reuse_checkpoint');
    expect(result.shouldReuseCheckpoint).toBe(true);
  });

  it('blocks instead of looping when the latest boundary payload alone exceeds the usable budget', () => {
    const result = evaluateContextCompaction({
      boundary: 'post_tool_batch',
      footprint: footprint({ context: 128_000, output: 8_000, serialized: 180_000 }),
      latestBoundaryPayloadTokens: 130_000,
    });

    expect(result.decision).toBe('block');
    expect(result.reason).toBe('latest_tool_batch_exceeds_usable_budget');
  });
});
