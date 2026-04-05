import { beforeEach, describe, expect, it, mock } from 'bun:test';

let streamingChatImportCounter = 0;

const loadStreamingChat = async () => {
  mock.restore();
  mock.module('@tauri-apps/api/core', () => ({
    invoke: mock(async () => undefined),
  }));
  mock.module('@tauri-apps/api/event', () => ({
    listen: mock(async () => () => undefined),
  }));
  mock.module('@tauri-apps/plugin-http', () => ({
    fetch: mock(async () => {
      throw new Error('HTTP fetch should not be called in streamingChat unit tests.');
    }),
  }));
  mock.module('../stores/useProviderStore', () => ({
    useProviderStore: {
      getState: () => ({
        markReasoningUnsupportedForModel: () => undefined,
      }),
    },
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
});
