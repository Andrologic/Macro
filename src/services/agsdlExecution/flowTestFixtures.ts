/** Synthetic IO fixtures for Flow tests. Real compiler/registry/language helpers
 * are used; these fixtures make no SQLite, native dispatch or runtime claim. */
import { requireMacroToolRegistryEntry } from '../../shared/macroToolRegistry';
import type { EngineActivation, EngineOwner, HostInspection, Prepare } from '../../types/generated/ipc';
import { compileFixture, documentFixture, json, registryFixture } from './conformanceFixtures';
import { decode, encode, record, type ExactObject } from './exact';
import { INVOCATION_CAPABILITIES, type CapturedRegistry } from './registry';

export const flowOwner: EngineOwner = { systemStartId: 'system', ownerEpoch: '3' };
export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export function flowDelivery(name: string, sequence: string, step: string | null = 'work', agent: string | null = 'worker-instance'): EngineActivation {
  return { delivery: { deliveryId: `delivery-${name}`, queueSequence: sequence, work: { systemStartId: 'system', flowInvocationId: 'flow', activationId: name,
    step: step === null ? null : [step], agentInstanceId: agent }, input: { origin: 'entry', valueJson: '{"prompt":[{"value":"Go"}]}' } }, workState: 'queued', stopState: { kind: 'none' } };
}
export async function flowFixture(graphless = false) {
  const document = documentFixture();
  record(record(document.configurations).fixed).settings = {};
  record(document.bindings).reader = { contract: { identity: 'macro/tool/read', version: '1' }, implementation: { identity: 'macro/desktop', version: '1' }, effects: 'none' };
  if (graphless) delete document.flow;
  else document.flow = { entry: 'work', steps: {
    work: { type: 'agent', agent: 'worker', next: ['call'] },
    call: { type: 'call', binding: 'reader', arguments: { path: { value: 'synthetic.txt' } }, scope: { action: 'read', resources: ['synthetic.txt'], context: { path: [] } }, next: ['check'] },
    check: { type: 'condition', test: { equals: [{ path: ['data'] }, { value: 'ok' }] }, next: { true: ['prepare'], false: [] } },
    prepare: { type: 'prepare', message: { prompt: [{ value: 'Continue.' }], resources: { exact: { select: { path: ['data'] }, mediaType: 'application/json' } } }, next: ['again'] },
    again: { type: 'agent', agent: 'worker', next: [] },
  } };
  const base = registryFixture(document);
  const permissionsJson = json('{"mode":"Implement","allowedToolIds":["read"],"riskLevel":"balanced"}');
  const scopeJson = json('{"root":"/synthetic/project"}');
  const registry: CapturedRegistry = { ...base,
    bindings: base.bindings.filter(binding => binding.declarationJson !== encode(record(document.bindings).reader)).concat({
      declarationJson: encode(record(document.bindings).reader), target: { kind: 'macro-tool', toolId: 'read' },
      argumentSchemaJson: encode(decode(JSON.stringify(requireMacroToolRegistryEntry('read').parameters))), resultConstraintJson: json('{"type":"string"}'),
      capabilities: INVOCATION_CAPABILITIES, verifiedRequirementsJson: [],
    }), configurations: base.configurations.map(configuration => ({ ...configuration, permissionsJson, scopeJson })) };
  const compiled = await compileFixture(document, registry);
  if (!compiled.plan) throw new Error(JSON.stringify(compiled.runtime.diagnostics));
  const plan = compiled.plan;
  const inspection: HostInspection = { snapshot: { systemStartId: 'system', source: plan.source, authoredSource: encode(document), versions: plan.versions,
    agents: plan.agents.map(agent => ({ ...agent })), compiledPlanJson: compiled.compiledPlanJson!, associations: {} },
    snapshotDigest: 'native-snapshot-digest', projection: { systemStartId: 'system', cursor: '1', activations: [], systemStop: { kind: 'none' } },
    privateCaptureJson: JSON.stringify({ implementationDigest: 'macro-native-host/1', registryJson: JSON.stringify(registry),
      nativeCatalogueJson: JSON.stringify({ providers: [{ providerId: 'synthetic-provider', providerType: 'openai' }] }),
      callScopes: graphless ? [] : [{ step: ['call'], permissionsJson, scopeJson }] }),
    agents: [{ agentName: 'worker', agentInstanceId: 'worker-instance', memory: null }], effects: [], responseClosuresJson: [], preparedTerminalsJson: [] };
  return { document, plan, registry, inspection };
}
export function preparedFixture(activation: EngineActivation, extra: Partial<Prepare> = {}): Prepare {
  return { owner: flowOwner, work: activation.delivery.work, outcome: { kind: 'completed', output: { origin: 'agent', valueJson: '{"text":"ok","results":{}}' } },
    memory: null, responseCursor: '0', terminationEvidenceJson: '{}', validation: { snapshotDigest: 'native-snapshot-digest', input: activation.delivery.input,
      declarationJson: '{}', closureDigest: 'native-closure-digest', selectedBranch: null }, ...extra };
}
export function exactRecord(jsonText: string): ExactObject { return record(decode(jsonText)); }
