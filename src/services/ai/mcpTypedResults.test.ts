import { projectCopilotMessageContent } from './copilotPromptCodec';
import { expect, test } from 'bun:test';
import fixture from '../../../src-tauri/src/commands/mcp/fixtures/typed-result.json';
import { normalizeToolResultBlocks, projectToolResultText, readTypedToolResult, MAX_TOOL_RESULT_BYTES } from '../../shared/toolResultContent';
import { callScopedMcpTool, resolveScopedMcpRuntime, type ScopedMcpRuntimeDeps } from '../scopedMcpRuntime';
import { runToolBatch } from './toolCallRunner';
import { buildToolChatCompletionProviderItem, buildChatCompletionMessages, resolveChatCompletionProviderProfile } from './chatCompletionsCodec';
import { buildFunctionCallOutputProviderInputItem } from './responsesCodec';
import { parseDbProviderInputItems } from '../chatDbMappers';
import { preserveToolResultContent, buildSpilledToolResultPreview } from '../toolResultArtifacts';
import { decodeToolResultMessage } from '../../../copilot-bridge/src/protocol';
import { toSdkToolResult } from '../../../copilot-bridge/src/sdkToolResult';
import type { ToolResultResolution } from './contracts';

const blocks = normalizeToolResultBlocks(fixture.content);
const toolName = 'mcp__fixture__read';
const call = { id: 'call-fixture', type: 'function' as const, function: { name: toolName, arguments: '{}' } };
const profile = resolveChatCompletionProviderProfile({ providerType: 'openai', modelId: 'fixture' });

async function execute() {
  const deps: ScopedMcpRuntimeDeps = {
    mcpRuntimeConnect: async selector => ({ key: { ...selector, projectId: null, configGeneration: 1 }, status: 'ready', requestedProtocolMode: null, negotiatedEra: null, negotiatedProtocolVersion: null, protocolDecisionReason: null, lastError: null, updatedAt: '' }),
    mcpRuntimeRefreshCatalog: async key => ({ key, tools: [{ id: toolName, serverId: 'fixture', name: 'read', enabled: true }], refreshedAt: '' }),
    mcpRuntimeCallTool: async () => ({ content: projectToolResultText(blocks), blocks, isError: fixture.isError }),
    mcpRuntimeCancelOperation: async () => true,
  };
  const runtime = await resolveScopedMcpRuntime({ fixture: { enabled: true, transport: { type: 'stdio', command: 'never-executed' } } }, [], { deps });
  const result = await runToolBatch({
    calls: [call], messages: [], allowedTools: new Set([toolName]), schemas: new Map(), batchId: 'fixture', usedToolNames: new Set(),
    options: { providerId: 'fixture', providerType: 'openai', baseUrl: 'https://example.invalid', modelId: 'fixture', messages: [], onToken() {}, onComplete() {}, onError() {}, onToolCall: (name, args) => callScopedMcpTool(name, args, runtime.servers, { deps }) },
    accumulator: { beginToolTrace() {}, completeToolTrace() {}, addHiddenToolContext() {}, addHiddenContextBlock() {}, appendSystemChunk() {} },
  });
  return result.toolResults[0];
}

test('scoped IPC result survives collection, persisted JSON reload, and actual codec projection', async () => {
  const result = await execute();
  expect(JSON.stringify(result.blocks)).toBe(JSON.stringify(fixture.content));
  expect(result.is_error).toBe(true);
  for (const item of [buildToolChatCompletionProviderItem(call.id, result.content, toolName, result.blocks, result.is_error), buildFunctionCallOutputProviderInputItem(call.id, result.content, result.blocks, result.is_error)]) {
    const reloaded = parseDbProviderInputItems(JSON.stringify([item]))!;
    expect(readTypedToolResult(reloaded[0])).toEqual({ version: 1, blocks, isError: true });
  }
  const stored = buildToolChatCompletionProviderItem(call.id, result.content, toolName, result.blocks, result.is_error);
  const payload = buildChatCompletionMessages([{ role: 'assistant', content: '', tool_calls: [call] }, { role: 'tool', content: result.content, tool_call_id: call.id, provider_input_items: [stored] }], profile);
  expect(payload[1].content).toContain('not sent as media by Chat Completions');
  expect(payload[1].content).toContain('MCP tool reported an error');
  expect(JSON.stringify(payload)).not.toContain(blocks[1].type === 'image' ? blocks[1].data : 'INVALID');
  expect(payload[1].role).toBe('tool');
  expect(payload.some(item => item.role === 'system')).toBe(false);
});

test('Copilot decoder and installed SDK payload retain image/audio and error status', () => {
  const decoded = decodeToolResultMessage({ type: 'tool_result', request_id: 'r', tool_call_id: call.id, result: projectToolResultText(blocks), blocks, is_error: true })!;
  const result = toSdkToolResult({ result: decoded.result!, blocks: decoded.blocks, isError: decoded.is_error });
  expect(result).toMatchObject({ binaryResultsForLlm: fixture.content.slice(1), resultType: 'failure' });
  expect(typeof result === 'object' && result.textResultForLlm).toContain('supplied as a binary tool result');
});

test('typed text spill preserves binary blocks and makes unavailable persistence explicit', async () => {
  const result = 'long result '.repeat(10000);
  const resolution: ToolResultResolution = { kind: 'result', result, blocks: [{ type: 'text', text: result }, ...blocks.slice(1)], isError: true };
  for (const artifactPath of ['tool-output://fixture/result.txt', null]) {
    const preserved = await preserveToolResultContent(toolName, resolution, async text => buildSpilledToolResultPreview({ toolName, result: text, artifactPath }).preview) as ToolResultResolution;
    expect(preserved.blocks?.slice(1)).toEqual(blocks.slice(1));
    expect(preserved.isError).toBe(true);
    expect(preserved.result).toContain(artifactPath ? 'Full output: tool-output://' : 'Full output unavailable');
    if (!artifactPath) expect(preserved.result).not.toContain('Use read_file');
  }
});

test('legacy text history remains readable without media metadata', () => {
  const item = buildToolChatCompletionProviderItem(call.id, 'legacy result', toolName);
  expect(readTypedToolResult(parseDbProviderInputItems(JSON.stringify([item]))![0])).toBeUndefined();
  const payload = buildChatCompletionMessages([{ role: 'assistant', content: '', tool_calls: [call] }, { role: 'tool', content: '', provider_input_items: [item] }], profile);
  expect(payload[1].content).toBe('legacy result');
});

test('invalid MIME/base64/type and oversize media become bounded explicit omissions', () => {
  for (const item of [ { type: 'image', mimeType: 'text/html', data: 'aGk=' }, { type: 'audio', mimeType: 'audio/wav', data: '!!!!' }, { type: 'image', mimeType: 'image/png', data: 'a'.repeat(MAX_TOOL_RESULT_BYTES + 1) }, { type: 'resource_link', uri: 'file:///private/fixture' } ]) {
    const normalized = normalizeToolResultBlocks([item]);
    expect(normalized[0].type).toBe('unavailable');
    expect(JSON.stringify(normalized).length).toBeLessThan(200);
  }
});

test('Responses media history keeps parallel calls paired when replayed through Chat Completions', () => {
  const items = [
    { type: 'function_call', call_id: 'c1', name: toolName, arguments: '{}' },
    { type: 'function_call', call_id: 'c2', name: toolName, arguments: '{}' },
    buildFunctionCallOutputProviderInputItem('c1', 'fallback', blocks, true),
    buildFunctionCallOutputProviderInputItem('c2', 'fallback', blocks),
  ];
  const payload = buildChatCompletionMessages([{ role: 'assistant', content: '', provider_input_items: items }], profile);
  expect(payload.map(item => item.role)).toEqual(['assistant', 'tool', 'tool']);
  expect(payload[1].tool_call_id).toBe('c1');
  expect(payload[2].tool_call_id).toBe('c2');
  expect(JSON.stringify(payload)).not.toContain('Tool execution aborted');
  expect(payload[1].content).toContain('not sent as media');
});

for (const type of ['text', 'image', 'audio'] as const) {
  test(`preserves a standalone ${type} result through persisted IPC output and the SDK`, () => {
    const single = normalizeToolResultBlocks(fixture.content.filter(block => block.type === type));
    const item = buildFunctionCallOutputProviderInputItem('single', projectToolResultText(single), single);
    const stored = readTypedToolResult(parseDbProviderInputItems(JSON.stringify([item]))![0])!;
    expect(stored.blocks).toEqual(single);
    const sdk = toSdkToolResult({ result: projectToolResultText(single), blocks: stored.blocks, isError: false });
    expect(sdk).toMatchObject({ resultType: 'success' });
    if (typeof sdk !== 'object') throw new Error('Expected typed SDK output');
    expect(sdk.binaryResultsForLlm?.length ?? 0).toBe(type === 'text' ? 0 : 1);
  });
}

test('the byte budget is shared across blocks and excess block count stays explicit', () => {
  const half = MAX_TOOL_RESULT_BYTES / 2;
  const limited = normalizeToolResultBlocks([{ type: 'text', text: 'a'.repeat(half) }, { type: 'image', mimeType: 'image/png', data: 'AAAA'.repeat(half / 4 + 1) }]);
  expect(limited[1].type).toBe('unavailable');
  const many = normalizeToolResultBlocks(Array.from({ length: 65 }, () => ({ type: 'text', text: '' })));
  expect(many.at(-1)).toMatchObject({ type: 'unavailable' });
  expect(projectToolResultText(many)).toContain('64 block limit');
});


test('tool metadata cannot inject remote result text into Copilot system instructions', () => {
  const item = buildFunctionCallOutputProviderInputItem('c', 'fallback', blocks);
  expect(projectCopilotMessageContent({ role: 'system', content: 'Trusted instructions', provider_input_items: [item] })).toBe('Trusted instructions');
});
