import { describe, expect, it, mock } from "bun:test";
import { collectAllowedTools, getFunctionToolName } from "./toolDefinitions";
import { applyEditingStrategyToToolIds } from "../aiEditingStrategy";
import { getImplementAgentToolPolicy, getToolModePolicy } from "../toolModePolicy";
import { runToolCallingLoop } from "./toolCallingLoop";
import { createStreamAccumulator } from "./streamAccumulator";
import type { StreamingChatOptions, ToolResult } from "./contracts";

const collect = (ids: string[], extra: Partial<Parameters<typeof collectAllowedTools>[0]> = {}) =>
  collectAllowedTools({ allowedTools: new Set(ids), enableWebFetch: false, enableWebSearch: false, ...extra });
const names = (tools: unknown[]) => tools.map(getFunctionToolName);

describe("tool availability at the model boundary", () => {
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
