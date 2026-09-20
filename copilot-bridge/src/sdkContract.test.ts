import { describe, expect, it } from 'bun:test';
import { MACRO_TOOL_REGISTRY, filterCopilotSupportedToolIds } from '../../src/shared/macroToolRegistry';

process.env.MACRO_COPILOT_BRIDGE_TEST_IMPORT = '1';
const { __testables } = await import('./index');

describe('installed Copilot SDK contract', () => {
  it('passes supported reasoning efforts unchanged and rejects values outside the SDK contract', () => {
    for (const effort of ['low', 'medium', 'high', 'xhigh'] as const) {
      expect(__testables.parseSdkReasoningEffort(effort)).toBe(effort);
    }
    for (const absent of [undefined, null, '']) {
      expect(__testables.parseSdkReasoningEffort(absent)).toBeUndefined();
    }
    for (const invalid of ['max', 'minimal', 'HIGH', 1, {}]) {
      expect(() => __testables.parseSdkReasoningEffort(invalid)).toThrow('Invalid reasoning_effort value');
    }
  });

  it('validates the unknown SDK tool argument envelope before invoking the relay', async () => {
    const [tool] = __testables.buildMacroTools({
      request_id: 'request', model_id: 'model', messages: [], allowed_tool_ids: ['read_file'],
    });
    const invocation = { sessionId: 'session', toolCallId: 'call', toolName: tool.name, arguments: {} };
    for (const invalid of [null, [], 'text', 1]) {
      await expect(tool.handler(invalid, invocation)).resolves.toBe('Error executing read_file: Tool arguments must be an object.');
    }
    await expect(tool.handler({ path: 'README.md' }, invocation)).resolves.toContain('Macro frontend relay is unavailable');
  });
});

it('documents advertised Copilot tools that still have no execution route', async () => {
  const ids = filterCopilotSupportedToolIds(MACRO_TOOL_REGISTRY.map((entry) => entry.id));
  const local = new Set(['mark_source_passage', 'read_sources', 'edit_source_passage', 'git_status', 'git_log', 'git_diff']);
  const unsupported = ids.filter((id) => !__testables.isFrontendRelayToolId(id) && !local.has(id));
  expect(unsupported.sort()).toEqual([
    'config_get', 'config_list', 'config_patch', 'config_validate',
    'skill_activate', 'skill_read_resource', 'skill_run_script',
    'task_artifact_get', 'task_artifact_list', 'task_artifact_put', 'task_todo_get', 'task_todo_update',
  ]);
  const tools = __testables.buildMacroTools({ model_id: 'model', messages: [], allowed_tool_ids: unsupported });
  expect(tools.map((tool) => tool.name).sort()).toEqual(unsupported);
  for (const tool of tools) {
    const result = await tool.handler({}, { sessionId: 'session', toolCallId: 'call', toolName: tool.name, arguments: {} });
    expect(result).toBe(`Error executing ${tool.name}: Macro AI runtime does not support tool "${tool.name}" yet.`);
  }
});
