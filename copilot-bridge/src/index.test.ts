import { afterEach, describe, expect, it, mock } from 'bun:test';

process.env.MACRO_COPILOT_BRIDGE_TEST_IMPORT = '1';

const defineToolMock = mock((name: string, options: Record<string, unknown>) => ({
  name,
  options,
}));

mock.module('@github/copilot-sdk', () => ({
  CopilotClient: class {},
  defineTool: defineToolMock,
}));

let importCounter = 0;

const loadBridge = async () => {
  importCounter += 1;
  return import(`./index.ts?test=${importCounter}`);
};

afterEach(() => {
  defineToolMock.mockClear();
  delete process.env.MACRO_TOOL_HOST_URL;
  delete process.env.MACRO_TOOL_HOST_BEARER_TOKEN;
});

describe('copilot bridge tool registration', () => {
  it('normalizes the Copilot send timeout with a 30 minute default', async () => {
    const { __testables } = await loadBridge();

    expect(__testables.normalizeCopilotSendTimeoutMs(undefined)).toBe(1_800_000);
    expect(__testables.normalizeCopilotSendTimeoutMs(null)).toBe(1_800_000);
    expect(__testables.normalizeCopilotSendTimeoutMs(30_000)).toBe(1_800_000);
    expect(__testables.normalizeCopilotSendTimeoutMs(1_800_500.8)).toBe(1_800_500);
  });

  it('passes Copilot built-in override metadata for web_fetch', async () => {
    const { __testables } = await loadBridge();

    const tools = __testables.buildMacroTools({
      request_id: 'req-1',
      model_id: 'gpt-5',
      messages: [],
      allowed_tool_ids: ['web_fetch', 'git_status'],
    }) as Array<{ name: string; options: { overridesBuiltInTool?: true } }>;

    const webFetchTool = tools.find((tool) => tool.name === 'web_fetch');
    const gitStatusTool = tools.find((tool) => tool.name === 'git_status');

    expect(webFetchTool?.options.overridesBuiltInTool).toBe(true);
    expect(gitStatusTool?.options.overridesBuiltInTool).toBeUndefined();
  });

  it('routes delete and apply_patch through the Macro tool host', async () => {
    const fetchCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchMock = mock(async (url: string, init?: RequestInit) => {
      fetchCalls.push({
        url,
        body: JSON.parse(String(init?.body ?? '{}')),
      });
      return {
        ok: true,
        json: async () => ({ result: 'host ok' }),
      } as Response;
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    process.env.MACRO_TOOL_HOST_URL = 'http://127.0.0.1:1456';
    process.env.MACRO_TOOL_HOST_BEARER_TOKEN = 'token-1';

    try {
      const { __testables } = await loadBridge();
      const tools = __testables.buildMacroTools({
        request_id: 'req-1',
        model_id: 'gpt-5',
        messages: [],
        default_workspace_path: '/tmp/macro-test',
        allowed_tool_ids: ['delete', 'apply_patch'],
      }) as Array<{
        name: string;
        options: {
          handler: (
            args: Record<string, unknown>,
            invocation: { sessionId: string; toolCallId: string; toolName: string },
          ) => Promise<string>;
        };
      }>;

      const deleteTool = tools.find((tool) => tool.name === 'delete');
      const applyPatchTool = tools.find((tool) => tool.name === 'apply_patch');

      await expect(
        deleteTool?.options.handler(
          { path: 'old.txt' },
          { sessionId: 'session-1', toolCallId: 'call-delete', toolName: 'delete' },
        ),
      ).resolves.toBe('host ok');
      await expect(
        applyPatchTool?.options.handler(
          { patch_text: '*** Begin Patch\n*** Delete File: old.txt\n*** End Patch' },
          { sessionId: 'session-1', toolCallId: 'call-patch', toolName: 'apply_patch' },
        ),
      ).resolves.toBe('host ok');

      expect(fetchCalls.map((call) => call.body.tool_id)).toEqual(['delete', 'apply_patch']);
      expect(fetchCalls.every((call) => call.url.endsWith('/api/v1/tools/execute'))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('copilot bridge reasoning events', () => {
  it('streams Copilot reasoning deltas inside a think block before response text', async () => {
    const { __testables } = await loadBridge();
    const state = __testables.createCopilotSessionEventState();
    const emitted: Array<Record<string, unknown>> = [];
    const emit = (payload: Record<string, unknown>) => {
      emitted.push(payload);
    };

    const common = {
      state,
      toolTraces: new Map(),
      hiddenContextBlocks: [],
      emit,
    };

    __testables.handleCopilotSessionEvent({
      ...common,
      event: {
        type: 'assistant.reasoning_delta',
        data: { reasoningId: 'reasoning-1', deltaContent: 'Inspecting files.' },
      },
    });
    __testables.handleCopilotSessionEvent({
      ...common,
      event: {
        type: 'assistant.reasoning_delta',
        data: { reasoningId: 'reasoning-1', deltaContent: ' Choosing fix.' },
      },
    });
    __testables.handleCopilotSessionEvent({
      ...common,
      event: {
        type: 'assistant.message_delta',
        data: { messageId: 'message-1', deltaContent: 'Done.' },
      },
    });

    expect(emitted.map((payload) => payload.delta)).toEqual([
      '<think>',
      'Inspecting files.',
      ' Choosing fix.',
      '</think>\n',
      'Done.',
    ]);
    expect(__testables.getCopilotReasoningSummary(state)).toBe(
      'Inspecting files. Choosing fix.'
    );
  });

  it('uses assistant message reasoningText as the readable reasoning fallback', async () => {
    const { __testables } = await loadBridge();
    const state = __testables.createCopilotSessionEventState();
    const emitted: Array<Record<string, unknown>> = [];

    __testables.handleCopilotSessionEvent({
      event: {
        type: 'assistant.message',
        data: {
          messageId: 'message-1',
          content: 'Final answer.',
          reasoningText: 'Readable Copilot thinking.',
        },
      },
      state,
      toolTraces: new Map(),
      hiddenContextBlocks: [],
      emit: (payload: Record<string, unknown>) => {
        emitted.push(payload);
      },
    });

    expect(emitted).toEqual([]);
    expect(state.finalContent).toBe('Final answer.');
    expect(__testables.getCopilotReasoningSummary(state)).toBe(
      'Readable Copilot thinking.'
    );
  });
});
