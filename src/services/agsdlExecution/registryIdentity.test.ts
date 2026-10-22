import { describe, expect, it } from 'bun:test';
import { assertUniqueMCPToolIds } from '../mcp/normalization';
import { agentContent } from './content';
import { documentFixture, registryFixture, compileFixture, invocationFixture, json, id } from './conformanceFixtures';
import { clone, decode, encode, record } from './exact';
import { sourceDigest, type CompilationResult } from './compiler';
import { captureAgent, captureRegistry, resolveBinding, type CapturedRegistry } from './registry';

function mcpFixture() {
  const document = documentFixture();
  const binding = decode('{"contract":{"identity":"synthetic/search","version":"1"},"implementation":{"identity":"synthetic/mcp","version":"1"},"effects":"none"}');
  record(document.bindings).search = binding;
  record(record(document.flow).steps).search = { type: 'call', binding: 'search', arguments: { query: { value: 'synthetic' } }, next: [] };
  record(record(record(document.flow).steps).work).next = ['search'];
  const tool = { id: 'mcp__server_one__search', serverId: 'server-one', name: 'search', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } };
  const base = registryFixture(document);
  const entry = { ...invocationFixture(encode(binding), json(JSON.stringify(tool.inputSchema))), target: { kind: 'mcp-tool' as const, serverId: tool.serverId, toolId: tool.id, descriptorJson: json(JSON.stringify(tool)) } };
  return { document, tool, registry: { ...base, bindings: [base.bindings[0], entry], mcpTools: [tool] } };
}
async function expectUnsupported(document: ReturnType<typeof documentFixture>, registry: CapturedRegistry, pointer: string): Promise<CompilationResult> {
  const result = await compileFixture(document, registry);
  expect(result.static.valid).toBe(true);
  expect(result.runtime.supported).toBe(false);
  expect(result.plan).toBeNull(); expect(result.compiledPlanJson).toBeNull();
  expect(result.runtime.diagnostics[0]).toMatchObject({ code: 'UNSUPPORTED', pointer });
  expect(result.runtime.source).toEqual({ owner: { projectId: 'synthetic-project', planId: 'synthetic-plan', branch: 'feature/synthetic' }, revision: '7', sourceSha256: id<'sha256'>(await sourceDigest(encode(document))) });
  expect(() => JSON.stringify(result)).not.toThrow();
  return result;
}
describe('native catalogue identity parity', () => {
  it('refuses every global MCP ID collision exactly as Macro, before server and enabled filtering', async () => {
    const { document, tool, registry } = mcpFixture();
    for (const serverId of ['server-one', 'server-two']) {
      for (const firstEnabled of [undefined, true, false]) {
        for (const secondEnabled of [undefined, true, false]) {
          const tools = [{ ...tool, enabled: firstEnabled }, { ...tool, serverId, name: 'other_search', enabled: secondEnabled }];
          const ambiguous = { ...registry, mcpTools: tools };
          expect(() => assertUniqueMCPToolIds(tools)).toThrow('Ambiguous MCP tool ID');
          expect(() => captureRegistry(ambiguous)).toThrow(expect.objectContaining({ code: 'UNSUPPORTED', pointer: '/registry/mcpTools' }));
          expect(() => resolveBinding(document, 'search', ambiguous, 'call')).toThrow(expect.objectContaining({ code: 'UNSUPPORTED', pointer: '/registry/mcpTools' }));
          const result = await expectUnsupported(document, ambiguous, '/registry/mcpTools');
          expect(JSON.stringify(result.runtime.diagnostics)).not.toContain('other_search');
        }
      }
    }
    const duplicate = { ...registry, mcpTools: [tool, { ...tool }] };
    expect(() => captureRegistry(duplicate)).toThrow();
    expect(() => resolveBinding(document, 'search', duplicate, 'call')).toThrow();
    await expectUnsupported(document, duplicate, '/registry/mcpTools');
  });
  it('rejects the global MCP collision even when no MCP binding is used', async () => {
    const { tool } = mcpFixture(), document = documentFixture();
    const registry = { ...registryFixture(document), mcpTools: [tool, { ...tool, serverId: 'server-two' }] };
    await expectUnsupported(document, registry, '/registry/mcpTools');
  });
  it('accepts distinct literal MCP IDs across or within a server without normalization', async () => {
    const { document, tool, registry } = mcpFixture();
    for (const serverId of ['server-one', 'server-two']) {
      for (const enabled of [undefined, true, false]) {
        const tools = [tool, { ...tool, id: 'mcp__server_one__SEARCH', serverId, name: 'other_search', enabled }];
        const distinct = { ...registry, mcpTools: tools };
        expect(() => assertUniqueMCPToolIds(tools)).not.toThrow();
        expect(captureRegistry(distinct).mcpTools[1].id).toBe('mcp__server_one__SEARCH');
        expect(resolveBinding(document, 'search', distinct, 'call').target.kind).toBe('mcp-tool');
        expect((await compileFixture(document, distinct)).runtime.supported).toBe(true);
      }
    }
  });
  it('keeps disabled distinct descriptors in capture while refusing a disabled selected Tool', async () => {
    const { document, tool, registry } = mcpFixture();
    const disabled = { ...registry, mcpTools: [{ ...tool, enabled: false }, { ...tool, id: 'mcp__server_two__search', serverId: 'server-two', enabled: true }] };
    expect(() => assertUniqueMCPToolIds(disabled.mcpTools)).not.toThrow();
    expect(captureRegistry(disabled).mcpTools[0].enabled).toBe(false);
    expect(() => resolveBinding(document, 'search', disabled, 'call')).toThrow('MCP descriptor is unknown or incomplete.');
    await expectUnsupported(document, disabled, '');
  });
  it('refuses an ambiguous native provider/model pair used by the fixed Agent even across editions', async () => {
    const document = documentFixture(), registry = registryFixture(document);
    const extra = { ...registry.models[0], editionJson: json('{"identity":"synthetic/model","version":"2"}') };
    const ambiguous = { ...registry, models: [...registry.models, extra] };
    expect(() => captureAgent(document, 'worker', agentContent(document, 'worker'), ambiguous)).toThrow(expect.objectContaining({ code: 'UNSUPPORTED', pointer: '/registry/models' }));
    await expectUnsupported(document, ambiguous, '/registry/models');
    for (const changed of [{ ...extra, providerId: 'provider-two' }, { ...extra, modelId: 'model-two' }]) {
      expect((await compileFixture(document, { ...registry, models: [...registry.models, changed] })).runtime.supported).toBe(true);
    }
    const sameEdition = { ...registry.models[0], providerId: 'provider-two' };
    await expectUnsupported(document, { ...registry, models: [...registry.models, sameEdition] }, '/registry/models');
  });
  it('requires one configuration attestation for the used Agent identity, without hiding a conflicting declaration', async () => {
    const document = documentFixture(), registry = registryFixture(document);
    const original = registry.configurations[0];
    const conflicting = { ...original, configurationDeclarationJson: json('{"engine":"engine"}') };
    for (const additional of [original, conflicting]) {
      const ambiguous = { ...registry, configurations: [...registry.configurations, additional] };
      expect(() => captureAgent(document, 'worker', agentContent(document, 'worker'), ambiguous)).toThrow(expect.objectContaining({ code: 'UNSUPPORTED', pointer: '/registry/configurations' }));
      await expectUnsupported(document, ambiguous, '/registry/configurations');
    }
    expect((await compileFixture(document, { ...registry, configurations: [...registry.configurations, { ...conflicting, agentName: 'other-agent' }] })).runtime.supported).toBe(true);
  });
  it('keeps exact declaration uniqueness for used bindings, including reordered JSON keys', async () => {
    const { document, registry } = mcpFixture();
    const entry = registry.bindings[1];
    const declaration = record(decode(entry.declarationJson));
    const duplicate = { ...clone(entry), declarationJson: encode({ effects: declaration.effects, implementation: declaration.implementation, contract: declaration.contract }) };
    const ambiguous = { ...registry, bindings: [...registry.bindings, duplicate] };
    expect(() => resolveBinding(document, 'search', ambiguous, 'call')).toThrow(expect.objectContaining({ code: 'UNSUPPORTED', pointer: '/bindings/search' }));
    await expectUnsupported(document, ambiguous, '/bindings/search');
  });
});
