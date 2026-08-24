import { describe, expect, it } from 'bun:test';
import { getToolModePolicy } from '../services/toolModePolicy';
import {
  filterCopilotSupportedToolIds,
  MACRO_TOOL_REGISTRY,
  requireMacroToolRegistryEntry,
  type JsonSchema,
  toCopilotFunctionToolShape,
  toFunctionToolShape,
} from './macroToolRegistry';

const schemaType = (schema: JsonSchema | undefined): string | undefined =>
  schema && 'type' in schema ? schema.type : undefined;

const requireObjectParameters = (toolId: string) => {
  const parameters = requireMacroToolRegistryEntry(toolId).parameters;
  if (!('type' in parameters) || parameters.type !== 'object') {
    throw new Error(`Expected ${toolId} to use an object schema`);
  }
  return parameters;
};

const extractRustPolicyToolIds = (
  source: string,
  functionName: string,
): string[] => {
  const match = source.match(
    new RegExp(
      `fn\\s+${functionName}\\(\\)\\s*->\\s*&'static\\s*\\[&'static\\s*str\\]\\s*\\{\\s*&\\[(.*?)\\]\\s*\\}`,
      's',
    ),
  );

  if (!match?.[1]) {
    throw new Error(`Unable to extract Rust tool policy for ${functionName}`);
  }

  return Array.from(match[1].matchAll(/"([^"]+)"/g), (entry) => entry[1]);
};

describe('macroToolRegistry', () => {
  const copilotBuiltInOverrideToolIds = [
    'web_fetch',
    'read_file',
    'list',
    'read',
    'write',
    'edit',
    'delete',
    'apply_patch',
    'glob',
    'grep',
  ];

  it('contains unique ids', () => {
    const ids = MACRO_TOOL_REGISTRY.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('covers every frontend mode policy tool id', () => {
    const modes = ['Chat', 'Architect', 'Implement'] as const;

    for (const mode of modes) {
      for (const toolId of getToolModePolicy(mode).allowedToolIds) {
        expect(() => requireMacroToolRegistryEntry(toolId)).not.toThrow();
      }
    }
  });

  it('marks tools that shadow Copilot built-ins as explicit overrides', () => {
    for (const toolId of copilotBuiltInOverrideToolIds) {
      expect(requireMacroToolRegistryEntry(toolId).copilot?.overridesBuiltInTool).toBe(true);
    }

    for (const toolId of ['ast_grep', 'git_status', 'terminal_run', 'question']) {
      expect(requireMacroToolRegistryEntry(toolId).copilot?.overridesBuiltInTool).toBeUndefined();
    }
  });

  it('keeps default function tool shapes provider-neutral', () => {
    const shape = toFunctionToolShape(requireMacroToolRegistryEntry('grep'));

    expect(shape.function.name).toBe('grep');
    expect(shape.overridesBuiltInTool).toBeUndefined();
  });

  it('adds Copilot override metadata only for marked tool shapes', () => {
    const grepShape = toCopilotFunctionToolShape(requireMacroToolRegistryEntry('grep'));
    const webFetchShape = toCopilotFunctionToolShape(requireMacroToolRegistryEntry('web_fetch'));
    const gitShape = toCopilotFunctionToolShape(requireMacroToolRegistryEntry('git_status'));

    expect(grepShape.overridesBuiltInTool).toBe(true);
    expect(webFetchShape.overridesBuiltInTool).toBe(true);
    expect(gitShape.overridesBuiltInTool).toBeUndefined();
  });

  it('registers the delete workspace tool', () => {
    expect(() => requireMacroToolRegistryEntry('delete')).not.toThrow();
  });

  it('publishes optimistic revision guards for every workspace mutation', () => {
    for (const toolId of ['write', 'edit', 'delete']) {
      const parameters = requireObjectParameters(toolId);
      expect(schemaType(parameters.properties?.expected_revision)).toBe('string');
    }

    const patchParameters = requireObjectParameters('apply_patch');
    const revisions = patchParameters.properties?.expected_revisions;
    expect(schemaType(revisions)).toBe('object');
    if (revisions && 'type' in revisions && revisions.type === 'object') {
      expect(revisions.additionalProperties).toMatchObject({ type: 'string' });
    }
  });

  it('publishes bounded, resumable arguments for workspace read tools', () => {
    for (const toolId of ['list', 'glob', 'grep', 'ast_grep', 'git_status', 'git_log'] as const) {
      const parameters = requireObjectParameters(toolId);
      expect(schemaType(parameters.properties?.limit)).toBe('number');
      expect(schemaType(parameters.properties?.cursor)).toBe('string');
    }

    const read = requireObjectParameters('read');
    expect(schemaType(read.properties?.max_lines)).toBe('number');
    expect(schemaType(read.properties?.cursor)).toBe('string');

    const diff = requireObjectParameters('git_diff');
    expect(diff.properties?.mode).toMatchObject({
      type: 'string',
      enum: ['patch', 'stat', 'name_only'],
    });
    expect(schemaType(diff.properties?.require_complete)).toBe('boolean');
  });

  it('keeps project identity out of the agent terminal contract', () => {
    const terminal = requireMacroToolRegistryEntry('terminal_create_session');

    const { parameters } = terminal;
    expect('type' in parameters && parameters.type).toBe('object');
    if (!('type' in parameters) || parameters.type !== 'object') {
      throw new Error('Expected terminal_create_session to use an object schema');
    }
    expect(parameters.required).toEqual([]);
    expect(parameters.properties).toHaveProperty('cwd');
    expect(parameters.properties).not.toHaveProperty('project_id');
    expect(terminal.description).toContain('independent');
  });

  it('filters Copilot tools to the currently supported Macro runtime surface', () => {
    expect(
      filterCopilotSupportedToolIds([
        'read_file',
        'web_search',
        'plan_get',
        'strategy_generate',
        'ast_grep',
        'git_status',
        'terminal_run',
      ])
    ).toEqual([
      'read_file',
      'plan_get',
      'strategy_generate',
      'ast_grep',
      'git_status',
      'terminal_run',
    ]);
  });

  it('keeps the Rust tool policy aligned with the frontend fallback policy', async () => {
    const rustPolicySource = await Bun.file(
      new URL('../../src-tauri/src/core/tool_policy.rs', import.meta.url),
    ).text();
    const rustPolicies = {
      Chat: extractRustPolicyToolIds(rustPolicySource, 'chat_allowed_tool_ids'),
      Architect: extractRustPolicyToolIds(
        rustPolicySource,
        'architect_allowed_tool_ids',
      ),
      Implement: extractRustPolicyToolIds(
        rustPolicySource,
        'implement_allowed_tool_ids',
      ),
    } as const;

    for (const mode of ['Chat', 'Architect', 'Implement'] as const) {
      expect(rustPolicies[mode].sort()).toEqual(
        [...getToolModePolicy(mode).allowedToolIds].sort(),
      );
    }
  });
});
