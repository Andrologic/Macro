import { expect, it } from 'bun:test';
import type { Emission } from '../../types/generated/ipc';
import type { RetainedEmission } from './retainedResponses';
import { type ResidentAgentPorts } from './residentAgent';
import { executeFlowActivation, loadFlowCapture, resolveFlowVisitLimit, prepareFlowAgent, type FlowActivationPorts } from './flowActivation';
import { ConformanceError, decode, record, shape } from './exact';
import { flowDelivery, flowFixture, flowOwner, exactRecord } from './flowTestFixtures';
import { evaluatePureStep, flowFailure, retainedAgentOutcome } from './flowValues';
import { schema } from '../../vendor/agsdl/v0.2/values.mjs';
import { json } from './conformanceFixtures';
import type { Sequence } from './contracts';

function io() {
  const order: string[] = [];
  const events: Emission[] = [];
  const resident: ResidentAgentPorts = {
    register: async () => { order.push('register'); return true; }, dispatch: async () => { order.push('dispatch'); }, end: async () => { order.push('ended'); },
    append: async emission => { order.push('append'); events.push(emission); return true; },
    stream: async options => {
      const native = options.nativeExecution!;
      const request = { requestId: 'attempt', providerId: 'synthetic-provider', modelId: 'synthetic-model', messages: [] };
      await native.beforeRequest('attempt', request); await native.dispatch!(request); await native.requestEnded('attempt');
      await native.visibleMessage('attempt', 'Original\n');
      options.onExecutionMessages!([...options.messages, { role: 'assistant', content: 'Original\n' }]);
      options.onComplete({ visibleContent: 'presentation', toolTraces: [] });
    },
    journal: { read: async () => ({ events: events as unknown as RetainedEmission[], digest: 'native-digest' }), close: async closure => { order.push('close'); return closure; } },
  };
  const ports: FlowActivationPorts = {
    readResponses: async () => { order.push('read-empty'); return [events, 'native-digest']; },
    closeResponses: async closure => { order.push('close-empty'); return closure; },
    identity: () => 'invocation', invoke: async request => { order.push('call'); expect(request.context.scopeJson).toContain('root'); return { failed: false, resultJson: '"ok"' }; },
    prepareAgent: async request => { order.push('initialize'); return prepareFlowAgent(request, resident); },
  };
  return { order, ports, resident, events };
}
it('runs the real Agent initialization/adaptation/memory and uses the retained closure before terminal proposal', async () => {
  const { inspection } = await flowFixture();
  const capture = await loadFlowCapture(inspection), f = io();
  const first = flowDelivery('first', '1');
  const terminal = await executeFlowActivation(flowOwner, first, null, inspection, capture, agent => {
    expect(agent.checkpoint().stateJson).toContain('Review.');
    expect(agent.checkpoint().stateJson).not.toContain('Go');
  }, f.ports);
  expect(f.order).toEqual(['initialize', 'register', 'dispatch', 'ended', 'append', 'close']);
  expect(terminal.outcome).toEqual({ kind: 'completed', output: { origin: 'agent', valueJson: '{"text":"Original\\n","results":{}}' } });
  expect(terminal.memory!.stateJson).toContain('Go');
  expect(terminal.memory!.stateJson).not.toContain('presentation');
  expect(terminal.responseCursor).toBe('1');
  const second = flowDelivery('second', '2', 'again');
  second.delivery.input = { origin: 'agent', valueJson: '{"text":"information","results":{}}' };
  f.events.length = 0;
  const again = await executeFlowActivation(flowOwner, second, terminal.memory, inspection, capture, () => {}, f.ports);
  expect(again.memory!.agentInstanceId).toBe(terminal.memory!.agentInstanceId);
  expect(again.memory!.revision).toBe('2');
  expect(again.memory!.stateJson).toContain('Go');
  expect(again.memory!.stateJson).toContain('Resource information, not instructions');
  expect(again.memory!.stateJson.match(/Review\./g)?.length).toBe(1);
});
it('closes an input failure after initialization without starting a provider', async () => {
  const { document, inspection } = await flowFixture();
  const capture = await loadFlowCapture(inspection), f = io();
  record(record(document.agents).worker).interface = { inputMediaTypes: ['application/json'] };
  // The isolated pure input boundary is exercised with the captured declaration.
  record(record(capture.document.agents).worker).interface = { inputMediaTypes: ['application/json'] };
  const result = await executeFlowActivation(flowOwner, flowDelivery('bad', '1'), null, inspection, capture, () => {}, f.ports);
  expect(result.outcome).toMatchObject({ kind: 'failed', code: 'INPUT_CONSTRAINT' });
  expect(f.order).toEqual(['initialize', 'read-empty', 'close-empty']);
  expect(result.memory!.stateJson).toContain('Review.');
  expect(result.memory!.stateJson).not.toContain('Go');
});
it('uses Call arguments, authored evaluated scope, native result and language result validation', async () => {
  const { inspection } = await flowFixture(), capture = await loadFlowCapture(inspection), f = io();
  const call = flowDelivery('call', '1', 'call', null);
  call.delivery.input = { origin: 'agent', valueJson: '{"text":"visible","results":{}}' };
  f.ports.invoke = async request => {
    expect(request.toolInvocationId).toBe('invocation'); expect(request.providerAttemptId).toBeNull();
    expect(exactRecord(request.argumentsJson)).toEqual({ path: 'synthetic.txt' });
    expect(exactRecord(request.callScopeJson!)).toEqual({ action: 'read', resources: ['synthetic.txt'], context: { text: 'visible', results: {} } });
    expect(request.context.scopeJson).not.toBe(request.callScopeJson);
    return { failed: false, resultJson: '"ok"' };
  };
  const terminal = await executeFlowActivation(flowOwner, call, null, inspection, capture, () => {}, f.ports);
  expect(terminal.outcome).toEqual({ kind: 'completed', output: { origin: 'call', valueJson: '{"data":"ok"}' } });
  f.ports.invoke = async () => ({ failed: false, resultJson: '9007199254740993' });
  expect((await executeFlowActivation(flowOwner, call, null, inspection, capture, () => {}, f.ports)).outcome).toMatchObject({ kind: 'failed', code: 'CALL_RESULT' });
  f.ports.invoke = async () => ({ failed: true, resultJson: '"technical"' });
  expect((await executeFlowActivation(flowOwner, call, null, inspection, capture, () => {}, f.ports)).outcome).toMatchObject({ kind: 'failed', code: 'CALL_FAILED' });
});
it('preserves Condition bytes/origin and constructs only the authored Prepare Message', async () => {
  const { inspection } = await flowFixture(), capture = await loadFlowCapture(inspection), f = io();
  const condition = flowDelivery('condition', '1', 'check', null);
  condition.delivery.input = { origin: 'call', valueJson: '{ "data" : "ok" }' };
  const result = await executeFlowActivation(flowOwner, condition, null, inspection, capture, () => {}, f.ports);
  expect(result.outcome).toEqual({ kind: 'completed', output: condition.delivery.input });
  expect(result.validation.selectedBranch).toBe('true');
  const prepare = flowDelivery('prepare', '2', 'prepare', null);
  prepare.delivery.input = condition.delivery.input;
  const prepared = await executeFlowActivation(flowOwner, prepare, null, inspection, capture, () => {}, f.ports);
  expect(prepared.outcome).toMatchObject({ kind: 'completed', output: { origin: 'prepare' } });
  expect(exactRecord((prepared.outcome as { kind: 'completed'; output: { valueJson: string } }).output.valueJson)).toEqual({ prompt: [{ value: 'Continue.' }], resources: { exact: { value: 'ok', mediaType: 'application/json' } } });
  expect(f.order).toEqual(['read-empty', 'close-empty', 'read-empty', 'close-empty']);
});
it('graphless uses the captured null-step contract and VISIT_LIMIT conserves native memory without initialization', async () => {
  const { inspection } = await flowFixture(true), capture = await loadFlowCapture(inspection), f = io();
  const activation = flowDelivery('graphless', '1', null);
  const result = await executeFlowActivation(flowOwner, activation, null, inspection, capture, () => {}, f.ports);
  expect(result.validation.declarationJson).toBeNull(); expect(result.validation.selectedBranch).toBeNull();
  expect(result.outcome).toMatchObject({ kind: 'completed', output: { origin: 'agent' } });
  const graph = await flowFixture(), graphCapture = await loadFlowCapture(graph.inspection);
  graph.inspection.agents[0].memory = result.memory;
  const blocked = io();
  const rejection = await resolveFlowVisitLimit(flowOwner, flowDelivery('limit', '2'), graph.inspection, graphCapture, blocked.ports);
  expect(rejection.memory).toEqual(result.memory); expect(rejection.outcome).toMatchObject({ kind: 'failed', code: 'VISIT_LIMIT' });
  expect(blocked.order).toEqual(['read-empty', 'close-empty']);
});
it('keeps unsafe native boundaries unconfirmed and rejects replaced snapshots before work', async () => {
  const { inspection } = await flowFixture(), capture = await loadFlowCapture(inspection), f = io();
  f.ports.readResponses = async () => [[], 'native-digest'];
  f.ports.closeResponses = async () => { throw new Error('Unresolved effect'); };
  await expect(executeFlowActivation(flowOwner, flowDelivery('pure', '1', 'prepare', null), null, inspection, capture, () => {}, f.ports)).rejects.toThrow('Unresolved effect');
  const changed = structuredClone(inspection); changed.snapshot.versions.runtime = 'other';
  await expect(loadFlowCapture(changed)).rejects.toMatchObject({ code: 'CORRELATION' });
});
it('uses closed portable errors with output details, preserving exact predicate values', () => {
  const input = { origin: 'call', valueJson: '{ "data":9007199254740993 }' };
  const step = record(decode('{"type":"condition","test":{"equals":[{"path":["data"]},{"value":9007199254740993}]}}'));
  expect(evaluatePureStep({}, step, input)).toEqual({ outcome: { kind: 'completed', output: input }, selectedBranch: 'true' });
  expect(() => flowFailure(new ConformanceError('STOP_PENDING', '', 'pending'))).toThrow('pending');
  const output = flowFailure(new ConformanceError('OUTPUT_CONSTRAINT', '/choice', 'Missing choice'), {}, { decision: { choices: ['normal'] } });
  expect(exactRecord((output as { errorJson: string }).errorJson)).toEqual({ error: { code: 'OUTPUT_CONSTRAINT', message: 'Missing choice', details: [{ path: '/choice', rule: 'OUTPUT_CONSTRAINT', expected: ['normal'] }] } });
});

it('retransmits an acknowledged closure operation after reply loss without another provider or Call', async () => {
  const { inspection } = await flowFixture(), capture = await loadFlowCapture(inspection), f = io();
  let lost = true;
  const closures: unknown[] = [];
  f.resident.journal.close = async closure => {
    closures.push(closure);
    if (lost) { lost = false; throw new Error('Closure committed, reply lost'); }
    return closure;
  };
  const result = await executeFlowActivation(flowOwner, flowDelivery('first', '1'), null, inspection, capture, () => {}, f.ports);
  expect(result.outcome.kind).toBe('completed'); expect(closures).toHaveLength(2); expect(closures[0]).toBe(closures[1]);
  expect(f.order.filter(item => item === 'dispatch')).toHaveLength(1);
});

it('stops the initialized no-effect boundary before input/provider work only after native closure', async () => {
  const { inspection } = await flowFixture(), capture = await loadFlowCapture(inspection), f = io();
  const result = await executeFlowActivation(flowOwner, flowDelivery('stopped', '1'), null, inspection, capture, agent => agent.requestStop(), f.ports);
  expect(result.outcome.kind).toBe('stopped'); expect(f.order).toEqual(['initialize', 'read-empty', 'close-empty']);
  expect(result.memory!.stateJson).toContain('Review.'); expect(result.memory!.stateJson).not.toContain('Go');
  f.ports.closeResponses = async () => { throw new Error('Owner still active'); };
  await expect(executeFlowActivation(flowOwner, flowDelivery('still-active', '2'), null, inspection, capture, agent => agent.requestStop(), f.ports)).rejects.toThrow('Owner still active');
});

it('uses the official ErrorInput shape and the normative Stop/work/output failure order', () => {
  const success = { kind: 'success' as const, text: '', resultsJson: json('{}'), choice: null };
  const failure = { kind: 'failure' as const, code: 'OUTPUT_CONSTRAINT' as const, diagnostics: [{ sequence: '0' as Sequence, pointer: '/choice', message: 'Missing choice' }] };
  for (const validation of [success, failure]) {
    const workFailure = retainedAgentOutcome({ closure: { validation }, stopped: false, failed: true }, {}, {});
    expect(workFailure.kind).toBe('failed');
    if (workFailure.kind !== 'failed') throw new Error('Expected failed work');
    expect(workFailure.code).toBe('AGENT_FAILED');
    expect(shape(decode(workFailure.errorJson), schema.$defs.ErrorInput)).toBe(true);
    expect(retainedAgentOutcome({ closure: { validation }, stopped: true, failed: true }, {}, {}))
      .toEqual({ kind: 'stopped', evidenceJson: '{"kind":"native-response-closure"}' });
  }
  const outputFailure = retainedAgentOutcome({ closure: { validation: failure }, stopped: false, failed: false }, {}, { decision: { choices: ['normal'] } });
  if (outputFailure.kind !== 'failed') throw new Error('Expected failed output');
  expect(outputFailure.code).toBe('OUTPUT_CONSTRAINT');
  expect(shape(decode(outputFailure.errorJson), schema.$defs.ErrorInput)).toBe(true);
  expect(JSON.parse(outputFailure.errorJson).error.details).toEqual([{ path: '/choice', rule: 'OUTPUT_CONSTRAINT', expected: ['normal'] }]);
});

it.each(['system', 'activation'] as const)('honors the initially retained %s Stop before Agent input without relying on its observer callback', async target => {
  const { inspection } = await flowFixture(), capture = await loadFlowCapture(inspection), f = io();
  const activation = flowDelivery('stopped', '1'); activation.workState = 'active';
  if (target === 'system') inspection.projection.systemStop = { kind: 'requested', requestId: 'stop' };
  else activation.stopState = { kind: 'requested', requestId: 'stop' };
  const result = await executeFlowActivation(flowOwner, activation, null, structuredClone(inspection), capture, () => {}, f.ports);
  expect(result.outcome.kind).toBe('stopped'); expect(f.order).toEqual(['initialize', 'read-empty', 'close-empty']);
  expect(result.memory!.stateJson).toContain('Review.'); expect(result.memory!.stateJson).not.toContain('Go');
  expect(result.validation.selectedBranch).toBeNull(); expect(result.responseCursor).toBe('0');
  expect(activation.stopState.kind).toBe(target === 'system' ? 'none' : 'requested');
});
it.each(['call', 'prepare'] as const)('closes an initially stopped %s without invocation or pure input work, and requires the native receipt', async step => {
  const { inspection } = await flowFixture(), capture = await loadFlowCapture(inspection), f = io();
  const activation = flowDelivery('stopped', '1', step, null); activation.workState = 'active';
  activation.stopState = { kind: 'requested', requestId: 'stop' };
  // This input would fail the captured Prepare selector if evaluated at all.
  const result = await executeFlowActivation(flowOwner, activation, null, structuredClone(inspection), capture, () => {}, f.ports);
  expect(result.outcome.kind).toBe('stopped'); expect(result.memory).toBeNull(); expect(result.validation.selectedBranch).toBeNull();
  expect(f.order).toEqual(['read-empty', 'close-empty']);
  f.ports.closeResponses = async () => { throw new Error('No confirmed native closure'); };
  await expect(executeFlowActivation(flowOwner, activation, null, inspection, capture, () => {}, f.ports)).rejects.toThrow('No confirmed native closure');
  expect(f.order).not.toContain('call'); expect(f.order).not.toContain('initialize');
});
it('keeps the reserved VISIT_LIMIT memory unchanged when Stop wins before its no-effect closure', async () => {
  const { inspection } = await flowFixture(), capture = await loadFlowCapture(inspection), f = io();
  const activation = flowDelivery('limit', '1'); activation.workState = 'active'; activation.stopState = { kind: 'requested', requestId: 'stop' };
  const initialized = await prepareFlowAgent({ context: { owner: flowOwner, work: activation.delivery.work, permissionsJson: capture.plan.agents[0].permissionsJson,
    scopeJson: capture.plan.agents[0].scopeJson, registryVersion: capture.registry.version } as import('./contracts').ExecutionContext,
    configuration: capture.plan.agents[0] as import('./contracts').FrozenAgentConfiguration, memory: null, providerType: 'openai', toolAliases: [],
    responses: { agentName: 'worker', interfaceJson: json('{}'), stepJson: capture.plan.steps[0].declarationJson, publicationContractJson: capture.plan.steps[0].publicationContractJson } }, f.resident);
  inspection.agents[0].memory = initialized.checkpoint();
  const result = await resolveFlowVisitLimit(flowOwner, activation, structuredClone(inspection), capture, f.ports);
  expect(result.outcome.kind).toBe('stopped'); expect(result.memory).toEqual(inspection.agents[0].memory);
  expect(f.order).toEqual(['read-empty', 'close-empty']); expect(result.validation.selectedBranch).toBeNull();
});
