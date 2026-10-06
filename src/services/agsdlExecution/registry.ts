import { MACRO_TOOL_REGISTRY } from '../../shared/macroToolRegistry';
import type { MCPTool } from '../../types';
import { read } from '../../vendor/agsdl/v0.2/reader.mjs';
import { schema, satisfies, type as valueType } from '../../vendor/agsdl/v0.2/values.mjs';
import type { ExactJsonText, FrozenAgentConfiguration } from './contracts';
import { NumberToken, clone, decimal, decode, encode, equal, fail, has, list, record, shape, text, type ExactObject, type ExactValue } from './exact';

import { captureNativeJson, metadataArray, metadataIdentity, metadataJson, metadataObject, metadataText } from './metadata';

export const PUBLICATION_PROTOCOL = 'macro-agsdl-publication/1' as const;
export const ENGINE_CAPABILITIES = ['agent-continuity', 'prompt-instructions', 'resources-information', 'inline-text-json', 'tool-admission', 'response-attribution'] as const;
export const INVOCATION_CAPABILITIES = ['actual-permission-scope', 'termination-evidence'] as const;
export type BindingTarget =
  | { readonly kind: 'engine'; readonly adapter: 'macro-streaming-v1' }
  | { readonly kind: 'macro-tool'; readonly toolId: string }
  | { readonly kind: 'mcp-tool'; readonly serverId: string; readonly toolId: string; readonly descriptorJson: ExactJsonText }
  | { readonly kind: 'publication'; readonly protocol: typeof PUBLICATION_PROTOCOL };
/** Filled by the trusted native-host adapter, never sourced from document claims or UI input. */
export interface BindingAttestation {
  readonly declarationJson: ExactJsonText;
  readonly target: BindingTarget;
  readonly argumentSchemaJson: ExactJsonText;
  readonly resultConstraintJson: ExactJsonText;
  readonly capabilities: readonly string[];
  readonly verifiedRequirementsJson: readonly ExactJsonText[];
}
export interface ModelCatalogueEntry {
  readonly editionJson: ExactJsonText;
  readonly providerId: string;
  readonly modelId: string;
}
export interface ConfigurationAttestation {
  readonly agentName: string;
  readonly agentDeclarationJson: ExactJsonText;
  readonly configurationDeclarationJson: ExactJsonText;
  readonly verifiedRequirementsJson: readonly ExactJsonText[];
  readonly effectiveSettingsJson: ExactJsonText;
  readonly permissionsJson: ExactJsonText;
  readonly scopeJson: ExactJsonText;
}
/** The caller must authenticate and capture these inputs behind native start.
 * This pure verifier is not an authentication service. Product availability stays false.
 * MCP descriptors must be captured through Macro's typed discovery adapter, including server identity.
 */
export interface CapturedRegistry {
  readonly version: string;
  readonly bindings: readonly BindingAttestation[];
  readonly models: readonly ModelCatalogueEntry[];
  readonly configurations: readonly ConfigurationAttestation[];
  readonly mcpTools: readonly MCPTool[];
}
/** Validate and copy the transport boundary. Native provenance still belongs to Hosting. */
export function captureRegistry(value: unknown): CapturedRegistry {
  const registry = metadataObject(value, '/registry');
  const version = metadataIdentity(registry.version, '/registry/version');
  const objects = (field: string) => metadataArray(registry[field], `/registry/${field}`).map((entry, index) => ({ entry: metadataObject(entry, `/registry/${field}/${index}`), pointer: `/registry/${field}/${index}` }));
  const jsons = (value: unknown, pointer: string) => metadataArray(value, pointer).map((json, index) => metadataJson(json, `${pointer}/${index}`));
  const bindings = objects('bindings').map(({ entry, pointer }): BindingAttestation => {
    const targetPointer = `${pointer}/target`, target = metadataObject(entry.target, targetPointer);
    let capturedTarget: BindingTarget;
    switch (target.kind) {
      case 'engine':
        if (target.adapter !== 'macro-streaming-v1') return fail('UNSUPPORTED', `${targetPointer}/adapter`, 'Unknown Engine adapter.');
        capturedTarget = { kind: 'engine', adapter: 'macro-streaming-v1' }; break;
      case 'publication':
        if (target.protocol !== PUBLICATION_PROTOCOL) return fail('UNSUPPORTED', `${targetPointer}/protocol`, 'Unknown publication protocol.');
        capturedTarget = { kind: 'publication', protocol: PUBLICATION_PROTOCOL }; break;
      case 'macro-tool':
        capturedTarget = { kind: 'macro-tool', toolId: metadataIdentity(target.toolId, `${targetPointer}/toolId`) }; break;
      case 'mcp-tool':
        capturedTarget = { kind: 'mcp-tool', serverId: metadataIdentity(target.serverId, `${targetPointer}/serverId`), toolId: metadataIdentity(target.toolId, `${targetPointer}/toolId`), descriptorJson: metadataJson(target.descriptorJson, `${targetPointer}/descriptorJson`) }; break;
      default: return fail('UNSUPPORTED', `${targetPointer}/kind`, 'Unknown binding target.');
    }
    return {
      declarationJson: metadataJson(entry.declarationJson, `${pointer}/declarationJson`), target: capturedTarget,
      argumentSchemaJson: metadataJson(entry.argumentSchemaJson, `${pointer}/argumentSchemaJson`),
      resultConstraintJson: metadataJson(entry.resultConstraintJson, `${pointer}/resultConstraintJson`),
      capabilities: metadataArray(entry.capabilities, `${pointer}/capabilities`).map((capability, index) => metadataIdentity(capability, `${pointer}/capabilities/${index}`)),
      verifiedRequirementsJson: jsons(entry.verifiedRequirementsJson, `${pointer}/verifiedRequirementsJson`),
    };
  });
  const models = objects('models').map(({ entry, pointer }): ModelCatalogueEntry => {
    const editionJson = metadataJson(entry.editionJson, `${pointer}/editionJson`);
    if (!shape(decode(editionJson), schema.$defs.Edition)) return fail('UNSUPPORTED', `${pointer}/editionJson`, 'Model catalogue edition is incomplete.');
    return { editionJson, providerId: metadataIdentity(entry.providerId, `${pointer}/providerId`), modelId: metadataIdentity(entry.modelId, `${pointer}/modelId`) };
  });
  const configurations = objects('configurations').map(({ entry, pointer }): ConfigurationAttestation => ({
    agentName: metadataIdentity(entry.agentName, `${pointer}/agentName`),
    agentDeclarationJson: metadataJson(entry.agentDeclarationJson, `${pointer}/agentDeclarationJson`),
    configurationDeclarationJson: metadataJson(entry.configurationDeclarationJson, `${pointer}/configurationDeclarationJson`),
    verifiedRequirementsJson: jsons(entry.verifiedRequirementsJson, `${pointer}/verifiedRequirementsJson`),
    effectiveSettingsJson: metadataJson(entry.effectiveSettingsJson, `${pointer}/effectiveSettingsJson`),
    permissionsJson: metadataJson(entry.permissionsJson, `${pointer}/permissionsJson`), scopeJson: metadataJson(entry.scopeJson, `${pointer}/scopeJson`),
  }));
  const mcpTools = objects('mcpTools').map(({ entry, pointer }): MCPTool => {
    const tool: MCPTool = { id: metadataIdentity(entry.id, `${pointer}/id`), serverId: metadataIdentity(entry.serverId, `${pointer}/serverId`), name: metadataIdentity(entry.name, `${pointer}/name`) };
    for (const key of ['description', 'discoveredAt'] as const) if (entry[key] !== undefined) tool[key] = metadataText(entry[key], `${pointer}/${key}`);
    if (entry.enabled !== undefined) {
      if (typeof entry.enabled !== 'boolean') return fail('UNSUPPORTED', `${pointer}/enabled`, 'Expected a native enabled flag.');
      tool.enabled = entry.enabled;
    }
    if (entry.inputSchema !== undefined) tool.inputSchema = captureNativeJson(metadataObject(entry.inputSchema, `${pointer}/inputSchema`), `${pointer}/inputSchema`) as Record<string, unknown>;
    return tool;
  });
  return { version, bindings, models, configurations, mcpTools };
}
function requiredCapabilities(entry: BindingAttestation, required: readonly string[]): void {
  if (required.some(value => !entry.capabilities.includes(value))) return fail('UNSUPPORTED', '', 'The trusted path has unverified capabilities.');
}
export function requireExactRequirements(requirements: readonly ExactValue[], proofs: readonly ExactJsonText[]): void {
  for (const requirement of requirements) {
    if (!proofs.some(proof => equal(decode(proof), requirement))) return fail('UNSUPPORTED', '/requires', 'No verification for this complete requirement.');
  }
}
const ARGUMENT_KEYWORDS = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'minLength', 'allowEmpty', 'description']);
function nonnegativeCount(value: ExactValue): bigint {
  if (!(value instanceof NumberToken)) return fail('UNSUPPORTED', '', 'Schema count must be an integer.');
  const [sign, digits, exponent] = decimal(value);
  if (sign || exponent < 0n || exponent > 8n) return fail('UNSUPPORTED', '', 'Unsupported schema count.');
  return BigInt(digits) * 10n ** exponent;
}
/** Only this explicitly implemented JSON Schema subset can authorize arguments.
 * Unsupported MCP keywords fail preflight rather than being silently ignored by vendor shape.
 */
export function verifyArgumentSchema(value: ExactValue): void {
  const definition = record(value);
  if (Object.keys(definition).some(key => !ARGUMENT_KEYWORDS.has(key))) return fail('UNSUPPORTED', '', 'Argument schema has unimplemented keywords.');
  if (has(definition, 'type') && !['null', 'boolean', 'number', 'integer', 'string', 'array', 'object'].includes(text(definition.type))) return fail('UNSUPPORTED', '', 'Unknown argument type.');
  if (has(definition, 'description')) text(definition.description);
  if (has(definition, 'allowEmpty') && typeof definition.allowEmpty !== 'boolean') return fail('UNSUPPORTED', '', 'Invalid allowEmpty.');
  if (has(definition, 'minLength')) nonnegativeCount(definition.minLength);
  if (has(definition, 'enum')) list(definition.enum);
  if (has(definition, 'properties')) for (const child of Object.values(record(definition.properties))) verifyArgumentSchema(child);
  if (has(definition, 'required')) for (const key of list(definition.required)) text(key);
  if (has(definition, 'items')) verifyArgumentSchema(definition.items);
  if (has(definition, 'additionalProperties') && typeof definition.additionalProperties !== 'boolean') verifyArgumentSchema(definition.additionalProperties);
}
export function argumentsSatisfy(value: ExactValue, definition: ExactObject): boolean {
  if (has(definition, 'type') && !valueType(value, text(definition.type))) return false;
  if (has(definition, 'enum') && !list(definition.enum).some(candidate => equal(candidate, value))) return false;
  if (typeof value === 'string') {
    if (has(definition, 'minLength') && BigInt([...value].length) < nonnegativeCount(definition.minLength)) return false;
    if (definition.allowEmpty === false && value.length === 0) return false;
  }
  if (Array.isArray(value) && has(definition, 'items')) return value.every(item => argumentsSatisfy(item, record(definition.items)));
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof NumberToken)) {
    if (list(definition.required ?? []).some(key => !has(value, text(key)))) return false;
    const properties = record(definition.properties ?? {});
    return Object.entries(value).every(([key, child]) => has(properties, key)
      ? argumentsSatisfy(child, record(properties[key]))
      : definition.additionalProperties === false ? false
        : definition.additionalProperties !== undefined && typeof definition.additionalProperties !== 'boolean'
          ? argumentsSatisfy(child, record(definition.additionalProperties)) : true);
  }
  return true;
}
export function validateRegisteredArguments(entry: BindingAttestation, argumentsJson: ExactJsonText): void {
  const definition = decode(entry.argumentSchemaJson);
  verifyArgumentSchema(definition);
  if (!argumentsSatisfy(decode(argumentsJson), record(definition))) return fail('INPUT_CONSTRAINT', '/arguments', 'Arguments violate the captured binding schema.');
}
export function verifyResultConstraint(constraintJson: ExactJsonText): void {
  const constraint = decode(constraintJson);
  if (!shape(constraint, schema.$defs.ValueConstraint)) return fail('UNSUPPORTED', '', 'Result constraint is not an AgSDL valueSchema.');
  // Reuse all semantic declaration checks, including enum/required consistency.
  const sample = encode({ contract: 'agsdl-0.2.0', id: 'constraint', bindings: { engine: { contract: { identity: 'constraint/engine', version: '1' }, implementation: { identity: 'constraint/local', version: '1' } } }, configurations: { fixed: { engine: 'engine' } }, agents: { agent: { configuration: 'fixed', interface: { results: { result: { mediaTypes: ['application/json'], valueSchema: constraint } } } } } });
  if (!read(new TextEncoder().encode(sample)).valid) return fail('UNSUPPORTED', '', 'Invalid result constraint declaration.');
}
export function validateRegisteredResult(entry: BindingAttestation, resultJson: ExactJsonText): void {
  verifyResultConstraint(entry.resultConstraintJson);
  if (!satisfies(decode(resultJson), decode(entry.resultConstraintJson))) return fail('CALL_RESULT', '/data', 'Result violates the captured binding constraint.');
}
export function resolveBinding(document: ExactObject, name: string, registry: CapturedRegistry, role: 'engine' | 'tool' | 'call' | 'publication'): BindingAttestation {
  const declaration = record(record(document.bindings)[name]);
  const matches = registry.bindings.filter(entry => equal(decode(entry.declarationJson), declaration));
  if (matches.length !== 1) return fail('UNSUPPORTED', `/bindings/${name}`, 'Binding has no unique complete trusted declaration.');
  const entry = matches[0];
  requireExactRequirements(list(declaration.requires ?? []), entry.verifiedRequirementsJson);
  verifyArgumentSchema(decode(entry.argumentSchemaJson));
  verifyResultConstraint(entry.resultConstraintJson);
  if (role === 'engine') {
    if (entry.target.kind !== 'engine' || entry.target.adapter !== 'macro-streaming-v1') return fail('UNSUPPORTED', '', 'Unknown Engine path.');
    requiredCapabilities(entry, ENGINE_CAPABILITIES);
  } else if (role === 'publication') {
    if (entry.target.kind !== 'publication' || entry.target.protocol !== PUBLICATION_PROTOCOL) return fail('UNSUPPORTED', '', 'Unknown publication path.');
    requiredCapabilities(entry, ['typed-publication', 'response-attribution']);
  } else {
    if (entry.target.kind === 'macro-tool') {
      const toolId = entry.target.toolId;
      const actual = MACRO_TOOL_REGISTRY.find(tool => tool.id === toolId);
      if (!actual || !equal(decode(entry.argumentSchemaJson), decode(JSON.stringify(actual.parameters)))) return fail('UNSUPPORTED', '', 'Macro tool or argument schema differs from the real registry.');
    } else if (entry.target.kind === 'mcp-tool') {
      const target = entry.target;
      const descriptors = registry.mcpTools.filter(tool => tool.id === target.toolId && tool.serverId === target.serverId && tool.enabled !== false);
      if (descriptors.length !== 1 || !descriptors[0].inputSchema) return fail('UNSUPPORTED', '', 'MCP descriptor is unknown or incomplete.');
      const actual = descriptors[0];
      const captured = record(decode(target.descriptorJson));
      if (!equal(captured, decode(JSON.stringify({ id: actual.id, serverId: actual.serverId, name: actual.name, inputSchema: actual.inputSchema }))) || !equal(decode(entry.argumentSchemaJson), captured.inputSchema)) return fail('UNSUPPORTED', '', 'MCP descriptor does not match captured discovery.');
    } else return fail('UNSUPPORTED', '', 'Tool/Call requires an explicit Macro or MCP target.');
    requiredCapabilities(entry, INVOCATION_CAPABILITIES);
  }
  return clone(entry);
}
export function captureAgent(document: ExactObject, agentName: string, initialization: ExactObject, registry: CapturedRegistry): FrozenAgentConfiguration {
  const agent = record(record(document.agents)[agentName]);
  const configurationName = text(agent.configuration);
  const configuration = record(record(document.configurations)[configurationName]);
  resolveBinding(document, text(configuration.engine), registry, 'engine');
  for (const name of Object.values(record(configuration.tools ?? {}))) resolveBinding(document, text(name), registry, 'tool');
  if (!has(configuration, 'model')) return fail('UNSUPPORTED', `/configurations/${configurationName}/model`, 'Provider and Model must be explicit.');
  const models = registry.models.filter(model => equal(decode(model.editionJson), configuration.model));
  if (models.length !== 1) return fail('UNSUPPORTED', '', 'Model has no unique captured native catalogue entry.');
  const providerId = metadataIdentity(models[0].providerId, '/registry/models/providerId');
  const modelId = metadataIdentity(models[0].modelId, '/registry/models/modelId');
  const proofs = registry.configurations.filter(proof => proof.agentName === agentName && equal(decode(proof.agentDeclarationJson), agent) && equal(decode(proof.configurationDeclarationJson), configuration));
  if (proofs.length !== 1) return fail('UNSUPPORTED', '', 'Agent configuration has no unique end-to-end verification.');
  const proof = proofs[0];
  const skillRequirements = list(agent.skills ?? []).flatMap(name => list(record(record(document.skills ?? {})[text(name)]).requires ?? []));
  requireExactRequirements([...list(configuration.requires ?? []), ...skillRequirements], proof.verifiedRequirementsJson);
  record(decode(proof.effectiveSettingsJson));
  decode(proof.permissionsJson);
  decode(proof.scopeJson);
  return {
    agentName, configurationName, providerId, modelId,
    configurationJson: encode({ agent: clone(agent), configuration: clone(configuration), initialization: clone(initialization), bindings: clone(record(document.bindings)) }),
    settingsJson: proof.effectiveSettingsJson, permissionsJson: proof.permissionsJson, scopeJson: proof.scopeJson,
  };
}
