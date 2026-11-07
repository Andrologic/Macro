import { Graph } from '../../vendor/agsdl/v0.3/graph.mjs';
import { equal, loadHarnessModule, validateExact, type HarnessModule030 } from '../../vendor/agsdl/v0.3/reader.mjs';
import { validate as validateValue } from '../../vendor/agsdl/v0.3/valueschema.mjs';
import type { ExactJsonText } from './contracts';
import type { AgentObservation030, CapabilityObservation030, CapturedRegistry030, FrozenAgentConfiguration030, HarnessObservation030 } from './contracts030';
import { at, decode, fail, has, NumberToken, record, text, type ExactObject, type ExactValue } from './exact';
import { metadataArray, metadataIdentity, metadataJson, metadataObject } from './metadata';

const HOST_GUARANTEES = ['result-submission', 'continuity', 'permission-enforcement', 'contained-stop', 'response-attribution'] as const;

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function unique(names: readonly string[], pointer: string): void {
  const seen = new Set<string>();
  for (const [index, name] of names.entries()) {
    if (seen.has(name)) fail('CORRELATION', `${pointer}/${index}`, 'Duplicate observation identity.');
    seen.add(name);
  }
}

function json(value: unknown, pointer: string): ExactJsonText {
  // TextEncoder would otherwise silently replace an unpaired UTF-16 surrogate.
  if (typeof value === 'string') for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff) fail('PARSE', pointer, 'Invalid UTF-16 in JSON transport text.');
  }
  return metadataJson(value, pointer);
}

function nonempty(value: ExactValue): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return value !== null && typeof value === 'object' && !(value instanceof NumberToken) && Object.keys(value).length > 0;
}

function receipt(value: unknown, pointer: string): ExactJsonText {
  const captured = json(value, pointer);
  if (!nonempty(decode(captured))) fail('CORRELATION', pointer, 'A nonempty native authority receipt or envelope is required.');
  return captured;
}

function nullableIdentity(value: unknown, pointer: string): string | null {
  return value === null ? null : metadataIdentity(value, pointer);
}

function identities(value: unknown, pointer: string): string[] {
  const names = metadataArray(value, pointer).map((name, index) => metadataIdentity(name, `${pointer}/${index}`));
  unique(names, pointer);
  return names;
}

function objects(value: unknown, pointer: string): { entry: Record<string, unknown>; pointer: string }[] {
  return metadataArray(value, pointer).map((entry, index) => ({ entry: metadataObject(entry, `${pointer}/${index}`), pointer: `${pointer}/${index}` }));
}

function captureCapabilities(value: unknown, pointer: string): CapabilityObservation030[] {
  const captured = objects(value, pointer).map(({ entry, pointer: where }): CapabilityObservation030 => {
    const name = metadataIdentity(entry.name, `${where}/name`);
    if (entry.support !== 'native' && entry.support !== 'approximate' && entry.support !== 'absent') return fail('UNSUPPORTED', `${where}/support`, 'Unknown observed support level.');
    const evidenceJson = entry.support === 'absent' ? json(entry.evidenceJson, `${where}/evidenceJson`) : receipt(entry.evidenceJson, `${where}/evidenceJson`);
    return { name, support: entry.support, evidenceJson };
  });
  unique(captured.map(capability => capability.name), pointer);
  return captured;
}

/** Defence in depth for public snapshots. Native capture must exclude all secrets,
 * including credentials whose arbitrary values cannot be recognized textually. */
function noCredentials(value: ExactValue, pointer: string): void {
  if (typeof value === 'string' && (/-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/.test(value) || /^(?:Bearer\s+\S+|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,})$/i.test(value))) {
    fail('SECRET_SETTINGS', pointer, 'Credential material cannot enter a frozen configuration.');
  }
  if (value === null || typeof value !== 'object' || value instanceof NumberToken) return;
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.replace(/[-_]/g, '').toLowerCase();
    if (/^(?:apikey|secret|clientsecret|password|passwd|token|accesstoken|refreshtoken|authorization|credential|credentials|privatekey)$/.test(normalized)) {
      fail('SECRET_SETTINGS', at(pointer, key), 'Credentials belong outside captured settings.');
    }
    noCredentials(child, at(pointer, key));
  }
}

function settings(value: unknown, pointer: string): ExactJsonText {
  const captured = json(value, pointer);
  noCredentials(record(decode(captured), pointer), pointer);
  return captured;
}

function moduleFromJson(moduleJson: ExactJsonText, pointer: string): HarnessModule030 {
  try { return loadHarnessModule(new TextEncoder().encode(moduleJson)); }
  catch { return fail('HARNESS_MODULE', pointer, 'Invalid AgSDL 0.3 harness module.'); }
}

/** Pure transport capture. Only the authenticated native host may supply input.
 * Shape checks do not authenticate a receipt or turn a module into an observation. */
export function captureRegistry030(input: unknown): CapturedRegistry030 {
  const source = metadataObject(input, '/registry');
  if (source.format !== 'macro-agsdl-registry/030') fail('CORRELATION', '/registry/format', 'Unknown captured registry format.');
  const version = metadataIdentity(source.version, '/registry/version');
  const modules = objects(source.modules, '/registry/modules').map(({ entry, pointer }) => {
    const harness = metadataIdentity(entry.harness, `${pointer}/harness`);
    const moduleJson = json(entry.moduleJson, `${pointer}/moduleJson`);
    if (moduleFromJson(moduleJson, `${pointer}/moduleJson`).name !== harness) fail('CORRELATION', `${pointer}/harness`, 'Module name differs from its registry identity.');
    return { harness, moduleJson };
  });
  unique(modules.map(module => module.harness), '/registry/modules');
  const hostCapabilities = source.hostCapabilities === undefined ? undefined : captureCapabilities(source.hostCapabilities, '/registry/hostCapabilities');
  const harnesses = objects(source.harnesses, '/registry/harnesses').map(({ entry, pointer }): HarnessObservation030 => {
    const harness = metadataIdentity(entry.harness, `${pointer}/harness`);
    if (entry.installation !== 'available' && entry.installation !== 'missing') fail('UNSUPPORTED', `${pointer}/installation`, 'Expected an installation observation.');
    if (typeof entry.qualified !== 'boolean') fail('UNSUPPORTED', `${pointer}/qualified`, 'Expected a qualification observation.');
    const capabilities = captureCapabilities(entry.capabilities, `${pointer}/capabilities`);
    const models = objects(entry.models, `${pointer}/models`).map(({ entry: model, pointer: where }) => {
      const name = metadataIdentity(model.name, `${where}/name`);
      const efforts = identities(model.efforts, `${where}/efforts`);
      const defaultEffort = nullableIdentity(model.defaultEffort, `${where}/defaultEffort`);
      if (defaultEffort !== null && !efforts.includes(defaultEffort)) fail('MODEL_UNAVAILABLE', `${where}/defaultEffort`, 'Default effort is absent from the observed model catalogue.');
      return { name, efforts, defaultEffort };
    });
    unique(models.map(model => model.name), `${pointer}/models`);
    const defaultModel = nullableIdentity(entry.defaultModel, `${pointer}/defaultModel`);
    if (defaultModel !== null && !models.some(model => model.name === defaultModel)) fail('MODEL_UNAVAILABLE', `${pointer}/defaultModel`, 'Default model is absent from the observed catalogue.');
    return { harness, version: nullableIdentity(entry.version, `${pointer}/version`), installation: entry.installation,
      adapterId: nullableIdentity(entry.adapterId, `${pointer}/adapterId`), qualified: entry.qualified, capabilities, models, defaultModel };
  });
  unique(harnesses.map(harness => harness.harness), '/registry/harnesses');
  const agents = objects(source.agents, '/registry/agents').map(({ entry, pointer }): AgentObservation030 => {
    const agentDeclarationJson = json(entry.agentDeclarationJson, `${pointer}/agentDeclarationJson`);
    const declaration = record(decode(agentDeclarationJson), `${pointer}/agentDeclarationJson`);
    if (has(declaration, 'harnessSettings')) noCredentials(declaration.harnessSettings, `${pointer}/agentDeclarationJson/harnessSettings`);
    return {
      agentName: metadataIdentity(entry.agentName, `${pointer}/agentName`), agentDeclarationJson,
      settingsJson: settings(entry.settingsJson, `${pointer}/settingsJson`),
      permissionsJson: receipt(entry.permissionsJson, `${pointer}/permissionsJson`),
      scopeJson: receipt(entry.scopeJson, `${pointer}/scopeJson`), evidenceJson: receipt(entry.evidenceJson, `${pointer}/evidenceJson`),
      provenanceJson: receipt(entry.provenanceJson, `${pointer}/provenanceJson`),
    };
  });
  unique(agents.map(agent => agent.agentName), '/registry/agents');
  return freeze({ format: 'macro-agsdl-registry/030', version, modules, harnesses, agents,
    ...(hostCapabilities === undefined ? {} : { hostCapabilities }) });
}

function requireCapability(observation: HarnessObservation030, name: string, pointer: string, native = true): void {
  const capability = observation.capabilities.find(candidate => candidate.name === name);
  if (!capability || capability.support === 'absent' || native && capability.support !== 'native') {
    fail('HARNESS_CAPABILITY', pointer, `The observed adapter lacks ${native ? 'native ' : ''}qualification for ${name}.`);
  }
}

/** No range grammar is invented here. Range evaluation belongs to a qualified
 * native evaluator until a shared normative implementation is available. */
function requireRange(observation: HarnessObservation030, range: string, pointer: string): void {
  const proof = observation.capabilities.find(capability => {
    if (capability.support !== 'native') return false;
    const evidence = decode(capability.evidenceJson);
    if (evidence === null || typeof evidence !== 'object' || Array.isArray(evidence) || evidence instanceof NumberToken) return false;
    return evidence.kind === 'harness-version-range' && evidence.harness === observation.harness
      && evidence.version === observation.version && evidence.range === range && evidence.satisfied === true
      && has(evidence, 'receipt') && nonempty(evidence.receipt);
  });
  if (!proof) fail('HARNESS_VERSION_UNVERIFIED', pointer, `No native range evaluation binds harness ${observation.harness}, version ${observation.version}, and range ${range}.`);
}

export function usedProperties030(document: ExactObject, agentName: string, agent: ExactObject, pointer: string): Map<string, string> {
  const used = new Map<string, string>();
  for (const key of ['resources', 'skills', 'mcpServers']) {
    const value = agent[key];
    if (value !== undefined && value !== null && typeof value === 'object' && Object.keys(value).length) used.set(key, at(pointer, key));
  }
  const model = record(agent.model ?? {}, at(pointer, 'model'));
  for (const key of ['name', 'effort']) if (has(model, key)) used.set(`model.${key}`, `${pointer}/model/${key}`);
  if (agent.plan === true) used.set('plan', `${pointer}/plan`);
  if (has(agent, 'planFirst')) used.set(`planFirst.${text(agent.planFirst)}`, `${pointer}/planFirst`);
  if (typeof agent.permissions === 'object') {
    const permissions = record(agent.permissions, `${pointer}/permissions`);
    if (has(permissions, 'reviewer')) used.set(`reviewer.${text(permissions.reviewer)}`, `${pointer}/permissions/reviewer`);
    if (Object.keys(record(permissions.directories ?? {})).length) used.set('directories', `${pointer}/permissions/directories`);
  }
  // The vendor graph resolves parameter bindings through nested compositions.
  // Abstract unbound parameters carry no concrete definition to qualify.
  const graphs = has(document, 'flow') ? [Graph.for_flow(document)] : [];
  for (const name of Object.keys(record(document.compositions ?? {}))) graphs.push(Graph.for_composition(document, name));
  for (const graph of graphs) for (const node of graph.nodes.values()) {
    if (node.agent !== agentName || node.decl === null) continue;
    const where = node.pointer.reduce<string>((path, part) => at(path, String(part)), '');
    if (node.decl.instance === 'new') used.set('instance.new', `${where}/instance`);
    else if (node.decl.delivery !== 'steer') used.set('delivery.queue', `${where}/delivery`);
    if (node.decl.delivery === 'steer') used.set('delivery.steer', `${where}/delivery`);
    if (graph.edges.some(edge => edge.dst === node.addr && edge.message !== null && typeof edge.message === 'object'
      && has(record(edge.message as ExactValue), 'resources') && Object.keys(record(record(edge.message as ExactValue).resources)).length)) {
      used.set('resources', where);
    }
  }
  return used;
}

/** Freezes one definition against a detached authenticated observation. No launch,
 * discovery, permission computation or authored-to-native attestation occurs here. */
export function captureAgent030(documentJson: ExactJsonText, agentName: string, registry: CapturedRegistry030): FrozenAgentConfiguration030 {
  const captured = captureRegistry030(registry);
  const document = record(decode(json(documentJson, '/document')));
  const modules = new Map(captured.modules.map(module => [module.harness, moduleFromJson(module.moduleJson, '/registry/modules')]));
  const validation = validateExact(document, { modules });
  const error = validation.diagnostics.find(diagnostic => diagnostic.severity === 'error');
  if (error) fail(error.code, error.path, error.message);
  const pointer = at('/agents', metadataIdentity(agentName, '/agentName'));
  const definitions = record(document.agents, '/agents');
  if (!has(definitions, agentName)) fail('CORRELATION', pointer, 'No such agent definition.');
  const agent = record(definitions[agentName], pointer);
  const proof = captured.agents.find(candidate => candidate.agentName === agentName);
  if (!proof || !equal(decode(proof.agentDeclarationJson), agent)) fail('CORRELATION', pointer, 'No native observation matches the complete agent declaration.');
  const harness = text(agent.harness, `${pointer}/harness`);
  const observation = captured.harnesses.find(candidate => candidate.harness === harness);
  if (!observation || observation.installation !== 'available') fail('HARNESS_INSTALLATION', `${pointer}/harness`, 'The requested harness is not observed as installed.');
  if (observation.adapterId === null) fail('HARNESS_ADAPTER', `${pointer}/harness`, 'No native adapter is registered for this harness.');
  if (!observation.qualified) fail('HARNESS_QUALIFICATION', `${pointer}/harness`, 'The installed adapter is not qualified.');
  if (observation.version === null) fail('HARNESS_VERSION_UNVERIFIED', `${pointer}/harness`, 'The installed harness version was not observed.');
  for (const guarantee of HOST_GUARANTEES) requireCapability(observation, guarantee, `${pointer}/harness`);
  if (has(agent, 'completionCheck')) requireCapability(observation, 'completion-check', `${pointer}/completionCheck`);
  if (has(agent, 'answerTimeoutMs')) requireCapability(observation, 'answer-timeout', `${pointer}/answerTimeoutMs`);
  if (has(agent, 'instructions')) requireCapability(observation, 'instructions', `${pointer}/instructions`);
  if (has(agent, 'harnessVersion')) requireRange(observation, text(agent.harnessVersion), `${pointer}/harnessVersion`);
  const module = modules.get(harness);
  for (const [key, where] of usedProperties030(document, agentName, agent, pointer)) {
    requireCapability(observation, key, where, key === 'planFirst.ask' || key === 'delivery.queue');
    const support = module?.properties[key as keyof HarnessModule030['properties']];
    if (support?.versions) requireRange(observation, support.versions, where);
  }
  const authoredSettings = record(agent.harnessSettings ?? {}, `${pointer}/harnessSettings`);
  noCredentials(authoredSettings, `${pointer}/harnessSettings`);
  const effectiveSettings = record(decode(proof.settingsJson));
  if (has(agent, 'harnessSettings') || Object.keys(effectiveSettings).length) {
    requireCapability(observation, 'harness-settings', `${pointer}/harnessSettings`);
    if (module?.settings) {
      const problem = validateValue(effectiveSettings, module.settings, ['agents', agentName, 'harnessSettings'])[0];
      if (problem) fail('HARNESS_SETTINGS', problem[0], problem[1]);
    } else if (module) fail('HARNESS_SETTINGS', `${pointer}/harnessSettings`, 'The module declares no effective settings schema.');
  }
  for (const [key, value] of Object.entries(authoredSettings)) {
    if (!has(effectiveSettings, key) || !equal(effectiveSettings[key], value)) fail('CORRELATION', at(`${pointer}/harnessSettings`, key), 'Effective settings differ from the requested settings.');
  }
  const requestedModel = record(agent.model ?? {}, `${pointer}/model`);
  const modelName = has(requestedModel, 'name') ? text(requestedModel.name) : observation.defaultModel;
  const model = observation.models.find(candidate => candidate.name === modelName);
  if (!model) fail('MODEL_UNAVAILABLE', `${pointer}/model/name`, 'The requested or default model is not observed as available.');
  const modelEffort = has(requestedModel, 'effort') ? text(requestedModel.effort) : model.defaultEffort;
  if (modelEffort !== null && !model.efforts.includes(modelEffort)) fail('MODEL_UNAVAILABLE', `${pointer}/model/effort`, 'The requested or default effort is not advertised by the observed model.');
  return freeze({ ...proof, harness, harnessVersion: observation.version, adapterId: observation.adapterId, modelName: model.name, modelEffort });
}
