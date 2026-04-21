import { describe, expect, it } from 'bun:test';
import { getToolModePolicy } from '../services/toolModePolicy';
import {
  filterCopilotSupportedToolIds,
  MACRO_TOOL_REGISTRY,
  requireMacroToolRegistryEntry,
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

  it('marks read_file as overriding the Copilot built-in tool', () => {
    expect(requireMacroToolRegistryEntry('read_file').copilot?.overridesBuiltInTool).toBe(true);
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
        'git_status',
        'terminal_run',
      ])
    ).toEqual(['read_file', 'git_status', 'terminal_run']);
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
