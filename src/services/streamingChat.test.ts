import { describe, expect, it } from 'bun:test';
import {
  __testables,
  CREATE_PLAN_TOOL,
  GENERATE_PLAN_TOOL,
  UPDATE_PLAN_TOOL,
} from './streamingChat';

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
  it('does not require title for plan_create and exposes label support', () => {
    const { properties, required = [] } = asObjectSchema(CREATE_PLAN_TOOL.function.parameters);

    expect(required).not.toContain('title');
    expect(properties.label).toBeDefined();
    expect(String(CREATE_PLAN_TOOL.function.description)).toContain('generated identifier');
  });

  it('documents plan_title as a label alias for strategy generation', () => {
    const planTitleProperty = asObjectSchema(GENERATE_PLAN_TOOL.function.parameters).properties
      .plan_title as { description?: string };

    expect(String(GENERATE_PLAN_TOOL.function.description)).toContain('branchType + branchSlug');
    expect(String(planTitleProperty.description)).toContain('secondary plan label');
  });

  it('documents plan_update title as a legacy alias without changing canonical ids', () => {
    const properties = asObjectSchema(UPDATE_PLAN_TOOL.function.parameters).properties as Record<
      string,
      { description?: string }
    >;

    expect(properties.label).toBeDefined();
    expect(String(properties.title.description).toLowerCase()).toContain('legacy alias');
    expect(properties.status).toBeUndefined();
    expect(properties.set_active).toBeUndefined();
    expect(String(UPDATE_PLAN_TOOL.function.description)).toContain('never rename the canonical id or slug');
  });
});

describe('streamingChat tool rendering helpers', () => {
  it('formats short tool details for file reads and web search', () => {
    expect(__testables.formatToolTraceDetail('read', { path: 'src/app.ts' })).toBe('src/app.ts');
    expect(__testables.formatToolTraceDetail('read_file', { file: 'README.md' })).toBe('README.md');
    expect(__testables.formatToolTraceDetail('web_search', { query: 'macro desktop app' })).toBe(
      'macro desktop app'
    );
  });

  it('stores raw tool results in hidden tool context blocks', () => {
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

  it('retries once when a required native tool was not used', () => {
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
});
