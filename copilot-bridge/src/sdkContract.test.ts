import { describe, expect, it, mock } from 'bun:test';
import type { PermissionRequest, ToolInvocation } from '@github/copilot-sdk';
import { MACRO_TOOL_REGISTRY, filterCopilotSupportedToolIds, requireMacroToolRegistryEntry, toFunctionToolShape } from '../../src/shared/macroToolRegistry';
import { collectAllowedTools } from '../../src/services/ai/toolDefinitions';
import type { BridgeControlChannel } from './controlChannel';

process.env.MACRO_COPILOT_BRIDGE_TEST_IMPORT = '1';
const { __testables } = await import('./index');
const definitions = (ids: string[]) => ids.map(id => toFunctionToolShape(requireMacroToolRegistryEntry(id)));
const invocation = (name: string, args: Record<string, unknown> = {}): ToolInvocation => ({
  sessionId: 'session', toolCallId: `call-${name}`, toolName: name, arguments: args,
});
const unsupported = [
  'config_get', 'config_list', 'config_patch', 'config_validate',
  'skill_activate', 'skill_read_resource', 'skill_run_script',
  'task_artifact_get', 'task_artifact_list', 'task_artifact_put', 'task_todo_get', 'task_todo_update',
];

describe('installed Copilot SDK contract', () => {
  it('passes supported reasoning efforts unchanged and rejects values outside the SDK contract', () => {
    for (const effort of ['low', 'medium', 'high', 'xhigh'] as const) {
      expect(__testables.parseSdkReasoningEffort(effort)).toBe(effort);
    }
    for (const absent of [undefined, null, '']) expect(__testables.parseSdkReasoningEffort(absent)).toBeUndefined();
    for (const invalid of ['max', 'minimal', 'HIGH', 1, {}]) {
      expect(() => __testables.parseSdkReasoningEffort(invalid)).toThrow('Invalid reasoning_effort value');
    }
  });

  it('validates the unknown SDK tool argument envelope before invoking the relay', async () => {
    const [tool] = __testables.buildMacroTools({
      request_id: 'request', model_id: 'model', messages: [], allowed_tool_ids: ['read_file'], tools: definitions(['read_file']),
    });
    for (const invalid of [null, [], 'text', 1]) {
      await expect(tool.handler(invalid, invocation(tool.name))).resolves.toBe('Error executing read_file: Tool arguments must be an object.');
    }
    await expect(tool.handler({ file: 'README.md' }, invocation(tool.name))).resolves.toContain('Macro frontend relay is unavailable');
  });

  it('excludes all twelve unsupported routes even when both supplied and allowed', () => {
    const tools = __testables.buildMacroTools({
      model_id: 'model', messages: [], allowed_tool_ids: unsupported, tools: definitions(unsupported),
    });
    expect(tools).toEqual([]);
    expect(filterCopilotSupportedToolIds(unsupported)).toEqual([]);
  });

  it('keeps the frontend web exclusion and schema at the SDK builder boundary', () => {
    const tools = collectAllowedTools({ allowedTools: new Set(['web_fetch', 'ast_grep']), enableWebFetch: false, enableWebSearch: false }) as ReturnType<typeof definitions>;
    tools[0].function.parameters = { type: 'object', properties: { pattern: { type: 'string', enum: ['fixture'] } }, required: ['pattern'] };
    const sdkTools = __testables.buildMacroTools({ model_id: 'model', messages: [], allowed_tool_ids: ['web_fetch', 'ast_grep'], tools });
    expect(sdkTools.map(tool => tool.name)).toEqual(['ast_grep']);
    expect(sdkTools[0].parameters).toEqual(tools[0].function.parameters);
  });

  it.each([false, true])('preserves web availability %s and scoped schemas through the session configuration and handler', async enabled => {
    const allowed = ['web_fetch', 'skill_activate', 'skill_read_resource', 'skill_run_script', 'apply_patch', 'ast_grep'];
    const tools = collectAllowedTools({
      allowedTools: new Set(allowed), enableWebFetch: enabled, enableWebSearch: false,
      skillToolIds: ['approved-skill'], runnableSkillToolIds: ['trusted-skill'],
    }) as ReturnType<typeof definitions>;
    // Exercise a narrowed schema on an executable route. Skills are unsupported,
    // so their narrowed definitions must stay absent rather than reappear unfiltered.
    const ast = tools.find(tool => tool.function.name === 'ast_grep')!;
    ast.function.parameters = { type: 'object', properties: {
      pattern: { type: 'string', enum: ['console.log($$$ARGS)'] },
    }, required: ['pattern'] };
    ast.function.description = 'Scoped structural search';
    const requestTool = mock(async (request: { toolName: string }) => request.toolName === 'web_fetch'
      ? { result: 'Web request denied by Macro', isError: true, errorKind: 'permission', interrupt: false }
      : { result: 'frontend-result', interrupt: false });
    const config = __testables.buildSessionToolConfig({
      request_id: 'request', model_id: 'model', messages: [], allowed_tool_ids: allowed, tools,
    }, { controlChannel: { requestTool } as unknown as BridgeControlChannel });
    const expected = ['apply_patch', 'ast_grep', ...(enabled ? ['web_fetch'] : [])].sort();
    expect(config.tools!.map(tool => tool.name).sort()).toEqual(expected);
    expect([...config.availableTools!].sort()).toEqual(expected);
    const sdkAst = config.tools!.find(tool => tool.name === 'ast_grep')!;
    expect(sdkAst.parameters).toEqual(ast.function.parameters);
    expect(sdkAst.description).toBe(ast.function.description);
    const args = { pattern: 'console.log($$$ARGS)' };
    await expect(sdkAst.handler(args, invocation('ast_grep', args))).resolves.toBe('frontend-result');
    expect(requestTool).toHaveBeenLastCalledWith(expect.objectContaining({ toolName: 'ast_grep', args }));
    if (enabled) {
      const web = config.tools!.find(tool => tool.name === 'web_fetch')!;
      await expect(web.handler({ url: 'https://example.invalid' }, invocation('web_fetch'))).resolves.toMatchObject({
        resultType: 'denied', textResultForLlm: 'Web request denied by Macro',
      });
    }
    const skill = tools.find(tool => tool.function.name === 'skill_activate')!;
    expect(skill.function.parameters).toMatchObject({ properties: { skill_id: { enum: ['approved-skill'] } } });
    const permission = (name: string) => config.onPermissionRequest!({ kind: 'custom-tool', toolName: name } as PermissionRequest, { sessionId: 'session' });
    expect(await permission('web_fetch')).toEqual({ kind: enabled ? 'approved' : 'denied-no-approval-rule-and-could-not-request-from-user' });
    expect(await permission('ast_grep')).toEqual({ kind: 'approved' });
    for (const id of ['skill_activate', 'skill_read_resource', 'skill_run_script', 'write', 'edit']) {
      expect(await permission(id)).toEqual({ kind: 'denied-no-approval-rule-and-could-not-request-from-user' });
    }
    expect(await config.onPermissionRequest!({ kind: 'shell' } as PermissionRequest, { sessionId: 'session' })).toEqual({ kind: 'denied-no-approval-rule-and-could-not-request-from-user' });
  });

  it('requires both the supplied catalogue and the allowlist, rejecting ambiguous definitions', () => {
    const base = { model_id: 'model', messages: [] };
    expect(__testables.buildMacroTools({ ...base, allowed_tool_ids: ['web_fetch'] })).toEqual([]);
    expect(__testables.buildMacroTools({ ...base, allowed_tool_ids: ['web_fetch'], tools: [] })).toEqual([]);
    expect(__testables.buildMacroTools({ ...base, allowed_tool_ids: [], tools: definitions(['web_fetch']) })).toEqual([]);
    expect(__testables.buildMacroTools({ ...base, allowed_tool_ids: ['web_fetch', 'web_fetch'], tools: definitions(['web_fetch']) })).toHaveLength(1);
    expect(() => __testables.buildMacroTools({ ...base, allowed_tool_ids: ['web_fetch'], tools: definitions(['web_fetch', 'web_fetch']) })).toThrow('Duplicate Macro tool web_fetch');
    expect(() => __testables.buildMacroTools({ ...base, allowed_tool_ids: ['web_fetch'], tools: [{ type: 'function', function: { name: 'web_fetch', parameters: null } }] })).toThrow('Invalid Macro schema');
    expect(__testables.buildMacroTools({ ...base, allowed_tool_ids: ['unknown'], tools: [{ type: 'function', function: { name: 'unknown', parameters: {} } }] })).toEqual([]);
  });

  it('dispatches every advertised SDK tool to a frontend, local source, or tool-host route', async () => {
    const ids = filterCopilotSupportedToolIds(MACRO_TOOL_REGISTRY.map(entry => entry.id));
    const requestTool = mock(async () => ({ result: 'relayed', interrupt: false }));
    const tools = __testables.buildMacroTools({ model_id: 'model', messages: [], allowed_tool_ids: ids, tools: definitions(ids) }, {
      controlChannel: { requestTool } as unknown as BridgeControlChannel,
    });
    expect(tools.map(tool => tool.name)).toEqual(ids);
    const local = new Set(['mark_source_passage', 'read_sources', 'edit_source_passage']);
    for (const tool of tools) {
      requestTool.mockClear();
      const result = await tool.handler({}, invocation(tool.name));
      if (__testables.isFrontendRelayToolId(tool.name)) {
        expect(result).toBe('relayed');
        expect(requestTool).toHaveBeenCalledTimes(1);
        expect(requestTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: tool.name, args: {} }));
      } else if (local.has(tool.name)) {
        if (tool.name === 'read_sources') expect(JSON.parse(String(result))).toEqual({ total: 0, passages: [] });
        if (tool.name === 'mark_source_passage') expect(result).toBe('Error executing mark_source_passage: mark_source_passage requires both title and passage.');
        if (tool.name === 'edit_source_passage') expect(result).toBe('Error executing edit_source_passage: edit_source_passage requires citation_id and action.');
        expect(requestTool).not.toHaveBeenCalled();
      } else {
        expect(['git_status', 'git_log', 'git_diff']).toContain(tool.name);
        expect(result).toBe(`Error executing ${tool.name}: No workspace is configured for this Copilot request.`);
      }
    }
  });
});
