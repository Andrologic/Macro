import { afterEach, describe, expect, it, mock } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { ModelInfo, ToolInvocation, ToolResultObject } from '@github/copilot-sdk';
import nativeToolResults from '../../src-tauri/src/ai/copilot/fixtures/tool-results.json';
import { BridgeControlChannel } from './controlChannel';
import type { RelayToolResult } from './protocol';
import { requireMacroToolRegistryEntry, toFunctionToolShape } from '../../src/shared/macroToolRegistry';

const suppliedTools = (ids: string[]) => ids.map(id => toFunctionToolShape(requireMacroToolRegistryEntry(id)));

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

describe('Copilot model catalogue', () => {
  it('maps models with missing capabilities or supports without claiming unsupported features', async () => {
    const { __testables } = await loadBridge();
    const missingCapabilities = { id: 'plain', name: 'Plain' } as ModelInfo;
    const missingSupports = { id: 'partial', name: '', capabilities: {} } as ModelInfo;

    expect(__testables.modelDescription(missingCapabilities)).toBeNull();
    expect(__testables.mapModel(missingCapabilities)).toEqual({
      model_id: 'plain', name: 'Plain', description: null,
      owned_by: 'github-copilot', supported_reasoning_efforts: undefined,
    });
    expect(__testables.modelDescription(missingSupports)).toBeNull();
    expect(__testables.mapModel(missingSupports)).toEqual({
      model_id: 'partial', name: 'partial', description: null,
      owned_by: 'github-copilot', supported_reasoning_efforts: undefined,
    });
  });

  it('preserves declared vision and reasoning support for complete models', async () => {
    const { __testables } = await loadBridge();
    const model: ModelInfo = {
      id: 'complete', name: 'Complete',
      capabilities: {
        supports: { vision: true, reasoningEffort: true },
        limits: { max_context_window_tokens: 128_000 },
      },
      supportedReasoningEfforts: ['low', 'high'],
    };

    expect(__testables.modelDescription(model)).toBe('Copilot model (vision, reasoning:low/high)');
    expect(__testables.mapModel(model)).toEqual({
      model_id: 'complete', name: 'Complete',
      description: 'Copilot model (vision, reasoning:low/high)',
      owned_by: 'github-copilot', supported_reasoning_efforts: ['low', 'high'],
    });
  });
});

describe('copilot bridge tool registration', () => {
  it('keeps SDK tool context only for native tools or accepted relay results', async () => {
    const { __testables } = await loadBridge();
    const state = __testables.createCopilotSessionEventState();
    const toolTraces = new Map();
    const hiddenContextBlocks: string[] = [];
    const acceptedRelayToolCallIds = new Set(['accepted']);
    const emit = () => undefined;
    for (const [toolCallId, toolName] of [
      ['rejected', 'read_file'], ['accepted', 'read_file'], ['native', 'mark_source_passage'],
    ]) {
      __testables.handleCopilotSessionEvent({
        event: { type: 'tool.execution_start', data: { toolCallId, toolName, arguments: {} } },
        state, toolTraces, hiddenContextBlocks, acceptedRelayToolCallIds, emit,
      });
      __testables.handleCopilotSessionEvent({
        event: { type: 'tool.execution_complete', data: {
          toolCallId, result: { content: `${toolCallId} result` },
        } },
        state, toolTraces, hiddenContextBlocks, acceptedRelayToolCallIds, emit,
      });
    }

    expect(hiddenContextBlocks.join('\n')).not.toContain('rejected result');
    expect(hiddenContextBlocks.join('\n')).toContain('accepted result');
    expect(hiddenContextBlocks.join('\n')).toContain('native result');
  });

  it('carries Rust error metadata through the concrete channel to the SDK handler', async () => {
    const { __testables } = await loadBridge();
    const input = new PassThrough();
    const channel = new BridgeControlChannel(input, () => {});
    const recorded = mock((_toolCallId: string, _result: RelayToolResult) => {});
    input.write('{}\n');
    const tools = __testables.buildMacroTools({
      request_id: ' request:opaque ', model_id: 'synthetic', messages: [],
      tools: suppliedTools(['read_file']),
      allowed_tool_ids: ['read_file'],
    }, { controlChannel: channel, recordRelayResult: recorded }) as Array<{
      name: string;
      options: { handler: (args: Record<string, unknown>, invocation: ToolInvocation) => Promise<string | ToolResultObject> };
    }>;
    const handler = tools.find((tool) => tool.name === 'read_file')!.options.handler;
    const invocation = {
      sessionId: 'session', toolCallId: ' call/opaque ', toolName: 'read_file', arguments: {},
    };
    try {
      for (const { payload, sdk_result_type: resultType } of nativeToolResults) {
        if (resultType !== 'success' && resultType !== 'denied' && resultType !== 'failure') {
          throw new Error(`Invalid fixture SDK result type: ${resultType}`);
        }
        const result = handler({ path: 'example.txt' }, invocation);
        input.write(`${JSON.stringify({ ...payload, submission_id: 'submission-1' })}\n`);
        await expect(result).resolves.toEqual({
          textResultForLlm: payload.result, resultType,
          ...(payload.is_error ? { error: payload.result } : {}),
          toolTelemetry: { is_error: payload.is_error, error_kind: payload.error_kind },
        });
        expect(recorded).toHaveBeenLastCalledWith(' call/opaque ', {
          result: payload.result,
          isError: payload.is_error,
          errorKind: payload.error_kind,
          interrupt: payload.interrupt,
          hiddenContext: payload.hidden_context ?? undefined,
          visibleContent: payload.visible_content ?? undefined,
          submissionId: 'submission-1',
        });
      }

      // A closed control channel must reach the SDK's exception path, not success text.
      channel.close();
      recorded.mockClear();
      await expect(handler({}, invocation)).rejects.toMatchObject({ code: 'tool_result_channel_closed' });
      expect(recorded).not.toHaveBeenCalled();
    } finally {
      channel.close();
    }
  });

  it('normalizes the Copilot send timeout with room for tool and completion margins', async () => {
    const { __testables } = await loadBridge();

    expect(__testables.normalizeCopilotSendTimeoutMs(undefined)).toBe(1_860_000);
    expect(__testables.normalizeCopilotSendTimeoutMs(null)).toBe(1_860_000);
    expect(__testables.normalizeCopilotSendTimeoutMs(30_000)).toBe(1_860_000);
    expect(__testables.normalizeCopilotSendTimeoutMs(60_000)).toBe(60_000);
    expect(__testables.normalizeCopilotSendTimeoutMs(1_800_500.8)).toBe(1_800_500);
  });

  it('keeps the frontend relay alive for the requested terminal runtime plus cleanup margin', async () => {
    const { __testables } = await loadBridge();

    expect(__testables.frontendToolTimeoutMs('read', {})).toBe(300_000);
    expect(__testables.frontendToolTimeoutMs('question', {})).toBe(1_830_000);
    expect(__testables.frontendToolTimeoutMs('need_user_input', {})).toBe(1_830_000);
    expect(__testables.frontendToolTimeoutMs('terminal_run', {})).toBe(300_000);
    expect(
      __testables.frontendToolTimeoutMs('terminal_run', { timeout_ms: 900_000 }),
    ).toBe(930_000);
    expect(
      __testables.frontendToolTimeoutMs('terminal_run', { timeout_ms: 1_800_000 }),
    ).toBe(1_830_000);
    expect(
      __testables.frontendToolTimeoutMs('terminal_run', { timeout_ms: 9_000_000 }),
    ).toBe(1_830_000);
    expect(__testables.frontendToolTimeoutMs('question', {}, 60_000)).toBe(30_000);
    expect(
      __testables.frontendToolTimeoutMs('terminal_run', { timeout_ms: 900_000 }, 120_000),
    ).toBe(90_000);
  });

  it('serializes compacted system checkpoints outside the visible transcript', async () => {
    const { __testables } = await loadBridge();

    const serialized = __testables.serializeConversationPrompt([
      {
        role: 'system',
        content: 'You are Macro.',
      },
      {
        role: 'system',
        content: '[COMPACTED CONVERSATION STATE]\nOlder Copilot turns summarized.',
      },
      {
        role: 'user',
        content: 'Continue from the retained turn.',
      },
      {
        role: 'assistant',
        content: 'Retained assistant answer.',
      },
    ]);

    expect(serialized.system).toContain('You are Macro.');
    expect(serialized.system).toContain('[COMPACTED CONVERSATION STATE]');
    expect(serialized.prompt).toContain('[USER]\nContinue from the retained turn.');
    expect(serialized.prompt).toContain('[ASSISTANT]\nRetained assistant answer.');
    expect(serialized.prompt).not.toContain('[COMPACTED CONVERSATION STATE]');
    expect(serialized.prompt).not.toContain('Older Copilot turns summarized.');
  });

  it('passes Copilot built-in override metadata for web_fetch', async () => {
    const { __testables } = await loadBridge();

    const tools = __testables.buildMacroTools({
      request_id: 'req-1',
      model_id: 'gpt-5',
      messages: [],
      tools: suppliedTools(['web_fetch', 'git_status']),
      allowed_tool_ids: ['web_fetch', 'git_status'],
    }) as Array<{ name: string; options: { overridesBuiltInTool?: true } }>;

    const webFetchTool = tools.find((tool) => tool.name === 'web_fetch');
    const gitStatusTool = tools.find((tool) => tool.name === 'git_status');

    expect(webFetchTool?.options.overridesBuiltInTool).toBe(true);
    expect(gitStatusTool?.options.overridesBuiltInTool).toBeUndefined();
  });

  it('never executes web_fetch without the frontend approval relay', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = mock(async () => {
      throw new Error('network access must not occur');
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const { __testables } = await loadBridge();
      const tools = __testables.buildMacroTools({
        request_id: 'req-web-fetch',
        model_id: 'gpt-5',
        messages: [],
        tools: suppliedTools(['web_fetch']),
        allowed_tool_ids: ['web_fetch'],
      }) as Array<{
        name: string;
        options: { handler: (args: Record<string, unknown>) => Promise<string> };
      }>;

      expect(__testables.isFrontendRelayToolId('web_fetch')).toBe(true);
      await expect(
        tools
          .find((tool) => tool.name === 'web_fetch')
          ?.options.handler({ url: 'http://127.0.0.1/secret' }),
      ).resolves.toContain('Macro frontend relay is unavailable');
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('classifies supported Chat terminal tools without being confused by MCP ids', async () => {
    const { __testables } = await loadBridge();

    expect(
      __testables.inferMacroMode([
        'read_file',
        'terminal_create_session',
        'terminal_run',
        'mcp__github__list_issues',
      ]),
    ).toBe('Chat');
    expect(__testables.inferMacroMode(['read_file', 'write'])).toBe('Implement');
    expect(__testables.inferMacroMode(['read_file', 'plan_get'])).toBe('Architect');
  });

  it('relays every terminal tool to the frontend permission handler', async () => {
    const { __testables } = await loadBridge();
    const requestTool = mock(async (params: Record<string, unknown>) => ({
      result: `frontend:${String(params.toolName)}`,
      hiddenContext: null,
      visibleContent: null,
      interrupt: false,
    }));

    for (const toolId of [
      'terminal_create_session',
      'terminal_run',
      'terminal_read',
      'terminal_kill',
    ]) {
      expect(__testables.isFrontendRelayToolId(toolId)).toBe(true);
      const tools = __testables.buildMacroTools(
        {
          request_id: 'req-terminal',
          model_id: 'gpt-5',
          messages: [],
          tools: suppliedTools([toolId]),
          allowed_tool_ids: [toolId],
        },
        { controlChannel: { requestTool } } as never,
      ) as Array<{
        name: string;
        options: {
          handler: (
            args: Record<string, unknown>,
            invocation: { sessionId: string; toolCallId: string; toolName: string },
          ) => Promise<string>;
        };
      }>;
      const terminalTool = tools.find((tool) => tool.name === toolId);

      await expect(
        terminalTool?.options.handler(
          { project_id: 'project-1', session_id: 'session-1', command: 'pwd' },
          {
            sessionId: 'session-1',
            toolCallId: `call-${toolId}`,
            toolName: toolId,
          },
        ),
      ).resolves.toBe(`frontend:${toolId}`);
    }

    expect(requestTool).toHaveBeenCalledTimes(4);
  });

  it('relays read_file arguments unchanged so the frontend can resolve artifacts and byte ranges', async () => {
    const { __testables } = await loadBridge();
    const requestTool = mock(async () => ({
      result: 'artifact contents',
      hiddenContext: null,
      visibleContent: null,
      interrupt: false,
    }));
    const tools = __testables.buildMacroTools(
      {
        request_id: 'req-read-file',
        model_id: 'gpt-5',
        messages: [],
        tools: suppliedTools(['read_file']),
        allowed_tool_ids: ['read_file'],
      },
      { controlChannel: { requestTool } } as never,
    ) as Array<{
      name: string;
      options: { handler: (args: Record<string, unknown>) => Promise<string> };
    }>;
    const args = {
      file: 'tool-output://artifact-1',
      raw: true,
      cursor: 'cursor-1',
      start_byte: 128,
      max_bytes: 4096,
    };

    await expect(
      tools.find((tool) => tool.name === 'read_file')?.options.handler(args),
    ).resolves.toBe('artifact contents');
    expect(requestTool).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'read_file',
      args,
    }));
  });

  it('relays workspace tools and mutating Git tools through the frontend unchanged', async () => {
    const { __testables } = await loadBridge();
    const requestTool = mock(async (params: Record<string, unknown>) => ({
      result: `frontend:${String(params.toolName)}`,
      hiddenContext: null,
      visibleContent: null,
      interrupt: false,
    }));
    const relayedToolIds = [
      'web_fetch',
      'list',
      'read',
      'glob',
      'grep',
      'ast_grep',
      'write',
      'edit',
      'delete',
      'apply_patch',
      'git_add',
      'git_commit',
      'git_checkout',
      'git_merge',
      'git_reset',
      'git_stash',
      'git_branch_list',
      'git_get_tree',
    ];
    const tools = __testables.buildMacroTools(
      {
        request_id: 'req-relay',
        model_id: 'gpt-5',
        messages: [],
        default_workspace_path: '/tmp/default-project',
        virtual_root_enabled: true,
        project_mounts: [
          {
            project_id: 'web-project',
            mount_name: 'web',
            workspace_path: '/tmp/web-project',
            is_read_only: false,
          },
          {
            project_id: 'api-project',
            mount_name: 'api',
            workspace_path: '/tmp/api-project',
            is_read_only: false,
          },
        ],
        tools: suppliedTools(relayedToolIds),
        allowed_tool_ids: relayedToolIds,
      },
      { controlChannel: { requestTool } } as never,
    ) as Array<{
      name: string;
      options: {
        handler: (
          args: Record<string, unknown>,
          invocation: { sessionId: string; toolCallId: string; toolName: string },
        ) => Promise<string>;
      };
    }>;

    for (const toolId of relayedToolIds) {
      expect(__testables.isFrontendRelayToolId(toolId)).toBe(true);
      const args = {
        path: 'web/src/index.ts',
        repo_path: 'web',
        project_id: 'web-project',
        patch_text: '*** Begin Patch\n*** Delete File: web/old.txt\n*** End Patch',
      };
      await expect(
        tools.find((tool) => tool.name === toolId)?.options.handler(args, {
          sessionId: 'session-relay',
          toolCallId: `call-${toolId}`,
          toolName: toolId,
        }),
      ).resolves.toBe(`frontend:${toolId}`);
      expect(requestTool).toHaveBeenLastCalledWith(
        expect.objectContaining({ toolName: toolId, args }),
      );
    }

    expect(requestTool).toHaveBeenCalledTimes(relayedToolIds.length);
  });

  it('keeps read-only Git inspection on the confined Macro tool host', async () => {
    const fetchCalls: Array<Record<string, unknown>> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
      fetchCalls.push(JSON.parse(String(init?.body ?? '{}')));
      return {
        ok: true,
        json: async () => ({ result: 'host ok' }),
      } as Response;
    }) as unknown as typeof fetch;
    process.env.MACRO_TOOL_HOST_URL = 'http://127.0.0.1:1456';
    process.env.MACRO_TOOL_HOST_BEARER_TOKEN = 'token-1';

    try {
      const { __testables } = await loadBridge();
      const tools = __testables.buildMacroTools({
        request_id: 'req-git-read',
        model_id: 'gpt-5',
        messages: [],
        default_workspace_path: '/tmp/macro-source',
        tools: suppliedTools(['git_status']),
        allowed_tool_ids: ['git_status'],
      }) as Array<{
        name: string;
        options: { handler: (args: Record<string, unknown>) => Promise<string> };
      }>;

      await expect(
        tools.find((tool) => tool.name === 'git_status')?.options.handler({ repo_path: '.' }),
      ).resolves.toBe('host ok');
      expect(fetchCalls).toEqual([
        expect.objectContaining({
          mode: 'Implement',
          tool_id: 'git_status',
          workspace_path: path.resolve('/tmp/macro-source'),
        }),
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('copilot bridge reasoning events', () => {
  it('classifies output-limit warnings without treating unrelated warnings as truncation', async () => {
    const { __testables } = await loadBridge();

    expect(
      __testables.classifyCopilotWarningCompletionReason({
        warningType: 'max_output_tokens',
        message: 'The response reached the output limit.',
      }),
    ).toBe('length');
    expect(
      __testables.classifyCopilotWarningCompletionReason({
        warningType: 'mcp',
        message: 'One optional MCP server is unavailable.',
      }),
    ).toBeNull();
  });

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

it('registers only allowed MCP schemas and relays mixed media through the channel to the SDK', async () => {
  const { default: fixture } = await import('../../src-tauri/src/commands/mcp/fixtures/typed-result.json');
  const { __testables } = await loadBridge();
  const input = new PassThrough();
  let dispatched: unknown;
  const channel = new BridgeControlChannel(input, payload => {
    dispatched = payload;
    input.write(`${JSON.stringify({ type: 'tool_result', request_id: payload.request_id, tool_call_id: payload.tool_call_id, result: 'partial result', is_error: true, blocks: fixture.content })}\n`);
  });
  input.write('{}\n');
  const schema = { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] };
  const tools = __testables.buildMacroTools({ request_id: 'mcp-native', model_id: 'fixture', messages: [],
    allowed_tool_ids: ['mcp__fixture__read', 'mcp__fixture__missing'], tools: [
      { type: 'function', function: { name: 'mcp__fixture__read', description: 'Fixture', parameters: schema } },
      { type: 'function', function: { name: 'mcp__fixture__denied', parameters: schema } },
    ],
  }, { controlChannel: channel }) as Array<{ name: string; options: { parameters: unknown; handler: (args: unknown, invocation: ToolInvocation) => Promise<ToolResultObject> } }>;
  try {
    expect(tools.map(tool => tool.name)).toEqual(['mcp__fixture__read']);
    expect(tools[0].options.parameters).toEqual(schema);
    const result = await tools[0].options.handler({ query: 'synthetic' }, { sessionId: 'session', toolCallId: 'call', toolName: tools[0].name, arguments: {} });
    expect(dispatched).toMatchObject({ request_id: 'mcp-native', tool_call_id: 'call', tool_name: 'mcp__fixture__read', args: { query: 'synthetic' } });
    expect(JSON.stringify(result.binaryResultsForLlm)).toBe(JSON.stringify(fixture.content.slice(1)));
    expect(result.resultType).toBe('failure');
  } finally { channel.close(); }
});
