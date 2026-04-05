import { describe, expect, it } from 'bun:test';

import type { ChatMessage } from '../types';
import type { Citation } from '../stores/useCitationsStore';
import {
  buildCompactedMessagesForRequest,
  invalidateCompactionFromMessage,
  parseHiddenToolContext,
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

const makePreparedMessages = (messages: ChatMessage[]) =>
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

describe('buildCompactedMessagesForRequest', () => {
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
      modelContextWindowTokens: 120,
      mode: 'blocking',
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
      modelContextWindowTokens: 200,
      mode: 'blocking',
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
