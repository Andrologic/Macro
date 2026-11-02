import { expect, it } from 'bun:test';
import { compilePlan, sourceDigest } from './compiler';
import { id, json } from './conformanceFixtures';
import { buildNativeRegistry, type NativeRegistryObservation } from './nativeRegistry';
import { encodeHostCompilation, HOST_COMPILE_RESULT_LIMIT } from './hostCompilation';

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
