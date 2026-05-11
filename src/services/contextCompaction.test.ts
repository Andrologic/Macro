import { describe, expect, it } from 'bun:test';

import type { ChatMessage } from '../types';
import type { Citation } from '../stores/useCitationsStore';
import type { StreamMessage } from './streamingChat';
import {
  buildContextTooLargeErrorMessage,
  buildCompactedMessagesForRequest,
  compactProviderInputItemsForContext,
  estimateConversationFootprint,
  invalidateCompactionFromMessage,
  parseHiddenToolContext,
  pruneToolContextBlocks,
  resolveModelContextWindowTokens,
} from './contextCompaction';

const makeMessage = (
  id: string,
  role: 'user' | 'assistant',
  content: string,
  options: Partial<ChatMessage> = {}
): ChatMessage => ({
  id,
  task_id: 'task-1',
  conversation_id: 'conv-1',
  role,
  content,
  timestamp: `2026-04-05T00:00:0${id.length}Z`,
  ...options,
});

const makePreparedMessages = (messages: ChatMessage[]): StreamMessage[] =>
  messages.map((message) => ({
    role: message.role,
    content:
      message.role === 'assistant' && message.hidden_context
        ? `${message.content}\n\n${message.hidden_context}`.trim()
        : message.content,
  }));

const toolDefinitions = [
  {
    id: 'read',
    description: 'Read a file.',
    parameters: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string' as const,
        },
      },
    },
  },
];

describe('parseHiddenToolContext', () => {
  it('extracts normalized tool facts from hidden tool context blocks', () => {
    const hiddenContext = `
<tool_context tool="read" detail="src/main.ts">
FILE: src/main.ts
export const answer = 42;
</tool_context>
<tool_context tool="git_diff" detail="HEAD~1">
diff --git a/src/main.ts b/src/main.ts
+export const answer = 42;
</tool_context>
`;

    const result = parseHiddenToolContext(hiddenContext, 'assistant-1');

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      tool_name: 'read',
      kind: 'file_read',
      target: 'src/main.ts',
      source_message_id: 'assistant-1',
    });
    expect(result[1]).toMatchObject({
      tool_name: 'git_diff',
      kind: 'git_result',
      source_message_id: 'assistant-1',
    });
  });
});

describe('buildContextTooLargeErrorMessage', () => {
  it('includes a stable payload estimate and largest contributors', () => {
    const message = buildContextTooLargeErrorMessage({
      totalEstimatedTokens: 14500,
      messageTokens: 8000,
      visibleMessageTokens: 6000,
      providerInputTokens: 9000,
      hiddenContextTokens: 200,
      systemTokens: 1800,
      toolSchemaTokens: 1200,
      imagePlaceholderTokens: 0,
      citationTokens: 0,
      summaryTokens: 700,
      latestUserContextTokens: 3000,
      modelContextWindowTokens: 12000,
      reservedTokens: 2400,
      usableContextTokens: 9600,
      threshold: 'degraded',
      reason: 'hard_stop_ratio',
      totalContextRatio: 1.2,
      usableContextRatio: 1.5,
      hiddenContextRatio: 0.02,
      hardStopRatio: 0.98,
      isHardStop: true,
      toolTurnCount: 8,
    });

    expect(message).toContain('Estimated payload: 14,500 tokens / 12,000 tokens');
    expect(message).toContain('provider history: 9,000 tokens');
    expect(message).toContain('messages: 6,000 tokens');
    expect(message).toContain('latest request: 3,000 tokens');
  });
});

describe('buildCompactedMessagesForRequest', () => {
  it('uses the reserved context budget when deciding blocking compaction', () => {
    const orderedMessages = [
      makeMessage('u1', 'user', 'a'.repeat(50)),
      makeMessage('a1', 'assistant', 'b'.repeat(50)),
      makeMessage('u2', 'user', 'c'.repeat(50)),
    ];

    const footprint = estimateConversationFootprint({
      systemMessage: 'You are Macro.',
      preparedMessages: makePreparedMessages(orderedMessages),
      orderedMessages,
      citations: [],
      toolDefinitions: [],
      modelContextWindowTokens: 100,
      budgetPolicy: { reservedTokens: 50 },
      mode: 'blocking',
    });

    expect(footprint.reservedTokens).toBe(50);
    expect(footprint.usableContextTokens).toBe(50);
    expect(footprint.threshold).toBe('blocking');
  });

  it('prunes old large tool contexts while preserving recent and protected tool output during normal pruning', () => {
    const orderedMessages = [
      makeMessage('u1', 'user', 'Inspect old files.'),
      makeMessage('a1', 'assistant', 'Old result.', {
        hidden_context:
          `<tool_context tool="read" detail="src/old.ts">\n${'old line\n'.repeat(300)}\n</tool_context>`,
      }),
      makeMessage('u2', 'user', 'Check plan state.'),
      makeMessage('a2', 'assistant', 'Protected result.', {
        hidden_context:
          `<tool_context tool="need_get" detail="need-1">\n${'need detail\n'.repeat(300)}\n</tool_context>`,
      }),
      makeMessage('u3', 'user', 'Continue.'),
    ];

    const result = pruneToolContextBlocks(
      makePreparedMessages(orderedMessages),
      orderedMessages,
      { force: false },
    );

    expect(result.prunedMessageIds).toEqual(['a1']);
    expect(String(result.messages[1]?.content)).toContain('[pruned tool context]');
    expect(String(result.messages[3]?.content)).toContain('need detail');
  });

  it('limits protected tool output during forced pruning', () => {
    const orderedMessages = [
      makeMessage('u1', 'user', 'Inspect plan state.'),
      makeMessage('a1', 'assistant', 'Protected result.', {
        hidden_context:
          `<tool_context tool="need_get" detail="need-1">\n${'need detail\n'.repeat(300)}\n</tool_context>`,
      }),
      makeMessage('u2', 'user', 'Continue.'),
      makeMessage('a2', 'assistant', 'Recent answer.'),
      makeMessage('u3', 'user', 'Now answer.'),
    ];

    const result = pruneToolContextBlocks(
      makePreparedMessages(orderedMessages),
      orderedMessages,
      { force: true },
    );

    expect(result.prunedMessageIds).toEqual(['a1']);
    expect(String(result.messages[1]?.content)).toContain('[pruned tool context]');
  });

  it('compacts provider input items instead of relying on visible content trimming', () => {
    const hugeReasoning = `Need context.\n${'native reasoning payload\n'.repeat(1200)}`;
    const orderedMessages = [
      makeMessage('u1', 'user', 'Inspect the parser.'),
      makeMessage('a1', 'assistant', 'Older answer.'),
      makeMessage('u2', 'user', 'Inspect runtime output.'),
      makeMessage('a2', 'assistant', 'Runtime output summarized.'),
      makeMessage('u3', 'user', 'Now answer.'),
    ];
    const preparedMessages = makePreparedMessages(orderedMessages);
    preparedMessages[3] = {
      ...preparedMessages[3]!,
      provider_input_items: [
        {
          type: 'chat_completion_message',
          role: 'assistant',
          content: 'Runtime output summarized.',
          visible_content: 'Runtime output summarized.',
          reasoning_content: hugeReasoning,
          reasoning_details: [{ trace: hugeReasoning }],
          tool_calls: [
            {
              id: 'call_read',
              type: 'function',
              function: { name: 'read', arguments: '{"path":"src/runtime.ts"}' },
            },
          ],
        },
      ],
    };

    const before = estimateConversationFootprint({
      systemMessage: 'You are Macro.',
      preparedMessages,
      orderedMessages,
      citations: [],
      toolDefinitions,
      modelContextWindowTokens: 8000,
      mode: 'blocking',
    });
    const compacted = compactProviderInputItemsForContext(
      preparedMessages,
      orderedMessages,
      'forced',
    );
    const after = estimateConversationFootprint({
      systemMessage: 'You are Macro.',
      preparedMessages: compacted.messages,
      orderedMessages,
      citations: [],
      toolDefinitions,
      modelContextWindowTokens: 8000,
      mode: 'blocking',
    });

    expect(after.providerInputTokens ?? Number.POSITIVE_INFINITY).toBeLessThan(
      before.providerInputTokens ?? 0,
    );
    expect(JSON.stringify(compacted.messages)).not.toContain('native reasoning payload');
    expect(JSON.stringify(compacted.messages)).not.toContain('tool_calls');
  });

  it('does not double-count hidden tool context when provider input items carry the tool result', () => {
    const orderedMessages = [
      makeMessage('u1', 'user', 'Inspect the runtime.'),
      makeMessage('a1', 'assistant', 'Runtime output summarized.', {
        hidden_context:
          `<tool_context tool="read" detail="src/runtime.ts">\n${'runtime output\n'.repeat(200)}\n</tool_context>`,
      }),
      makeMessage('u2', 'user', 'Now answer.'),
    ];
    const preparedMessages = makePreparedMessages(orderedMessages);
    preparedMessages[1] = {
      role: 'assistant',
      content: 'Runtime output summarized.',
      provider_input_items: [
        {
          type: 'function_call_output',
          call_id: 'call_read',
          output: 'runtime output\n'.repeat(200),
        },
      ],
    };

    const footprint = estimateConversationFootprint({
      systemMessage: 'You are Macro.',
      preparedMessages,
      orderedMessages,
      citations: [],
      toolDefinitions,
      modelContextWindowTokens: 16_000,
      mode: 'blocking',
    });

    expect(footprint.hiddenContextTokens).toBe(0);
    expect(footprint.providerInputTokens).toBeGreaterThan(0);
  });

  it('does not reintroduce pruned hidden context when measuring a compacted payload', () => {
    const orderedMessages = [
      makeMessage('u1', 'user', 'Inspect old files.'),
      makeMessage('a1', 'assistant', 'Old result.', {
        hidden_context:
          `<tool_context tool="read" detail="src/old.ts">\n${'old output\n'.repeat(200)}\n</tool_context>`,
      }),
      makeMessage('u2', 'user', 'Continue from the summary.'),
    ];
    const preparedMessages: StreamMessage[] = [
      {
        role: 'system',
        content:
          '[COMPACTED CONVERSATION STATE]\n\nOlder tool output was summarized.',
      },
      {
        role: 'user',
        content: 'Continue from the summary.',
      },
    ];

    const footprint = estimateConversationFootprint({
      systemMessage: 'You are Macro.',
      preparedMessages,
      orderedMessages,
      citations: [],
      toolDefinitions,
      modelContextWindowTokens: 16_000,
      mode: 'blocking',
    });

    expect(footprint.hiddenContextTokens).toBe(0);
    expect(footprint.summaryTokens).toBeGreaterThan(0);
  });

  it('moves compacted provider tool-call details into plain context', async () => {
    const hugeReasoning = `Need context.\n${'native reasoning payload\n'.repeat(1200)}`;
    const orderedMessages = [
      makeMessage('u1', 'user', 'Inspect the runtime.'),
      makeMessage('a1', 'assistant', 'Runtime output summarized.'),
      makeMessage('a2', 'assistant', 'FILE: README.md'),
      makeMessage('u2', 'user', 'Now answer.'),
    ];
    const preparedMessages = makePreparedMessages(orderedMessages);
    preparedMessages[1] = {
      ...preparedMessages[1]!,
      provider_input_items: [
        {
          type: 'chat_completion_message',
          role: 'assistant',
          content: 'Runtime output summarized.',
          visible_content: 'Runtime output summarized.',
          reasoning_content: hugeReasoning,
          tool_calls: [
            {
              id: 'call_read',
              type: 'function',
              function: { name: 'read', arguments: '{"path":"README.md"}' },
            },
          ],
        },
      ],
    };
    preparedMessages[2] = {
      ...preparedMessages[2]!,
      provider_input_items: [
        {
          type: 'chat_completion_message',
          role: 'tool',
          content: 'FILE: README.md\n\n# Macro',
          tool_call_id: 'call_read',
          tool_name: 'read',
        },
      ],
    };

    const result = await buildCompactedMessagesForRequest({
      systemMessage: 'You are Macro.',
      preparedMessages,
      orderedMessages,
      citations: [],
      toolDefinitions,
      modelContextWindowTokens: 1000,
      mode: 'overflow_recovery',
      forceCompaction: true,
      forcePrune: true,
      generateSummary: async () => 'Current objective: answer from compacted provider history.',
    });
    const serializedMessages = JSON.stringify(result.messages);

    expect(serializedMessages).toContain('Tool calls preserved as fact: read');
    expect(serializedMessages).not.toContain('"tool_calls"');
    expect(serializedMessages).not.toContain('native reasoning payload');
  });

  it('uses the final serialized payload estimate to trigger compaction after reload', async () => {
    const orderedMessages = [
      makeMessage('u1', 'user', 'Inspect the old provider trace.'),
      makeMessage('a1', 'assistant', 'Older provider trace summary.'),
      makeMessage('u2', 'user', 'Continue from the findings.'),
      makeMessage('a2', 'assistant', 'Recent answer.'),
      makeMessage('u3', 'user', 'Now answer.'),
    ];
    const preparedMessages = makePreparedMessages(orderedMessages);
    preparedMessages[1] = {
      ...preparedMessages[1]!,
      provider_input_items: [
        {
          type: 'chat_completion_message',
          role: 'assistant',
          content: 'Older provider trace summary.',
          visible_content: 'Older provider trace summary.',
          reasoning_content: 'provider trace payload\n'.repeat(500),
        },
      ],
    };
    const estimateSerializedPayloadTokens = (messages: typeof preparedMessages): number =>
      JSON.stringify(messages).includes('provider trace payload') ? 4000 : 100;

    const result = await buildCompactedMessagesForRequest({
      systemMessage: 'You are Macro.',
      preparedMessages,
      orderedMessages,
      citations: [],
      toolDefinitions: [],
      modelContextWindowTokens: 1000,
      budgetPolicy: { reservedTokens: 0 },
      mode: 'blocking',
      estimateSerializedPayloadTokens,
      generateSummary: async () => 'Current objective: answer from compacted provider history.',
    });

    expect(result.footprintBefore.serializedPayloadTokens).toBe(4000);
    expect(result.footprintAfter.serializedPayloadTokens).toBe(100);
    expect(result.decision).toBe('send');
    expect(JSON.stringify(result.messages)).not.toContain('provider trace payload');
  });

  it('does not create automatic summary compaction before the usable window is full', async () => {
    const orderedMessages = [
      makeMessage('u1', 'user', 'First request.'),
      makeMessage('a1', 'assistant', 'First answer.'),
      makeMessage('u2', 'user', 'Second request.'),
    ];

    const result = await buildCompactedMessagesForRequest({
      systemMessage: 'You are Macro.',
      preparedMessages: makePreparedMessages(orderedMessages),
      orderedMessages,
      citations: [],
      toolDefinitions: [],
      modelContextWindowTokens: 100,
      budgetPolicy: { reservedTokens: 0 },
      mode: 'blocking',
      estimateSerializedPayloadTokens: () => 80,
      generateSummary: async () => 'This summary should not be created.',
    });

    expect(result.footprintBefore.usableContextRatio).toBeGreaterThan(0.75);
    expect(result.footprintBefore.usableContextRatio).toBeLessThan(1);
    expect(result.compactionState).toBeNull();
    expect(result.messages).toEqual([
      { role: 'system', content: 'You are Macro.' },
      ...makePreparedMessages(orderedMessages),
    ]);
    expect(JSON.stringify(result.messages)).not.toContain('[COMPACTED CONVERSATION STATE]');
  });

  it('never creates durable summary compaction in background mode', async () => {
    const orderedMessages = [
      makeMessage('u1', 'user', 'First request.'),
      makeMessage('a1', 'assistant', 'First answer.'),
      makeMessage('u2', 'user', 'Second request.'),
    ];

    const result = await buildCompactedMessagesForRequest({
      systemMessage: 'You are Macro.',
      preparedMessages: makePreparedMessages(orderedMessages),
      orderedMessages,
      citations: [],
      toolDefinitions: [],
      modelContextWindowTokens: 100,
      budgetPolicy: { reservedTokens: 0 },
      mode: 'background',
      estimateSerializedPayloadTokens: () => 120,
      generateSummary: async () => 'This background summary should not be created.',
    });

    expect(result.footprintBefore.isHardStop).toBe(true);
    expect(result.compactionState).toBeNull();
    expect(result.decision).toBe('hard_stop');
    expect(JSON.stringify(result.messages)).not.toContain('[COMPACTED CONVERSATION STATE]');
  });

  it('keeps the last two user turns raw and injects a compacted system message', async () => {
    const orderedMessages = [
      makeMessage('u1', 'user', 'Inspect the parser.'),
      makeMessage('a1', 'assistant', 'I read the parser and found the issue.', {
        hidden_context:
          '<tool_context tool="read" detail="src/parser.ts">\nFILE: src/parser.ts\nconst parser = createParser();\n</tool_context>',
      }),
      makeMessage('u2', 'user', 'Now inspect the reducer too.'),
      makeMessage('a2', 'assistant', 'The reducer looks fine.'),
      makeMessage('u3', 'user', 'Propose the patch.'),
    ];
    const citations: Citation[] = [
      {
        id: 'cite-used',
        type: 'source_passage',
        scope: 'source',
        source: 'src/parser.ts',
        title: 'Parser init',
        snippet: 'const parser = createParser();',
        messageId: 'a1',
        conversationId: 'conv-1',
        kind: 'used',
        timestamp: '2026-04-05T00:00:00.000Z',
      },
    ];

    const result = await buildCompactedMessagesForRequest({
      systemMessage: 'You are Macro.',
      preparedMessages: makePreparedMessages(orderedMessages),
      orderedMessages,
      citations,
      toolDefinitions,
      modelContextWindowTokens: 1000,
      mode: 'blocking',
      forceCompaction: true,
      generateSummary: async () =>
        'Current objective: propose the fix.\n\nSummary:\nOlder parser investigation is compacted.',
    });

    expect(result.compactionState?.upToMessageId).toBe('a1');
    expect(result.compactionState?.usedSourcePassageIds).toEqual(['cite-used']);
    expect(result.messages[0]).toEqual({ role: 'system', content: 'You are Macro.' });
    expect(result.messages[1]?.role).toBe('system');
    expect(String(result.messages[1]?.content)).toContain('[COMPACTED CONVERSATION STATE]');
    expect(result.messages.slice(2).map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
    ]);
    expect(result.usedExistingCompaction).toBe(false);
  });

  it('falls back to emergency trimming when post-compaction context is still too large', async () => {
    const hugeToolBody = `FILE: src/server.ts\n${'console.log("x");\n'.repeat(500)}`;
    const orderedMessages = [
      makeMessage('u1', 'user', 'Inspect the server logs.'),
      makeMessage('a1', 'assistant', 'Older inspection.', {
        hidden_context: `<tool_context tool="read" detail="src/server.ts">\n${hugeToolBody}\n</tool_context>`,
      }),
      makeMessage('u2', 'user', 'Inspect the runtime command output.'),
      makeMessage('a2', 'assistant', 'The command output is large.', {
        hidden_context:
          `<tool_context tool="terminal_run" detail="npm test">\n${'line\n'.repeat(4000)}\n</tool_context>`,
      }),
      makeMessage('u3', 'user', 'Summarize what matters.'),
    ];

    const result = await buildCompactedMessagesForRequest({
      systemMessage: 'You are Macro.',
      preparedMessages: makePreparedMessages(orderedMessages),
      orderedMessages,
      citations: [],
      toolDefinitions,
      modelContextWindowTokens: 6000,
      mode: 'blocking',
      forcePrune: false,
      generateSummary: async () => 'Current objective: summarize the debug results.',
    });

    expect(result.degraded).toBe(true);
    const recentAssistant = result.messages.find(
      (message) =>
        message.role === 'assistant' &&
        typeof message.content === 'string' &&
        message.content.includes('terminal_run')
    );
    expect(typeof recentAssistant?.content).toBe('string');
    expect(String(recentAssistant?.content)).toContain('[... truncated for compacted context ...]');
  });

  it('returns a hard stop decision when pruning and summary cannot fit the model window', async () => {
    const orderedMessages = [
      makeMessage('u1', 'user', 'Inspect the large trace.'),
      makeMessage('a1', 'assistant', 'Trace captured.', {
        hidden_context:
          `<tool_context tool="terminal_run" detail="trace">\n${'trace\n'.repeat(3000)}\n</tool_context>`,
      }),
      makeMessage('u2', 'user', 'Keep going.'),
      makeMessage('a2', 'assistant', 'Recent trace.', {
        hidden_context:
          `<tool_context tool="terminal_run" detail="recent">\n${'recent\n'.repeat(3000)}\n</tool_context>`,
      }),
      makeMessage('u3', 'user', 'Now answer with the required payload:\n'.repeat(500)),
    ];

    const result = await buildCompactedMessagesForRequest({
      systemMessage: 'You are Macro.',
      preparedMessages: makePreparedMessages(orderedMessages),
      orderedMessages,
      citations: [],
      toolDefinitions,
      modelContextWindowTokens: 100,
      mode: 'overflow_recovery',
      forceCompaction: true,
      forcePrune: true,
      generateSummary: async () => 'Current objective: answer from the trace.',
    });

    expect(result.decision).toBe('hard_stop');
    expect(result.footprintAfter.isHardStop).toBe(true);
  });

  it('uses an ultra pass before hard stopping when recent provider history is too large', async () => {
    const hugeReasoning = `Trace.\n${'provider trace payload\n'.repeat(3000)}`;
    const orderedMessages = [
      makeMessage('u1', 'user', 'Inspect old files.'),
      makeMessage('a1', 'assistant', 'Older inspection.'),
      makeMessage('u2', 'user', 'Inspect recent provider history.'),
      makeMessage('a2', 'assistant', 'Recent provider result.'),
      makeMessage('u3', 'user', 'Now answer.'),
    ];
    const preparedMessages = makePreparedMessages(orderedMessages);
    preparedMessages[3] = {
      ...preparedMessages[3]!,
      provider_input_items: [
        {
          type: 'chat_completion_message',
          role: 'assistant',
          content: 'Recent provider result.',
          visible_content: 'Recent provider result.',
          reasoning_content: hugeReasoning,
        },
      ],
    };

    const result = await buildCompactedMessagesForRequest({
      systemMessage: 'You are Macro.',
      preparedMessages,
      orderedMessages,
      citations: [],
      toolDefinitions: [],
      modelContextWindowTokens: 80,
      mode: 'blocking',
      budgetPolicy: { prune: false, reservedTokens: 0 },
      generateSummary: async () => 'Current objective: answer from the compacted trace.',
    });

    expect(result.decision).toBe('send');
    expect(result.compactionState?.upToMessageId).toBe('a2');
    expect(result.compactionState?.compactionPass).toBe('ultra');
    expect(result.compactionState?.summaryFormatVersion).toBe(2);
    expect(result.compactionState?.summarySource).toBe('model');
    expect(JSON.stringify(result.messages)).not.toContain('provider trace payload');
  });

  it('records fallback summaries explicitly when model summarization fails', async () => {
    const orderedMessages = [
      makeMessage('u1', 'user', 'Remember that the migration must stay reversible.'),
      makeMessage('a1', 'assistant', 'I will keep the migration reversible.'),
      makeMessage('u2', 'user', 'Capture the risky files before editing.'),
      makeMessage('a2', 'assistant', 'Risky files captured in tool facts.'),
      makeMessage('u3', 'user', 'Continue from the retained turn.'),
    ];

    const result = await buildCompactedMessagesForRequest({
      systemMessage: 'You are Macro.',
      preparedMessages: makePreparedMessages(orderedMessages),
      orderedMessages,
      citations: [],
      toolDefinitions: [],
      modelContextWindowTokens: 80,
      mode: 'manual',
      forceCompaction: true,
      budgetPolicy: { prune: false, reservedTokens: 0 },
      generateSummary: async () => null,
    });

    expect(result.compactionState?.summarySource).toBe('fallback');
    expect(result.compactionState?.summaryFormatVersion).toBe(2);
    expect(result.compactionState?.summaryText).toContain('Remember that the migration');
  });

  it('keeps the latest user provider input items intact during aggressive compaction', async () => {
    const latestProviderItems = [
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'Now answer with this exact attachment.' },
          { type: 'input_image', image_url: 'data:image/png;base64,abc123' },
        ],
      },
    ];
    const orderedMessages = [
      makeMessage('u1', 'user', 'Inspect old files.'),
      makeMessage('a1', 'assistant', 'Older inspection.'),
      makeMessage('u2', 'user', 'Inspect recent provider history.'),
      makeMessage('a2', 'assistant', 'Recent provider result.'),
      makeMessage('u3', 'user', 'Now answer with this exact attachment.'),
    ];
    const preparedMessages = makePreparedMessages(orderedMessages);
    preparedMessages[3] = {
      ...preparedMessages[3]!,
      provider_input_items: [
        {
          type: 'chat_completion_message',
          role: 'assistant',
          content: 'Recent provider result.',
          reasoning_content: 'provider trace payload\n'.repeat(3000),
        },
      ],
    };
    preparedMessages[4] = {
      ...preparedMessages[4]!,
      provider_input_items: latestProviderItems,
    };

    const result = await buildCompactedMessagesForRequest({
      systemMessage: 'You are Macro.',
      preparedMessages,
      orderedMessages,
      citations: [],
      toolDefinitions: [],
      modelContextWindowTokens: 90,
      mode: 'blocking',
      budgetPolicy: { prune: false, reservedTokens: 0 },
      generateSummary: async () => 'Current objective: answer from compacted context.',
    });
    const latestUserMessage = [...result.messages]
      .reverse()
      .find((message) => message.role === 'user');

    expect(latestUserMessage?.provider_input_items).toEqual(latestProviderItems);
  });

  it('uses a larger fallback window for OpenCode Go Kimi when model metadata is missing', () => {
    expect(
      resolveModelContextWindowTokens({
        providerType: 'openai',
        providerId: 'opencode-go',
        baseUrl: 'https://opencode.ai/zen/go/v1',
        modelId: 'kimi-k2.6',
      }),
    ).toBe(128_000);
  });
});

describe('invalidateCompactionFromMessage', () => {
  it('invalidates only when the edited message is inside the compacted prefix', () => {
    const orderedMessages = [
      makeMessage('u1', 'user', 'First request'),
      makeMessage('a1', 'assistant', 'First answer'),
      makeMessage('u2', 'user', 'Second request'),
      makeMessage('a2', 'assistant', 'Second answer'),
      makeMessage('u3', 'user', 'Third request'),
    ];

    const state = {
      conversationId: 'conv-1',
      upToMessageId: 'a1',
      summaryText: 'Summary',
      toolDigest: [],
      usedSourcePassageIds: [],
      interestingSourcePassageIds: [],
      estimatedTokensBefore: 300,
      estimatedTokensAfter: 120,
      fingerprint: 'fp',
      version: 1,
      createdAt: '2026-04-05T00:00:00.000Z',
      updatedAt: '2026-04-05T00:00:00.000Z',
    };

    expect(invalidateCompactionFromMessage(state, orderedMessages, 'u1')).toBe(true);
    expect(invalidateCompactionFromMessage(state, orderedMessages, 'u3')).toBe(false);
  });
});
