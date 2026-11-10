import { describe, expect, it } from 'bun:test';
import { compilePlan, compileVersionedPlan, sourceDigest } from './compiler';
import { compilePlan030 } from './compiler030';
import type { CapturedRegistry030 } from './contracts030';
import { clone, decode, encode, record, type ExactObject } from './exact';
import type { SourceRevision } from './contracts';

const evidence = encode({ receipt: 'synthetic-native-qualification' });
function document030(): ExactObject {
  return decode('{"contract":"agsdl-0.3.0","id":"compiler-test","agents":{"worker":{"harness":"synthetic","permissions":"read-only"}}}') as ExactObject;
}
function registry030(document: ExactObject): CapturedRegistry030 {
  return { format: 'macro-agsdl-registry/030', version: 'synthetic-capture', modules: [],
    hostCapabilities: ['call.command', 'call.mcp', 'approval'].map(name => ({ name, support: 'native', evidenceJson: evidence })), harnesses: [{
    harness: 'synthetic', version: '1.0.0', installation: 'available', adapterId: 'synthetic-adapter', qualified: true,
    defaultModel: 'private/model', models: [{ name: 'private/model', efforts: ['custom-effort'], defaultEffort: 'custom-effort' }],
    capabilities: ['result-submission', 'agent-continuity', 'continuity', 'permission-enforcement', 'contained-stop', 'response-attribution',
      'completion-check', 'resources', 'model.name', 'model.effort', 'skills', 'mcpServers', 'plan', 'planFirst.auto',
      'planFirst.ask', 'reviewer.person', 'reviewer.model', 'directories', 'instance.new', 'delivery.steer',
      'delivery.queue', 'instructions', 'answer-timeout', 'harness-settings']
      .map(name => ({ name, support: 'native', evidenceJson: evidence })),
  }], agents: Object.entries(record(document.agents)).map(([agentName, agent]) => ({ agentName,
    agentDeclarationJson: encode(agent), settingsJson: encode({}), permissionsJson: encode({ preset: 'read-only' }),
    scopeJson: encode({ workspace: '/synthetic/workspace' }), evidenceJson: evidence,
    provenanceJson: encode({ documentBase: 'file:///synthetic/workspace/flow.json', entries: [] }) })) };
}
async function sourceFor(source: string): Promise<SourceRevision> {
  return { owner: { projectId: 'test-project', planId: 'test-plan', branch: 'feature/test' }, revision: '1',
    sourceSha256: await sourceDigest(source) as SourceRevision['sourceSha256'] };
}
async function compile(document: ExactObject, registry = registry030(document)) {
  const source = encode(document);
  return compilePlan030(source, await sourceFor(source), registry);
}
function requirePlan(result: Awaited<ReturnType<typeof compile>>) {
  expect({ static: result.static.diagnostics.filter(d => d.severity === 'error'), runtime: result.runtime.diagnostics }).toEqual({ static: [], runtime: [] });
  expect(result.static.valid).toBe(true);
  expect(result.runtime.supported).toBe(true);
  expect(result.plan).not.toBeNull();
  return result.plan!;
}

describe('0.3 compiler wire plan', () => {
  it('compiles graphless direct definitions, open defaults and exact content without effects', async () => {
    const doc = document030();
    doc.content = { large: { value: decode('9007199254740993') }, reference: { uri: 'file:///synthetic/unread.json' } };
    const result = await compile(doc), plan = requirePlan(result);
    expect(plan.format).toBe('macro-agsdl-compiled-plan/2');
    expect(plan.versions.profile).toBe('macro-agsdl-030-v1');
    expect(plan.entry).toBeNull();
    expect(plan.steps).toEqual([]);
    expect(plan.documentJson).toContain('9007199254740993');
    expect(plan.agents[0].modelName).toBe('private/model');
    expect(plan.agents[0].modelEffort).toBe('custom-effort');
    expect(plan.graphlessSubmissionContracts.worker).toContain('macro-agsdl-agent-work/030');
    expect(plan.agents[0].provenanceJson).toContain('file:///synthetic/workspace/flow.json');
    expect(result.productRuntimeAvailable).toBe(false);
  });
  it('reports product availability from the captured Codex adapter', async () => {
    const doc = document030();
    record(record(doc.agents).worker).harness = 'codex';
    const base = registry030(doc);
    const registry: CapturedRegistry030 = { ...base, harnesses: base.harnesses.map(item => ({ ...item, harness: 'codex', adapterId: 'codex-app-server-v1' })) };
    expect((await compile(doc, registry)).productRuntimeAvailable).toBe(true);
    expect((await compile(doc, { ...registry, harnesses: registry.harnesses.map(item => ({ ...item, adapterId: 'other' })) })).productRuntimeAvailable).toBe(false);
  });
  it('keeps compose scopes, parameter bindings and joins instead of flattening work occurrences', async () => {
    const doc = document030();
    doc.compositions = { inner: { parameters: ['who'], entry: 'work', outputs: ['done'], steps: {
      work: { type: 'agent', agent: { parameter: 'who' }, instance: 'new', next: { output: 'done' } },
    } }, outer: { parameters: ['who'], entry: 'inside', outputs: ['done'], steps: {
      inside: { type: 'compose', composition: 'inner', agents: { who: { parameter: 'who' } }, next: { done: { output: 'done' } } },
    } } };
    doc.flow = { entry: 'fork', steps: {
      fork: { type: 'call', command: 'true', next: ['left', 'right'] },
      left: { type: 'agent', agent: 'worker', instance: 'new', next: 'join' },
      right: { type: 'compose', composition: 'outer', agents: { who: 'worker' }, next: { done: 'join' } },
      join: { type: 'join', remaining: 'wait' },
    } };
    const plan = requirePlan(await compile(doc));
    expect(plan.scopes.map(scope => scope.address)).toEqual([[], ['right'], ['right', 'inside']]);
    expect(plan.scopes[1].entry).toEqual(['right', 'inside']);
    expect(plan.scopes[2].parent).toEqual(['right']);
    expect(plan.steps.find(step => step.address.join('/') === 'right/inside/work')?.agent).toBe('worker');
    expect(plan.steps.filter(step => step.type === 'compose')).toHaveLength(2);
    expect(plan.joins[0].origin).toEqual(['fork']);
    expect(plan.joins[0].branches.map(branch => branch.name)).toEqual(['left', 'right']);
    expect(plan.joins[0].branches[1].members).toEqual([['right']]);
    expect(plan.handlers.find(handler => handler.address.join('/') === 'right')?.joins).toEqual([{ join: ['join'], branch: 'right' }]);
    expect(plan.routes.find(route => route.source.join('/') === 'right/inside/work')?.targets).toEqual([{ kind: 'output', scope: ['right', 'inside'], name: 'done' }]);
  });
  it('retains each batches, exact limits and per-choice instruction contracts', async () => {
    const doc = document030();
    record(doc.agents).lead = { harness: 'synthetic', permissions: 'read-only', instructs: true };
    doc.flow = { entry: 'split', steps: {
      split: { type: 'agent', agent: 'lead', next: { send: { step: 'work', each: ['instructions'],
        max: decode('9007199254740993'), concurrency: decode('1e1000000000') }, done: [] } },
      work: { type: 'agent', agent: 'worker', instance: 'new', maxVisits: decode('9007199254740995'), timeoutMs: decode('1e1000000000'), next: 'join' },
      join: { type: 'join', maxVisits: decode('1.0'), failures: 'keep', maxFailures: decode('2e0'), next: { done: [], incomplete: [] } },
    } };
    const plan = requirePlan(await compile(doc));
    const batch = plan.routes.find(route => route.key === 'send')!.targets[0];
    expect(batch).toMatchObject({ kind: 'step', eachPathJson: '["instructions"]', maxJson: '9007199254740993', concurrencyJson: '1e1000000000' });
    expect(plan.steps.find(step => step.address[0] === 'work')).toMatchObject({ maxVisitsJson: '9007199254740995', timeoutMsJson: '1e1000000000' });
    expect(plan.joins[0]).toMatchObject({ maxFailuresJson: '2e0', mode: 'all' });
    expect(plan.joins[0].branches[0].fanout).toBe(true);
    const contract = record(decode(plan.steps[0].submissionContractJson!));
    expect(contract.instructionsByChoice).toEqual({ send: 'list', done: 'none' });
  });
  it('derives submission requirements through nested composition exits', async () => {
    const doc = document030();
    record(record(doc.agents).worker).instructs = true;
    doc.compositions = { fragment: { entry: 'produce', outputs: ['done'], steps: {
      produce: { type: 'agent', agent: 'worker', next: { output: 'done' } },
    } } };
    doc.flow = { entry: 'compose', steps: {
      compose: { type: 'compose', composition: 'fragment', next: { done: { step: 'consume', each: ['instructions'] } } },
      consume: { type: 'agent', agent: 'worker', instance: 'new' },
    } };
    const plan = requirePlan(await compile(doc));
    const producing = plan.steps.find(step => step.address.join('/') === 'compose/produce')!;
    expect(record(decode(producing.submissionContractJson!)).defaultInstructions).toBe('list');
  });
  it('applies flow error shorthand only to covered steps, with local handlers preserved', async () => {
    const doc = document030();
    doc.flow = { entry: 'start', onError: 'error', steps: {
      start: { type: 'call', command: 'true', next: ['left', 'right'] },
      left: { type: 'call', command: 'true', next: 'join' },
      right: { type: 'call', command: 'true', next: 'join' },
      join: { type: 'join', next: 'done' },
      done: { type: 'call', command: 'true', onError: 'local' },
      local: { type: 'call', command: 'true' }, error: { type: 'call', command: 'true' },
    } };
    const plan = requirePlan(await compile(doc));
    expect(plan.handlers.find(h => h.address[0] === 'left')).toMatchObject({ local: false, flow: false });
    expect(plan.handlers.find(h => h.address[0] === 'done')).toMatchObject({ local: true, flow: false });
    expect(plan.handlers.find(h => h.address[0] === 'error')).toMatchObject({ local: false, flow: false });
    expect(plan.routes.find(route => route.source[0] === 'start' && route.kind === 'error')).toMatchObject({ inherited: true });
  });
  it('captures all caller input before SHA awaits and refuses stale source digests', async () => {
    const doc = document030(), authored = encode(doc), source = await sourceFor(authored), registry = registry030(doc);
    const before = clone(registry);
    const pending = compilePlan030(authored, source, registry);
    Object.assign(source.owner, { projectId: 'mutated' });
    Object.assign(registry.agents[0], { settingsJson: encode({ changed: true }) });
    const plan = requirePlan(await pending);
    expect(plan.source.owner.projectId).toBe('test-project');
    expect(plan.agents[0].settingsJson).toBe(before.agents[0].settingsJson);
    const stale = await compilePlan030(authored, { ...await sourceFor(authored), sourceSha256: 'f'.repeat(64) as SourceRevision['sourceSha256'] }, before);
    expect(stale.runtime.diagnostics[0].code).toBe('CORRELATION');
    expect(stale.plan).toBeNull();
  });
  it('rejects invalid JSON, duplicate keys, lone surrogates and cycles statically', async () => {
    const valid = document030();
    for (const source of ['{"contract":"agsdl-0.3.0","id":1,"id":2}', '\ufeff{}', '{"x":"\ud800"}']) {
      const result = await compilePlan030(source, await sourceFor(source), registry030(valid));
      expect(result.static.valid).toBe(false);
      expect(result.plan).toBeNull();
    }
    valid.compositions = { cycle: { entry: 'again', outputs: ['done'], steps: {
      again: { type: 'compose', composition: 'cycle', next: { done: { output: 'done' } } },
    } } };
    expect((await compile(valid)).static.valid).toBe(false);
  });
  it('keeps 0.2 strict and dispatches an explicit 0.3 document without migration', async () => {
    const doc = document030(), authored = encode(doc), source = await sourceFor(authored), registry = registry030(doc);
    const historical = await compilePlan(authored, source, registry as never);
    expect(historical.static.valid).toBe(false);
    expect(historical.plan).toBeNull();
    const versioned = await compileVersionedPlan(authored, source, registry);
    expect(versioned.plan?.format).toBe('macro-agsdl-compiled-plan/2');
  });
  it('retains module warnings and reports that its version coverage was not evaluated', async () => {
    const doc = document030();
    record(record(doc.agents).worker).planFirst = 'auto';
    const base = registry030(doc);
    const module = { name: 'synthetic', version: '1.0.0', contract: 'agsdl-0.3.0', harnessVersions: '>=1.0.0',
      properties: { 'planFirst.auto': { support: 'approximate', note: 'Synthetic test approximation.' } },
      permissions: { read: { deny: 'sandbox', outside: 'sandbox' }, write: { deny: 'sandbox' },
        shell: { deny: 'sandbox' }, network: { deny: 'sandbox' }, mcp: { deny: 'sandbox' }, delegate: { deny: 'sandbox' } } };
    const observed = { ...base, modules: [{ harness: 'synthetic', moduleJson: encode(module) }],
      harnesses: base.harnesses.map(harness => ({ ...harness, capabilities: harness.capabilities.map(capability =>
        capability.name === 'planFirst.auto' ? { ...capability, support: 'approximate' as const } : capability) })) };
    const result = await compile(doc, observed);
    expect(result.static.valid).toBe(true);
    expect(result.static.diagnostics).toContainEqual(expect.objectContaining({ code: 'HARNESS_APPROXIMATE', severity: 'warning' }));
    expect(result.runtime.supported).toBe(true);
    expect(result.runtime.unassessed).toContain('Harness synthetic version 1.0.0 against module range >=1.0.0');
    const nativeModule = { ...module, properties: { 'planFirst.auto': { support: 'native' } } };
    const runtimeApproximation = await compile(doc, { ...observed, modules: [{ harness: 'synthetic', moduleJson: encode(nativeModule) }] });
    expect(runtimeApproximation.static.diagnostics.some(diagnostic => diagnostic.code === 'HARNESS_APPROXIMATE')).toBe(false);
    expect(runtimeApproximation.runtime.diagnostics).toContainEqual(expect.objectContaining({ code: 'HARNESS_APPROXIMATE', severity: 'warning', pointer: '/agents/worker/planFirst' }));
  });
  it('requires a native host observation for every kind of non-agent work', async () => {
    const doc = document030();
    doc.flow = { entry: 'call', steps: { call: { type: 'call', command: 'true', next: 'approval' }, approval: { type: 'approval', next: { yes: [] } } } };
    const base = registry030(doc);
    for (const missing of ['call.command', 'approval']) {
      const registry = { ...base, hostCapabilities: base.hostCapabilities!.filter(capability => capability.name !== missing) };
      const result = await compile(doc, registry);
      expect(result.static.valid).toBe(true);
      expect(result.runtime.diagnostics).toContainEqual(expect.objectContaining({ code: 'HOST_CAPABILITY', message: expect.stringContaining(missing) }));
      expect(result.plan).toBeNull();
    }
    expect((await compile(doc, base)).runtime.supported).toBe(true);
    doc.mcpServers = { server: { command: ['synthetic-server'] } };
    doc.flow = { entry: 'call', steps: { call: { type: 'call', mcp: { server: 'server', tool: 'tool' } } } };
    const mcp = registry030(doc);
    const result = await compile(doc, { ...mcp, hostCapabilities: mcp.hostCapabilities!.filter(capability => capability.name !== 'call.mcp') });
    expect(result.static.valid).toBe(true);
    expect(result.runtime.diagnostics).toContainEqual(expect.objectContaining({ code: 'HOST_CAPABILITY', message: expect.stringContaining('call.mcp') }));
    expect((await compile(doc, mcp)).runtime.supported).toBe(true);
  });
  it('reports an approximate resource path for a default call message', async () => {
    const doc = document030();
    doc.flow = { entry: 'call', steps: { call: { type: 'call', command: 'true', next: 'work' }, work: { type: 'agent', agent: 'worker' } } };
    const base = registry030(doc);
    const withoutResources = { ...base, harnesses: base.harnesses.map(harness => ({ ...harness,
      capabilities: harness.capabilities.filter(capability => capability.name !== 'resources') })) };
    expect((await compile(doc, withoutResources)).runtime.diagnostics).toContainEqual(expect.objectContaining({ code: 'HARNESS_CAPABILITY' }));
    const approximate = { ...base, harnesses: base.harnesses.map(harness => ({ ...harness,
      capabilities: harness.capabilities.map(capability => capability.name === 'resources' ? { ...capability, support: 'approximate' as const } : capability) })) };
    const result = await compile(doc, approximate);
    expect(result.runtime.supported).toBe(true);
    expect(result.runtime.diagnostics).toContainEqual(expect.objectContaining({ code: 'HARNESS_APPROXIMATE', severity: 'warning' }));
    expect(result.runtime.unassessed).toContain('Native admission of resources in later graphless messages');
    const module = { name: 'synthetic', version: '1.0.0', contract: 'agsdl-0.3.0', harnessVersions: '>=1.0.0',
      properties: { resources: { support: 'approximate', note: 'Synthetic resource approximation.' } },
      permissions: { read: { deny: 'sandbox', outside: 'sandbox' }, write: { deny: 'sandbox' }, shell: { deny: 'sandbox' },
        network: { deny: 'sandbox' }, mcp: { deny: 'sandbox' }, delegate: { deny: 'sandbox' } } };
    const declaredApproximate = await compile(doc, { ...approximate, modules: [{ harness: 'synthetic', moduleJson: encode(module) }] });
    expect(declaredApproximate.static.valid).toBe(true);
    expect(declaredApproximate.static.diagnostics.some(diagnostic => diagnostic.code === 'HARNESS_APPROXIMATE')).toBe(false);
    expect(declaredApproximate.runtime.diagnostics).toContainEqual(expect.objectContaining({ code: 'HARNESS_APPROXIMATE', severity: 'warning', pointer: '/flow/steps/work' }));
    const shared = clone(doc);
    const steps = record(record(shared.flow).steps);
    record(steps.work).next = 'more';
    steps.more = { type: 'agent', agent: 'worker' };
    const sharedResult = await compile(shared, { ...registry030(shared), modules: [{ harness: 'synthetic', moduleJson: encode(module) }],
      harnesses: approximate.harnesses });
    expect(sharedResult.runtime.diagnostics).toContainEqual(expect.objectContaining({ code: 'HARNESS_APPROXIMATE', pointer: '/flow/steps/work' }));
    expect(sharedResult.runtime.diagnostics).toContainEqual(expect.objectContaining({ code: 'HARNESS_APPROXIMATE', pointer: '/flow/steps/more' }));
    const reused = document030();
    reused.compositions = { fragment: { entry: 'worker', outputs: ['done'], steps: {
      worker: { type: 'agent', agent: 'worker', next: { output: 'done' } },
    } } };
    reused.flow = { entry: 'start', steps: {
      start: { type: 'call', command: 'true', next: ['first', 'second'] },
      first: { type: 'compose', composition: 'fragment', next: { done: [] } },
      second: { type: 'compose', composition: 'fragment', next: { done: [] } },
    } };
    const reusedResult = await compile(reused, { ...registry030(reused), modules: [{ harness: 'synthetic', moduleJson: encode(module) }],
      harnesses: approximate.harnesses });
    expect(reusedResult.runtime.diagnostics).toContainEqual(expect.objectContaining({ code: 'HARNESS_APPROXIMATE', pointer: '/compositions/fragment/steps/worker', step: ['first', 'worker'] }));
    expect(reusedResult.runtime.diagnostics).toContainEqual(expect.objectContaining({ code: 'HARNESS_APPROXIMATE', pointer: '/compositions/fragment/steps/worker', step: ['second', 'worker'] }));
  });
});
