/** Synthetic fixtures shared by focused conformance tests. No provider is contacted. */
import type { CapturedRegistry, BindingAttestation } from './registry';
import { ENGINE_CAPABILITIES, INVOCATION_CAPABILITIES } from './registry';
import { decode, encode, record, type ExactObject } from './exact';
import type { ExactJsonText, ExecutionContext, Identity, SourceRevision } from './contracts';
import { compilePlan, sourceDigest } from './compiler';

export const json = (value: string) => value as ExactJsonText;
export const id = <K extends string>(value: string) => value as Identity<K>;
export const BASE_SOURCE = '{"contract":"agsdl-0.2.0","id":"synthetic","bindings":{"engine":{"contract":{"identity":"synthetic/engine","version":"1"},"implementation":{"identity":"macro/streaming","version":"1"}}},"configurations":{"fixed":{"engine":"engine","model":{"identity":"synthetic/model","version":"1"},"settings":{"budget":9007199254740993}}},"agents":{"worker":{"configuration":"fixed","prompt":[{"value":"Review."}]}},"flow":{"entry":"work","steps":{"work":{"type":"agent","agent":"worker","next":[],"maxVisits":1e20}}}}';
export const documentFixture = (): ExactObject => record(decode(BASE_SOURCE));
export function registryFixture(document: ExactObject): CapturedRegistry {
  const configuration = record(record(document.configurations).fixed);
  const bindings: BindingAttestation[] = Object.values(record(document.bindings)).map(binding => ({ declarationJson: encode(binding), target: { kind: 'engine', adapter: 'macro-streaming-v1' }, argumentSchemaJson: json('{}'), resultConstraintJson: json('{"type":"object"}'), capabilities: [...ENGINE_CAPABILITIES, 'typed-publication'], verifiedRequirementsJson: [] }));
  return { version: 'synthetic-captured/1', bindings, models: [{ editionJson: encode(configuration.model), providerId: 'synthetic-provider', modelId: 'synthetic-model' }], configurations: [{ agentName: 'worker', agentDeclarationJson: encode(record(document.agents).worker), configurationDeclarationJson: encode(configuration), effectiveSettingsJson: encode(configuration.settings ?? {}), permissionsJson: json('["read"]'), scopeJson: json('{}'), verifiedRequirementsJson: [] }], mcpTools: [] };
}
export function invocationFixture(declarationJson: ExactJsonText, argumentSchemaJson: ExactJsonText): BindingAttestation {
  return { declarationJson, target: { kind: 'macro-tool', toolId: 'web_search' }, argumentSchemaJson, resultConstraintJson: json('{"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"],"additionalProperties":false}'), capabilities: [...INVOCATION_CAPABILITIES], verifiedRequirementsJson: [] };
}
export async function compileFixture(document: ExactObject, registry = registryFixture(document)) {
  const sourceText = encode(document);
  const source: SourceRevision = { owner: { projectId: 'synthetic-project', planId: 'synthetic-plan', branch: 'feature/synthetic' }, revision: '7', sourceSha256: id(await sourceDigest(sourceText)) };
  return compilePlan(sourceText, source, registry);
}
export const contextFixture = (): ExecutionContext => ({ owner: { systemStartId: id('system'), ownerEpoch: id('3') }, work: { systemStartId: id('system'), flowInvocationId: id('flow'), activationId: id('activation'), step: ['work'], agentInstanceId: id('worker-instance') }, permissionsJson: json('["read"]'), scopeJson: json('{}'), registryVersion: 'synthetic-captured/1' });
