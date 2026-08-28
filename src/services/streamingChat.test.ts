import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { ChatMessage } from '../types';
import { buildCompactedMessagesForRequest } from './contextCompaction';
import { fingerprintImageSource } from './contextTokenEstimation';
import type {
  LiveStreamContextSnapshot,
  StreamCompletionResult,
  StreamingFollowUpCompactionRequest,
} from './streamingChat';

let streamingChatImportCounter = 0;
const actualTauriIpc = await import('./tauriIpc');

const loadStreamingChat = async (
  fetchImpl?: ReturnType<typeof mock>,
  options?: {
    invokeImpl?: ReturnType<typeof mock>;
    listenImpl?: ReturnType<typeof mock>;
    forceTauriAvailable?: boolean;
  }
) => {
  mock.restore();
  const invokeImpl = options?.invokeImpl ?? mock(async () => undefined);
  const actualCore = await import('@tauri-apps/api/core');
  const actualEvent = await import('@tauri-apps/api/event');
  const actualHttp = await import('@tauri-apps/plugin-http');
  const actualArchitectChat = await import('./architectChat');
  mock.module('@tauri-apps/api/core', () => ({
    ...actualCore,
    invoke: invokeImpl,
  }));
  mock.module('@tauri-apps/api/event', () => ({
    ...actualEvent,
    listen: options?.listenImpl ?? mock(async () => () => undefined),
  }));
  mock.module('@tauri-apps/plugin-http', () => ({
    ...actualHttp,
    fetch:
      fetchImpl ??
      mock(async () => {
        throw new Error('HTTP fetch should not be called in streamingChat unit tests.');
      }),
  }));
  mock.module('../stores/useProviderStore', () => ({
    isLinkedProviderType: (providerType?: string | null) =>
      providerType === 'chatgpt' || providerType === 'copilot',
    providerHasAuthSession: () => false,
    providerHasCredentials: () => true,
    useProviderStore: {
      getState: () => ({
        markReasoningUnsupportedForModel: () => undefined,
      }),
    },
  }));
  const tauriIpcMock = {
    ...actualTauriIpc,
    isTauriAvailable: () => options?.forceTauriAvailable ?? false,
    frontendLog: async () => undefined,
    aiStreamChat: async (params: {
      requestId: string;
      providerId: string;
      modelId: string;
      reasoningEffort?: string | null;
      conversationId?: string | null;
      messages: unknown[];
      tools?: unknown[];
      toolChoice?: string;
      parallelToolCalls?: boolean;
      workspacePath?: string | null;
      defaultWorkspacePath?: string | null;
      projectMounts?: Array<{
        projectId: string;
        mountName: string;
        workspacePath?: string | null;
        displayName: string;
      }>;
      virtualRootEnabled?: boolean | null;
      focusedProjectId?: string | null;
      allowedToolIds?: string[];
      copilotSendTimeoutMs?: number | null;
    }) =>
      invokeImpl('ai_stream_chat', {
        request: {
          request_id: params.requestId,
          provider_id: params.providerId,
          model_id: params.modelId,
          reasoning_effort: params.reasoningEffort ?? null,
          conversation_id: params.conversationId ?? null,
          messages: params.messages,
          tools: params.tools ?? [],
          tool_choice: params.toolChoice ?? 'auto',
          parallel_tool_calls: params.parallelToolCalls ?? false,
          workspace_path: params.workspacePath ?? null,
          default_workspace_path: params.defaultWorkspacePath ?? null,
          project_mounts: (params.projectMounts ?? []).map((mount) => ({
            project_id: mount.projectId,
            mount_name: mount.mountName,
            workspace_path: mount.workspacePath ?? null,
            display_name: mount.displayName,
          })),
          virtual_root_enabled: params.virtualRootEnabled ?? null,
          focused_project_id: params.focusedProjectId ?? null,
          allowed_tool_ids: params.allowedToolIds ?? [],
          copilot_send_timeout_ms: params.copilotSendTimeoutMs ?? null,
        },
    }),
    aiCancelStream: async (requestId: string) =>
      invokeImpl('ai_cancel_stream', { requestId }),
    aiSubmitToolResult: async (params: {
      requestId: string;
      toolCallId: string;
      result: string;
      hiddenContext?: string | null;
      visibleContent?: string | null;
      interrupt?: boolean;
      isError?: boolean;
      errorKind?: 'validation' | 'permission' | 'execution' | 'aborted';
    }) =>
      invokeImpl('ai_submit_tool_result', {
        request: {
          request_id: params.requestId,
          tool_call_id: params.toolCallId,
          result: params.result,
          hidden_context: params.hiddenContext ?? null,
          visible_content: params.visibleContent ?? null,
          interrupt: params.interrupt ?? false,
          is_error: params.isError ?? false,
          error_kind: params.errorKind ?? null,
        },
      }),
  };
  mock.module('./tauriIpc', () => tauriIpcMock);
  mock.module('../services/tauriIpc', () => tauriIpcMock);
  mock.module('./architectChat', () => ({
    ...actualArchitectChat,
    ARCHITECT_POST_TOOL_RESPONSE_INSTRUCTION:
      'After using an Architect tool, always answer in natural language with a concise recap.',
    ARCHITECT_POST_TOOL_RETRY_SYSTEM_PROMPT:
      'After using tools, provide a concise recap to the user.',
    ARCHITECT_GENERATE_STRATEGY_BUTTON_PROMPT_SUFFIX:
      'Keep every strategy node inside the active plan project scope: omit project_ids to use the plan projectIds, and never include unrelated Macro projects. After the tool call, answer in natural language with what changed, a short summary of the strategy, and the next useful step.',
  }));

  streamingChatImportCounter += 1;
  return import(`./streamingChat.ts?test=${streamingChatImportCounter}`);
};

const asObjectSchema = (
  schema: unknown
): {
  properties: Record<string, unknown>;
  required?: string[];
} => schema as {
  properties: Record<string, unknown>;
  required?: string[];
};

describe('streamingChat Architect tool contracts', () => {
  beforeEach(() => {
    mock.restore();
  });

  it('does not require title for plan_create and exposes label support', async () => {
    const { CREATE_PLAN_TOOL } = await loadStreamingChat();
    const { properties, required = [] } = asObjectSchema(CREATE_PLAN_TOOL.function.parameters);

    expect(required).not.toContain('title');
    expect(properties.label).toBeDefined();
    expect(String(CREATE_PLAN_TOOL.function.description)).toContain('generated identifier');
  });

  it('documents plan_title as a label alias for strategy generation', async () => {
    const { GENERATE_PLAN_TOOL } = await loadStreamingChat();
    const properties = asObjectSchema(GENERATE_PLAN_TOOL.function.parameters).properties as Record<
      string,
      { description?: string }
    >;
    const planTitleProperty = properties.plan_title;

    expect(String(GENERATE_PLAN_TOOL.function.description)).toContain('plan_slug');
    expect(properties.plan_slug).toBeDefined();
    expect(String(planTitleProperty.description)).toContain('secondary plan label');
  });

  it('documents plan_update title as a legacy alias without changing canonical ids', async () => {
    const { UPDATE_PLAN_TOOL } = await loadStreamingChat();
    const properties = asObjectSchema(UPDATE_PLAN_TOOL.function.parameters).properties as Record<
      string,
      { description?: string }
    >;

    expect(properties.label).toBeDefined();
    expect(String(properties.title.description).toLowerCase()).toContain('legacy alias');
    expect(properties.status).toBeUndefined();
    expect(properties.set_active).toBeUndefined();
    expect(String(UPDATE_PLAN_TOOL.function.description)).toContain(
      'logical slug becomes immutable'
    );
  });
});

describe('streamingChat context estimates', () => {
  beforeEach(() => {
    mock.restore();
  });

  it('counts image context without treating a chat-completion data URL as text', async () => {
    const { estimateChatCompletionSerializedPayloadTokens } = await loadStreamingChat();
    const dataUrl = `data:image/png;base64,${'a'.repeat(900_000)}`;

    const tokens = estimateChatCompletionSerializedPayloadTokens({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Inspect this image.' },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
          image_metadata: [
            { width: 1024, height: 1024 },
            { width: 10_000, height: 10_000 },
          ],
        },
      ],
      providerType: 'openai',
      modelId: 'gpt-4.1',
    });

    expect(tokens).toBeGreaterThanOrEqual(765);
    expect(tokens).toBeLessThan(850);
  });

  it('aligns image metadata with images that survive provider-item serialization', async () => {
    const { estimateChatCompletionSerializedPayloadTokens } = await loadStreamingChat();
    const removedDataUrl = `data:image/png;base64,${'a'.repeat(64)}`;
    const retainedDataUrl = `data:image/png;base64,${'b'.repeat(64)}`;

    const tokens = estimateChatCompletionSerializedPayloadTokens({
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'image_url', image_url: { url: removedDataUrl } },
            { type: 'image_url', image_url: { url: retainedDataUrl } },
          ],
          image_metadata: [
            {
              width: 10_000,
              height: 10_000,
              sourceFingerprint: fingerprintImageSource(removedDataUrl),
            },
            {
              width: 512,
              height: 512,
              sourceFingerprint: fingerprintImageSource(retainedDataUrl),
            },
          ],
          provider_input_items: [
            {
              type: 'chat_completion_message',
              role: 'assistant',
              content: [
                { type: 'image_url', image_url: { url: retainedDataUrl } },
              ],
            },
          ],
        },
        {
          role: 'user',
          content: 'Inspect the retained image.',
        },
      ],
      providerType: 'openai',
      modelId: 'gpt-4.1',
    });

    expect(tokens).toBeGreaterThanOrEqual(255);
    expect(tokens).toBeLessThan(350);
  });

  it('does not embed image data URLs in the Copilot prompt estimate', async () => {
    const { estimateCopilotSerializedPayloadTokens } = await loadStreamingChat();
    const dataUrl = `data:image/png;base64,${'a'.repeat(900_000)}`;

    const tokens = estimateCopilotSerializedPayloadTokens({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Inspect this image.' },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
          image_metadata: [
            { width: 1024, height: 1024 },
            { width: 10_000, height: 10_000 },
          ],
        },
      ],
      providerType: 'openai',
      modelId: 'gpt-5.6',
    });

    expect(tokens).toBeGreaterThanOrEqual(1229);
    expect(tokens).toBeLessThan(1350);
  });

  it('does not count stale Copilot metadata when the prompt contains no image', async () => {
    const { estimateCopilotSerializedPayloadTokens } = await loadStreamingChat();

    const tokens = estimateCopilotSerializedPayloadTokens({
      messages: [
        {
          role: 'assistant',
          content: 'Historical text-only answer.',
          image_metadata: [{ width: 10_000, height: 10_000 }],
        },
        {
          role: 'user',
          content: 'Continue.',
        },
      ],
      providerType: 'openai',
      modelId: 'gpt-5.6',
    });

    expect(tokens).toBeLessThan(100);
  });
});

describe('streamingChat SSE parsing', () => {
  it('joins multiline data fields and preserves the SSE field rules', async () => {
    const { __testables } = await loadStreamingChat();

    expect(
      __testables.extractSseData('event: message\r\ndata: first\r\ndata: second'),
    ).toBe('first\nsecond');
  });

  it('flushes an unterminated final event across chunk boundaries', async () => {
    const { __testables } = await loadStreamingChat();
    const parser = __testables.createSseEventParser();

    expect(parser.push('data: {"choices":[')).toEqual([]);
    expect(parser.push(']}\r')).toEqual([]);
    expect(parser.push('\ndata: tail')).toEqual([]);
    expect(parser.flush()).toEqual(['data: {"choices":[]}\ndata: tail']);
  });
});

describe('streamingChat tool rendering helpers', () => {
  beforeEach(() => {
    mock.restore();
  });

  it('formats short tool details for file reads and web search', async () => {
    const { __testables } = await loadStreamingChat();
    expect(__testables.formatToolTraceDetail('read', { path: 'src/app.ts' })).toBe('src/app.ts');
    expect(__testables.formatToolTraceDetail('read_file', { file: 'README.md' })).toBe(
      'README.md'
    );
    expect(__testables.formatToolTraceDetail('web_search', { query: 'macro desktop app' })).toBe(
      'macro desktop app'
    );
  });

  it('stores raw tool results in hidden tool context blocks', async () => {
    const { __testables } = await loadStreamingChat();
    const block = __testables.buildToolContextBlock(
      'call_123',
      'read',
      'src/app.ts',
      'FILE: src/app.ts\nSOURCE: WORKSPACE_FILE\n\nconst ok = true;'
    );

    expect(block).toContain('<tool_context');
    expect(block).toContain('tool_call_id="call_123"');
    expect(block).toContain('tool="read"');
    expect(block).toContain('detail="src/app.ts"');
    expect(block).toContain('const ok = true;');
  });

  it('collects internal skill tools when they are allowed', async () => {
    const { __testables } = await loadStreamingChat();
    const tools = __testables.collectAllowedTools({
      allowedTools: new Set(['skill_activate', 'skill_read_resource', 'skill_run_script']),
      enableWebSearch: false,
      enableWebFetch: false,
      skillToolIds: ['global:agents:docs:aaa111'],
      runnableSkillToolIds: ['global:agents:docs:aaa111'],
    });

    const serializedTools = JSON.stringify(tools);
    expect(serializedTools).toContain('skill_activate');
    expect(serializedTools).toContain('skill_read_resource');
    expect(serializedTools).toContain('skill_run_script');
  });

  it('retries once when a required native tool was not used', async () => {
    const { __testables } = await loadStreamingChat();
    expect(
      __testables.shouldRetryMissingRequiredTool(
        {
          requiredToolNames: ['read_file'],
          retrySystemPrompt: 'Use read_file first.',
          maxRetries: 1,
        },
        [],
        0
      )
    ).toBe(true);

    expect(
      __testables.shouldRetryMissingRequiredTool(
        {
          requiredToolNames: ['read_file'],
          retrySystemPrompt: 'Use read_file first.',
          maxRetries: 1,
        },
        [
          {
            id: 'call_1',
            type: 'function',
            function: {
              name: 'read_file',
              arguments: '{"file":"README.md"}',
            },
          },
        ],
        0
      )
    ).toBe(false);

    expect(
      __testables.shouldRetryMissingRequiredTool(
        {
          requiredToolNames: ['read_file'],
          retrySystemPrompt: 'Use read_file first.',
          maxRetries: 1,
        },
        [],
        1
      )
    ).toBe(false);
  });

  it('wraps ChatGPT reasoning summaries into a think block', async () => {
    const { __testables } = await loadStreamingChat();
    expect(
      __testables.buildChatGptVisibleTurnContent(
        'Voici la reponse finale.',
        'Le modele a d abord inspecte les fichiers.'
      )
    ).toBe('<think>Le modele a d abord inspecte les fichiers.</think>\nVoici la reponse finale.');

    expect(__testables.buildChatGptVisibleTurnContent('', 'Resume bref.')).toBe(
      '<think>Resume bref.</think>'
    );
  });

  it('appends missing ChatGPT turn content when the final text only arrives at completion', async () => {
    const { __testables } = await loadStreamingChat();

    expect(
      __testables.getMissingChatGptVisibleTurnSuffix('', 'Bilan final apres outils.')
    ).toBe('Bilan final apres outils.');

    expect(
      __testables.getMissingChatGptVisibleTurnSuffix('Bilan', 'Bilan final apres outils.')
    ).toBe(' final apres outils.');

    expect(
      __testables.getMissingChatGptVisibleTurnSuffix(
        'Bilan final apres outils.',
        'Bilan final apres outils.'
      )
    ).toBeNull();
  });

  it('builds provider turn state from ChatGPT native response metadata', async () => {
    const { __testables } = await loadStreamingChat();

    expect(
      __testables.buildChatGptProviderTurnState('resp_123', [{ type: 'function_call' }])
    ).toEqual({
      provider: 'chatgpt',
      response_id: 'resp_123',
      output_items: [{ type: 'function_call' }],
    });

    expect(__testables.buildChatGptProviderTurnState(undefined, [])).toBeUndefined();
  });

  it('builds canonical function_call_output items for the stateless transcript', async () => {
    const { __testables } = await loadStreamingChat();

    expect(
      __testables.buildFunctionCallOutputProviderInputItem(
        'call_123',
        'FILE: README.md\nSOURCE: WORKSPACE_FILE\n\nMacro'
      )
    ).toEqual({
      type: 'function_call_output',
      call_id: 'call_123',
      output: 'FILE: README.md\nSOURCE: WORKSPACE_FILE\n\nMacro',
    });
  });

  it('extracts visible assistant text from provider transcript items when output_text is absent', async () => {
    const { __testables } = await loadStreamingChat();

    expect(
      __testables.extractVisibleTextFromProviderInputItems([
        {
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: { value: 'Bilan final apres outils.' },
            },
          ],
        },
      ])
    ).toBe('Bilan final apres outils.');
  });

  it('flags empty terminal ChatGPT turns only when no tool call remains', async () => {
    const { __testables } = await loadStreamingChat();
    expect(__testables.isEmptyTerminalChatGptTurn('', [])).toBe(true);
    expect(__testables.isEmptyTerminalChatGptTurn('<think>Resume</think>', [])).toBe(false);
    expect(
      __testables.isEmptyTerminalChatGptTurn('', [
        {
          id: 'call_1',
          type: 'function',
          function: {
            name: 'read',
            arguments: '{"path":"README.md"}',
          },
        },
      ])
    ).toBe(false);
  });

  it('detects when an architect post-tool turn still lacks visible text', async () => {
    const { __testables } = await loadStreamingChat();

    expect(__testables.hasMeaningfulVisibleAssistantText('<think>Analyse</think>')).toBe(false);
    expect(
      __testables.shouldRetryArchitectPostToolResponse({
        mode: 'Architect',
        usedToolNames: new Set(['plan_list']),
        visibleContent: '<think>Analyse</think>',
        retryCount: 0,
      })
    ).toBe(true);
    expect(
      __testables.shouldRetryArchitectPostToolResponse({
        mode: 'Architect',
        usedToolNames: new Set(['plan_list']),
        visibleContent: 'Bilan final.',
        retryCount: 0,
      })
    ).toBe(false);
  });

  it('summarizes provider item text presence for architect diagnostics', async () => {
    const { __testables } = await loadStreamingChat();

    expect(
      __testables.summarizeProviderTextPresence([
        {
          type: 'message',
          content: [
            {
              type: 'text',
              text: { value: 'Bilan final.' },
            },
          ],
        },
        {
          type: 'output_text',
          text: 'Bilan final.',
        },
      ])
    ).toEqual({
      hasMessageItem: true,
      hasOutputTextItem: true,
      hasTextContentPart: true,
    });
  });

  it('compacts large file tool outputs before ChatGPT follow-up turns', async () => {
    const { __testables } = await loadStreamingChat();
    const largeFileResult =
      'FILE: macro/README.md\nSOURCE: WORKSPACE_FILE\n\n' + 'A'.repeat(7000) + '\n' + 'B'.repeat(2000);

    const compacted = __testables.compactToolResultForChatGptModelContext(
      'read',
      largeFileResult,
      1200
    );

    expect(compacted).toContain('FILE: macro/README.md');
    expect(compacted).toContain('Tool=read');
    expect(compacted).toContain('truncated for model context');
    expect(compacted.length).toBeLessThanOrEqual(1300);
  });

  it('keeps tool traces in insertion order even when tool ids sort differently', async () => {
    const { __testables } = await loadStreamingChat();
    const updates: Array<Array<{ tool_call_id: string }>> = [];
    const accumulator = __testables.createStreamAccumulator({
      onToken: () => undefined,
      onToolTracesUpdate: (toolTraces: Array<{ tool_call_id: string }>) => {
        updates.push(toolTraces);
      },
    });

    accumulator.upsertRunningToolTrace('call_z', 'read', 'README.md');
    accumulator.upsertRunningToolTrace('call_a', 'grep', 'src');

    expect(updates.at(-1)?.map((trace: { tool_call_id: string }) => trace.tool_call_id)).toEqual(['call_z', 'call_a']);
    expect(accumulator.buildResult().toolTraces.map((trace: { tool_call_id: string }) => trace.tool_call_id)).toEqual([
      'call_z',
      'call_a',
    ]);
  });

  it('publishes live context snapshots for tokens, tool traces, hidden context, and provider context', async () => {
    const { __testables } = await loadStreamingChat();
    const snapshots: LiveStreamContextSnapshot[] = [];
    const accumulator = __testables.createStreamAccumulator({
      onToken: () => undefined,
      onToolTracesUpdate: () => undefined,
      onLiveContextUpdate: (snapshot: LiveStreamContextSnapshot) => {
        snapshots.push(snapshot);
      },
    });

    accumulator.appendProviderDelta('Response');
    expect(snapshots.at(-1)).toEqual(
      expect.objectContaining({
        version: 1,
        visibleContent: 'Response',
        visibleContentLength: 'Response'.length,
      }),
    );

    accumulator.beginToolTrace('call_1', 'read', 'README.md');
    expect(snapshots.at(-1)?.toolTraces).toEqual([
      expect.objectContaining({
        tool_call_id: 'call_1',
        tool_name: 'read',
        status: 'running',
      }),
    ]);

    accumulator.addHiddenToolContext('call_1', 'read', 'README.md', 'FILE: README.md\nsecret');
    expect(snapshots.at(-1)?.hiddenContext).toContain('FILE: README.md');

    const providerInputItems = [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Response' }],
      },
    ];
    const providerTurnState = {
      provider: 'chatgpt' as const,
      response_id: 'resp_1',
      output_items: providerInputItems,
    };
    accumulator.setProviderContext({ providerInputItems, providerTurnState });

    expect(snapshots.at(-1)).toEqual(
      expect.objectContaining({
        version: 4,
        providerInputItems,
        providerTurnState,
      }),
    );
    expect(snapshots.map((snapshot) => snapshot.version)).toEqual([1, 2, 3, 4]);
  });

  it('counts native live-only tool output in snapshots without persisting duplicate hidden context', async () => {
    const { __testables } = await loadStreamingChat();
    const snapshots: LiveStreamContextSnapshot[] = [];
    const accumulator = __testables.createStreamAccumulator({
      onToken: () => undefined,
      onToolTracesUpdate: () => undefined,
      onLiveContextUpdate: (snapshot: LiveStreamContextSnapshot) => {
        snapshots.push(snapshot);
      },
    });

    accumulator.addLiveOnlyHiddenToolContext('call_native', 'read', 'src/App.tsx', 'A'.repeat(500));

    expect(snapshots.at(-1)?.hiddenContext).toContain('call_native');
    expect(snapshots.at(-1)?.hiddenContext).toContain('src/App.tsx');
    expect(accumulator.getFinalHiddenContext()).toBeUndefined();
    expect(accumulator.buildResult().hiddenContext).toBeUndefined();
  });

  it('marks individual sequential tools done before the next tool starts', async () => {
    const { __testables } = await loadStreamingChat();
    const updates: Array<Array<{ tool_call_id: string; status: string }>> = [];
    const accumulator = __testables.createStreamAccumulator({
      onToken: () => undefined,
      onToolTracesUpdate: (toolTraces: Array<{ tool_call_id: string; status: string }>) => {
        updates.push(toolTraces);
      },
    });

    accumulator.beginToolTrace('call_1', 'read', 'README.md', {
      execution_mode: 'sequential',
      batch_id: 'batch_1',
      order: 0,
    });
    accumulator.completeToolTrace('call_1');
    accumulator.beginToolTrace('call_2', 'grep', 'src', {
      execution_mode: 'sequential',
      batch_id: 'batch_1',
      order: 1,
    });

    expect(
      updates.at(-1)?.map((trace) => ({
        tool_call_id: trace.tool_call_id,
        status: trace.status,
      }))
    ).toEqual([
      { tool_call_id: 'call_1', status: 'done' },
      { tool_call_id: 'call_2', status: 'running' },
    ]);
  });

  it('does not mark running tools done when provider text continues streaming', async () => {
    const { __testables } = await loadStreamingChat();
    const updates: Array<Array<{ tool_call_id: string; status: string }>> = [];
    const accumulator = __testables.createStreamAccumulator({
      onToken: () => undefined,
      onToolTracesUpdate: (toolTraces: Array<{ tool_call_id: string; status: string }>) => {
        updates.push(toolTraces);
      },
    });

    accumulator.beginToolTrace('call_1', 'read', 'README.md');
    accumulator.appendProviderDelta('Assistant text after tool request.');

    expect(
      updates.at(-1)?.map((trace) => ({
        tool_call_id: trace.tool_call_id,
        status: trace.status,
      }))
    ).toEqual([{ tool_call_id: 'call_1', status: 'running' }]);
  });

  it('does not let stale provider traces downgrade local done traces to running', async () => {
    const { __testables } = await loadStreamingChat();
    const accumulator = __testables.createStreamAccumulator({
      onToken: () => undefined,
      onToolTracesUpdate: () => undefined,
    });

    accumulator.beginToolTrace('call_1', 'read', 'README.md');
    accumulator.completeToolTrace('call_1');
    accumulator.upsertToolTraceFromProvider({
      tool_call_id: 'call_1',
      tool_name: 'read',
      detail: 'README.md',
      status: 'running',
    });

    expect(accumulator.buildResult().toolTraces).toEqual([
      expect.objectContaining({
        tool_call_id: 'call_1',
        status: 'done',
      }),
    ]);
  });

  it('maps reasoning request parameters by provider type', async () => {
    const { __testables } = await loadStreamingChat();

    const openAiBody: Record<string, unknown> = {};
    __testables.applyReasoningToChatCompletionsRequest(
      openAiBody,
      __testables.resolveChatCompletionProviderCapabilities({
        providerType: 'openai',
        modelId: 'gpt-5',
      }),
      'medium'
    );
    expect(openAiBody.reasoning_effort).toBe('medium');

    const openRouterBody: Record<string, unknown> = {};
    __testables.applyReasoningToChatCompletionsRequest(
      openRouterBody,
      __testables.resolveChatCompletionProviderCapabilities({
        providerType: 'openrouter',
        modelId: 'openai/gpt-5',
      }),
      'high'
    );
    expect(openRouterBody.reasoning).toEqual({ effort: 'high' });
    expect(openRouterBody.include_reasoning).toBe(true);

    const capabilityDrivenBody: Record<string, unknown> = {};
    __testables.applyReasoningToChatCompletionsRequest(
      capabilityDrivenBody,
      __testables.resolveChatCompletionProviderCapabilities({
        providerType: 'openai',
        modelId: 'custom-deepseek-compatible-model',
        reasoningTransportMode: 'deepseek_thinking',
      }),
      'provider-custom-level'
    );
    expect(capabilityDrivenBody).toEqual({
      thinking: { type: 'enabled' },
      reasoning_effort: 'provider-custom-level',
    });
  });

  it('uses Kimi preserved-thinking parameters without OpenAI reasoning_effort', async () => {
    const { __testables } = await loadStreamingChat();
    const kimiBody: Record<string, unknown> = {};
    const kimiProfile = __testables.resolveChatCompletionProviderCapabilities({
      providerType: 'openai',
      providerId: 'opencode-go',
      baseUrl: 'https://opencode.ai/zen/go/v1',
      modelId: 'kimi-k2.6',
    });

    __testables.applyReasoningToChatCompletionsRequest(
      kimiBody,
      kimiProfile,
      'high'
    );

    expect(kimiBody.thinking).toEqual({ type: 'enabled', keep: 'all' });
    expect(kimiBody.reasoning_effort).toBeUndefined();
    expect(kimiBody.reasoning).toBeUndefined();
    expect(__testables.shouldRequestProviderReasoning(kimiProfile, null)).toBe(true);

    __testables.applyReasoningToChatCompletionsRequest(kimiBody, kimiProfile, 'high', {
      enabled: false,
    });
    expect(kimiBody.thinking).toBeUndefined();
    expect(__testables.shouldRequestProviderReasoning(kimiProfile, 'high', {
      enabled: false,
    })).toBe(false);
  });

  it('distinguishes unsupported reasoning parameters from rejected effort values', async () => {
    const { __testables } = await loadStreamingChat();
    expect(__testables.isReasoningUnsupportedError('Unknown parameter: reasoning_effort')).toBe(true);
    expect(__testables.isReasoningUnsupportedError('Unsupported value for reasoning')).toBe(true);
    expect(__testables.isReasoningUnsupportedError('Unknown parameter: thinking')).toBe(true);
    expect(__testables.isReasoningUnsupportedError('Request failed: 500')).toBe(false);
    expect(__testables.classifyReasoningRejection('Unknown parameter: reasoning_effort')).toBe(
      'parameter'
    );
    expect(
      __testables.classifyReasoningRejection(
        "Invalid value 'xhigh' for reasoning_effort. Supported values are low, medium, high."
      )
    ).toBe('value');
    expect(__testables.classifyReasoningRejection('reasoning_effort')).toBeNull();
  });

  it('retries a rejected reasoning value without disabling the whole parameter', async () => {
    const encoder = new TextEncoder();
    const requestBodies: Array<Record<string, unknown>> = [];
    const fetchMock = mock(async (_url: string, init?: { body?: string }) => {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
      requestBodies.push(body);
      if (requestBodies.length === 1) {
        return {
          ok: false,
          status: 400,
          headers: new Headers(),
          text: async () =>
            JSON.stringify({
              error: {
                message:
                  "Invalid value 'xhigh' for reasoning_effort. Supported values are low, medium, high.",
              },
            }),
        };
      }
      return {
        ok: true,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Done."}}]}\n\n'));
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          },
        }),
      };
    });
    const { streamChat } = await loadStreamingChat(fetchMock);

    await streamChat({
      providerId: 'openai-provider',
      providerType: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'test-key',
      modelId: 'gpt-future',
      reasoningEffort: 'xhigh',
      messages: [{ role: 'user', content: 'Hello' }],
      enableWebSearch: false,
      enableWebFetch: false,
      onToken: () => undefined,
      onComplete: () => undefined,
      onError: (error: Error) => {
        throw error;
      },
    });

    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[0]?.reasoning_effort).toBe('xhigh');
    expect(requestBodies[1]?.reasoning_effort).toBeUndefined();
  });

  it('retries an unsupported reasoning parameter once without control fields', async () => {
    const encoder = new TextEncoder();
    const requestBodies: Array<Record<string, unknown>> = [];
    const fetchMock = mock(async (_url: string, init?: { body?: string }) => {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
      requestBodies.push(body);
      if (requestBodies.length === 1) {
        return {
          ok: false,
          status: 400,
          headers: new Headers(),
          text: async () =>
            JSON.stringify({ error: { message: 'Unknown parameter: reasoning_effort' } }),
        };
      }
      return {
        ok: true,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Done."}}]}\n\n'));
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          },
        }),
      };
    });
    const { streamChat } = await loadStreamingChat(fetchMock);

    await streamChat({
      providerId: 'openai-provider',
      providerType: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'test-key',
      modelId: 'gpt-future',
      reasoningEffort: 'max',
      messages: [{ role: 'user', content: 'Hello' }],
      enableWebSearch: false,
      enableWebFetch: false,
      onToken: () => undefined,
      onComplete: () => undefined,
      onError: (error: Error) => {
        throw error;
      },
    });

    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[0]?.reasoning_effort).toBe('max');
    expect(requestBodies[1]?.reasoning_effort).toBeUndefined();
  });

  it('serializes provider reasoning metadata without replaying visible think blocks as content', async () => {
    const { __testables } = await loadStreamingChat();
    const reasoningDetails = [{ type: 'reasoning.trace', payload: 'opaque-provider-data' }];
    const providerItem = __testables.buildAssistantChatCompletionProviderItem({
      visibleContent: '<think>native thoughts</think>\nFinal answer',
      apiContent: 'Final answer',
      reasoningContent: 'native thoughts',
      reasoningDetails,
      toolCalls: [
        {
          id: 'call_read',
          type: 'function' as const,
          function: { name: 'read', arguments: '{"path":"README.md"}' },
        },
      ],
    });

    const messages = __testables.buildChatCompletionMessages(
      [
        {
          role: 'assistant',
          content: '<think>legacy thoughts</think>\nFinal answer',
          provider_input_items: providerItem ? [providerItem] : undefined,
        },
      ],
      __testables.resolveChatCompletionProviderCapabilities({
        providerType: 'openrouter',
        modelId: 'deepseek/deepseek-v4-pro',
      })
    );

    expect(messages[0]).toEqual(
      expect.objectContaining({
        role: 'assistant',
        content: 'Final answer',
        reasoning_details: reasoningDetails,
        tool_calls: [
          expect.objectContaining({
            id: 'call_read',
            function: { name: 'read', arguments: '{"path":"README.md"}' },
          }),
        ],
      })
    );
    expect(messages[0]?.reasoning_content).toBeUndefined();
    expect(messages[1]).toEqual({
      role: 'tool',
      content: 'Tool execution aborted',
      tool_call_id: 'call_read',
    });
    expect(JSON.stringify(messages)).not.toContain('<think>');
  });

  it('normalizes tool call ids only for providers that need it', async () => {
    const { __testables } = await loadStreamingChat();
    const messages = [
      {
        role: 'assistant' as const,
        content: '',
        tool_calls: [
          {
            id: 'call:abc.123',
            type: 'function' as const,
            function: { name: 'read', arguments: '{"path":"README.md"}' },
          },
        ],
      },
      {
        role: 'tool' as const,
        content: 'FILE: README.md',
        tool_call_id: 'call:abc.123',
      },
    ];

    const claudeMessages = __testables.buildChatCompletionMessages(
      messages,
      __testables.resolveChatCompletionProviderCapabilities({
        providerType: 'openrouter',
        modelId: 'anthropic/claude-3.7-sonnet',
      })
    );
    expect(claudeMessages[0]?.tool_calls?.[0]?.id).toBe('call_abc_123');
    expect(claudeMessages[1]?.tool_call_id).toBe('call_abc_123');

    const mistralMessages = __testables.buildChatCompletionMessages(
      messages,
      __testables.resolveChatCompletionProviderCapabilities({
        providerType: 'openrouter',
        modelId: 'mistral/devstral-small',
      })
    );
    expect(mistralMessages[0]?.tool_calls?.[0]?.id).toBe('callabc12');
    expect(mistralMessages[1]?.tool_call_id).toBe('callabc12');

    const defaultMessages = __testables.buildChatCompletionMessages(
      messages,
      __testables.resolveChatCompletionProviderCapabilities({
        providerType: 'openai',
        modelId: 'gpt-4.1',
      })
    );
    expect(defaultMessages[0]?.tool_calls?.[0]?.id).toBe('call:abc.123');
    expect(defaultMessages[1]?.tool_call_id).toBe('call:abc.123');
  });

  it('repairs dangling tool calls and Mistral tool-user ordering only in API payloads', async () => {
    const { __testables } = await loadStreamingChat();
    const capabilities = __testables.resolveChatCompletionProviderCapabilities({
      providerType: 'openrouter',
      modelId: 'mistral/devstral-small',
    });

    const messages = __testables.buildChatCompletionMessages(
      [
        { role: 'user', content: 'Inspect README.' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call:abc.123',
              type: 'function' as const,
              function: { name: 'read', arguments: '{"path":"README.md"}' },
            },
          ],
        },
        { role: 'user', content: 'Continue.' },
      ],
      capabilities
    );

    expect(messages).toEqual([
      { role: 'user', content: 'Inspect README.' },
      expect.objectContaining({
        role: 'assistant',
        tool_calls: [
          expect.objectContaining({
            id: 'callabc12',
          }),
        ],
      }),
      {
        role: 'tool',
        content: 'Tool execution aborted',
        tool_call_id: 'callabc12',
      },
      {
        role: 'assistant',
        content: 'Done.',
      },
      { role: 'user', content: 'Continue.' },
    ]);
  });

  it('converts orphan tool messages into assistant context before provider send', async () => {
    const { __testables } = await loadStreamingChat();
    const messages = __testables.buildChatCompletionMessages(
      [
        { role: 'assistant', content: 'Compacted historical tool result.' },
        {
          role: 'tool',
          content: 'FILE: README.md\n\n# Macro',
          tool_call_id: 'call_read',
        },
        { role: 'user', content: 'Continue.' },
      ],
      __testables.resolveChatCompletionProviderCapabilities({
        providerType: 'openai',
        providerId: 'opencode-go',
        baseUrl: 'https://opencode.ai/zen/go/v1',
        modelId: 'deepseek-v4-flash',
      })
    );

    expect(messages).toEqual([
      { role: 'assistant', content: 'Compacted historical tool result.' },
      {
        role: 'assistant',
        content: expect.stringContaining('Historical tool result preserved as context'),
      },
      { role: 'user', content: 'Continue.' },
    ]);
    expect(messages.some((message: Record<string, unknown>) => message.role === 'tool')).toBe(false);
  });

  it('keeps valid parallel tool responses and converts only orphan tool results', async () => {
    const { __testables } = await loadStreamingChat();
    const messages = __testables.buildChatCompletionMessages(
      [
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_read',
              type: 'function' as const,
              function: { name: 'read', arguments: '{"path":"README.md"}' },
            },
            {
              id: 'call_glob',
              type: 'function' as const,
              function: { name: 'glob', arguments: '{"pattern":"*.ts"}' },
            },
          ],
        },
        {
          role: 'tool',
          content: 'FILE: README.md',
          tool_call_id: 'call_read',
        },
        {
          role: 'tool',
          content: 'orphan terminal output',
          tool_call_id: 'call_terminal',
        },
        {
          role: 'tool',
          content: 'MATCHES: src/index.ts',
          tool_call_id: 'call_glob',
        },
      ],
      __testables.resolveChatCompletionProviderCapabilities({
        providerType: 'openai',
        modelId: 'gpt-4.1',
      })
    );

    expect(messages).toEqual([
      expect.objectContaining({ role: 'assistant' }),
      { role: 'tool', content: 'FILE: README.md', tool_call_id: 'call_read' },
      {
        role: 'tool',
        content: 'MATCHES: src/index.ts',
        tool_call_id: 'call_glob',
      },
      {
        role: 'assistant',
        content: expect.stringContaining('orphan terminal output'),
      },
    ]);
  });

  it('injects a hidden noop tool only for LiteLLM proxy payload compatibility', async () => {
    const { __testables } = await loadStreamingChat();
    const toolHistoryMessages = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_read',
            type: 'function',
            function: { name: 'read', arguments: '{"path":"README.md"}' },
          },
        ],
      },
      {
        role: 'tool',
        content: 'FILE: README.md',
        tool_call_id: 'call_read',
      },
    ];
    const liteLlmCapabilities = __testables.resolveChatCompletionProviderCapabilities({
      providerType: 'openai',
      providerId: 'team-litellm-proxy',
      baseUrl: 'https://llm.example.com/litellm/v1',
      modelId: 'openai/gpt-4.1',
    });
    const liteLlmBody: Record<string, unknown> = {};

    __testables.applyToolsToChatCompletionsRequest(
      liteLlmBody,
      [],
      liteLlmCapabilities,
      toolHistoryMessages
    );

    expect((liteLlmBody.tools as Array<{ function?: { name?: string } }>)[0]?.function?.name).toBe(
      '_noop'
    );
    expect(liteLlmBody.tool_choice).toBe('auto');

    const defaultCapabilities = __testables.resolveChatCompletionProviderCapabilities({
      providerType: 'openai',
      modelId: 'gpt-4.1',
    });
    const defaultBody: Record<string, unknown> = {};
    __testables.applyToolsToChatCompletionsRequest(
      defaultBody,
      [],
      defaultCapabilities,
      toolHistoryMessages
    );
    expect(defaultBody.tools).toBeUndefined();
  });

  it('includes enabled MCP tools in provider tool definitions', async () => {
    const { __testables } = await loadStreamingChat();

    const tools = __testables.collectAllowedTools({
      allowedTools: new Set(['mcp__github__list_issues']),
      enableWebSearch: false,
      enableWebFetch: false,
      mcpTools: [
        {
          id: 'mcp__github__list_issues',
          serverId: 'github',
          name: 'list_issues',
          description: 'List GitHub issues',
          inputSchema: {
            type: 'object',
            properties: { state: { type: 'string' } },
          },
        },
      ],
    }) as Array<{ function?: { name?: string; parameters?: unknown } }>;

    expect(tools).toHaveLength(1);
    expect(tools[0]?.function?.name).toBe('mcp__github__list_issues');
    expect(tools[0]?.function?.parameters).toEqual({
      type: 'object',
      properties: { state: { type: 'string' } },
    });
  });

  it('serializes Kimi reasoning_content and tool names for OpenCode Go Kimi only', async () => {
    const { __testables } = await loadStreamingChat();
    const assistantItem = __testables.buildAssistantChatCompletionProviderItem({
      visibleContent: '<think>Need context.</think>',
      apiContent: '',
      reasoningContent: 'Need context.',
      reasoningDetails: [],
      toolCalls: [
        {
          id: 'call_read',
          type: 'function' as const,
          function: { name: 'read', arguments: '{"path":"README.md"}' },
        },
      ],
    });
    const toolItem = __testables.buildToolChatCompletionProviderItem(
      'call_read',
      'FILE: README.md\n\n# Macro',
      'read'
    );

    const kimiMessages = __testables.buildChatCompletionMessages(
      [
        {
          role: 'assistant',
          content: '',
          provider_input_items: assistantItem ? [assistantItem] : undefined,
        },
        {
          role: 'tool',
          content: 'FILE: README.md\n\n# Macro',
          provider_input_items: [toolItem],
        },
      ],
      __testables.resolveChatCompletionProviderCapabilities({
        providerType: 'openai',
        providerId: 'opencode-go',
        baseUrl: 'https://opencode.ai/zen/go/v1',
        modelId: 'kimi-k2.6',
      })
    );

    expect(kimiMessages[0]).toEqual(
      expect.objectContaining({
        role: 'assistant',
        content: '',
        reasoning_content: 'Need context.',
      })
    );
    expect(kimiMessages[1]).toEqual({
      role: 'tool',
      content: 'FILE: README.md\n\n# Macro',
      tool_call_id: 'call_read',
      name: 'read',
    });

    const glmMessages = __testables.buildChatCompletionMessages(
      [
        {
          role: 'assistant',
          content: '',
          provider_input_items: assistantItem ? [assistantItem] : undefined,
        },
        {
          role: 'tool',
          content: 'FILE: README.md\n\n# Macro',
          provider_input_items: [toolItem],
        },
      ],
      __testables.resolveChatCompletionProviderCapabilities({
        providerType: 'openai',
        providerId: 'opencode-go',
        baseUrl: 'https://opencode.ai/zen/go/v1',
        modelId: 'glm-5',
      })
    );

    expect(glmMessages[0]?.reasoning_content).toBeUndefined();
    expect(glmMessages[1]).not.toHaveProperty('name');
  });

  it('compacts provider_input_items before final Chat Completions serialization', async () => {
    const { __testables } = await loadStreamingChat();
    const hugeReasoning = `Need context.\n${'provider trace payload\n'.repeat(1200)}`;
    const assistantProviderItem = __testables.buildAssistantChatCompletionProviderItem({
      visibleContent: 'I inspected the runtime trace.',
      apiContent: 'I inspected the runtime trace.',
      reasoningContent: hugeReasoning,
      reasoningDetails: [{ trace: hugeReasoning }],
      toolCalls: [
        {
          id: 'call_read',
          type: 'function' as const,
          function: { name: 'read', arguments: '{"path":"src/runtime.ts"}' },
        },
      ],
    });
    const orderedMessages: ChatMessage[] = [
      {
        id: 'u1',
        task_id: 'task-1',
        conversation_id: 'conv-1',
        role: 'user',
        content: 'Inspect the runtime.',
        timestamp: '2026-04-05T00:00:00.000Z',
      },
      {
        id: 'a1',
        task_id: 'task-1',
        conversation_id: 'conv-1',
        role: 'assistant',
        content: 'Older answer.',
        timestamp: '2026-04-05T00:00:01.000Z',
      },
      {
        id: 'u2',
        task_id: 'task-1',
        conversation_id: 'conv-1',
        role: 'user',
        content: 'Inspect the latest trace.',
        timestamp: '2026-04-05T00:00:02.000Z',
      },
      {
        id: 'a2',
        task_id: 'task-1',
        conversation_id: 'conv-1',
        role: 'assistant',
        content: 'I inspected the runtime trace.',
        timestamp: '2026-04-05T00:00:03.000Z',
      },
      {
        id: 'u3',
        task_id: 'task-1',
        conversation_id: 'conv-1',
        role: 'user',
        content: 'Now answer.',
        timestamp: '2026-04-05T00:00:04.000Z',
      },
    ];
    const preparedMessages = orderedMessages.map((message) => ({
      role: message.role,
      content: message.content,
      ...(message.id === 'a2' && assistantProviderItem
        ? { provider_input_items: [assistantProviderItem] }
        : {}),
    }));
    const profile = __testables.resolveChatCompletionProviderCapabilities({
      providerType: 'openai',
      providerId: 'opencode-go',
      baseUrl: 'https://opencode.ai/zen/go/v1',
      modelId: 'kimi-k2.6',
    });
    const rawPayload = __testables.buildChatCompletionMessages(
      preparedMessages,
      profile,
    );

    const compacted = await buildCompactedMessagesForRequest({
      systemMessage: 'You are Macro.',
      preparedMessages,
      orderedMessages,
      citations: [],
      toolDefinitions: [],
      modelContextWindowTokens: 8000,
      mode: 'overflow_recovery',
      forceCompaction: true,
      forcePrune: true,
      generateSummary: async () => 'Current objective: answer from the runtime trace.',
    });
    const compactedPayload = __testables.buildChatCompletionMessages(
      compacted.messages,
      profile,
    );

    expect(JSON.stringify(rawPayload)).toContain('provider trace payload');
    expect(JSON.stringify(compactedPayload)).not.toContain('provider trace payload');
    expect(JSON.stringify(compactedPayload).length).toBeLessThan(
      JSON.stringify(rawPayload).length,
    );
  });

  it('coalesces every system instruction at the beginning for strict compatible servers', async () => {
    const { __testables } = await loadStreamingChat();
    const profile = __testables.resolveChatCompletionProviderCapabilities({
      providerType: 'openai',
      providerId: 'andrologic',
      baseUrl: 'https://example.invalid/v1',
      modelId: 'qwen3.5',
    });
    const payload = __testables.buildChatCompletionMessages(
      [
        { role: 'system', content: 'Base instruction.' },
        { role: 'user', content: 'Run the tool.' },
        { role: 'assistant', content: 'Working.' },
        { role: 'system', content: 'Retry after a tool error.' },
      ],
      profile,
    );

    expect(payload).toEqual([
      {
        role: 'system',
        content: 'Base instruction.\n\nRetry after a tool error.',
      },
      { role: 'user', content: 'Run the tool.' },
      { role: 'assistant', content: 'Working.' },
    ]);
    expect(() => __testables.validateChatCompletionMessageSequence(payload)).not.toThrow();
  });

  it('rejects a non-leading system message before the provider request', async () => {
    const { __testables } = await loadStreamingChat();

    expect(() =>
      __testables.validateChatCompletionMessageSequence([
        { role: 'user', content: 'Hello' },
        { role: 'system', content: 'Too late' },
      ]),
    ).toThrow('system message at index 1 is not leading');
  });

  it('replays DeepSeek reasoning_content only when the history has tool calls', async () => {
    const { __testables } = await loadStreamingChat();
    const providerItem = __testables.buildAssistantChatCompletionProviderItem({
      visibleContent: '<think>Need context.</think>',
      apiContent: '',
      reasoningContent: 'Need context.',
      reasoningDetails: [],
      toolCalls: [],
    });
    const capabilities = __testables.resolveChatCompletionProviderCapabilities({
      providerType: 'deepseek',
      modelId: 'deepseek-v4-pro',
    });

    const plainMessages = __testables.buildChatCompletionMessages(
      [
        {
          role: 'assistant',
          content: '',
          provider_input_items: providerItem ? [providerItem] : undefined,
        },
      ],
      capabilities
    );
    expect(plainMessages[0]?.reasoning_content).toBeUndefined();

    const toolMessages = __testables.buildChatCompletionMessages(
      [
        {
          role: 'assistant',
          content: '',
          provider_input_items: providerItem ? [providerItem] : undefined,
        },
        { role: 'tool', content: 'FILE: README.md', tool_call_id: 'call_read' },
      ],
      capabilities
    );
    expect(toolMessages[0]?.reasoning_content).toBe('Need context.');
  });

  it('sends OpenCode Go Kimi preserved-thinking payloads across tool calls', async () => {
    const encoder = new TextEncoder();
    const requestBodies: Array<Record<string, unknown>> = [];
    let requestCount = 0;
    const fetchMock = mock(async (_url: string, init?: { body?: string }): Promise<unknown> => {
      requestCount += 1;
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
      requestBodies.push(body);

      if (requestCount === 1) {
        expect(body.thinking).toEqual({ type: 'enabled', keep: 'all' });
        expect(body.reasoning_effort).toBeUndefined();
        return {
          ok: true,
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  'data: {"choices":[{"delta":{"reasoning_content":"Need file context.","tool_calls":[{"index":0,"id":"call_read","type":"function","function":{"name":"read","arguments":"{\\"path\\":\\"README.md\\"}"}}]}}]}\n\n'
                )
              );
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              controller.close();
            },
          }),
          text: async () => '',
          json: async () => ({}),
        };
      }

      const assistantMessage = (body.messages as Array<Record<string, unknown>>).find(
        (message) => message.role === 'assistant'
      );
      const toolMessage = (body.messages as Array<Record<string, unknown>>).find(
        (message) => message.role === 'tool'
      );
      expect(body.thinking).toEqual({ type: 'enabled', keep: 'all' });
      expect(body.reasoning_effort).toBeUndefined();
      expect(assistantMessage).toEqual(
        expect.objectContaining({
          content: '',
          reasoning_content: 'Need file context.',
        })
      );
      expect(toolMessage).toEqual(
        expect.objectContaining({
          tool_call_id: 'call_read',
          name: 'read',
        })
      );

      return {
        ok: true,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode('data: {"choices":[{"delta":{"content":"Done."}}]}\n\n')
            );
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          },
        }),
        text: async () => '',
        json: async () => ({}),
      };
    });
    const invokeImpl = mock(async () => {
      throw new Error('Kimi preserved-thinking profiles must use the generic HTTP path.');
    });
    const { streamChat } = await loadStreamingChat(fetchMock, {
      forceTauriAvailable: true,
      invokeImpl,
    });

    await streamChat({
      providerId: 'opencode-go',
      providerType: 'openai',
      baseUrl: 'https://opencode.ai/zen/go/v1',
      modelId: 'kimi-k2.6',
      reasoningEffort: 'high',
      messages: [{ role: 'user', content: 'Inspect README.' }],
      allowedToolIds: ['read'],
      enableWebSearch: false,
      enableWebFetch: false,
      onToken: () => undefined,
      onComplete: () => undefined,
      onError: (error: Error) => {
        throw error;
      },
      onToolCall: async () => 'FILE: README.md\n\n# Macro',
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(invokeImpl).not.toHaveBeenCalled();
    expect(requestBodies).toHaveLength(2);
  });

  it('allows compaction before generic provider follow-up requests after tool results', async () => {
    const encoder = new TextEncoder();
    const requestBodies: Array<{ messages?: Array<Record<string, unknown>> }> = [];
    let requestCount = 0;
    const fetchMock = mock(async (_url: string, init?: { body?: string }) => {
      requestCount += 1;
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
      requestBodies.push(body);

      if (requestCount === 1) {
        return {
          ok: true,
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_read","type":"function","function":{"name":"read","arguments":"{\\"path\\":\\"README.md\\"}"}}]}}]}\n\n'
                )
              );
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              controller.close();
            },
          }),
          text: async () => '',
          json: async () => ({}),
        };
      }

      expect(JSON.stringify(body.messages)).toContain('[COMPACTED CONVERSATION STATE]');
      expect(JSON.stringify(body.messages)).not.toContain('FILE: README.md');
      return {
        ok: true,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode('data: {"choices":[{"delta":{"content":"Done."}}]}\n\n')
            );
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          },
        }),
        text: async () => '',
        json: async () => ({}),
      };
    });
    const onBeforeFollowUpRequest = mock(
      async (request: StreamingFollowUpCompactionRequest) => {
        expect(request.reason).toBe('tool_results');
        expect(request.toolResultCount).toBe(1);
        expect(JSON.stringify(request.messages)).toContain('FILE: README.md');
        expect(JSON.stringify(request.messages)).not.toContain(
          'For file analysis tasks, use only the exact tool outputs',
        );
        return {
          messages: [
            {
              role: 'system' as const,
              content: '[COMPACTED CONVERSATION STATE]\nTool output summarized.',
            },
            {
              role: 'user' as const,
              content: 'Continue.',
            },
          ],
        };
      },
    );
    const { streamChat } = await loadStreamingChat(fetchMock);

    await streamChat({
      providerId: 'provider-1',
      providerType: 'openai',
      baseUrl: 'https://example.com',
      modelId: 'gpt-4.1',
      messages: [{ role: 'user', content: 'Inspect README.' }],
      allowedToolIds: ['read'],
      enableWebSearch: false,
      enableWebFetch: false,
      onToken: () => undefined,
      onComplete: () => undefined,
      onError: (error: Error) => {
        throw error;
      },
      onToolCall: async () => 'FILE: README.md\n\n' + 'A'.repeat(6000),
      onBeforeFollowUpRequest,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onBeforeFollowUpRequest).toHaveBeenCalledTimes(1);
    expect(requestBodies[1]?.messages).toEqual([
      {
        role: 'system',
        content: expect.stringContaining(
          'For file analysis tasks, use only the exact tool outputs',
        ),
      },
      { role: 'user', content: 'Continue.' },
    ]);
    expect(String(requestBodies[1]?.messages?.[0]?.content)).toContain(
      '[COMPACTED CONVERSATION STATE]\nTool output summarized.',
    );
  });

  it('returns invalid tool arguments to the model without sending a late system message', async () => {
    const encoder = new TextEncoder();
    const requestBodies: Array<{ messages: Array<Record<string, unknown>> }> = [];
    const fetchMock = mock(async (_url: string, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? '{}') as {
        messages: Array<Record<string, unknown>>;
      };
      requestBodies.push(body);

      if (requestBodies.length === 1) {
        return {
          ok: true,
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_edit","type":"function","function":{"name":"edit_source_passage","arguments":"{\\"action\\":\\"reclassify\\"}"}}]}}]}\n\n',
                ),
              );
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              controller.close();
            },
          }),
          text: async () => '',
          json: async () => ({}),
        };
      }

      return {
        ok: true,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode('data: {"choices":[{"delta":{"content":"I need a citation id."}}]}\n\n'),
            );
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          },
        }),
        text: async () => '',
        json: async () => ({}),
      };
    });
    const onToolCall = mock(async () => 'must not execute');
    const { streamChat } = await loadStreamingChat(fetchMock);

    await streamChat({
      providerId: 'andrologic',
      providerType: 'openai',
      baseUrl: 'https://example.invalid/v1',
      modelId: 'qwen3.5',
      messages: [
        { role: 'system', content: 'You are Macro.' },
        { role: 'user', content: 'Reclassify the source.' },
      ],
      allowedToolIds: ['edit_source_passage'],
      enableWebSearch: false,
      enableWebFetch: false,
      onToken: () => undefined,
      onComplete: () => undefined,
      onError: (error: Error) => {
        throw error;
      },
      onToolCall,
    });

    expect(onToolCall).not.toHaveBeenCalled();
    expect(requestBodies).toHaveLength(2);
    const followUpMessages = requestBodies[1]?.messages ?? [];
    expect(followUpMessages.filter((message) => message.role === 'system')).toHaveLength(1);
    expect(followUpMessages[0]?.role).toBe('system');
    expect(String(followUpMessages[0]?.content)).toContain(
      'One or more tool calls failed',
    );
    expect(followUpMessages.at(-1)).toEqual(
      expect.objectContaining({
        role: 'tool',
        content: expect.stringContaining('$.citation_id required value is missing'),
      }),
    );
  });

  it('does not apply the restricted Macro schema validator to MCP tools', async () => {
    const encoder = new TextEncoder();
    let requestCount = 0;
    const fetchMock = mock(async () => {
      requestCount += 1;
      const data =
        requestCount === 1
          ? '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_mcp","type":"function","function":{"name":"mcp__demo__count","arguments":"{\\"count\\":1}"}}]}}]}'
          : '{"choices":[{"delta":{"content":"Done."}}]}';
      return {
        ok: true,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(`data: ${data}\n\ndata: [DONE]\n\n`));
            controller.close();
          },
        }),
        text: async () => '',
        json: async () => ({}),
      };
    });
    const onToolCall = mock(
      async (_toolName: string, _args: Record<string, unknown>) => 'counted',
    );
    const { streamChat } = await loadStreamingChat(fetchMock);

    await streamChat({
      providerId: 'custom',
      providerType: 'openai',
      baseUrl: 'https://example.invalid/v1',
      modelId: 'model',
      messages: [{ role: 'user', content: 'Count.' }],
      allowedToolIds: ['mcp__demo__count'],
      mcpTools: [
        {
          id: 'mcp__demo__count',
          serverId: 'demo',
          name: 'count',
          description: 'Count an integer.',
          inputSchema: {
            type: 'object',
            properties: { count: { type: 'integer' } },
            required: ['count'],
          },
        },
      ],
      enableWebSearch: false,
      enableWebFetch: false,
      onToken: () => undefined,
      onComplete: () => undefined,
      onError: (error: Error) => {
        throw error;
      },
      onToolCall,
    });

    expect(onToolCall).toHaveBeenCalledTimes(1);
    expect(onToolCall.mock.calls[0]?.[1]).toEqual({ count: 1 });
  });

  it('marks a failed workspace-backed read_file result as an error', async () => {
    const encoder = new TextEncoder();
    const requestBodies: Array<{ messages: Array<Record<string, unknown>> }> = [];
    const fetchMock = mock(async (_url: string, init?: { body?: string }) => {
      requestBodies.push(JSON.parse(init?.body ?? '{}'));
      const data =
        requestBodies.length === 1
          ? '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_file","type":"function","function":{"name":"read_file","arguments":"{\\"file\\":\\"missing.txt\\"}"}}]}}]}'
          : '{"choices":[{"delta":{"content":"The read failed."}}]}';
      return {
        ok: true,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(`data: ${data}\n\ndata: [DONE]\n\n`));
            controller.close();
          },
        }),
        text: async () => '',
        json: async () => ({}),
      };
    });
    const { streamChat } = await loadStreamingChat(fetchMock);

    await streamChat({
      providerId: 'custom',
      providerType: 'openai',
      baseUrl: 'https://example.invalid/v1',
      modelId: 'model',
      messages: [{ role: 'user', content: 'Read the file.' }],
      allowedToolIds: ['read_file', 'read'],
      enableWebSearch: false,
      enableWebFetch: false,
      onToken: () => undefined,
      onComplete: () => undefined,
      onError: (error: Error) => {
        throw error;
      },
      onToolCall: async () => ({
        kind: 'result',
        result: 'File not found: missing.txt',
        isError: true,
        errorKind: 'execution',
      }),
    });

    const systemContent = requestBodies[1]?.messages
      .filter((message) => message.role === 'system')
      .map((message) => String(message.content))
      .join('\n');
    expect(systemContent).toContain('One or more tool calls failed');
    expect(requestBodies[1]?.messages.at(-1)).toEqual(
      expect.objectContaining({
        role: 'tool',
        content: expect.stringContaining('File not found: missing.txt'),
      }),
    );
  });

  it('validates non-streaming provider payloads before fetch', async () => {
    const fetchMock = mock(async () => {
      throw new Error('fetch must not run for an invalid payload');
    });
    const { sendChatNonStreaming } = await loadStreamingChat(fetchMock);

    await expect(
      sendChatNonStreaming({
        providerId: 'custom',
        providerType: 'openai',
        baseUrl: 'https://example.invalid/v1',
        modelId: 'model',
        messages: [
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'duplicate',
                type: 'function',
                function: { name: 'read', arguments: '{"path":"a"}' },
              },
              {
                id: 'duplicate',
                type: 'function',
                function: { name: 'read', arguments: '{"path":"b"}' },
              },
            ],
          },
          { role: 'tool', content: 'a', tool_call_id: 'duplicate' },
        ],
        onComplete: () => undefined,
        onError: () => undefined,
      }),
    ).rejects.toThrow('duplicate id duplicate');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('continues the active turn when a steering message arrives before completion', async () => {
    const encoder = new TextEncoder();
    const requestBodies: Array<{ messages?: Array<Record<string, unknown>> }> = [];
    const fetchMock = mock(async (_url: string, init?: { body?: string }) => {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
      requestBodies.push(body);
      const content = requestBodies.length === 1 ? 'Initial answer.' : 'Adjusted answer.';
      return {
        ok: true,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(`data: {"choices":[{"delta":{"content":"${content}"}}]}\n\n`),
            );
            controller.enqueue(
              encoder.encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'),
            );
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          },
        }),
        text: async () => '',
        json: async () => ({}),
      };
    });
    let pending = true;
    const { streamChat } = await loadStreamingChat(fetchMock);

    await streamChat({
      providerId: 'provider-1',
      providerType: 'openai',
      baseUrl: 'https://example.com',
      modelId: 'gpt-4.1',
      messages: [{ role: 'user', content: 'Start.' }],
      enableWebSearch: false,
      enableWebFetch: false,
      onToken: () => undefined,
      onComplete: () => undefined,
      onError: (error: Error) => { throw error; },
      consumePendingSteers: () => {
        if (!pending) return [];
        pending = false;
        return [{ role: 'user', content: 'Use the new direction.' }];
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestBodies[1]?.messages).toContainEqual({
      role: 'user',
      content: 'Use the new direction.',
    });
  });

  it('retries Kimi-compatible providers without thinking when the gateway rejects it', async () => {
    const encoder = new TextEncoder();
    const requestBodies: Array<Record<string, unknown>> = [];
    const fetchMock = mock(async (_url: string, init?: { body?: string }): Promise<unknown> => {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
      requestBodies.push(body);

      if (requestBodies.length === 1) {
        expect(body.thinking).toEqual({ type: 'enabled', keep: 'all' });
        return {
          ok: false,
          status: 400,
          headers: new Headers(),
          text: async () =>
            JSON.stringify({
              error: {
                message: 'Unknown parameter: thinking',
              },
            }),
          json: async () => ({}),
        };
      }

      expect(body.thinking).toBeUndefined();
      expect(body.reasoning_effort).toBeUndefined();
      return {
        ok: true,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode('data: {"choices":[{"delta":{"content":"Done."}}]}\n\n')
            );
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          },
        }),
        text: async () => '',
        json: async () => ({}),
      };
    });
    const { streamChat } = await loadStreamingChat(fetchMock);

    await streamChat({
      providerId: 'opencode-go',
      providerType: 'openai',
      baseUrl: 'https://opencode.ai/zen/go/v1',
      modelId: 'kimi-k2.6',
      messages: [{ role: 'user', content: 'Hello.' }],
      enableWebSearch: false,
      enableWebFetch: false,
      onToken: () => undefined,
      onComplete: () => undefined,
      onError: (error: Error) => {
        throw error;
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestBodies).toHaveLength(2);
  });

  it('classifies context overflow as non-retryable', async () => {
    const { __testables } = await loadStreamingChat();
    const statusError = __testables.classifyProviderError('Request failed: 413', 413);
    const codeError = __testables.classifyProviderError(
      'prompt too long context_length_exceeded',
      400
    );

    expect(statusError.kind).toBe('context_overflow');
    expect(statusError.retryable).toBe(false);
    expect(codeError.kind).toBe('context_overflow');
    expect(codeError.retryable).toBe(false);
    expect(__testables.isContextOverflowError('model_context_window_exceeded', 400)).toBe(true);
    expect(__testables.isContextOverflowError('400 (no body)', 400)).toBe(true);
    expect(
      __testables.isContextOverflowError(
        'input token count 120000 exceeds the maximum of 64000',
        400,
      ),
    ).toBe(true);
    expect(
      __testables.isContextOverflowError('input is too long for requested model', 400),
    ).toBe(true);
  });

  it('preserves provider error details for UI presentation', async () => {
    const { __testables } = await loadStreamingChat();
    const error = __testables.classifyProviderError(
      'Quota exceeded rate_limit_exceeded rate_limit',
      429,
      12000,
      {
        providerMessage: 'Quota exceeded',
        providerCode: 'rate_limit_exceeded',
        providerType: 'rate_limit',
        providerRawBodyExcerpt: '{"error":{"message":"Quota exceeded"}}',
      }
    );

    expect(error.name).toBe('ProviderRuntimeError');
    expect(error.providerError).toBe(true);
    expect(error.kind).toBe('rate_limited');
    expect(error.status).toBe(429);
    expect(error.retryAfterMs).toBe(12000);
    expect(error.providerMessage).toBe('Quota exceeded');
    expect(error.providerCode).toBe('rate_limit_exceeded');
    expect(error.providerType).toBe('rate_limit');
    expect(error.providerRawBodyExcerpt).toContain('Quota exceeded');
  });

  it('detects repeated identical tool calls before entering another tool loop', async () => {
    const { __testables } = await loadStreamingChat();
    const repeatedCall = {
      id: 'call_4',
      type: 'function' as const,
      function: { name: 'read', arguments: '{"path":"README.md"}' },
    };
    const currentMessages = ['call_1', 'call_2', 'call_3'].map((id) => ({
      role: 'assistant' as const,
      content: '',
      tool_calls: [
        {
          id,
          type: 'function' as const,
          function: { name: 'read', arguments: '{"path":"README.md"}' },
        },
      ],
    }));

    expect(__testables.isRepeatedToolCallLoop(currentMessages, repeatedCall)).toBe(true);
    expect(
      __testables.isRepeatedToolCallLoop(currentMessages.slice(1), repeatedCall)
    ).toBe(false);
    expect(
      __testables.isRepeatedToolCallLoop(currentMessages, {
        ...repeatedCall,
        function: { name: 'read', arguments: '{"path":"CHANGELOG.md"}' },
      })
    ).toBe(false);
  });

  it('does not retry context overflow failures blindly', async () => {
    const fetchMock = mock(async () => ({
      ok: false,
      status: 413,
      headers: new Headers(),
      text: async () =>
        JSON.stringify({
          error: {
            message: 'Request entity too large',
            code: 'context_length_exceeded',
          },
        }),
      json: async () => ({}),
    }));
    const { streamChat } = await loadStreamingChat(fetchMock);
    const onError = mock(() => undefined);

    await streamChat({
      providerId: 'openrouter',
      providerType: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      modelId: 'openai/gpt-4.1',
      messages: [{ role: 'user', content: 'Huge prompt.' }],
      enableWebSearch: false,
      enableWebFetch: false,
      onToken: () => undefined,
      onComplete: () => undefined,
      onError,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'context_overflow',
        retryable: false,
      })
    );
  });

  it('repairs DeepSeek thinking-mode follow-up requests by replaying native reasoning_content', async () => {
    const encoder = new TextEncoder();
    const requestBodies: Array<{ messages?: Array<Record<string, unknown>> }> = [];
    let requestCount = 0;
    const fetchMock = mock(async (_url: string, init?: { body?: string }) => {
      requestCount += 1;
      requestBodies.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}'));

      if (requestCount === 1) {
        return {
          ok: true,
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  'data: {"choices":[{"delta":{"reasoning_content":"Need file context.","tool_calls":[{"index":0,"id":"call_read","type":"function","function":{"name":"read","arguments":"{\\"path\\":\\"README.md\\"}"}}]}}]}\n\n'
                )
              );
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              controller.close();
            },
          }),
          text: async () => '',
          json: async () => ({}),
        };
      }

      if (requestCount === 2) {
        const assistantMessage = requestBodies[1]?.messages?.find(
          (message) => message.role === 'assistant'
        );
        expect(assistantMessage?.reasoning_content).toBeUndefined();
        return {
          ok: false,
          status: 400,
          headers: new Headers(),
          text: async () =>
            JSON.stringify({
              error: {
                message:
                  'The reasoning_content in the thinking mode must be passed back to the API.',
              },
            }),
          json: async () => ({}),
        };
      }

      const assistantMessage = requestBodies[2]?.messages?.find(
        (message) => message.role === 'assistant'
      );
      expect(assistantMessage).toEqual(
        expect.objectContaining({
          content: '',
          reasoning_content: 'Need file context.',
          tool_calls: [
            expect.objectContaining({
              id: 'call_read',
              function: { name: 'read', arguments: '{"path":"README.md"}' },
            }),
          ],
        })
      );
      expect(JSON.stringify(requestBodies[2]?.messages)).not.toContain('<think>');

      return {
        ok: true,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode('data: {"choices":[{"delta":{"content":"Done."}}]}\n\n')
            );
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          },
        }),
        text: async () => '',
        json: async () => ({}),
      };
    });
    const { streamChat } = await loadStreamingChat(fetchMock);
    const onComplete = mock((_: StreamCompletionResult) => undefined);

    await streamChat({
      providerId: 'openrouter',
      providerType: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      modelId: 'provider/reasoner',
      messages: [{ role: 'user', content: 'Inspect README.' }],
      allowedToolIds: ['read'],
      enableWebSearch: false,
      enableWebFetch: false,
      onToken: () => undefined,
      onComplete,
      onError: (error: Error) => {
        throw error;
      },
      onToolCall: async () => 'FILE: README.md\n\n# Macro',
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        visibleContent: '<think>Need file context.</think>Done.',
        providerInputItems: expect.arrayContaining([
          expect.objectContaining({
            type: 'chat_completion_message',
            role: 'assistant',
            reasoning_content: 'Need file context.',
          }),
          expect.objectContaining({
            type: 'chat_completion_message',
            role: 'tool',
            tool_call_id: 'call_read',
          }),
        ]),
      })
    );
  });

  it('stops immediately when the configured max turn budget is reached', async () => {
    const encoder = new TextEncoder();
    const requestBodies: Array<Record<string, unknown>> = [];
    let requestCount = 0;
    const fetchMock = mock(async (_url: string, init?: { body?: string }) => {
      requestCount += 1;
      requestBodies.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}'));

      if (requestCount <= 3) {
        return {
          ok: true,
          body: new ReadableStream({
            start(controller) {
              const path = requestCount === 1 ? 'README.md' : 'package.json';
              controller.enqueue(
                encoder.encode(
                  `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_read_${requestCount}","type":"function","function":{"name":"read","arguments":"{\\"path\\":\\"${path}\\"}"}}]}}]}\n\n`
                )
              );
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              controller.close();
            },
          }),
          text: async () => '',
          json: async () => ({}),
        };
      }

      return {
        ok: true,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode('data: {"choices":[{"delta":{"content":"Final summary."}}]}\n\n')
            );
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          },
        }),
        text: async () => '',
        json: async () => ({}),
      };
    });
    const { streamChat } = await loadStreamingChat(fetchMock);
    const onComplete = mock((_: StreamCompletionResult) => undefined);

    await streamChat({
      providerId: 'provider-1',
      providerType: 'openai',
      baseUrl: 'https://example.com',
      modelId: 'gpt-4.1',
      messages: [{ role: 'user', content: 'Inspect files.' }],
      allowedToolIds: ['read'],
      maxTurns: 3,
      enableWebSearch: false,
      enableWebFetch: false,
      onToken: () => undefined,
      onComplete,
      onError: (error: Error) => {
        throw error;
      },
      onToolCall: async (_toolName: string, args: Record<string, unknown>) =>
        `FILE: ${args.path}\n\nok`,
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(requestBodies[2]?.tools).toBeDefined();
    expect(requestBodies[2]?.tool_choice).toBe('auto');
    expect(JSON.stringify(requestBodies)).not.toContain(
      'Finish the answer now in natural language without using tools.'
    );
    const finalResult = onComplete.mock.calls[0]?.[0];
    expect(finalResult?.completionReason).toBe('tool_turn_limit');
    expect(finalResult?.visibleContent).not.toContain('[Macro]');
    expect(finalResult?.visibleContent).not.toContain('Limite de tours atteinte');
    expect(finalResult?.visibleContent).not.toContain('Final summary.');
  });

  it('does not emit a post-tool fallback when stopping at the max turn budget', async () => {
    const encoder = new TextEncoder();
    let requestCount = 0;
    const fetchMock = mock(async () => {
      requestCount += 1;

      return {
        ok: true,
        body: new ReadableStream({
          start(controller) {
            const path = `README-${requestCount}.md`;
            controller.enqueue(
              encoder.encode(
                `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_read_${requestCount}","type":"function","function":{"name":"read","arguments":"{\\"path\\":\\"${path}\\"}"}}]}}]}\n\n`
              )
            );
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          },
        }),
        text: async () => '',
        json: async () => ({}),
      };
    });
    const { streamChat } = await loadStreamingChat(fetchMock);
    const onToolCall = mock(async () => 'FILE: README.md\n\nok');
    const onComplete = mock((_: StreamCompletionResult) => undefined);

    await streamChat({
      providerId: 'provider-1',
      providerType: 'openai',
      baseUrl: 'https://example.com',
      modelId: 'gpt-4.1',
      messages: [{ role: 'user', content: 'Inspect files.' }],
      allowedToolIds: ['read'],
      maxTurns: 3,
      enableWebSearch: false,
      enableWebFetch: false,
      onToken: () => undefined,
      onComplete,
      onError: (error: Error) => {
        throw error;
      },
      onToolCall,
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(onToolCall).toHaveBeenCalledTimes(3);
    const finalResult = onComplete.mock.calls[0]?.[0];
    expect(finalResult?.completionReason).toBe('tool_turn_limit');
    expect(finalResult?.visibleContent).not.toContain(
      "Le dernier tour sans outils n'a pas fourni de reponse finale exploitable."
    );
    expect(finalResult?.visibleContent).not.toContain('[Macro]');
  });

  it('does not force a final no-tool turn when max turns is omitted by default', async () => {
    const encoder = new TextEncoder();
    const requestBodies: Array<Record<string, unknown>> = [];
    let requestCount = 0;
    const fetchMock = mock(async (_url: string, init?: RequestInit) => {
      requestCount += 1;
      requestBodies.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}'));

      if (requestCount <= 4) {
        return {
          ok: true,
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_read_${requestCount}","type":"function","function":{"name":"read","arguments":"{\\"path\\":\\"file-${requestCount}.md\\"}"}}]}}]}\n\n`
                )
              );
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              controller.close();
            },
          }),
          text: async () => '',
          json: async () => ({}),
        };
      }

      return {
        ok: true,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode('data: {"choices":[{"delta":{"content":"Final after tools."}}]}\n\n')
            );
            controller.enqueue(
              encoder.encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n')
            );
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          },
        }),
        text: async () => '',
        json: async () => ({}),
      };
    });
    const { streamChat } = await loadStreamingChat(fetchMock);
    const onToolCall = mock(async () => 'FILE: file.md\n\nok');
    const onComplete = mock((_: StreamCompletionResult) => undefined);

    await streamChat({
      providerId: 'provider-1',
      providerType: 'openai',
      baseUrl: 'https://example.com',
      modelId: 'gpt-4.1',
      messages: [{ role: 'user', content: 'Inspect files.' }],
      allowedToolIds: ['read'],
      enableWebSearch: false,
      enableWebFetch: false,
      onToken: () => undefined,
      onComplete,
      onError: (error: Error) => {
        throw error;
      },
      onToolCall,
    });

    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(onToolCall).toHaveBeenCalledTimes(4);
    expect(requestBodies[4]?.tools).toBeDefined();
    const finalResult = onComplete.mock.calls[0]?.[0];
    expect(finalResult?.completionReason).toBe('completed');
    expect(finalResult?.visibleContent).not.toContain('Limite de tours atteinte');
    expect(finalResult?.visibleContent).not.toContain('[Macro]');
    expect(finalResult?.visibleContent).toContain('Final after tools.');
  });

  it('silently retries recoverable provider errors before streaming visible output', async () => {
    const encoder = new TextEncoder();
    let requestCount = 0;
    const fetchMock = mock(async () => {
      requestCount += 1;
      if (requestCount === 1) {
        return {
          ok: false,
          status: 429,
          headers: new Headers({ 'retry-after-ms': '0' }),
          text: async (): Promise<string> =>
            JSON.stringify({ error: { message: 'Rate limited' } }),
          json: async () => ({}),
        };
      }

      return {
        ok: true,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode('data: {"choices":[{"delta":{"content":"Recovered."}}]}\n\n')
            );
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          },
        }),
        text: async (): Promise<string> => '',
        json: async () => ({}),
      };
    });
    const { streamChat } = await loadStreamingChat(fetchMock);
    const onError = mock(() => undefined);
    const onComplete = mock(() => undefined);

    await streamChat({
      providerId: 'openrouter',
      providerType: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      modelId: 'openai/gpt-4.1',
      messages: [{ role: 'user', content: 'Say hi.' }],
      enableWebSearch: false,
      enableWebFetch: false,
      onToken: () => undefined,
      onComplete,
      onError,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onError).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({ visibleContent: 'Recovered.' })
    );
  });

  it('interrupts the turn immediately when the question tool is invoked', async () => {
    const encoder = new TextEncoder();
    const fetchMock = mock(async () => ({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_question","type":"function","function":{"name":"question","arguments":"{\\"intro\\":\\"Need two clarifications.\\",\\"questions\\":[{\\"id\\":\\"scope\\",\\"prompt\\":\\"Which scope?\\",\\"choices\\":[\\"Minimal\\",\\"Balanced\\",\\"Large\\"]}]}"}}]}}]}\n\n'
            )
          );
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      }),
      text: async () => '',
      json: async () => ({}),
    }));
    const { streamChat } = await loadStreamingChat(fetchMock);
    const onToolCall = mock(async () => ({
      kind: 'interrupt' as const,
      result: 'Questionnaire queued for the user.',
      visibleContent: 'Need two clarifications.',
      hiddenContext:
        '<questionnaire_context>\n' +
        '{"intro":"Need two clarifications.","questions":[{"id":"scope","prompt":"Which scope?","choices":["Minimal","Balanced","Large"]}]}\n' +
        '</questionnaire_context>',
    }));
    const onComplete = mock(() => undefined);

    await streamChat({
      providerId: 'provider-1',
      providerType: 'openai',
      baseUrl: 'https://example.com',
      modelId: 'gpt-4.1',
      messages: [
        {
          role: 'user',
          content: 'Help me continue.',
        },
      ],
      allowedToolIds: ['question'],
      enableWebSearch: false,
      enableWebFetch: false,
      onToken: () => undefined,
      onComplete,
      onError: (error: Error) => {
        throw error;
      },
      onToolCall,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onToolCall).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        visibleContent: 'Need two clarifications.',
        hiddenContext: expect.stringContaining('<questionnaire_context>'),
      })
    );
  });

  it('retries once when question is required but the first turn answers in plain text', async () => {
    const encoder = new TextEncoder();
    let requestCount = 0;
    const fetchMock = mock(async (_url: string, init?: { body?: string }) => {
      requestCount += 1;

      if (requestCount === 1) {
        return {
          ok: true,
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  'data: {"choices":[{"delta":{"content":"Je peux t aider a choisir."}}]}\n\n'
                )
              );
              controller.enqueue(
                encoder.encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n')
              );
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              controller.close();
            },
          }),
          text: async () => '',
          json: async () => ({}),
        };
      }

      const parsedBody = JSON.parse(init?.body ?? '{}') as {
        messages?: Array<{ role?: string; content?: string }>;
      };
      expect(parsedBody.messages?.some((message) =>
        message.role === 'system' &&
        String(message.content).includes('explicitly asked you to use the question tool')
      )).toBe(true);

      return {
        ok: true,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_question","type":"function","function":{"name":"question","arguments":"{\\"intro\\":\\"Need one choice.\\",\\"questions\\":[{\\"id\\":\\"color\\",\\"prompt\\":\\"Which color?\\",\\"choices\\":[\\"Red\\",\\"Blue\\",\\"Green\\"]}]}"}}]}}]}\n\n'
              )
            );
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          },
        }),
        text: async () => '',
        json: async () => ({}),
      };
    });
    const { streamChat } = await loadStreamingChat(fetchMock);
    const onToolCall = mock(async () => ({
      kind: 'interrupt' as const,
      result: 'Questionnaire queued for the user.',
      visibleContent: 'Need one choice.',
      hiddenContext:
        '<questionnaire_context>\n' +
        '{"intro":"Need one choice.","questions":[{"id":"color","prompt":"Which color?","choices":["Red","Blue","Green"]}]}\n' +
        '</questionnaire_context>',
    }));
    const onComplete = mock(() => undefined);

    await streamChat({
      providerId: 'provider-1',
      providerType: 'openai',
      baseUrl: 'https://example.com',
      modelId: 'gpt-4.1',
      messages: [
        {
          role: 'user',
          content: 'Utilise l outil question pour choisir ma couleur preferee.',
        },
      ],
      allowedToolIds: ['question'],
      guidedToolRetry: {
        requiredToolNames: ['question'],
        retrySystemPrompt:
          'The user explicitly asked you to use the question tool. Emit exactly one question tool call.',
        maxRetries: 1,
      },
      enableWebSearch: false,
      enableWebFetch: false,
      onToken: () => undefined,
      onComplete,
      onError: (error: Error) => {
        throw error;
      },
      onToolCall,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onToolCall).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        visibleContent: 'Need one choice.',
      })
    );
  });

  it('passes native tools to Copilot and resolves question tool interruptions', async () => {
    const listeners = new Map<string, (event: { payload: Record<string, unknown> }) => void>();
    const listenMock = mock(async (eventName: string, handler: (event: { payload: Record<string, unknown> }) => void) => {
      listeners.set(eventName, handler);
      return () => {
        listeners.delete(eventName);
      };
    });
    const invokeMock = mock(async (command: string, payload?: unknown) => {
      if (command === 'ai_stream_chat') {
        const request = (payload as { request: { request_id: string } }).request;
        queueMicrotask(() => {
          listeners.get('ai:done')?.({
            payload: {
              request_id: request.request_id,
              output_text: '',
              tool_calls: [
                {
                  id: 'call_question',
                  type: 'function',
                  function: {
                    name: 'question',
                    arguments:
                      '{"intro":"Need one choice.","questions":[{"id":"color","prompt":"Which color?","choices":["Red","Blue","Green"]}]}',
                  },
                },
              ],
              provider_input_items: [
                {
                  type: 'function_call',
                  call_id: 'call_question',
                  name: 'question',
                  arguments:
                    '{"intro":"Need one choice.","questions":[{"id":"color","prompt":"Which color?","choices":["Red","Blue","Green"]}]}',
                },
              ],
              provider_turn_state: {
                provider: 'copilot',
                endpoint_flavor: 'chat',
                stored_item_refs: [],
                provider_items_digest: 'digest-1',
              },
            },
          });
        });
      }

      return undefined;
    });
    const { streamChat } = await loadStreamingChat(undefined, {
      invokeImpl: invokeMock,
      listenImpl: listenMock,
      forceTauriAvailable: true,
    });
    const onToolCall = mock(async () => ({
      kind: 'interrupt' as const,
      result: 'Questionnaire queued for the user.',
      visibleContent: 'Need one choice.',
      hiddenContext:
        '<questionnaire_context>\n' +
        '{"intro":"Need one choice.","questions":[{"id":"color","prompt":"Which color?","choices":["Red","Blue","Green"]}]}\n' +
        '</questionnaire_context>',
    }));
    const onComplete = mock(() => undefined);

    await streamChat({
      conversationId: 'conv-1',
      providerId: 'copilot',
      providerType: 'copilot',
      baseUrl: 'copilot://cli',
      modelId: 'gpt-5',
      messages: [
        {
          role: 'user',
          content: 'Utilise l outil question pour m aider a choisir une couleur.',
        },
      ],
      allowedToolIds: ['question'],
      enableWebSearch: false,
      enableWebFetch: false,
      onToken: () => undefined,
      onComplete,
      onError: (error: Error) => {
        throw error;
      },
      onToolCall,
    });

    expect(invokeMock).toHaveBeenCalledTimes(1);
    const invokePayload = (invokeMock.mock.calls[0]?.[1] ?? {}) as {
      request?: {
        tools?: Array<{ function?: { name?: string } }>;
      };
    };
    expect(invokePayload.request?.tools?.map((tool) => tool.function?.name)).toContain('question');
    expect(onToolCall).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        visibleContent: 'Need one choice.',
        hiddenContext: expect.stringContaining('<questionnaire_context>'),
        providerTurnState: expect.objectContaining({
          provider: 'copilot',
        }),
      })
    );
  });

  it('streams and persists Copilot readable thinking as a think block', async () => {
    const listeners = new Map<string, (event: { payload: Record<string, unknown> }) => void>();
    const listenMock = mock(async (eventName: string, handler: (event: { payload: Record<string, unknown> }) => void) => {
      listeners.set(eventName, handler);
      return () => {
        listeners.delete(eventName);
      };
    });
    const invokeMock = mock(async (command: string, payload?: unknown) => {
      if (command === 'ai_stream_chat') {
        const request = (payload as { request: { request_id: string } }).request;
        queueMicrotask(() => {
          for (const delta of ['<think>', 'Inspecting files.', '</think>\n', 'Done.']) {
            listeners.get('ai:stream')?.({
              payload: {
                request_id: request.request_id,
                delta,
              },
            });
          }
          listeners.get('ai:done')?.({
            payload: {
              request_id: request.request_id,
              output_text: 'Done.',
              reasoning_summary: 'Inspecting files.',
              tool_calls: [],
            },
          });
        });
      }

      return undefined;
    });
    const { streamChat } = await loadStreamingChat(undefined, {
      invokeImpl: invokeMock,
      listenImpl: listenMock,
      forceTauriAvailable: true,
    });
    const streamed: string[] = [];
    const onComplete = mock(() => undefined);

    await streamChat({
      conversationId: 'conv-1',
      providerId: 'copilot',
      providerType: 'copilot',
      baseUrl: 'copilot://cli',
      modelId: 'gpt-5',
      messages: [{ role: 'user', content: 'Explain the change.' }],
      allowedToolIds: [],
      enableWebSearch: false,
      enableWebFetch: false,
      onToken: (token: string) => {
        streamed.push(token);
      },
      onComplete,
      onError: (error: Error) => {
        throw error;
      },
    });

    expect(streamed.join('')).toBe('<think>Inspecting files.</think>\nDone.');
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        visibleContent: '<think>Inspecting files.</think>\nDone.',
      })
    );
  });

  it('continues a native length-limited response once without duplicating overlap or tools', async () => {
    const listeners = new Map<string, (event: { payload: Record<string, unknown> }) => void>();
    const requests: Array<Record<string, unknown>> = [];
    const listenMock = mock(async (eventName: string, handler: (event: { payload: Record<string, unknown> }) => void) => {
      listeners.set(eventName, handler);
      return () => {
        listeners.delete(eventName);
      };
    });
    const invokeMock = mock(async (command: string, payload?: unknown) => {
      if (command !== 'ai_stream_chat') return undefined;
      const request = (payload as { request: Record<string, unknown> }).request;
      requests.push(request);
      const requestId = request.request_id as string;
      const firstRequest = requests.length === 1;
      queueMicrotask(() => {
        const text = firstRequest
          ? 'Alpha repeated phrase'
          : 'repeated phrase and omega';
        listeners.get('ai:stream')?.({
          payload: { request_id: requestId, delta: text },
        });
        listeners.get('ai:done')?.({
          payload: {
            request_id: requestId,
            output_text: text,
            tool_calls: firstRequest
              ? [
                  {
                    id: 'call_truncated',
                    type: 'function',
                    function: {
                      name: 'read',
                      arguments: '{"path":"README.md"}',
                    },
                  },
                ]
              : [],
            completion_reason: firstRequest ? 'length' : 'completed',
          },
        });
      });
      return undefined;
    });
    const { streamChat } = await loadStreamingChat(undefined, {
      invokeImpl: invokeMock,
      listenImpl: listenMock,
      forceTauriAvailable: true,
    });
    const streamed: string[] = [];
    const onComplete = mock((_result: unknown) => undefined);
    const onToolCall = mock(async () => 'must not run');

    await streamChat({
      conversationId: 'conv-1',
      providerId: 'openai-local',
      providerType: 'openai',
      baseUrl: 'https://example.test',
      modelId: 'gpt-test',
      messages: [{ role: 'user', content: 'Write a long answer.' }],
      allowedToolIds: ['read'],
      enableWebSearch: false,
      enableWebFetch: false,
      onToken: (token: string) => streamed.push(token),
      onComplete,
      onToolCall,
      onError: (error: Error) => {
        throw error;
      },
    });

    expect(requests).toHaveLength(2);
    expect(requests[0]?.tools).toBeArray();
    expect(requests[1]?.tools).toEqual([]);
    expect(JSON.stringify(requests[1]?.messages)).toContain('Continue exactly where it stopped');
    expect(JSON.stringify(requests[1]?.messages)).not.toContain('call_truncated');
    expect(streamed.join('')).toBe('Alpha repeated phrase and omega');
    expect(onToolCall).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        visibleContent: 'Alpha repeated phrase and omega',
        completionReason: 'length_recovered',
      }),
    );
    const finalResult = onComplete.mock.calls[0]?.[0] as {
      providerInputItems?: unknown[];
    };
    expect(JSON.stringify(finalResult.providerInputItems)).toContain('"text":" and omega"');
    expect(JSON.stringify(finalResult.providerInputItems)).not.toContain(
      '"text":"repeated phrase and omega"',
    );
  });

  it('continues a generic length-limited response once and preserves the recovery cause', async () => {
    const encoder = new TextEncoder();
    const requestBodies: Array<Record<string, unknown>> = [];
    const fetchMock = mock(async (_url: string, init?: { body?: string }) => {
      requestBodies.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}'));
      const firstRequest = requestBodies.length === 1;
      const text = firstRequest
        ? 'Alpha repeated phrase'
        : 'repeated phrase and omega';
      const finishReason = firstRequest ? 'length' : 'stop';
      return {
        ok: true,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
              ),
            );
            if (firstRequest) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_truncated', type: 'function', function: { name: 'read', arguments: '{"path":"README.md"}' } }] } }] })}\n\n`,
                ),
              );
            }
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason }] })}\n\n`,
              ),
            );
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          },
        }),
      };
    });
    const { streamChat } = await loadStreamingChat(fetchMock);
    const streamed: string[] = [];
    const onComplete = mock((_result: unknown) => undefined);
    const onToolCall = mock(async () => 'must not run');

    await streamChat({
      providerId: 'openai-generic',
      providerType: 'openai',
      baseUrl: 'https://example.test',
      apiKey: 'test-key',
      modelId: 'gpt-test',
      messages: [{ role: 'user', content: 'Write a long answer.' }],
      allowedToolIds: ['read'],
      enableWebSearch: false,
      enableWebFetch: false,
      onToken: (token: string) => streamed.push(token),
      onComplete,
      onToolCall,
      onError: (error: Error) => {
        throw error;
      },
    });

    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[0]?.tools).toBeDefined();
    expect(requestBodies[1]?.tools).toBeUndefined();
    expect(JSON.stringify(requestBodies[1]?.messages)).toContain('Continue exactly where it stopped');
    expect(JSON.stringify(requestBodies[1]?.messages)).not.toContain('call_truncated');
    expect(streamed.join('')).toBe('Alpha repeated phrase and omega');
    expect(onToolCall).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        visibleContent: 'Alpha repeated phrase and omega',
        completionReason: 'length_recovered',
      }),
    );
    const finalResult = onComplete.mock.calls[0]?.[0] as {
      providerInputItems?: unknown[];
    };
    expect(JSON.stringify(finalResult.providerInputItems)).toContain(
      '"content":" and omega"',
    );
    expect(JSON.stringify(finalResult.providerInputItems)).not.toContain(
      '"content":"repeated phrase and omega"',
    );
  });

  it('marks a generic stream without a finish reason as incomplete', async () => {
    const encoder = new TextEncoder();
    const fetchMock = mock(async () => ({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode('data: {"choices":[{"delta":{"content":"Partial answer."}}]}\n\n'),
          );
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      }),
    }));
    const { streamChat } = await loadStreamingChat(fetchMock);
    const onComplete = mock((_result: StreamCompletionResult) => undefined);

    await streamChat({
      providerId: 'openai-generic',
      providerType: 'openai',
      baseUrl: 'https://example.test',
      apiKey: 'test-key',
      modelId: 'gpt-test',
      messages: [{ role: 'user', content: 'Answer.' }],
      enableWebSearch: false,
      enableWebFetch: false,
      onToken: () => undefined,
      onComplete,
      onError: (error: Error) => {
        throw error;
      },
    });

    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        visibleContent: 'Partial answer.',
        completionReason: 'incomplete',
      }),
    );
  });

  it('relays Copilot bridge tool requests to frontend tool handlers', async () => {
    const listeners = new Map<string, (event: { payload: Record<string, unknown> }) => void>();
    const listenMock = mock(async (eventName: string, handler: (event: { payload: Record<string, unknown> }) => void) => {
      listeners.set(eventName, handler);
      return () => {
        listeners.delete(eventName);
      };
    });
    const invokeMock = mock(async (command: string, payload?: unknown) => {
      if (command === 'ai_stream_chat') {
        const request = (payload as { request: { request_id: string } }).request;
        queueMicrotask(() => {
          listeners.get('ai:tool-request')?.({
            payload: {
              request_id: request.request_id,
              tool_call_id: 'call_plan',
              tool_name: 'plan_get',
              args: {
                plan_id: 'plan-1',
              },
            },
          });
        });
      }

      if (command === 'ai_submit_tool_result') {
        const request = (payload as {
          request: {
            request_id: string;
            result: string;
          };
        }).request;
        queueMicrotask(() => {
          listeners.get('ai:done')?.({
            payload: {
              request_id: request.request_id,
              output_text: 'Plan loaded.',
              tool_calls: [],
              hidden_context: `<tool_context tool_call_id="call_plan" tool="plan_get">\n${request.result}\n</tool_context>`,
            },
          });
        });
      }

      return undefined;
    });
    const { streamChat } = await loadStreamingChat(undefined, {
      invokeImpl: invokeMock,
      listenImpl: listenMock,
      forceTauriAvailable: true,
    });
    const onToolCall = mock(async (toolName: string, args: Record<string, unknown>) => ({
      kind: 'result' as const,
      result: `${toolName}:${args.plan_id}`,
      isError: true,
      errorKind: 'execution' as const,
    }));
    const onComplete = mock((_result: unknown) => undefined);

    await streamChat({
      conversationId: 'conv-1',
      providerId: 'copilot',
      providerType: 'copilot',
      baseUrl: 'copilot://cli',
      modelId: 'gpt-5',
      messages: [{ role: 'user', content: 'Charge le plan.' }],
      allowedToolIds: ['plan_get'],
      enableWebSearch: false,
      enableWebFetch: false,
      onToken: () => undefined,
      onComplete,
      onError: (error: Error) => {
        throw error;
      },
      onToolCall,
    });

    expect(onToolCall).toHaveBeenCalledWith(
      'plan_get',
      { plan_id: 'plan-1' },
      'call_plan',
    );

    const submitCall = invokeMock.mock.calls.find((call) => call[0] === 'ai_submit_tool_result');
    expect(submitCall?.[1]).toEqual({
      request: {
        request_id: expect.any(String),
        tool_call_id: 'call_plan',
        result: 'plan_get:plan-1',
        hidden_context: null,
        visible_content: null,
        interrupt: false,
        is_error: true,
        error_kind: 'execution',
      },
    });
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        visibleContent: 'Plan loaded.',
        hiddenContext: expect.stringContaining('plan_get:plan-1'),
      })
    );
  });

  it('relays Copilot send timeout to the desktop backend', async () => {
    const listeners = new Map<string, (event: { payload: Record<string, unknown> }) => void>();
    const listenMock = mock(async (eventName: string, handler: (event: { payload: Record<string, unknown> }) => void) => {
      listeners.set(eventName, handler);
      return () => {
        listeners.delete(eventName);
      };
    });
    const invokeMock = mock(async (command: string, payload?: unknown) => {
      if (command === 'ai_stream_chat') {
        const request = (payload as { request: { request_id: string } }).request;
        queueMicrotask(() => {
          listeners.get('ai:done')?.({
            payload: {
              request_id: request.request_id,
              output_text: 'Done.',
              tool_calls: [],
            },
          });
        });
      }
      return undefined;
    });
    const { streamChat } = await loadStreamingChat(undefined, {
      invokeImpl: invokeMock,
      listenImpl: listenMock,
      forceTauriAvailable: true,
    });

    await streamChat({
      conversationId: 'conv-1',
      providerId: 'copilot',
      providerType: 'copilot',
      baseUrl: 'copilot://cli',
      modelId: 'gpt-5',
      messages: [{ role: 'user', content: 'Hello' }],
      allowedToolIds: [],
      copilotSendTimeoutMs: 2_400_000,
      enableWebSearch: false,
      enableWebFetch: false,
      onToken: () => undefined,
      onComplete: () => undefined,
      onError: (error: Error) => {
        throw error;
      },
    });

    const streamCall = invokeMock.mock.calls.find((call) => call[0] === 'ai_stream_chat');
    expect((streamCall?.[1] as { request?: Record<string, unknown> }).request)
      .toMatchObject({
        provider_id: 'copilot',
        copilot_send_timeout_ms: 2_400_000,
      });
  });

  it('sends Copilot built-in override metadata only for shadowing tools', async () => {
    const listeners = new Map<string, (event: { payload: Record<string, unknown> }) => void>();
    const listenMock = mock(async (eventName: string, handler: (event: { payload: Record<string, unknown> }) => void) => {
      listeners.set(eventName, handler);
      return () => {
        listeners.delete(eventName);
      };
    });
    const invokeMock = mock(async (command: string, payload?: unknown) => {
      if (command === 'ai_stream_chat') {
        const request = (payload as { request: { request_id: string } }).request;
        queueMicrotask(() => {
          listeners.get('ai:done')?.({
            payload: {
              request_id: request.request_id,
              output_text: 'Done.',
              tool_calls: [],
            },
          });
        });
      }

      return undefined;
    });
    const { streamChat } = await loadStreamingChat(undefined, {
      invokeImpl: invokeMock,
      listenImpl: listenMock,
      forceTauriAvailable: true,
    });

    await streamChat({
      conversationId: 'conv-1',
      providerId: 'copilot',
      providerType: 'copilot',
      baseUrl: 'copilot://cli',
      modelId: 'gpt-5',
      messages: [{ role: 'user', content: 'Search and inspect git status.' }],
      allowedToolIds: ['grep', 'web_fetch', 'git_status'],
      enableWebSearch: false,
      enableWebFetch: true,
      onToken: () => undefined,
      onComplete: () => undefined,
      onError: (error: Error) => {
        throw error;
      },
    });

    const invokePayload = (invokeMock.mock.calls[0]?.[1] ?? {}) as {
      request?: {
        tools?: Array<{
          overridesBuiltInTool?: true;
          function?: { name?: string };
        }>;
      };
    };
    const tools = invokePayload.request?.tools ?? [];
    const grepTool = tools.find((tool) => tool.function?.name === 'grep');
    const webFetchTool = tools.find((tool) => tool.function?.name === 'web_fetch');
    const gitStatusTool = tools.find((tool) => tool.function?.name === 'git_status');

    expect(grepTool?.overridesBuiltInTool).toBe(true);
    expect(webFetchTool?.overridesBuiltInTool).toBe(true);
    expect(gitStatusTool?.overridesBuiltInTool).toBeUndefined();
  });

  it('does not leak Copilot override metadata into OpenAI-compatible payloads', async () => {
    const encoder = new TextEncoder();
    const requestBodies: Array<{
      tools?: Array<{
        overridesBuiltInTool?: true;
        function?: { name?: string };
      }>;
    }> = [];
    const fetchMock = mock(async (_url: string, init?: { body?: string }) => {
      requestBodies.push(JSON.parse(init?.body ?? '{}'));
      return {
        ok: true,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode('data: {"choices":[{"delta":{"content":"Done."}}]}\n\n')
            );
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          },
        }),
        text: async () => '',
        json: async () => ({}),
      };
    });
    const { streamChat } = await loadStreamingChat(fetchMock);

    await streamChat({
      providerId: 'provider-1',
      providerType: 'openai',
      baseUrl: 'https://example.com',
      modelId: 'gpt-4.1',
      messages: [{ role: 'user', content: 'Search workspace.' }],
      allowedToolIds: ['grep'],
      enableWebSearch: false,
      enableWebFetch: false,
      onToken: () => undefined,
      onComplete: () => undefined,
      onError: (error: Error) => {
        throw error;
      },
    });

    const grepTool = requestBodies[0]?.tools?.find((tool) => tool.function?.name === 'grep');

    expect(grepTool).toBeDefined();
    expect(grepTool?.overridesBuiltInTool).toBeUndefined();
  });

  it('streams and persists Copilot tool traces from native events', async () => {
    const listeners = new Map<string, (event: { payload: Record<string, unknown> }) => void>();
    const listenMock = mock(async (eventName: string, handler: (event: { payload: Record<string, unknown> }) => void) => {
      listeners.set(eventName, handler);
      return () => {
        listeners.delete(eventName);
      };
    });
    const invokeMock = mock(async (command: string, payload?: unknown) => {
      if (command === 'ai_stream_chat') {
        const request = (payload as { request: { request_id: string } }).request;
        queueMicrotask(() => {
          listeners.get('ai:stream')?.({
            payload: {
              request_id: request.request_id,
              delta: 'Inspecting files.',
            },
          });
          listeners.get('ai:tool-trace')?.({
            payload: {
              request_id: request.request_id,
              tool_trace: {
                tool_call_id: 'call_read',
                tool_name: 'read',
                detail: 'README.md',
                status: 'running',
              },
            },
          });
          listeners.get('ai:tool-trace')?.({
            payload: {
              request_id: request.request_id,
              tool_trace: {
                tool_call_id: 'call_read',
                tool_name: 'read',
                detail: 'README.md',
                status: 'done',
              },
            },
          });
          listeners.get('ai:done')?.({
            payload: {
              request_id: request.request_id,
              output_text: 'Inspecting files. Done.',
              tool_calls: [],
              tool_traces: [
                {
                  tool_call_id: 'call_read',
                  tool_name: 'read',
                  detail: 'README.md',
                  status: 'done',
                },
                {
                  tool_call_id: 'call_glob',
                  tool_name: 'glob',
                  detail: 'src/**/*.ts',
                  status: 'done',
                },
              ],
              hidden_context:
                '<tool_context tool_call_id="call_read" tool="read" detail="README.md">\nFILE: README.md\n</tool_context>',
            },
          });
        });
      }

      return undefined;
    });
    const { streamChat } = await loadStreamingChat(undefined, {
      invokeImpl: invokeMock,
      listenImpl: listenMock,
      forceTauriAvailable: true,
    });
    const onToolTracesUpdate = mock((_toolTraces: unknown) => undefined);
    const onComplete = mock((_result: unknown) => undefined);

    await streamChat({
      conversationId: 'conv-1',
      providerId: 'copilot',
      providerType: 'copilot',
      baseUrl: 'copilot://cli',
      modelId: 'gpt-5',
      messages: [{ role: 'user', content: 'Analyse le projet.' }],
      allowedToolIds: ['read', 'glob'],
      enableWebSearch: false,
      enableWebFetch: false,
      onToken: () => undefined,
      onToolTracesUpdate,
      onComplete,
      onError: (error: Error) => {
        throw error;
      },
    });

    const traceUpdateCalls = onToolTracesUpdate.mock.calls as Array<
      [Array<{ tool_call_id: string; status: string }>]
    >;
    const traceUpdates = traceUpdateCalls.map(([toolTraces]) => toolTraces);
    expect(traceUpdates[0]).toEqual([
      expect.objectContaining({ tool_call_id: 'call_read', status: 'running' }),
    ]);
    expect(traceUpdates.some((toolTraces) =>
      toolTraces.some((trace) => trace.tool_call_id === 'call_read' && trace.status === 'done')
    )).toBe(true);

    const completionCalls = onComplete.mock.calls as Array<
      [
        {
          visibleContent: string;
          hiddenContext?: string;
          toolTraces?: Array<{
            tool_call_id: string;
            tool_name: string;
            detail?: string;
            status: string;
            visible_offset?: number;
          }>;
        },
      ]
    >;
    const completion = completionCalls[0]?.[0];
    expect(completion).toBeDefined();
    const completedResult = completion as {
      visibleContent: string;
      hiddenContext?: string;
      toolTraces?: Array<{
        tool_call_id: string;
        tool_name: string;
        detail?: string;
        status: string;
        visible_offset?: number;
      }>;
    };
    expect(completedResult.visibleContent).toBe('Inspecting files. Done.');
    expect(completedResult.hiddenContext).toContain('FILE: README.md');
    expect(completedResult.toolTraces).toEqual([
      expect.objectContaining({
        tool_call_id: 'call_read',
        tool_name: 'read',
        status: 'done',
        visible_offset: expect.any(Number),
      }),
      expect.objectContaining({
        tool_call_id: 'call_glob',
        tool_name: 'glob',
        detail: 'src/**/*.ts',
        status: 'done',
      }),
    ]);
  });

  it('tracks active streaming sessions independently and cancels only the targeted one', async () => {
    const fetchMock = mock(async () => ({
      ok: true,
      body: new ReadableStream({
        start() {
          // Keep the stream open until the runtime cancels it.
        },
      }),
      text: async () => '',
      json: async () => ({}),
    }));
    const { __testables, cancelStream, streamChat } = await loadStreamingChat(fetchMock);

    void streamChat({
      sessionId: 'session-a',
      providerId: 'provider-1',
      providerType: 'openai',
      baseUrl: 'https://example.com',
      modelId: 'gpt-4.1',
      messages: [{ role: 'user', content: 'A' }],
      onToken: () => undefined,
      onComplete: () => undefined,
      onError: (error: Error) => {
        throw error;
      },
    });
    void streamChat({
      sessionId: 'session-b',
      providerId: 'provider-1',
      providerType: 'openai',
      baseUrl: 'https://example.com',
      modelId: 'gpt-4.1',
      messages: [{ role: 'user', content: 'B' }],
      onToken: () => undefined,
      onComplete: () => undefined,
      onError: (error: Error) => {
        throw error;
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(__testables.getActiveStreamingSessionIds().sort()).toEqual([
      'session-a',
      'session-b',
    ]);

    cancelStream('session-a');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(__testables.getActiveStreamingSessionIds()).toEqual(['session-b']);

    cancelStream();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(__testables.getActiveStreamingSessionIds()).toEqual([]);
  });

  it('sends Anthropic compatibility headers with streamed chat requests', async () => {
    const encoder = new TextEncoder();
    const fetchMock = mock(
      async (_url: string, init?: { headers?: Record<string, string> }): Promise<unknown> => {
        expect(init?.headers).toMatchObject({
          Authorization: 'Bearer anthropic-key',
          'x-api-key': 'anthropic-key',
          'anthropic-version': '2023-06-01',
        });
        return {
          ok: true,
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode('data: {"choices":[{"delta":{"content":"Bonjour"}}]}\n\n')
              );
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              controller.close();
            },
          }),
          text: async () => '',
          json: async () => ({}),
        };
      }
    );
    const { streamChat } = await loadStreamingChat(fetchMock);

    await streamChat({
      providerId: 'anthropic',
      providerType: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: 'anthropic-key',
      modelId: 'claude-sonnet',
      messages: [{ role: 'user', content: 'Bonjour' }],
      onToken: () => undefined,
      onComplete: () => undefined,
      onError: (error: Error) => {
        throw error;
      },
    });
  });

});
