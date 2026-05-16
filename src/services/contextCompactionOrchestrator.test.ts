import { describe, expect, it } from 'bun:test';

import type { ChatMessage } from '../types';
import type { StreamMessage } from './streamingChat';
import {
  buildCompactionDecisionAuditMetadata,
  getCompactionBoundaryForMode,
  runContextCompactionOrchestration,
} from './contextCompactionOrchestrator';

const message = (
  id: string,
  role: 'user' | 'assistant',
  content: string,
): ChatMessage => ({
  id,
  conversation_id: 'conv-1',
  task_id: 'task-1',
  role,
  content,
  timestamp: `2026-05-16T10:00:0${id.length}.000Z`,
});

const prepared = (messages: ChatMessage[]): StreamMessage[] =>
  messages.map((item) => ({ role: item.role, content: item.content }));

const estimateByText = (messages: StreamMessage[]): number =>
  Math.ceil(
    messages.reduce(
      (total, item) =>
        total + (typeof item.content === 'string' ? item.content.length : 0),
      0,
    ) / 4,
  );

const baseParams = (messages: ChatMessage[]) => ({
  boundary: 'pre_send' as const,
  mode: 'safety_prestream' as const,
  systemMessage: 'You are Macro.',
  preparedMessages: prepared(messages),
  orderedMessages: messages,
  citations: [],
  toolDefinitions: [],
  footprintFields: {
    modelContextWindowTokens: 128_000,
    outputLimitTokens: 8_000,
    contextLimitSource: 'provider_metadata' as const,
    isContextLimitAuthoritative: true,
    contextLimitConfidence: 'verified' as const,
  },
  providerId: 'provider-1',
  providerType: 'openai',
  modelId: 'model-1',
  estimateSerializedPayloadTokens: estimateByText,
});

describe('contextCompactionOrchestrator', () => {
  it('sends without compaction when the projected payload fits', async () => {
    const messages = [message('u1', 'user', 'hello')];

    const result = await runContextCompactionOrchestration(baseParams(messages));

    expect(result.outcome).toBe('completed');
    if (result.outcome !== 'completed') {
      throw new Error('expected completed result');
    }
    expect(result.evaluation.decision).toBe('send');
    expect(result.result.compactionState).toBeNull();
    expect(result.shouldPersistCompaction).toBe(false);
  });

  it('blocks when the latest boundary payload cannot fit alone', async () => {
    const messages = [message('u1', 'user', 'x'.repeat(20_000))];

    const result = await runContextCompactionOrchestration({
      ...baseParams(messages),
      footprintFields: {
        ...baseParams(messages).footprintFields,
        modelContextWindowTokens: 4_000,
        outputLimitTokens: 500,
      },
    });

    expect(result.outcome).toBe('blocked');
    if (result.outcome !== 'blocked') {
      throw new Error('expected blocked result');
    }
    expect(result.evaluation.reason).toBe('latest_message_exceeds_usable_budget');
    expect(result.errorMessage).toContain('too large');
  });

  it('returns manual_required instead of compacting when auto compaction is disabled', async () => {
    const messages = [message('u1', 'user', 'small latest payload')];

    const result = await runContextCompactionOrchestration({
      ...baseParams(messages),
      budgetPolicy: { auto: false },
      footprintFields: {
        ...baseParams(messages).footprintFields,
        modelContextWindowTokens: 2_000,
        outputLimitTokens: 100,
      },
      estimateSerializedPayloadTokens: () => 1_950,
    });

    expect(result.outcome).toBe('manual_required');
    if (result.outcome !== 'manual_required') {
      throw new Error('expected manual_required result');
    }
    expect(result.evaluation.decision).toBe('manual_required');
    expect(result.errorMessage).toContain('manual');
  });

  it('creates a checkpoint for forced manual compaction and reports persistence intent', async () => {
    const messages = [
      message('u1', 'user', 'old request '.repeat(400)),
      message('a1', 'assistant', 'old answer '.repeat(400)),
      message('u2', 'user', 'second request '.repeat(100)),
      message('a2', 'assistant', 'second answer '.repeat(100)),
      message('u3', 'user', 'new request'),
    ];
    let started = false;

    const result = await runContextCompactionOrchestration({
      ...baseParams(messages),
      boundary: 'manual',
      mode: 'manual',
      forceCompaction: true,
      onCompactionStarted: () => {
        started = true;
      },
      generateSummary: async () => 'Structured compacted summary.',
    });

    expect(result.outcome).toBe('completed');
    if (result.outcome !== 'completed') {
      throw new Error('expected completed result');
    }
    expect(started).toBe(true);
    expect(result.result.compactionState).not.toBeNull();
    expect(result.result.compactionState?.summaryText).toContain('Structured');
    expect(result.shouldPersistCompaction).toBe(true);
  });

  it('keeps audit metadata consistent with the useful budget formula', async () => {
    const messages = [message('u1', 'user', 'hello')];
    const result = await runContextCompactionOrchestration(baseParams(messages));
    const metadata = buildCompactionDecisionAuditMetadata({
      providerId: 'provider-1',
      providerType: 'openai',
      modelId: 'model-1',
      trigger: 'safety_prestream',
      status: 'success',
      footprint: result.preflightFootprint,
      footprintFields: baseParams(messages).footprintFields,
      result: 'send',
    });

    expect(getCompactionBoundaryForMode('manual')).toBe('manual');
    expect(metadata.formula).toBe('128k context - 8k output reserve = 120k usable');
    expect(metadata.contextLimitSource).toBe('provider_metadata');
  });
});
