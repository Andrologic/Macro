import { MACRO_TOOL_REGISTRY } from '../../shared/macroToolRegistry';
import { MACRO_ENGINE_CONTRACT, MACRO_ENGINE_IMPLEMENTATION } from '../agsdl/macroAgentConfiguration';
import type { ExactJsonText } from './contracts';
import { decode, encode, equal, fail, has, list, record, text, type ExactObject } from './exact';
import { captureRegistry, ENGINE_CAPABILITIES, INVOCATION_CAPABILITIES, PUBLICATION_PROTOCOL, requireExactRequirements, type BindingAttestation, type CapturedRegistry, type ConfigurationAttestation, type ModelCatalogueEntry } from './registry';

/** Native observations supplied only in the authenticated compiler ticket. No UI intake. */
export interface NativeRegistryObservation {
  readonly format: 'macro-native-registry-observation/1';
  readonly version: string;
  readonly models: readonly ModelCatalogueEntry[];
  readonly tools: readonly {
    readonly toolId: string;
    readonly resultConstraintJson: ExactJsonText;
    readonly effects: 'none' | 'external';
    readonly verifiedRequirementsJson: readonly ExactJsonText[];
  }[];
  readonly configurations: readonly Omit<ConfigurationAttestation, 'agentDeclarationJson' | 'configurationDeclarationJson'>[];
}

/** The embedded component contributes schemas from the actual shared Macro registry.
 * Native capture supplies the registered adapter/result contracts and concrete scopes.
 * Requirements and effects are compared to those observations, never copied as proofs.
 */
export function buildNativeRegistry(authoredSource: string, observed: NativeRegistryObservation): CapturedRegistry {
  if (observed.format !== 'macro-native-registry-observation/1') return fail('CORRELATION', '/registry', 'Unknown native observation format.');
  const document = record(decode(authoredSource));
  const tools = new Map(observed.tools.map(tool => [tool.toolId, tool]));
  if (tools.size !== observed.tools.length) return fail('CORRELATION', '/registry', 'Native tool observations are ambiguous.');
  const bindings: BindingAttestation[] = [];
  for (const declaration of Object.values(record(document.bindings))) {
    const binding = record(declaration);
    if (!equal(binding.implementation, MACRO_ENGINE_IMPLEMENTATION)) continue;
    // No binding settings have an implemented interpretation in this profile.
    if (Object.keys(record(binding.settings ?? {})).length) continue;
    let candidate: Omit<BindingAttestation, 'declarationJson'> | undefined;
    let effects: 'none' | 'external' = 'external';
    if (equal(binding.contract, MACRO_ENGINE_CONTRACT)) {
      candidate = { target: { kind: 'engine', adapter: 'macro-streaming-v1' }, argumentSchemaJson: encode({}), resultConstraintJson: encode({ type: 'object' }), capabilities: [...ENGINE_CAPABILITIES, 'typed-publication'], verifiedRequirementsJson: [] };
    } else if (equal(binding.contract, { identity: 'macro-agsdl-publication', version: '1' })) {
      effects = 'none';
      candidate = { target: { kind: 'publication', protocol: PUBLICATION_PROTOCOL }, argumentSchemaJson: encode({}), resultConstraintJson: encode({ type: 'object' }), capabilities: ['typed-publication', 'response-attribution'], verifiedRequirementsJson: [] };
    } else {
      const match = [...tools.values()].find(tool => equal(binding.contract, { identity: `macro/tool/${tool.toolId}`, version: '1' }));
      if (match) {
        const entry = MACRO_TOOL_REGISTRY.find(tool => tool.id === match.toolId);
        if (!entry) return fail('CORRELATION', '/registry', 'Native adapter is absent from the Macro tool registry.');
        effects = match.effects;
        candidate = { target: { kind: 'macro-tool', toolId: match.toolId }, argumentSchemaJson: encode(decode(JSON.stringify(entry.parameters))), resultConstraintJson: match.resultConstraintJson, capabilities: [...INVOCATION_CAPABILITIES], verifiedRequirementsJson: match.verifiedRequirementsJson };
      }
    }
    if (!candidate || (has(binding, 'effects') && binding.effects !== 'unknown' && binding.effects !== effects)) continue;
    requireExactRequirements(list(binding.requires ?? []), candidate.verifiedRequirementsJson);
    // Identical declarations may be referenced under multiple binding names.
    if (!bindings.some(entry => equal(decode(entry.declarationJson), declaration))) bindings.push({ ...candidate, declarationJson: encode(declaration) });
  }
  const configurations: ConfigurationAttestation[] = [];
  for (const observation of observed.configurations) {
    const agents = record(document.agents);
    if (!has(agents, observation.agentName)) return fail('CORRELATION', '/registry', 'Native configuration names an absent Agent.');
    const agent = record(agents[observation.agentName]);
    if (typeof agent.configuration !== 'string') continue;
    const configuration: ExactObject = record(record(document.configurations)[agent.configuration]);
    const permissions = record(decode(observation.permissionsJson));
    const allowed = list(permissions.allowedToolIds).map(value => text(value));
    for (const bindingName of Object.values(record(configuration.tools ?? {}))) {
      const declaration = record(document.bindings)[text(bindingName)];
      const adapter = bindings.find(binding => equal(decode(binding.declarationJson), declaration));
      if (!adapter || adapter.target.kind !== 'macro-tool' || !allowed.includes(adapter.target.toolId)) {
        return fail('PERMISSION', '/configurations/tools', 'Configured tool is outside the captured native policy.');
      }
    }
    configurations.push({ ...observation, agentDeclarationJson: encode(agent), configurationDeclarationJson: encode(configuration) });
  }
  return captureRegistry({ version: observed.version, bindings, models: observed.models, configurations, mcpTools: [] });
}
