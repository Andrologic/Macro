import { expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { compilePlan } from './compiler';
import { sourceDigest } from './sourceDigest';
import { id, json } from './conformanceFixtures';
import { buildNativeRegistry, type NativeRegistryObservation } from './nativeRegistry';
import { compileHost030, encodeHostCompilation, HOST_COMPILE_RESULT_LIMIT } from './hostCompilation';
import type { CapturedRegistry030 } from './contracts030';
import type { SourceRevision } from './contracts';

async function fixture(instruction: string) {
  const model = { identity: 'macro/native-model/p/c3ludGhldGlj/m/c3ludGhldGlj', version: '1' };
  const document = {
    contract: 'agsdl-0.2.0', id: 'synthetic',
    bindings: { engine: { contract: { identity: 'macro/agent-engine', version: '1' }, implementation: { identity: 'macro/desktop', version: '1' } } },
    configurations: { fixed: { engine: 'engine', model, settings: { mode: 'build', maxTurns: 3 } } },
    skills: { shared: { prompt: [{ value: instruction }] } },
    agents: Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map(name => [name, { configuration: 'fixed', skills: ['shared'] }])),
    flow: { entry: 'work', steps: { work: { type: 'agent', agent: 'a', next: [] } } },
  };
  const authored = JSON.stringify(document);
  const observation: NativeRegistryObservation = {
    format: 'macro-native-registry-observation/1', version: 'synthetic-native-observation/1', tools: [],
    models: [{ editionJson: json(JSON.stringify(model)), providerId: 'synthetic', modelId: 'synthetic' }],
    configurations: Object.keys(document.agents).map(agentName => ({ agentName, verifiedRequirementsJson: [], effectiveSettingsJson: json(JSON.stringify(document.configurations.fixed.settings)), permissionsJson: json('{"mode":"Implement","readOnly":false,"allowedToolIds":[]}'), scopeJson: json('{"projectId":"synthetic","root":"/synthetic/project"}') })),
  };
  const registry = buildNativeRegistry(authored, observation);
  const result = await compilePlan(authored, { owner: { projectId: 'synthetic', planId: 'synthetic', branch: 'feature/synthetic' }, revision: '1', sourceSha256: id(await sourceDigest(authored)) }, registry);
  return { authored, registry, result };
}

it.each(['x'.repeat(800_000), 'é'.repeat(400_000)])('bounds an expanded shared skill without changing its ticket identities', async instruction => {
  const { authored, registry, result } = await fixture(instruction);
  expect(new TextEncoder().encode(authored).byteLength).toBeLessThan(1_048_576);
  expect(result.runtime.supported).toBe(true);
  const unbounded = JSON.stringify({ ...result, capturedRegistryJson: JSON.stringify(registry) });
  expect(new TextEncoder().encode(unbounded).byteLength).toBeGreaterThan(HOST_COMPILE_RESULT_LIMIT);
  const input = { declarationJson: '{"n":9007199254740993}', input: { valueJson: '{"x":1e999}' } };
  const encoded = encodeHostCompilation(result, registry, {
    entryValidation: { messageJson: '{"n":9007199254740993}', valid: true },
    deliveryValidation: { input, valid: true }, callValidation: { input, prepared: { authorized: true } },
  });
  expect(new TextEncoder().encode(encoded).byteLength).toBeLessThan(2_000);
  const refusal = JSON.parse(encoded);
  expect(refusal.runtime.source).toEqual(result.runtime.source);
  expect(refusal.runtime.registryVersion).toBe(registry.version);
  expect(refusal.runtime.supported).toBe(false);
  expect(refusal.runtime.diagnostics[0].code).toBe('INPUT_LIMIT');
  expect(refusal.static.valid).toBe(true);
  expect(refusal.plan).toBeNull(); expect(refusal.compiledPlanJson).toBeNull();
  expect(refusal.productRuntimeAvailable).toBe(false);
  expect(refusal.entryValidation).toEqual({ messageJson: '{"n":9007199254740993}', valid: false });
  expect(refusal.deliveryValidation).toEqual({ input, valid: false });
  expect(refusal.callValidation).toEqual({ input, prepared: null });
});

it('preserves the next ordinary compilation and its captured attestations', async () => {
  const { registry, result } = await fixture('Review.');
  const encoded = encodeHostCompilation(result, registry, {});
  expect(encoded).toBe(JSON.stringify({ ...result, capturedRegistryJson: JSON.stringify(registry) }));
  expect(JSON.parse(encoded).runtime.supported).toBe(true);
});

it('closes a permissive tool policy while retaining its exact native input on size refusal', async () => {
  const { registry, result } = await fixture('Review.');
  const input = { invocationIdentity: 'synthetic', toolId: 'read', bindingJson: json('{}'), argumentsJson: json('{"n":9007199254740993}'), mode: 'Implement' as const, riskLevel: 'balanced' as const, capturedRiskLevel: 'balanced' as const, root: '/synthetic', allowedToolIds: ['read'] };
  const encoded = encodeHostCompilation({ ...result, static: { valid: false, diagnostics: [{ code: 'SYNTHETIC', pointer: '', message: 'x'.repeat(HOST_COMPILE_RESULT_LIMIT) }] } }, registry, {
    toolPolicy: { input, decision: 'allow', summary: 'Allowed', detail: null, code: null },
  });
  const refusal = JSON.parse(encoded);
  expect(new TextEncoder().encode(encoded).byteLength).toBeLessThan(2_000);
  expect(refusal.static).toEqual({ valid: false, diagnostics: [] });
  expect(refusal.toolPolicy.input).toEqual(input);
  expect(refusal.toolPolicy.decision).toBe('deny');
  expect(refusal.toolPolicy.code).toBe('INPUT_LIMIT');
});

it('runs the 0.3 reader without inventing native qualification and binds refusals to the ticket', async () => {
  const authored = '{"contract":"agsdl-0.3.0","id":"fixture","agents":{"worker":{"harness":"codex","permissions":"read-only"}},"content":{"number":{"value":9007199254740993}}}';
  const source: SourceRevision = { owner: { projectId: 'p', planId: 'p', branch: 'feature/p' }, revision: '1', sourceSha256: id(await sourceDigest(authored)) };
  const modules = ['codex', 'claude-code', 'opencode', 'pi'].map(harness => ({ harness,
    moduleJson: json(readFileSync(new URL(`../../vendor/agsdl/v0.3/harnesses/${harness}/module.json`, import.meta.url), 'utf8')) }));
  const registry: CapturedRegistry030 = { format: 'macro-agsdl-registry/030', version: 'native-capture', modules, harnesses: [], agents: [] };
  const ticket = { ...registry, startEntry: null, callPermissions: { allowed: false } };
  const result = JSON.parse(await compileHost030(authored, source, ticket));
  expect(result.static.valid).toBe(true);
  expect(result.runtime).toMatchObject({ source, registryVersion: registry.version, supported: false });
  expect(result.runtime.diagnostics[0]).toMatchObject({ code: 'CORRELATION', pointer: '/agents/worker' });
  expect(result.entryValidation).toEqual({ messageJson: null, valid: true, shapeValid: true, unassessed: [] });
  expect(JSON.parse(result.capturedRegistryJson)).toEqual(registry);
  expect(result.productRuntimeAvailable).toBe(false);

  const malformed = JSON.parse(await compileHost030('{', source, ticket));
  expect(malformed.static.valid).toBe(false);
  expect(malformed.runtime).toMatchObject({ source, registryVersion: registry.version, supported: false });
});

it('checks 0.3 entry and graphless messages separately from content authority', async () => {
  const registry: CapturedRegistry030 = { format: 'macro-agsdl-registry/030', version: 'capture', modules: [], harnesses: [], agents: [] };
  const sourceFor = async (authored: string): Promise<SourceRevision> => ({ owner: { projectId: 'p', planId: 'p', branch: 'feature/p' }, revision: '1', sourceSha256: id(await sourceDigest(authored)) });
  const agents = '"agents":{"worker":{"harness":"synthetic","permissions":"read-only"}}';
  for (const step of ['{"type":"call","command":"true"}', '{"type":"approval","next":{"yes":[]}}']) {
    const authored = `{"contract":"agsdl-0.3.0","id":"test",${agents},"flow":{"entry":"work","steps":{"work":${step}}}}`;
    const messageJson = '{"prompt":"Hello"}';
    const result = JSON.parse(await compileHost030(authored, await sourceFor(authored), { ...registry, startEntry: { messageJson } } as never));
    expect(result.static.valid).toBe(true);
    expect(result.entryValidation).toMatchObject({ messageJson, shapeValid: true, valid: true });
  }
  const authored = `{"contract":"agsdl-0.3.0","id":"test",${agents}}`;
  const source = await sourceFor(authored);
  const input = { agentName: 'worker', messageJson: '{"resources":{"n":{"value":9007199254740993}}}' };
  const result = JSON.parse(await compileHost030(authored, source, { ...registry, deliveryInput: input } as never));
  expect(result.deliveryValidation).toMatchObject({ input, shapeValid: true, valid: false, unassessed: ['Native resource delivery qualification'] });
  const uri = { agentName: 'worker', messageJson: '{"prompt":[{"uri":"file:///tmp/example"}]}' };
  expect(JSON.parse(await compileHost030(authored, source, { ...registry, deliveryInput: uri } as never)).deliveryValidation)
    .toMatchObject({ input: uri, shapeValid: true, valid: false, unassessed: ['Native content capture for URI'] });
  const plain = { agentName: 'worker', messageJson: '{"prompt":"ok"}' };
  expect(JSON.parse(await compileHost030(authored, source, { ...registry, deliveryInput: plain } as never)).deliveryValidation)
    .toMatchObject({ input: plain, shapeValid: true, valid: true });
  const unknown = { ...plain, agentName: 'other' };
  expect(JSON.parse(await compileHost030(authored, source, { ...registry, deliveryInput: unknown } as never)).deliveryValidation.valid).toBe(false);
});
