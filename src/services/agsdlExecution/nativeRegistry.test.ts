import { expect, it } from 'bun:test';
import { compilePlan, sourceDigest } from './compiler';
import { documentFixture, id, json } from './conformanceFixtures';
import { encode, record } from './exact';
import { buildNativeRegistry, type NativeRegistryObservation } from './nativeRegistry';
import { captureToolAliases } from './registry';

function fixture() {
  const doc = documentFixture();
  doc.bindings = {
    engine: { contract: { identity: 'macro/agent-engine', version: '1' }, implementation: { identity: 'macro/desktop', version: '1' } },
    inspect: { contract: { identity: 'macro/tool/read', version: '1' }, implementation: { identity: 'macro/desktop', version: '1' }, effects: 'none' },
  };
  const config = record(record(doc.configurations).fixed);
  config.settings = {};
  config.model = { identity: 'macro/native-model/p/cA/m/bQ', version: '1' };
  config.tools = { inspect_source: 'inspect' };
  const observed: NativeRegistryObservation = {
    format: 'macro-native-registry-observation/1', version: 'native-fixture/1',
    models: [{ editionJson: encode(config.model), providerId: 'p', modelId: 'm' }],
    tools: [{ toolId: 'read', resultConstraintJson: json('{"type":"string"}'), effects: 'none', verifiedRequirementsJson: [] }],
    configurations: [{ agentName: 'worker', verifiedRequirementsJson: [], effectiveSettingsJson: json('{}'), permissionsJson: json('{"allowedToolIds":["read"]}'), scopeJson: json('{"projectId":"synthetic"}') }],
  };
  return { doc, config, observed };
}

it('compiles approved Editions and projects absent provider settings from the explicit Model', async () => {
  const { doc, config, observed } = fixture(), source = encode(doc);
  const registry = buildNativeRegistry(source, observed);
  expect(captureToolAliases(doc, config, registry)).toEqual([{ name: 'inspect_source', toolId: 'read' }]);
  const result = await compilePlan(source, { owner: { projectId: 'synthetic', planId: 'plan', branch: 'feature/test' }, revision: '1', sourceSha256: id(await sourceDigest(source)) }, registry);
  expect(result.runtime.supported).toBe(true);
  expect(result.plan!.agents[0].settingsJson).toBe(json('{"providerId":"p","modelId":"m"}'));
  expect(result.productRuntimeAvailable).toBe(true);
});

it('never promotes authored requirements or claims to adapter proof', () => {
  const { doc, observed } = fixture();
  const binding = record(record(doc.bindings).inspect);
  binding.requires = [{ contract: { identity: 'unverified', version: '1' } }];
  binding.claims = [];
  expect(() => buildNativeRegistry(encode(doc), observed)).toThrow('No verification');
});

it.each(['version', 'implementation', 'settings', 'effect'])('refuses unimplemented binding %s', field => {
  const { doc, observed } = fixture();
  const binding = record(record(doc.bindings).inspect);
  if (field === 'version') record(binding.contract).version = '2';
  if (field === 'implementation') record(binding.implementation).identity = 'other';
  if (field === 'settings') binding.settings = { workspacePath: '/untrusted' };
  if (field === 'effect') binding.effects = 'external';
  expect(() => buildNativeRegistry(encode(doc), observed)).toThrow('outside the captured native policy');
});

it('requires a real registered adapter, excludes MCP, and deduplicates identical declarations', () => {
  const { doc, observed } = fixture();
  record(doc.bindings).same = record(doc.bindings).inspect;
  expect(buildNativeRegistry(encode(doc), observed).bindings).toHaveLength(2);
  expect(() => buildNativeRegistry(encode(doc), { ...observed, tools: [] })).toThrow();
  expect(buildNativeRegistry(encode(doc), observed).mcpTools).toEqual([]);
  expect(() => buildNativeRegistry(encode(doc), { ...observed, tools: [...observed.tools, ...observed.tools] })).toThrow('ambiguous');
});

it.each([['a'.repeat(64), true], ['a'.repeat(65), false], ['résumé', false], ['a.b', false], ['read_item-1', true]] as const)('assesses exact native alias %s before admission', async (alias, supported) => {
  const { doc, config, observed } = fixture();
  config.tools = { [alias]: 'inspect' };
  const source = encode(doc), registry = buildNativeRegistry(source, observed);
  const result = await compilePlan(source, { owner: { projectId: 'synthetic', planId: 'plan', branch: 'feature/test' }, revision: '1', sourceSha256: id(await sourceDigest(source)) }, registry);
  expect(result.static.valid).toBe(/^[A-Za-z0-9_-]+$/.test(alias));
  expect(result.runtime.supported).toBe(supported);
  if (supported) expect(captureToolAliases(doc, config, registry)[0].name).toBe(alias);
  else {
    expect(result.plan).toBeNull();
    expect(() => captureToolAliases(doc, config, registry)).toThrow('transport');
  }
});

it('rejects a registered tool removed by the native project policy before compilation or provider admission', () => {
  const { doc, observed } = fixture();
  const restricted = { ...observed, configurations: observed.configurations.map(configuration => ({ ...configuration, permissionsJson: json('{"allowedToolIds":[]}') })) };
  expect(() => buildNativeRegistry(encode(doc), restricted)).toThrow('outside the captured native policy');
});

it('captures Codex as a distinct adapter only after a native profile observation', async () => {
  const { doc, config, observed } = fixture();
  record(record(doc.bindings).engine).implementation = { identity: 'openai/codex', version: '1' };
  delete config.tools;
  const source = encode(doc);
  const compile = async (observation: NativeRegistryObservation) => compilePlan(source,
    { owner: { projectId: 'synthetic', planId: 'plan', branch: 'feature/test' }, revision: '1', sourceSha256: id(await sourceDigest(source)) }, buildNativeRegistry(source, observation));
  expect((await compile(observed)).runtime.supported).toBe(false);
  const codexProfileJson = json('{"format":"macro-codex-native-profile/1","version":"0.163.0","toolPolicy":"codex-native","approvalPolicy":"never","digest":"synthetic"}');
  const captured = { ...observed, codexProfileJson };
  const result = await compile(captured);
  expect(result.runtime.supported).toBe(true);
  const binding = buildNativeRegistry(source, captured).bindings.find(binding => binding.target.kind === 'engine')!;
  expect(binding.target).toEqual({ kind: 'engine', adapter: 'codex-app-server-v1', profileJson: codexProfileJson });
  expect(binding.capabilities).not.toContain('tool-admission');
  expect(binding.capabilities).toContain('native-tool-policy');
  expect(result.plan!.versions.profile).toBe('macro-serial-inline-v1');
  expect(result.plan!.agents[0].configurationJson).toContain('nativeEngine');
  expect(() => buildNativeRegistry(source, { ...captured, codexProfileJson: json(codexProfileJson.replace('0.163.0', 'unknown')) })).toThrow('Unknown Codex native profile');
  config.tools = { inspect: 'inspect' };
  expect((await compilePlan(encode(doc), { owner: { projectId: 'synthetic', planId: 'plan', branch: 'feature/test' }, revision: '1', sourceSha256: id(await sourceDigest(encode(doc))) }, buildNativeRegistry(encode(doc), captured))).runtime.supported).toBe(false);
});
