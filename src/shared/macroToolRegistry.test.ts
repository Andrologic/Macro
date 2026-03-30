import { describe, expect, it } from 'bun:test';
import { getToolModePolicy } from '../services/toolModePolicy';
import {
  filterCopilotSupportedToolIds,
  MACRO_TOOL_REGISTRY,
  requireMacroToolRegistryEntry,
} from './macroToolRegistry';

describe('macroToolRegistry', () => {
  it('contains unique ids', () => {
    const ids = MACRO_TOOL_REGISTRY.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('covers every frontend mode policy tool id', () => {
    const modes = ['Chat', 'Architect', 'Implement', 'Debug'] as const;

    for (const mode of modes) {
      for (const toolId of getToolModePolicy(mode).allowedToolIds) {
        expect(() => requireMacroToolRegistryEntry(toolId)).not.toThrow();
      }
    }
  });

  it('marks read_file as overriding the Copilot built-in tool', () => {
    expect(requireMacroToolRegistryEntry('read_file').copilot?.overridesBuiltInTool).toBe(true);
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
});
