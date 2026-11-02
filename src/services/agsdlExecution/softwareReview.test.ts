import { expect, it } from 'bun:test';
import { requireMacroToolRegistryEntry } from '../../shared/macroToolRegistry';
import { compileFixture, contextFixture, json } from './conformanceFixtures';
import { prepareClaudeAgent } from './claudeAgent';
import { deliveryMessage } from './content';
import { decode, encode, record } from './exact';
import { executeFlowActivation, loadFlowCapture, type FlowActivationPorts } from './flowActivation';
import { flowInput } from './flowValues';
import { flowDelivery, flowFixture, flowOwner } from './flowTestFixtures';

// Controlled ports isolate exact transfer from Git rendering, SQLite and physical
// engine qualification, which have their own native checks.
async function fixture() {
  const f = await flowFixture();
  const binding = { contract: { identity: 'macro/tool/git_diff', version: '1' }, implementation: { identity: 'macro/desktop', version: '1' }, effects: 'none' };
  record(f.document.bindings).reader = binding;
  const steps = record(record(f.document.flow).steps);
  delete steps.check;
  steps.call = decode(JSON.stringify({ type: 'call', binding: 'reader', arguments: {
    repo_path: { value: '/synthetic/project' }, base: { value: '0123456789abcdef0123456789abcdef01234567' },
    mode: { value: 'patch' }, ignore_whitespace: { value: false }, require_complete: { value: true }, paths: { value: ['greeting.js'] }, context_lines: { value: 3 },
  }, next: ['prepare'] }));
  steps.prepare = { type: 'prepare', message: { resources: { patch: { select: { path: ['data'] }, mediaType: 'text/plain' } } }, next: ['again'] };
  const registry = { ...f.registry, bindings: [...f.registry.bindings.slice(0, -1), { ...f.registry.bindings.at(-1)!, declarationJson: encode(binding),
    target: { kind: 'macro-tool', toolId: 'git_diff' }, argumentSchemaJson: json(JSON.stringify(requireMacroToolRegistryEntry('git_diff').parameters)) } as const] };
  const compiled = await compileFixture(f.document, registry);
  if (!compiled.plan) throw Error(JSON.stringify(compiled));
  Object.assign(f.inspection.snapshot, { source: compiled.plan.source, authoredSource: encode(f.document), compiledPlanJson: compiled.compiledPlanJson!, agents: compiled.plan.agents });
  const privateCapture = JSON.parse(f.inspection.privateCaptureJson);
  privateCapture.registryJson = JSON.stringify(registry);
  f.inspection.privateCaptureJson = JSON.stringify(privateCapture);
  const ports: FlowActivationPorts = {
    readResponses: async () => [[], 'empty-native-digest'], closeResponses: async closure => closure,
    identity: () => 'capture-invocation', prepareAgent: async () => { throw Error('No provider during capture/Prepare'); },
    invoke: async () => { throw Error('Set the retained tool receipt'); },
  };
  return { ...f, ports, capture: await loadFlowCapture(f.inspection) };
}

it('transfers the retained strict patch through Call and Prepare into the Claude adapter unchanged', async () => {
  const f = await fixture();
  const patch = 'diff --git a/greeting.js b/greeting.js\n--- a/greeting.js\n+++ b/greeting.js\n@@ -1 +1 @@\n-Bonjour\r\n+Bonjour, été\r\n\\ No newline at end of file\n';
  f.ports.invoke = async request => {
    expect(JSON.parse(request.argumentsJson)).toMatchObject({ mode: 'patch', require_complete: true, ignore_whitespace: false, paths: ['greeting.js'] });
    return { failed: false, resultJson: JSON.stringify(patch) };
  };
  const captured = await executeFlowActivation(flowOwner, flowDelivery('capture', '1', 'call', null), null, f.inspection, f.capture, () => {}, f.ports);
  if (captured.outcome.kind !== 'completed') throw Error('Capture failed');
  const prepare = flowDelivery('prepare', '2', 'prepare', null);
  prepare.delivery.input = captured.outcome.output;
  const prepared = await executeFlowActivation(flowOwner, prepare, null, f.inspection, f.capture, () => {}, f.ports);
  if (prepared.outcome.kind !== 'completed') throw Error('Prepare failed');
  const input = deliveryMessage(f.capture.document, flowInput(prepared.outcome.output));
  expect(record(record(record(decode(input)).resources).patch).value).toBe(patch);
  let received = '';
  const configuration = f.capture.plan.agents[0];
  const agent = await prepareClaudeAgent({ context: { ...contextFixture(), work: { ...contextFixture().work, step: null },
    permissionsJson: configuration.permissionsJson, scopeJson: configuration.scopeJson, registryVersion: f.registry.version },
    providerType: 'claude-native', toolAliases: [], memory: null,
    configuration: { ...configuration, providerId: 'claude-native', configurationJson: json(JSON.stringify({ initialization: {}, nativeEngine: { adapter: 'claude-sdk-v1', profileJson: JSON.stringify({ format: 'macro-claude-controlled-profile/1', version: '0.3.308', cliVersion: '2.1.308', toolPolicy: 'macro-controlled' }) } })) },
    responses: { agentName: 'worker', interfaceJson: json('{}'), stepJson: null, publicationContractJson: null } }, {
    identity: () => 'review-attempt', run: async request => { received = request.inputJson; return { kind: 'completed', sessionId: 'review-session', runId: 'review-turn' }; },
    stop: async () => {}, journal: { read: async () => ({ events: [], digest: 'review-digest' }), close: async closure => closure },
  });
  await agent.acceptInput(() => input); await agent.executeReady();
  expect(received).toBe(input);
});

it('fails closed when strict patch capture fails or its acknowledgement is unknown', async () => {
  const f = await fixture();
  const activation = flowDelivery('capture', '1', 'call', null);
  f.ports.invoke = async () => ({ failed: true, resultJson: '"Binary, invalid encoding or size limit"' });
  const failed = await executeFlowActivation(flowOwner, activation, null, f.inspection, f.capture, () => {}, f.ports);
  expect(failed.outcome).toMatchObject({ kind: 'failed', code: 'CALL_FAILED' });
  // An unresolved acknowledgement never fabricates a terminal patch for routing.
  f.ports.invoke = async () => { throw Error('Unknown capture acknowledgement'); };
  await expect(executeFlowActivation(flowOwner, activation, null, f.inspection, f.capture, () => {}, f.ports)).rejects.toThrow('Unknown capture acknowledgement');
});
