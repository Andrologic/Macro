import { beforeEach, describe, expect, it, mock } from 'bun:test';

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
        },
    }),
    aiCancelStream: async (requestId: string) =>
      invokeImpl('ai_cancel_stream', { requestId }),
  };
  mock.module('./tauriIpc', () => tauriIpcMock);
  mock.module('../services/tauriIpc', () => tauriIpcMock);
  mock.module('./architectChat', () => ({
    ARCHITECT_POST_TOOL_RETRY_SYSTEM_PROMPT:
      'After using tools, provide a concise recap to the user.',
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
    const planTitleProperty = asObjectSchema(GENERATE_PLAN_TOOL.function.parameters).properties
      .plan_title as { description?: string };

    expect(String(GENERATE_PLAN_TOOL.function.description)).toContain('branchType + branchSlug');
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
      'never rename the canonical id or slug'
    );
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

  it('maps reasoning request parameters by provider type', async () => {
    const { __testables } = await loadStreamingChat();

    const openAiBody: Record<string, unknown> = {};
    __testables.applyReasoningToChatCompletionsRequest(openAiBody, 'openai', 'medium');
    expect(openAiBody.reasoning_effort).toBe('medium');

    const openRouterBody: Record<string, unknown> = {};
    __testables.applyReasoningToChatCompletionsRequest(openRouterBody, 'openrouter', 'high');
    expect(openRouterBody.reasoning).toEqual({ effort: 'high' });
    expect(openRouterBody.include_reasoning).toBe(true);
  });

  it('detects unsupported reasoning parameter errors', async () => {
    const { __testables } = await loadStreamingChat();
    expect(__testables.isReasoningUnsupportedError('Unknown parameter: reasoning_effort')).toBe(true);
    expect(__testables.isReasoningUnsupportedError('Unsupported value for reasoning')).toBe(true);
    expect(__testables.isReasoningUnsupportedError('Request failed: 500')).toBe(false);
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

});
