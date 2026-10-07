import { describe, expect, it, mock } from "bun:test";
import { buildNativeAliasedTools, collectAllowedTools, getFunctionToolName } from "./toolDefinitions";
import { applyEditingStrategyToToolIds } from "../aiEditingStrategy";
import { getImplementAgentToolPolicy, getToolModePolicy } from "../toolModePolicy";
import { runToolCallingLoop } from "./toolCallingLoop";
import { createStreamAccumulator } from "./streamAccumulator";
import type { StreamingChatOptions, ToolResult } from "./contracts";
import { requireMacroToolRegistryEntry, toFunctionToolShape } from "../../shared/macroToolRegistry";

const collect = (ids: string[], extra: Partial<Parameters<typeof collectAllowedTools>[0]> = {}) =>
  collectAllowedTools({ allowedTools: new Set(ids), enableWebFetch: false, enableWebSearch: false, ...extra });
const names = (tools: unknown[]) => tools.map(getFunctionToolName);

describe("tool availability at the model boundary", () => {
  it("uses the native AgSDL tool contracts only when both IDs are allowed", () => {
    const ids = ["agsdl_get", "agsdl_update"] as const;
    const tools = collect([...ids]);
    expect(names(tools)).toEqual([...ids]);
    expect(tools).toEqual(ids.map(id => toFunctionToolShape(requireMacroToolRegistryEntry(id))));
    expect(names(collect(["agsdl_get"]))).toEqual(["agsdl_get"]);
    expect(names(collect([]))).toEqual([]);
  });

  it('refuses a provider batch with a missing call ID before any tool runs', async () => {
    const handler = mock(() => 'unexpected');
    const options: StreamingChatOptions = {
      providerId: 'fixture', providerType: 'openai', modelId: 'model', baseUrl: 'https://example.invalid',
      messages: [], allowedToolIds: ['read'], maxTurns: 1,
      onToken: () => undefined, onComplete: () => undefined, onError: () => undefined,
      onToolCall: handler,
    };
    await expect(runToolCallingLoop(options, {
      kind: 'generic',
      streamTurn: async () => ({
        result: { content: '', toolCalls: [{ id: '', type: 'function', function: { name: 'read', arguments: '{}' } }] },
        projectAssistant: () => ({ items: [] }),
      }),
      projectTool: result => result.content,
      afterToolResults: () => undefined,
    }, createStreamAccumulator(options))).rejects.toThrow('without a stable call ID');
    expect(handler).not.toHaveBeenCalled();
  });

  it('offers bounded MCP discovery on the common transport and rejects hidden direct calls', async () => {
    const mcpTools = Array.from({ length: 13 }, (_, index) => ({
      id: `mcp__fixture__tool_${index}`, serverId: 'fixture', name: `tool_${index}`,
      inputSchema: { type: 'object', properties: {} },
    }));
    const handler = mock(() => 'unexpected');
    const options: StreamingChatOptions = {
      providerId: 'fixture', providerType: 'openai', modelId: 'model', baseUrl: 'https://example.invalid',
      messages: [], allowedToolIds: mcpTools.map(tool => tool.id), mcpTools, maxTurns: 1,
      onToken: () => undefined, onComplete: () => undefined, onError: () => undefined,
      onToolCall: handler,
    };
    const results: ToolResult[] = [];
    await runToolCallingLoop(options, {
      kind: 'generic',
      streamTurn: async ({ tools }) => {
        expect(names(tools)).toEqual(['mcp_search', 'mcp_call']);
        return { result: { content: '', toolCalls: [{ id: 'direct', type: 'function', function: {
          name: mcpTools[0].id, arguments: '{}',
        } }] }, projectAssistant: () => ({ items: [] }) };
      },
      projectTool: result => { results.push(result); return { output: result.content }; },
      afterToolResults: () => undefined,
    }, createStreamAccumulator(options));
    expect(results[0].error_kind).toBe('permission');
    expect(handler).not.toHaveBeenCalled();
  });

  it("keeps permitted write/edit when a patch-first model cannot use apply_patch", () => {
    const allowed = getImplementAgentToolPolicy("build").allowedToolIds.filter(id => id !== "apply_patch");
    const tools = names(collect(applyEditingStrategyToToolIds(allowed, "openai", "gpt-5")));
    expect(tools).toContain("write");
    expect(tools).toContain("edit");
    expect(tools).not.toContain("apply_patch");
  });

  it("preserves independent web, skill and MCP availability gates", () => {
    const ids = ["apply_patch", "ast_grep", "web_search", "web_fetch", "skill_activate", "skill_read_resource", "skill_run_script", "mcp__fixture__read", "not_registered"];
    expect(names(collect(ids))).toEqual(["apply_patch", "ast_grep"]);
    const extra = {
      enableWebSearch: true, enableWebFetch: true,
      webSearchOptions: { configured: true }, skillToolIds: ["fixture"], runnableSkillToolIds: ["trusted"],
      mcpTools: [{ id: "mcp__fixture__read", serverId: "fixture", name: "read", description: "Read fixture", inputSchema: { type: "object", properties: {} } },
        { id: "mcp__fixture__denied", serverId: "fixture", name: "denied", description: "Denied fixture", inputSchema: { type: "object" } }],
    };
    expect(names(collect(ids, extra)).sort()).toEqual(ids.filter(id => id !== "not_registered").sort());
    expect(names(collect([], extra))).toEqual([]);
    expect(names(collect(ids, { enableWebSearch: true }))).not.toContain("web_search");
    expect(names(collect(ids, { skillToolIds: ["fixture"] }))).not.toContain("skill_run_script");
  });

  it.each(["Chat", "plan", "denied", "invalid-patch", "invalid-ast"])("blocks %s calls before a workspace handler", async scenario => {
    const permitted = scenario === "Chat" ? getToolModePolicy("Chat").allowedToolIds
      : scenario === "plan" ? getImplementAgentToolPolicy("plan").allowedToolIds
      : scenario === "denied" ? [] : ["apply_patch", "ast_grep"];
    const allowedToolIds = applyEditingStrategyToToolIds(permitted, "openai", "gpt-5");
    const toolName = scenario === "invalid-ast" ? "ast_grep" : "apply_patch";
    let executed = false;
    const options: StreamingChatOptions = {
      providerId: "fixture", providerType: "openai", modelId: "gpt-5", baseUrl: "https://example.invalid", messages: [], allowedToolIds, maxTurns: 1,
      onToken: () => undefined, onComplete: () => undefined, onError: () => undefined,
      onToolCall: () => { executed = true; return "unexpected"; },
    };
    const results: ToolResult[] = [];
    await runToolCallingLoop(options, {
      kind: "generic",
      streamTurn: async ({ tools }) => {
        if (results.length) return { result: { content: "Done", toolCalls: [] }, projectAssistant: () => ({ items: [] }) };
        if (!scenario.startsWith("invalid")) {
          expect(names(tools)).not.toContain("apply_patch");
          expect(names(tools)).not.toContain("write");
          expect(names(tools)).not.toContain("edit");
        }
        if (scenario === "plan") expect(names(tools)).toContain("ast_grep");
        if (scenario === "Chat") expect(names(tools)).not.toContain("ast_grep");
        return { result: { content: "", toolCalls: [{ id: "call", type: "function", function: {
          name: toolName, arguments: JSON.stringify(scenario.startsWith("invalid") ? { wrong_field: "value" } : { patch_text: "*** Begin Patch\n*** Add File: x\n+x\n*** End Patch" }),
        } }] }, projectAssistant: () => ({ items: [] }) };
      },
      projectTool: result => { results.push(result); return { output: result.content }; },
      afterToolResults: () => undefined,
    }, createStreamAccumulator(options));
    expect(executed).toBe(false);
    expect(results).toHaveLength(1);
    expect(results[0].error_kind).toBe(scenario.startsWith("invalid") ? "validation" : "permission");
  });
});

it.each(['{"results":{"large":{"value":9007199254740993}}}', '{ malformed publication'])('passes publication arguments unchanged to the native collector: %s', async raw => {
  const seen: string[] = [];
  const options: StreamingChatOptions = {
    providerId: 'fixture', providerType: 'openai', modelId: 'model', baseUrl: 'https://example.invalid',
    messages: [], allowedToolIds: [], maxTurns: 1, executionPolicy: 'native-serial',
    onToken: () => undefined, onComplete: () => undefined, onError: () => undefined,
    nativeExecution: {
      publication: { choices: ['done'] },
      beforeRequest: async () => 'registered', requestEnded: async () => undefined, visibleMessage: async () => undefined,
    },
    onRawToolCall: async call => { seen.push(call.function.arguments); return { kind: 'result', result: 'Retained' }; },
  };
  await runToolCallingLoop(options, {
    kind: 'native',
    streamTurn: async ({ tools }) => {
      expect(names(tools)).toEqual(['macro_agsdl_publish']);
      if (seen.length) return { result: { content: 'Done', toolCalls: [] }, projectAssistant: () => ({ items: [] }) };
      return { result: { content: '', toolCalls: [{ id: 'publication', type: 'function', function: {
        name: 'macro_agsdl_publish', arguments: raw,
      } }] }, projectAssistant: () => ({ items: [] }) };
    },
    projectTool: result => result.content, afterToolResults: () => undefined,
  }, createStreamAccumulator(options));
  expect(seen).toEqual([raw]);
  const ordinary = { ...options, executionPolicy: undefined };
  await expect(runToolCallingLoop(ordinary, {
    kind: 'generic', streamTurn: async () => { throw new Error('Unexpected provider request'); },
    projectTool: result => result.content, afterToolResults: () => undefined,
  }, createStreamAccumulator(ordinary))).rejects.toThrow('Publication requires the native execution profile');
});

it('offers captured aliases with real schemas and retains exact alias calls', async () => {
  const raw = '{"path":"file.txt","offset":9007199254740993}';
  const seen: string[] = [];
  const results: ToolResult[] = [];
  const options: StreamingChatOptions = {
    providerId: 'fixture', providerType: 'openai', modelId: 'model', baseUrl: 'https://example.invalid',
    messages: [], allowedToolIds: ['read', 'write'], maxTurns: 1, executionPolicy: 'native-serial',
    onToken: () => undefined, onComplete: () => undefined, onError: () => undefined,
    nativeExecution: {
      toolAliases: [{ name: 'inspect_source', toolId: 'read' }],
      beforeRequest: async () => 'registered', requestEnded: async () => undefined, visibleMessage: async () => undefined,
    },
    onRawToolCall: async call => { seen.push(`${call.function.name}:${call.function.arguments}`); return { kind: 'result', result: 'Exact text' }; },
  };
  const adapter = {
    kind: 'native' as const,
    streamTurn: async ({ tools }: { tools: unknown[] }) => {
      if (seen.length) return { result: { content: 'Done', toolCalls: [] }, projectAssistant: () => ({ items: [] }) };
      const actual = toFunctionToolShape(requireMacroToolRegistryEntry('read'));
      expect(tools).toEqual([{ ...actual, function: { ...actual.function, name: 'inspect_source' } }]);
      return { result: { content: '', toolCalls: [
        { id: 'alias', type: 'function' as const, function: { name: 'inspect_source', arguments: raw } },
        { id: 'canonical', type: 'function' as const, function: { name: 'read', arguments: raw } },
      ] }, projectAssistant: () => ({ items: [] }) };
    },
    projectTool: (result: ToolResult) => { results.push(result); return result.content; }, afterToolResults: () => undefined,
  };
  await runToolCallingLoop(options, adapter, createStreamAccumulator(options));
  expect(seen).toEqual([`inspect_source:${raw}`]);
  expect(results[1].error_kind).toBe('permission');
  const ordinary = { ...options, executionPolicy: undefined };
  await expect(runToolCallingLoop(ordinary, adapter, createStreamAccumulator(ordinary))).rejects.toThrow('Tool aliases require');
});

it.each([
  [{ name: 'macro_agsdl_publish', toolId: 'read' }],
  [{ name: 'a'.repeat(65), toolId: 'read' }],
  [{ name: 'résumé', toolId: 'read' }],
  [{ name: 'a.b', toolId: 'read' }],
  [{ name: 'alias', toolId: 'read' }, { name: 'alias', toolId: 'write' }],
  [{ name: 'alias', toolId: 'delete' }],
  [{ name: 'alias', toolId: 'mcp__unknown' }],
].map(toolAliases => ({ toolAliases })))('rejects an unqualified or colliding alias before the provider request: %j', async ({ toolAliases }) => {
  const provider = mock(async () => { throw new Error('Unexpected provider request'); });
  const options: StreamingChatOptions = {
    providerId: 'fixture', providerType: 'openai', modelId: 'model', baseUrl: 'https://example.invalid',
    messages: [], allowedToolIds: ['read', 'write', 'mcp__unknown'], executionPolicy: 'native-serial',
    onToken: () => undefined, onComplete: () => undefined, onError: () => undefined,
    onRawToolCall: async () => ({ kind: 'result', result: 'Unexpected dispatch' }),
    nativeExecution: { toolAliases, beforeRequest: async () => 'registered', requestEnded: async () => undefined, visibleMessage: async () => undefined },
  };
  await expect(runToolCallingLoop(options, {
    kind: 'native', streamTurn: provider, projectTool: result => result.content, afterToolResults: () => undefined,
  }, createStreamAccumulator(options))).rejects.toThrow();
  expect(provider).not.toHaveBeenCalled();
});

it('keeps the exact 64-character alias at the transport boundary', () => {
  const alias = 'a'.repeat(64);
  const shaped = buildNativeAliasedTools([{ name: alias, toolId: 'read' }], new Set(['read']));
  expect(names(shaped.tools)).toEqual([alias]);
});
