import { describe, expect, it, spyOn } from 'bun:test';
import * as exact from './exact';
import { clone, decode, encode, record } from './exact';
import { compilePlan, sourceDigest, type CompilationResult } from './compiler';
import { documentFixture, id, registryFixture } from './conformanceFixtures';
import type { SourceRevision } from './contracts';
import type { CapturedRegistry } from './registry';

const invalidText = [undefined, null, 7, 7n, true, Object('synthetic'), Symbol('synthetic-marker'), '', ' \t\n'];
async function inputs() {
  const document = documentFixture(), authored = encode(document);
  const source: SourceRevision = { owner: { projectId: 'synthetic', planId: 'synthetic', branch: 'feature/synthetic' }, revision: '7', sourceSha256: id(await sourceDigest(authored)) };
  return { authored, source, registry: registryFixture(document) };
}
function replace(input: unknown, path: readonly string[], value: unknown, omit = false): void {
  let object = input as Record<string, unknown>;
  for (const key of path.slice(0, -1)) object = object[key] as Record<string, unknown>;
  const key = path[path.length - 1];
  if (omit) delete object[key]; else object[key] = value;
}
function refusal(result: CompilationResult, code: string, pointer: string): void {
  expect(result.static.valid).toBe(true);
  expect(result.runtime.supported).toBe(false);
  expect(result.productRuntimeAvailable).toBe(false);
  expect(result.plan).toBeNull();
  expect(result.compiledPlanJson).toBeNull();
  expect(result.runtime.diagnostics[0]).toMatchObject({ code, pointer });
  expect(typeof result.runtime.registryVersion).toBe('string');
  expect(() => JSON.stringify(result)).not.toThrow();
  expect(JSON.stringify(result)).not.toContain('synthetic-marker');
}
describe('compiler metadata transport boundaries', () => {
  it('rejects malformed source fields together and never transports the malformed capture', async () => {
    const fixture = await inputs();
    for (const path of [['owner', 'projectId'], ['owner', 'planId'], ['owner', 'branch'], ['revision'], ['sourceSha256']]) {
      const pointer = `/source/${path.join('/')}`;
      for (const value of invalidText) {
        const source = clone(fixture.source); replace(source, path, value);
        const result = await compilePlan(fixture.authored, source, fixture.registry);
        refusal(result, 'CORRELATION', pointer);
        expect(result.runtime.source).toBeNull();
      }
      const source = clone(fixture.source); replace(source, path, undefined, true);
      const result = await compilePlan(fixture.authored, source, fixture.registry);
      refusal(result, 'CORRELATION', pointer);
      expect(result.runtime.source).toBeNull();
    }
    for (const source of [undefined, null, 7n, Symbol('synthetic-marker'), Object('source'), { ...fixture.source, owner: null }]) {
      const result = await compilePlan(fixture.authored, source as SourceRevision, fixture.registry);
      refusal(result, 'CORRELATION', source && typeof source === 'object' && 'owner' in source ? '/source/owner' : '/source');
      expect(result.runtime.source).toBeNull();
    }
  });
  it('requires canonical revision and SHA strings without imposing a numeric size limit', async () => {
    const fixture = await inputs();
    for (const revision of ['01', '-1', '7.0', '7e0', '7 ', '7\n']) {
      const result = await compilePlan(fixture.authored, { ...fixture.source, revision }, fixture.registry);
      refusal(result, 'CORRELATION', '/source/revision'); expect(result.runtime.source).toBeNull();
    }
    for (const sourceSha256 of ['bad', fixture.source.sourceSha256.toUpperCase(), `${fixture.source.sourceSha256}\n`]) {
      const result = await compilePlan(fixture.authored, { ...fixture.source, sourceSha256: id(sourceSha256) }, fixture.registry);
      refusal(result, 'CORRELATION', '/source/sourceSha256'); expect(result.runtime.source).toBeNull();
    }
    for (const revision of ['0', '123456789012345678901234567890123456789012345678901234567890']) {
      const result = await compilePlan(fixture.authored, { ...fixture.source, revision }, fixture.registry);
      expect(result.runtime.supported).toBe(true);
      expect(result.runtime.source?.revision).toBe(revision);
      expect(result.plan!.source.revision).toBe(revision);
      expect(record(record(decode(result.compiledPlanJson!)).source).revision).toBe(revision);
      expect(() => JSON.stringify(result)).not.toThrow();
    }
  });
  it('rejects malformed registry and catalogue identifiers while retaining the valid source', async () => {
    const fixture = await inputs();
    for (const path of [['version'], ['models', '0', 'providerId'], ['models', '0', 'modelId'], ['configurations', '0', 'agentName'], ['bindings', '0', 'capabilities', '0']]) {
      for (const value of invalidText) {
        const registry = clone(fixture.registry); replace(registry, path, value);
        const result = await compilePlan(fixture.authored, fixture.source, registry);
        refusal(result, 'UNSUPPORTED', `/registry/${path.join('/')}`);
        expect(result.runtime.source).toEqual(fixture.source);
      }
      const registry = clone(fixture.registry); replace(registry, path, undefined, true);
      refusal(await compilePlan(fixture.authored, fixture.source, registry), 'UNSUPPORTED', `/registry/${path.join('/')}`);
    }
  });
  it('requires registry containers and primitive exact JSON texts, including unused catalogue entries', async () => {
    const fixture = await inputs();
    for (const field of ['bindings', 'models', 'configurations', 'mcpTools']) {
      for (const value of [undefined, null, {}, 7n, Symbol('synthetic-marker')]) {
        const registry = { ...fixture.registry, [field]: value } as CapturedRegistry;
        refusal(await compilePlan(fixture.authored, fixture.source, registry), 'UNSUPPORTED', `/registry/${field}`);
      }
    }
    for (const path of [['models', '0', 'editionJson'], ['bindings', '0', 'declarationJson'], ['configurations', '0', 'effectiveSettingsJson']]) {
      for (const value of [7, 7n, undefined, Object('{}'), Symbol('synthetic-marker'), '{']) {
        const registry = clone(fixture.registry); replace(registry, path, value);
        refusal(await compilePlan(fixture.authored, fixture.source, registry), 'UNSUPPORTED', `/registry/${path.join('/')}`);
      }
    }
    const registry = { ...fixture.registry, models: [...fixture.registry.models, { editionJson: encode({ identity: 'unused', version: '1' }), providerId: 7n, modelId: 'unused' }] } as unknown as CapturedRegistry;
    refusal(await compilePlan(fixture.authored, fixture.source, registry), 'UNSUPPORTED', '/registry/models/1/providerId');
    for (const registry of [undefined, null, Object('registry'), 7n, Symbol('synthetic-marker')]) {
      refusal(await compilePlan(fixture.authored, fixture.source, registry as CapturedRegistry), 'UNSUPPORTED', '/registry');
    }
  });
  it('validates binding target and native MCP metadata before retaining any captured path', async () => {
    const fixture = await inputs();
    for (const target of [
      { kind: 'engine', adapter: 7n }, { kind: Object('engine'), adapter: 'macro-streaming-v1' },
      { kind: 'macro-tool', toolId: 7 }, { kind: 'mcp-tool', serverId: Symbol('synthetic-marker'), toolId: 'tool', descriptorJson: '{}' },
      { kind: 'mcp-tool', serverId: 'server', toolId: 'tool', descriptorJson: Object('{}') },
    ]) {
      const registry = clone(fixture.registry); replace(registry, ['bindings', '0', 'target'], target);
      const result = await compilePlan(fixture.authored, fixture.source, registry);
      expect(result.runtime.supported).toBe(false); expect(result.runtime.diagnostics[0].code).toBe('UNSUPPORTED');
      expect(result.runtime.source).toEqual(fixture.source); expect(() => JSON.stringify(result)).not.toThrow();
    }
    const descriptor = { id: 'tool', serverId: 'server', name: 'tool', inputSchema: { type: 'object' } };
    for (const [path, value] of [
      [['id'], 7n], [['serverId'], Object('server')], [['name'], undefined], [['enabled'], 'true'],
      [['inputSchema', 'type'], Symbol('synthetic-marker')], [['inputSchema', 'count'], Number.NaN],
    ] as const) {
      const tool = clone(descriptor); replace(tool, path, value);
      const registry = { ...fixture.registry, mcpTools: [tool] };
      const result = await compilePlan(fixture.authored, fixture.source, registry);
      refusal(result, 'UNSUPPORTED', `/registry/mcpTools/0/${path.join('/')}`);
    }
  });
  it('captures registry metadata synchronously and preserves meaningful identities without trimming', async () => {
    const fixture = await inputs();
    const registry = clone(fixture.registry);
    replace(registry, ['models', '0', 'providerId'], ' synthetic provider ');
    replace(registry, ['models', '0', 'modelId'], ' synthetic model ');
    const pending = compilePlan(fixture.authored, fixture.source, registry);
    replace(registry, ['version'], 7n); replace(registry, ['models', '0', 'providerId'], Symbol('synthetic-marker'));
    const result = await pending;
    expect(result.runtime.supported).toBe(true);
    expect(result.runtime.registryVersion).toBe(fixture.registry.version);
    expect(result.plan!.agents[0].providerId).toBe(' synthetic provider ');
    expect(result.plan!.agents[0].modelId).toBe(' synthetic model ');
    expect(result.plan!.versions.registry).toBe(fixture.registry.version);
    expect(() => JSON.stringify(result)).not.toThrow();
  });
  it('keeps valid source captures for later refusals and ignores undeclared source metadata', async () => {
    const fixture = await inputs();
    const source = { ...fixture.source, sourceSha256: id<'sha256'>('f'.repeat(64)) };
    const mismatch = await compilePlan(fixture.authored, source, fixture.registry);
    refusal(mismatch, 'CORRELATION', '/source/sourceSha256'); expect(mismatch.runtime.source).toEqual(source);
    const doc = documentFixture(); record(record(doc.agents).worker).interface = { inputMediaTypes: ['image/png'] };
    const authored = encode(doc), captured = { ...fixture.source, sourceSha256: id<'sha256'>(await sourceDigest(authored)) };
    const unsupported = await compilePlan(authored, captured, registryFixture(doc));
    expect(unsupported.runtime.supported).toBe(false); expect(unsupported.runtime.source).toEqual(captured);
    const malformed = { ...fixture.source, sourceSha256: id<'sha256'>('bad') };
    const pending = compilePlan(fixture.authored, malformed, fixture.registry);
    malformed.sourceSha256 = fixture.source.sourceSha256;
    const invalidCapture = await pending;
    refusal(invalidCapture, 'CORRELATION', '/source/sourceSha256');
    expect(invalidCapture.runtime.source).toBeNull();
    const extra = { ...fixture.source, extra: 7n, owner: { ...fixture.source.owner, extra: Symbol('synthetic-marker') } };
    const result = await compilePlan(fixture.authored, extra, fixture.registry);
    expect(result.runtime.supported).toBe(true); expect(result.runtime.source).toEqual(fixture.source);
    expect(() => JSON.stringify(result)).not.toThrow();
  });
  it('never reports support or returns a plan when final serialization fails', async () => {
    const fixture = await inputs(), original = exact.encode;
    const serializer = spyOn(exact, 'encode').mockImplementation(value => {
      if (value !== null && typeof value === 'object' && 'format' in value && value.format === 'macro-agsdl-compiled-plan/1') throw new TypeError('synthetic-marker');
      return original(value);
    });
    try {
      const result = await compilePlan(fixture.authored, fixture.source, fixture.registry);
      refusal(result, 'UNSUPPORTED', ''); expect(result.runtime.source).toEqual(fixture.source);
    } finally { serializer.mockRestore(); }
  });
});
