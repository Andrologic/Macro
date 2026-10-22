import { expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { buildNativeRegistry, type NativeRegistryObservation } from './nativeRegistry';
import { compileFixture, json } from './conformanceFixtures';
import { decode, encode, record } from './exact';
import { prepareMessage, deliveryMessage } from './content';
import { completionResult } from './constraints';
import { macroNativeModelEdition } from '../agsdl/nativeModelEdition';

// This suite verifies compilation and exact transfer, not native execution or SQLite.
const source = readFileSync(new URL('../../../docs/examples/agsdl-mixed-engine.json', import.meta.url), 'utf8');
async function fixture() {
  const document = record(decode(source));
  const models = [
    ['macro', 'synthetic-http', 'synthetic-model'],
    ['claude', 'claude-native', 'claude-haiku-5-5'],
    ['codex', 'codex-native', 'synthetic-codex'],
  ];
  const observed: NativeRegistryObservation = {
    format: 'macro-native-registry-observation/1', version: 'mixed-synthetic/1', tools: [],
    codexProfileJson: json('{"format":"macro-codex-native-profile/1","version":"0.163.0","toolPolicy":"codex-native","approvalPolicy":"never"}'),
    claudeProfileJson: json('{"format":"macro-claude-controlled-profile/1","version":"0.3.308","cliVersion":"2.1.308","toolPolicy":"macro-controlled"}'),
    models: models.map(([name, providerId, modelId]) => {
      const edition = macroNativeModelEdition(providerId, modelId);
      record(record(document.configurations)[name]).model = edition;
      return { editionJson: encode(edition), providerId, modelId };
    }),
    configurations: models.map(([agentName]) => ({ agentName, effectiveSettingsJson: json('{"mode":"Chat","maxTurns":3,"reasoningEffort":"low"}'),
      permissionsJson: json('{"mode":"Chat","allowedToolIds":[],"riskLevel":"balanced"}'), scopeJson: json('{"root":"/synthetic/project"}'), verifiedRequirementsJson: [] })),
  };
  const registry = buildNativeRegistry(encode(document), observed);
  return { document, observed, registry, compiled: await compileFixture(document, registry) };
}

it('captures three different engines and revisits only the same three declarations', async () => {
  const { document, compiled } = await fixture();
  expect(compiled.static.diagnostics).toEqual([]);
  expect(compiled.runtime.diagnostics).toEqual([]);
  expect(compiled.plan).not.toBeNull();
  expect(compiled.plan!.agents.map(agent => agent.agentName)).toEqual(['macro', 'claude', 'codex']);
  const configurations = compiled.plan!.agents.map(agent => record(decode(agent.configurationJson)));
  expect(configurations[0].nativeEngine).toBeUndefined();
  expect(record(configurations[1].nativeEngine).adapter).toBe('claude-sdk-v1');
  expect(record(configurations[2].nativeEngine).adapter).toBe('codex-app-server-v1');
  const steps = record(record(document.flow).steps);
  expect(Object.values(steps).filter(step => record(step).type === 'agent').map(step => record(step).agent))
    .toEqual(['macro', 'claude', 'codex', 'macro', 'claude', 'codex']);
  expect(Object.keys(record(document.agents))).toHaveLength(3);
});

it('transfers only the explicitly named report with exact numbers, decimals and accents', async () => {
  const { document } = await fixture();
  const steps = record(record(document.flow).steps);
  const report = '{"value":{"n":9007199254740993,"decimal":0.12345678901234567890123456789,"label":"Été à Montréal"},"mediaType":"application/json"}';
  const completion = decode(`{"text":"Visible text is not the report","results":{"report":${report},"private":{"value":"must not transfer","mediaType":"text/plain"}}}`);
  const contract = record(record(record(document.agents).macro).interface);
  expect(completionResult(contract, record(steps['macro-first']), completion).valueJson).toContain('0.12345678901234567890123456789');
  const rounded = decode(encode(completion).replace('0.12345678901234567890123456789', '0.12345678901234568'));
  expect(() => completionResult(contract, record(steps['macro-first']), rounded)).toThrow('valueSchema');
  for (const step of Object.values(steps).map(step => record(step)).filter(step => step.type === 'prepare')) {
    const prepared = prepareMessage(document, step, completion);
    expect(encode(record(prepared.resources).report)).toBe(json(report));
    expect(Object.keys(record(prepared.resources))).toEqual(['report']);
    expect(deliveryMessage(document, { origin: 'prepare', valueJson: encode(prepared) })).toContain(report);
    expect(encode(prepared)).not.toContain('must not transfer');
  }
  expect(() => prepareMessage(document, record(steps['to-claude-first']), decode('{"text":"only visible","results":{}}'))).toThrow('Missing operand property');
  expect(deliveryMessage(document, { origin: 'agent', valueJson: encode(completion) })).not.toContain('9007199254740993');
});

it('does not fall back to HTTP when either native profile observation is missing', async () => {
  const { document, observed } = await fixture();
  for (const field of ['codexProfileJson', 'claudeProfileJson'] as const) {
    const incomplete = { ...observed }; delete incomplete[field];
    const result = await compileFixture(document, buildNativeRegistry(encode(document), incomplete));
    expect(result.runtime.supported).toBe(false);
    expect(result.plan).toBeNull();
  }
});
