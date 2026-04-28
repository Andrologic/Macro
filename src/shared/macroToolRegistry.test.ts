import { describe, expect, it } from 'bun:test';
import { getToolModePolicy } from '../services/toolModePolicy';
import {
  filterCopilotSupportedToolIds,
  MACRO_TOOL_REGISTRY,
  requireMacroToolRegistryEntry,
  toCopilotFunctionToolShape,
  toFunctionToolShape,
} from './macroToolRegistry';

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

    for (const toolId of ['git_status', 'terminal_run', 'question']) {
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

  it('filters Copilot tools to the currently supported Macro runtime surface', () => {
    expect(
      filterCopilotSupportedToolIds([
        'read_file',
        'web_search',
        'plan_get',
        'need_add',
        'strategy_generate',
        'git_status',
        'terminal_run',
      ])
    ).toEqual([
      'read_file',
      'plan_get',
      'need_add',
      'strategy_generate',
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
