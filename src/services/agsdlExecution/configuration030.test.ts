import { expect, test } from 'bun:test';
import type { ExactJsonText } from './contracts';
import type { AgentObservation030, CapturedRegistry030, HarnessObservation030 } from './contracts030';
import { captureAgent030, captureRegistry030 } from './configuration030';
import { ConformanceError, decode, encode, record, type ExactObject } from './exact';

const json = (value: string) => value as ExactJsonText;
const receipt = json('{"receipt":"synthetic-native-receipt"}');
const baseline = ['result-submission', 'continuity', 'permission-enforcement', 'contained-stop', 'response-attribution'];
const properties = ['resources', 'model.name', 'model.effort', 'skills', 'mcpServers', 'plan', 'planFirst.auto', 'planFirst.ask', 'reviewer.person', 'reviewer.model', 'directories', 'instance.new', 'delivery.steer'];
const capabilities = [...baseline, ...properties, 'instructions', 'delivery.queue', 'harness-settings', 'completion-check', 'answer-timeout'];

function fixture(changes: ExactObject = {}) {
  const agent: ExactObject = { harness: 'example', permissions: 'read-only', ...changes };
  const document: ExactObject = { contract: 'agsdl-0.3.0', id: 'configuration-test', agents: { worker: agent } };
  const module: ExactObject = {
    name: 'example', version: '1.0.0', contract: 'agsdl-0.3.0', harnessVersions: '>=1.0.0 <2.0.0',
    properties: Object.fromEntries(properties.map(key => [key, { support: 'native' }])),
    permissions: Object.fromEntries(['read', 'write', 'shell', 'network', 'mcp', 'delegate'].map(key => [key, { allow: 'sandbox', deny: 'sandbox', ask: 'sandbox', ...(key === 'read' ? { outside: 'sandbox' } : {}) }])),
    settings: { type: 'object', properties: { verbosity: { type: 'string' }, budget: { type: 'number' } }, additionalProperties: false },
  };
  const registry: CapturedRegistry030 = {
    format: 'macro-agsdl-registry/030', version: 'synthetic-registry/1',
    modules: [{ harness: 'example', moduleJson: encode(module) }],
    harnesses: [{ harness: 'example', version: '1.5.0', installation: 'available', adapterId: 'synthetic-adapter', qualified: true,
      capabilities: capabilities.map(name => ({ name, support: 'native', evidenceJson: receipt })),
      models: [{ name: 'future-private-model', efforts: ['minimal', 'future-effort'], defaultEffort: 'future-effort' }], defaultModel: 'future-private-model' }],
    agents: [{ agentName: 'worker', agentDeclarationJson: encode(agent), settingsJson: encode(agent.harnessSettings ?? {}),
      permissionsJson: json('{"nativeCeiling":"read-only"}'), scopeJson: json('{"workspace":"synthetic-workspace"}'),
      evidenceJson: receipt, provenanceJson: json('{"authority":"synthetic-content-capture"}') }],
  };
  return { document, module, registry };
}

function harness(registry: CapturedRegistry030, patch: Partial<HarnessObservation030>): CapturedRegistry030 {
  return { ...registry, harnesses: [{ ...registry.harnesses[0], ...patch }] };
}

function agent(registry: CapturedRegistry030, patch: Partial<AgentObservation030>): CapturedRegistry030 {
  return { ...registry, agents: [{ ...registry.agents[0], ...patch }] };
}

function without(registry: CapturedRegistry030, name: string): CapturedRegistry030 {
  return harness(registry, { capabilities: registry.harnesses[0].capabilities.filter(capability => capability.name !== name) });
}

function fails(action: () => unknown, code: string, pointer?: string) {
  let caught: unknown;
  try { action(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(ConformanceError);
  expect((caught as ConformanceError).code).toBe(code);
  if (pointer !== undefined) expect((caught as ConformanceError).pointer).toBe(pointer);
}

test('capture keeps empty catalogues empty and detaches and freezes all observations', () => {
  expect(captureRegistry030({ format: 'macro-agsdl-registry/030', version: 'empty', modules: [], harnesses: [], agents: [] })).toEqual({
    format: 'macro-agsdl-registry/030', version: 'empty', modules: [], harnesses: [], agents: [],
  });
  const { registry } = fixture();
  const captured = captureRegistry030(registry);
  expect(captured).toEqual(registry);
  expect(captured.harnesses).not.toBe(registry.harnesses);
  expect(captured.harnesses[0].models[0].efforts).not.toBe(registry.harnesses[0].models[0].efforts);
  expect(Object.isFrozen(captured.agents[0])).toBe(true);
  expect(Object.isFrozen(captured.harnesses[0].models[0].efforts)).toBe(true);
});

test('registry rejects ambiguous identities, invalid native metadata and empty positive receipts', () => {
  const { registry } = fixture();
  for (const field of ['modules', 'harnesses', 'agents'] as const) {
    fails(() => captureRegistry030({ ...registry, [field]: [...registry[field], registry[field][0]] }), 'CORRELATION');
  }
  fails(() => captureRegistry030({ ...registry, version: '' }), 'UNSUPPORTED', '/registry/version');
  fails(() => captureRegistry030({ ...registry, harnesses: Array(1) }), 'UNSUPPORTED', '/registry/harnesses/0');
  fails(() => captureRegistry030({ ...registry, harnesses: [{ ...registry.harnesses[0], qualified: 'yes' }] }), 'UNSUPPORTED');
  for (const field of ['evidenceJson', 'permissionsJson', 'scopeJson', 'provenanceJson'] as const) {
    for (const empty of ['null', '{}', '[]', '" "', 'false', '1']) fails(() => captureRegistry030(agent(registry, { [field]: json(empty) })), 'CORRELATION');
  }
  fails(() => captureRegistry030(harness(registry, { capabilities: [{ name: 'continuity', support: 'native', evidenceJson: json('{}') }] })), 'CORRELATION');
  fails(() => captureRegistry030(harness(registry, { capabilities: [registry.harnesses[0].capabilities[0], registry.harnesses[0].capabilities[0]] })), 'CORRELATION');
  fails(() => captureRegistry030({ ...registry, hostCapabilities: [{ name: 'approval', support: 'native', evidenceJson: json('{}') }] }), 'CORRELATION');
  fails(() => captureRegistry030({ ...registry, hostCapabilities: [registry.harnesses[0].capabilities[0], registry.harnesses[0].capabilities[0]] }), 'CORRELATION');
});

test('module capture uses vendor validation and never qualifies an installed adapter', () => {
  const { registry, document } = fixture();
  fails(() => captureRegistry030({ ...registry, modules: [{ harness: 'other', moduleJson: registry.modules[0].moduleJson }] }), 'CORRELATION');
  fails(() => captureRegistry030({ ...registry, modules: [{ harness: 'example', moduleJson: json('{}') }] }), 'HARNESS_MODULE');
  for (const [patch, code] of [
    [{ installation: 'missing' }, 'HARNESS_INSTALLATION'], [{ adapterId: null }, 'HARNESS_ADAPTER'],
    [{ qualified: false }, 'HARNESS_QUALIFICATION'], [{ version: null }, 'HARNESS_VERSION_UNVERIFIED'],
  ] as const) fails(() => captureAgent030(encode(document), 'worker', harness(registry, patch)), code);
  fails(() => captureAgent030(encode(document), 'worker', { ...registry, harnesses: [] }), 'HARNESS_INSTALLATION');
});

test('complete declarations must match native observations without numeric rounding', () => {
  const { registry, document } = fixture({ maxCorrections: decode('9007199254740993') });
  expect(captureAgent030(encode(document), 'worker', registry).agentDeclarationJson).toContain('9007199254740993');
  fails(() => captureAgent030(encode(document), 'worker', agent(registry, {
    agentDeclarationJson: encode({ ...record(record(document.agents).worker), maxCorrections: decode('9007199254740992') }),
  })), 'CORRELATION', '/agents/worker');
  fails(() => captureAgent030(encode(document), 'worker', { ...registry, agents: [] }), 'CORRELATION');
  fails(() => captureAgent030(encode(document), 'missing', registry), 'CORRELATION');
  fails(() => captureRegistry030(agent(registry, { agentDeclarationJson: json('{"harness":"example","harness":"example"}') })), 'UNSUPPORTED');
  fails(() => captureRegistry030(agent(registry, { settingsJson: json('{"verbosity":"\ud800"}') })), 'PARSE');
});

test('native catalogue resolves open model and effort names and actual harness defaults', () => {
  const { registry, document } = fixture();
  const frozen = captureAgent030(encode(document), 'worker', registry);
  expect(frozen.modelName).toBe('future-private-model');
  expect(frozen.modelEffort).toBe('future-effort');
  expect(frozen.agentDeclarationJson).toBe(registry.agents[0].agentDeclarationJson);
  expect(Object.isFrozen(frozen)).toBe(true);
  for (const model of [{ name: 'future-private-model' }, { effort: 'future-effort' }, { name: 'future-private-model', effort: 'minimal' }] as ExactObject[]) {
    const input = fixture({ model });
    expect(captureAgent030(encode(input.document), 'worker', input.registry).modelName).toBe('future-private-model');
  }
  const nullEffort = harness(registry, { models: [{ name: 'future-private-model', efforts: [], defaultEffort: null }] });
  expect(captureAgent030(encode(document), 'worker', nullEffort).modelEffort).toBeNull();
  fails(() => captureAgent030(encode(document), 'worker', harness(registry, { defaultModel: null })), 'MODEL_UNAVAILABLE');
  for (const model of [{ name: 'unknown' }, { effort: 'unknown' }] as ExactObject[]) {
    const input = fixture({ model });
    fails(() => captureAgent030(encode(input.document), 'worker', input.registry), 'MODEL_UNAVAILABLE');
  }
  fails(() => captureRegistry030(harness(registry, { defaultModel: 'unknown' })), 'MODEL_UNAVAILABLE');
  fails(() => captureRegistry030(harness(registry, { models: [{ name: 'future-private-model', efforts: ['minimal'], defaultEffort: 'unknown' }] })), 'MODEL_UNAVAILABLE');
  fails(() => captureRegistry030(harness(registry, { models: [{ name: 'future-private-model', efforts: ['minimal', 'minimal'], defaultEffort: null }] })), 'CORRELATION');
});

test('module suggestions are open but closed effort values remain authoritative', () => {
  const input = fixture({ model: { name: 'future-private-model', effort: 'future-effort' } });
  const module = { ...input.module, properties: { ...record(input.module.properties), 'model.effort': { support: 'native', suggestions: ['old-effort'] } } };
  const registry = { ...input.registry, modules: [{ harness: 'example', moduleJson: encode(module) }] };
  expect(captureAgent030(encode(input.document), 'worker', registry).modelEffort).toBe('future-effort');
  record(module.properties)['model.effort'] = { support: 'native', values: ['minimal'] };
  fails(() => captureAgent030(encode(input.document), 'worker', { ...registry, modules: [{ harness: 'example', moduleJson: encode(module) }] }), 'HARNESS_VALUE');
});

test('host guarantees require actual native capability receipts', () => {
  const { registry, document } = fixture();
  for (const name of baseline) {
    fails(() => captureAgent030(encode(document), 'worker', without(registry, name)), 'HARNESS_CAPABILITY');
    fails(() => captureAgent030(encode(document), 'worker', harness(registry, {
      capabilities: registry.harnesses[0].capabilities.map(capability => capability.name === name ? { ...capability, support: 'approximate' } : capability),
    })), 'HARNESS_CAPABILITY');
  }
  const input = fixture({ permissions: 'workspace', completionCheck: { command: 'test-command' } });
  fails(() => captureAgent030(encode(input.document), 'worker', without(input.registry, 'completion-check')), 'HARNESS_CAPABILITY', '/agents/worker/completionCheck');
  expect(captureAgent030(encode(document), 'worker', without(registry, 'completion-check')).agentName).toBe('worker');
});

test('only used properties need observations and allowed approximation stays executable', () => {
  const input = fixture({ plan: true, instructions: 'Standing instructions.', answerTimeoutMs: decode('1000') });
  for (const name of ['plan', 'instructions', 'answer-timeout']) fails(() => captureAgent030(encode(input.document), 'worker', without(input.registry, name)), 'HARNESS_CAPABILITY');
  const simple = fixture();
  expect(captureAgent030(encode(simple.document), 'worker', without(simple.registry, 'plan')).agentName).toBe('worker');
  const automatic = fixture({ planFirst: 'auto' });
  const approximate = harness(automatic.registry, { capabilities: automatic.registry.harnesses[0].capabilities.map(capability => capability.name === 'planFirst.auto' ? { ...capability, support: 'approximate' } : capability) });
  expect(captureAgent030(encode(automatic.document), 'worker', approximate).agentName).toBe('worker');
  const approval = fixture({ planFirst: 'ask' });
  fails(() => captureAgent030(encode(approval.document), 'worker', harness(approval.registry, {
    capabilities: approval.registry.harnesses[0].capabilities.map(capability => capability.name === 'planFirst.ask' ? { ...capability, support: 'approximate' } : capability),
  })), 'HARNESS_CAPABILITY');
});

test('effective settings retain exact numbers, match authored settings and follow the module schema', () => {
  const input = fixture({ harnessSettings: { budget: decode('1e999999'), verbosity: 'brief' } });
  expect(captureAgent030(encode(input.document), 'worker', input.registry).settingsJson).toContain('1e999999');
  fails(() => captureAgent030(encode(input.document), 'worker', agent(input.registry, { settingsJson: json('{"budget":1e999998,"verbosity":"brief"}') })), 'CORRELATION');
  fails(() => captureAgent030(encode(input.document), 'worker', agent(input.registry, { settingsJson: json('{"budget":1e999999}') })), 'CORRELATION');
  fails(() => captureAgent030(encode(input.document), 'worker', agent(input.registry, { settingsJson: json('{"verbosity":"brief","budget":1e999999,"unknown":true}') })), 'HARNESS_SETTINGS');
  fails(() => captureAgent030(encode(input.document), 'worker', without(input.registry, 'harness-settings')), 'HARNESS_CAPABILITY');
  const simple = fixture();
  expect(captureAgent030(encode(simple.document), 'worker', agent(simple.registry, { settingsJson: json('{"verbosity":"native-default"}') })).settingsJson).toContain('native-default');
});

test('credentials in settings are rejected without copying their values into diagnostics', () => {
  const { registry } = fixture();
  for (const raw of ['{"apiKey":"synthetic-secret"}', '{"nested":[{"access_token":"synthetic-secret"}]}', '{"verbosity":"Bearer synthetic-secret"}', '{"verbosity":"-----BEGIN PRIVATE KEY-----"}']) {
    fails(() => captureRegistry030(agent(registry, { settingsJson: json(raw) })), 'SECRET_SETTINGS');
    try { captureRegistry030(agent(registry, { settingsJson: json(raw) })); } catch (error) { expect(String(error)).not.toContain('synthetic-secret'); }
  }
});

test('version restrictions require a native receipt tied to the entire range and observed version', () => {
  const input = fixture({ harnessVersion: '^1.5.0 || >=3.0.0-beta.2' });
  fails(() => captureAgent030(encode(input.document), 'worker', input.registry), 'HARNESS_VERSION_UNVERIFIED', '/agents/worker/harnessVersion');
  const evidence: ExactObject = { kind: 'harness-version-range', harness: 'example', version: '1.5.0', range: '^1.5.0 || >=3.0.0-beta.2', satisfied: true, receipt: 'synthetic-range-evaluator' };
  const qualified = (value: ExactObject) => harness(input.registry, { capabilities: [...input.registry.harnesses[0].capabilities, { name: 'native-range-receipt', support: 'native', evidenceJson: encode(value) }] });
  expect(captureAgent030(encode(input.document), 'worker', qualified(evidence)).harnessVersion).toBe('1.5.0');
  for (const patch of [{ harness: 'other' }, { version: '1.6.0' }, { range: '>=1.0.0' }, { satisfied: false }, { receipt: '' }] as ExactObject[]) {
    fails(() => captureAgent030(encode(input.document), 'worker', qualified({ ...evidence, ...patch })), 'HARNESS_VERSION_UNVERIFIED');
  }
  const plan = fixture({ plan: true });
  const module = { ...plan.module, properties: { ...record(plan.module.properties), plan: { support: 'native', versions: '>=1.2.0' } } };
  fails(() => captureAgent030(encode(plan.document), 'worker', { ...plan.registry, modules: [{ harness: 'example', moduleJson: encode(module) }] }), 'HARNESS_VERSION_UNVERIFIED', '/agents/worker/plan');
});

test('missing static modules do not fabricate defaults or substitute for runtime observations', () => {
  const { registry, document } = fixture();
  expect(captureAgent030(encode(document), 'worker', { ...registry, modules: [] }).modelName).toBe('future-private-model');
  fails(() => captureAgent030(encode(document), 'worker', { ...without(registry, 'continuity'), modules: [] }), 'HARNESS_CAPABILITY');
});

test('composition parameter bindings qualify only the actual receiving definitions', () => {
  const input = fixture();
  input.document.compositions = {
    inner: { parameters: ['member'], outputs: ['done'], entry: 'work', steps: { work: { type: 'agent', agent: { parameter: 'member' }, instance: 'new', prompt: 'Work.', next: { output: 'done' } } } },
    outer: { parameters: ['member'], outputs: ['done'], entry: 'nested', steps: { nested: { type: 'compose', composition: 'inner', agents: { member: { parameter: 'member' } }, next: { done: { output: 'done' } } } } },
  };
  input.document.flow = { entry: 'nested', steps: { nested: { type: 'compose', composition: 'outer', agents: { member: 'worker' }, next: { done: [] } } } };
  fails(() => captureAgent030(encode(input.document), 'worker', without(input.registry, 'instance.new')), 'HARNESS_CAPABILITY');
  expect(captureAgent030(encode(input.document), 'worker', input.registry).agentName).toBe('worker');
  // An unrelated graphless definition does not inherit the worker's instance needs.
  record(input.document.agents).idle = { harness: 'example', permissions: 'read-only' };
  const idle: AgentObservation030 = { ...input.registry.agents[0], agentName: 'idle', agentDeclarationJson: encode(record(input.document.agents).idle) };
  expect(captureAgent030(encode(input.document), 'idle', { ...without(input.registry, 'instance.new'), agents: [...input.registry.agents, idle] }).agentName).toBe('idle');
});

test('message resources and queue delivery require observed capabilities at their receiving agent', () => {
  const input = fixture();
  input.document.flow = { entry: 'start', steps: {
    start: { type: 'agent', agent: 'worker', prompt: 'Start.', next: { step: 'finish', message: { prompt: 'Finish.', resources: { note: { value: 'Information.' } } } } },
    finish: { type: 'agent', agent: 'worker' },
  } };
  fails(() => captureAgent030(encode(input.document), 'worker', without(input.registry, 'resources')), 'HARNESS_CAPABILITY');
  fails(() => captureAgent030(encode(input.document), 'worker', without(input.registry, 'delivery.queue')), 'HARNESS_CAPABILITY');
  expect(captureAgent030(encode(input.document), 'worker', input.registry).agentName).toBe('worker');
});

test('default, error, approval and composition messages qualify resources at the receiving definition', () => {
  const flows: ExactObject[] = [
    { entry: 'work', steps: { work: { type: 'agent', agent: 'worker' } } },
    { entry: 'start', steps: { start: { type: 'call', command: 'true', next: 'work' }, work: { type: 'agent', agent: 'worker' } } },
    { entry: 'start', steps: { start: { type: 'call', command: 'true', onError: 'work' }, work: { type: 'agent', agent: 'worker' } } },
    { entry: 'start', steps: { start: { type: 'call', command: 'true', next: 'approval' }, approval: { type: 'approval', next: { yes: 'work' } }, work: { type: 'agent', agent: 'worker' } } },
    { entry: 'start', steps: { start: { type: 'call', command: 'true', next: 'nested' }, nested: { type: 'compose', composition: 'fragment', next: { done: [] } } } },
  ];
  for (const flow of flows) {
    const input = fixture();
    input.document.flow = flow;
    if (Object.hasOwn(record(flow.steps), 'nested')) input.document.compositions = {
      fragment: { entry: 'work', outputs: ['done'], steps: { work: { type: 'agent', agent: 'worker', next: { output: 'done' } } } },
    };
    fails(() => captureAgent030(encode(input.document), 'worker', without(input.registry, 'resources')), 'HARNESS_CAPABILITY');
    expect(captureAgent030(encode(input.document), 'worker', input.registry).agentName).toBe('worker');
  }
  for (const failure of [false, true]) {
    const input = fixture();
    input.document.compositions = { fragment: { entry: 'call', outputs: ['done'], steps: {
      call: { type: 'call', command: 'true', next: { output: 'done' } },
    } } };
    input.document.flow = { entry: 'nested', steps: {
      nested: { type: 'compose', composition: 'fragment', next: { done: failure ? [] : 'work' }, ...(failure ? { onError: 'work' } : {}) },
      work: { type: 'agent', agent: 'worker' },
    } };
    fails(() => captureAgent030(encode(input.document), 'worker', without(input.registry, 'resources')), 'HARNESS_CAPABILITY');
    expect(captureAgent030(encode(input.document), 'worker', input.registry).agentName).toBe('worker');
  }
});

test('an explicit message without resources replaces a default containing resources', () => {
  const input = fixture();
  input.document.flow = { entry: 'start', steps: {
    start: { type: 'call', command: 'true', next: { step: 'work', message: { prompt: 'Continue.' } } },
    work: { type: 'agent', agent: 'worker' },
  } };
  expect(captureAgent030(encode(input.document), 'worker', without(input.registry, 'resources')).agentName).toBe('worker');
  input.document.flow = { entry: 'start', steps: {
    start: { type: 'call', command: 'true', next: { step: 'approval', message: { prompt: 'Continue.' } } },
    approval: { type: 'approval', next: { yes: 'work' } },
    work: { type: 'agent', agent: 'worker' },
  } };
  expect(captureAgent030(encode(input.document), 'worker', without(input.registry, 'resources')).agentName).toBe('worker');
});
