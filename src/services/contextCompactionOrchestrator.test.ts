import { describe, expect, it } from 'bun:test';

import type { ChatMessage } from '../types';
import type { StreamMessage } from './streamingChat';
import { estimateConversationFootprint } from './contextCompaction';
import {
  buildAppliedCompactionAuditDetails,
  buildCompactionDecisionAuditMetadata,
  consolidateCompletedAssistantTurnCompaction,
  getCompactionBoundaryForMode,
  isSyntheticCompactionBoundaryState,
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

const footprintFor = (messages: ChatMessage[]) =>
  estimateConversationFootprint({
    systemMessage: baseParams(messages).systemMessage,
    preparedMessages: baseParams(messages).preparedMessages,
    orderedMessages: messages,
    citations: [],
    toolDefinitions: [],
    ...baseParams(messages).footprintFields,
    estimateSerializedPayloadTokens: estimateByText,
    mode: 'safety_prestream',
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

  it('creates a durable checkpoint from proactive pre-send pressure', async () => {
    const messages = [
      message('u1', 'user', 'old request '.repeat(400)),
      message('a1', 'assistant', 'old answer '.repeat(400)),
      message('u2', 'user', 'second request '.repeat(100)),
      message('a2', 'assistant', 'second answer '.repeat(100)),
      message('u3', 'user', 'new request'),
    ];

    const result = await runContextCompactionOrchestration({
      ...baseParams(messages),
      footprintFields: {
        ...baseParams(messages).footprintFields,
        modelContextWindowTokens: 5_000,
        outputLimitTokens: 500,
      },
      estimateSerializedPayloadTokens: () => 3_500,
      buildForceCompaction: true,
      generateSummary: async () => 'Proactive compacted summary.',
    });

    expect(result.outcome).toBe('completed');
    if (result.outcome !== 'completed') {
      throw new Error('expected completed result');
    }
    expect(result.evaluation.decision).toBe('compact');
    expect(result.preflightFootprint.isHardStop).toBe(false);
    expect(result.result.compactionState?.summaryText).toContain('Proactive');
    expect(result.shouldPersistCompaction).toBe(true);
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

  it('continues post-tool execution when only image estimates exceed the budget', async () => {
    const messages = [
      message('u1', 'user', 'Old request.'),
      message('a1', 'assistant', 'Old answer.'),
      message('u2', 'user', 'Second request.'),
      message('a2', 'assistant', 'Second answer.'),
      message('u3', 'user', 'Inspect this image.'),
    ];
    const preparedMessages = prepared(messages);
    preparedMessages[preparedMessages.length - 1] = {
      role: 'user',
      content: [
        { type: 'text', text: 'Inspect this image.' },
        {
          type: 'image_url',
          image_url: { url: 'data:image/png;base64,aaaa' },
        },
      ],
      image_metadata: [{ width: 10_000, height: 10_000 }],
    };
    const result = await runContextCompactionOrchestration({
      ...baseParams(messages),
      boundary: 'post_tool_batch',
      budgetPolicy: { auto: false },
      latestBoundaryPayloadTokens: 20,
      preparedMessages,
      buildForceCompaction: true,
      forcePrune: true,
      footprintFields: {
        ...baseParams(messages).footprintFields,
        modelContextWindowTokens: 2_000,
        outputLimitTokens: 100,
      },
    });

    expect(result.outcome).toBe('completed');
    if (result.outcome !== 'completed') {
      throw new Error('expected completed result');
    }
    expect(result.evaluation.decision).toBe('send');
    expect(result.evaluation.reason).toBe('image_estimate_is_non_blocking');
    expect(result.result.compactionState).toBeNull();
    expect(result.result.messages).toEqual([
      { role: 'system', content: 'You are Macro.' },
      ...preparedMessages,
    ]);
    expect(result.shouldPersistCompaction).toBe(false);
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
      footprintFields: {
        ...baseParams(messages).footprintFields,
        modelContextWindowTokens: 5_000,
        outputLimitTokens: 500,
      },
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
      completionReason: 'length_recovered',
      compactionMethod: 'none',
      checkpointDecision: 'none',
      checkpointInvalidated: false,
    });

    expect(getCompactionBoundaryForMode('manual')).toBe('manual');
    expect(metadata.formula).toBe('128k context - 8k output reserve = 120k usable');
    expect(metadata.contextLimitSource).toBe('provider_metadata');
    expect(metadata.completionReason).toBe('length_recovered');
    expect(metadata.compactionMethod).toBe('none');
    expect(metadata.estimatedTokensGained).toBeNull();
    expect(metadata.checkpointDecision).toBe('none');
    expect(metadata.checkpointInvalidated).toBe(false);
    expect(metadata.promptCacheCompatibility).toBe('not_applicable');
  });

  it('audits the applied method, pruning gains, checkpoint refresh, and cache rebuild', async () => {
    const messages = [
      message('u1', 'user', 'old request '.repeat(400)),
      message('a1', 'assistant', 'old answer '.repeat(400)),
      message('u2', 'user', 'second request '.repeat(100)),
      message('a2', 'assistant', 'second answer '.repeat(100)),
      message('u3', 'user', 'new request'),
    ];
    const result = await runContextCompactionOrchestration({
      ...baseParams(messages),
      boundary: 'manual',
      mode: 'manual',
      footprintFields: {
        ...baseParams(messages).footprintFields,
        modelContextWindowTokens: 5_000,
        outputLimitTokens: 500,
      },
      forceCompaction: true,
      generateSummary: async () => 'Audited summary.',
    });
    if (result.outcome !== 'completed') {
      throw new Error('expected completed result');
    }
    const details = buildAppliedCompactionAuditDetails({
      result: result.result,
    });
    const metadata = buildCompactionDecisionAuditMetadata({
      footprintBefore: result.result.footprintBefore,
      footprintAfter: result.result.footprintAfter,
      ...details,
    });

    expect(metadata.compactionMethod).toBe('summary_normal_model');
    expect(metadata.checkpointDecision).toBe('created');
    expect(metadata.checkpointInvalidated).toBe(false);
    expect(metadata.promptCacheCompatibility).toBe('rebuilt');
    expect(metadata.prunedElements).toEqual([]);
    expect(metadata.pruningEstimatedTokensGained).toBe(0);
    expect(metadata.estimatedTokensGained).toBeGreaterThanOrEqual(0);
  });

  it('skips post-tool consolidation when there is no pending synthetic checkpoint', async () => {
    const messages = [message('u1', 'user', 'hello')];

    const result = await consolidateCompletedAssistantTurnCompaction({
      pending: null,
      ...baseParams(messages),
      toolDefinitions: [],
    });

    expect(result.outcome).toBe('skipped');
    if (result.outcome !== 'skipped') {
      throw new Error('expected skipped result');
    }
    expect(result.reason).toBe('no_pending_compaction');
  });

  it('skips post-tool consolidation when the real assistant message is missing', async () => {
    const messages = [message('u1', 'user', 'hello')];

    const result = await consolidateCompletedAssistantTurnCompaction({
      pending: {
        conversationId: 'conv-1',
        assistantMessageId: 'missing-assistant',
        providerId: 'provider-1',
        providerType: 'openai',
        modelId: 'model-1',
        createdAt: '2026-05-16T10:00:00.000Z',
        compactionState: {
          conversationId: 'conv-1',
          upToMessageId: 'stream-boundary-2',
          summaryText: 'Synthetic post-tool summary.',
          toolDigest: [],
          usedSourcePassageIds: [],
          interestingSourcePassageIds: [],
          estimatedTokensBefore: 1000,
          estimatedTokensAfter: 200,
          fingerprint: 'synthetic',
          version: 1,
          createdAt: '2026-05-16T10:00:00.000Z',
          updatedAt: '2026-05-16T10:00:00.000Z',
        },
        footprintBefore: footprintFor(messages),
        footprintAfter: footprintFor(messages),
        messages: prepared(messages),
        pruning: {
          method: 'deterministic_superseded_tool_results',
          elements: [],
          estimatedTokensSaved: 0,
          cacheBoundaryMessageId: null,
          promptCacheCompatibility: 'rebuilt',
        },
      },
      ...baseParams(messages),
      toolDefinitions: [],
    });

    expect(result.outcome).toBe('skipped');
    if (result.outcome !== 'skipped') {
      throw new Error('expected skipped result');
    }
    expect(result.reason).toBe('assistant_message_missing');
  });

  it('consolidates a synthetic post-tool checkpoint onto real message ids', async () => {
    const messages = [
      message('u1', 'user', 'old request '.repeat(400)),
      message('a1', 'assistant', 'old answer '.repeat(400)),
      message('u2', 'user', 'tool request '.repeat(120)),
      message('a2', 'assistant', 'tool result and final answer '.repeat(160)),
      message('u3', 'user', 'continue'),
    ];
    const syntheticRun = await runContextCompactionOrchestration({
      ...baseParams(messages),
      boundary: 'post_tool_batch',
      mode: 'safety_prestream',
      orderedMessages: messages.map((item, index) => ({
        ...item,
        id: `stream-boundary-${index}`,
      })),
      forceCompaction: true,
      forcePrune: true,
      generateSummary: async () => 'Synthetic post-tool summary.',
      syntheticBoundary: true,
    });
    if (syntheticRun.outcome !== 'completed' || !syntheticRun.result.compactionState) {
      throw new Error('expected synthetic compaction');
    }
    expect(isSyntheticCompactionBoundaryState(syntheticRun.result.compactionState)).toBe(true);

    const result = await consolidateCompletedAssistantTurnCompaction({
      pending: {
        conversationId: 'conv-1',
        assistantMessageId: 'a2',
        providerId: 'provider-1',
        providerType: 'openai',
        modelId: 'model-1',
        createdAt: '2026-05-16T10:00:00.000Z',
        compactionState: syntheticRun.result.compactionState,
        footprintBefore: syntheticRun.result.footprintBefore,
        footprintAfter: syntheticRun.result.footprintAfter,
        messages: syntheticRun.result.messages,
        pruning: syntheticRun.result.pruning,
      },
      ...baseParams(messages),
      toolDefinitions: [],
      generateSummary: async () => 'Real post-tool summary.',
    });

    expect(result.outcome).toBe('consolidated');
    if (result.outcome !== 'consolidated') {
      throw new Error('expected consolidated result');
    }
    expect(result.result.compactionState).not.toBeNull();
    expect(result.result.compactionState?.upToMessageId.startsWith('stream-boundary-')).toBe(
      false,
    );
    expect(result.result.compactionState?.summaryText).toBe('Real post-tool summary.');
    expect(result.shouldPersistCompaction).toBe(true);
  });
});
