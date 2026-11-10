import type { PublicExecutionIntent, PublicRunSummary030, RuntimeActivation030, RuntimeProjectionPage030 } from '../../types/generated/ipc';
import { sourceDigest } from '../agsdlExecution/compiler';
import type { RunReadTransport030 } from './runAccess030';
import { inspectionFixture030 } from './runInspection030.testSupport';

const activation = (id: string, step: string[], phase: string, physical: boolean): RuntimeActivation030 => ({
  id, step, agent: null, instanceId: null, phase, physical, stopRequested: phase === 'stopping',
  context: [], pathIds: [], physicalWaitGroupIds: [], composeActivationIds: [], nearestFanoutIndex: null,
});

/** Two serial calls: the first ended and the second is physically running.
 * No terminal verdict, path frame, instance, group or fan-out has been created. */
export async function nativeRunFixture030(id = 'run') {
  const template = inspectionFixture030(id);
  const capture = { ...structuredClone(template.capture), associations: {}, authoredSource: JSON.stringify({
    contract: 'agsdl-0.3.0', id: 'serial-calls', agents: {}, flow: { entry: 'first', steps: {
      first: { type: 'call', command: 'echo first', next: 'second' }, second: { type: 'call', command: 'echo second' },
    } },
  }) };
  capture.source.sourceSha256 = await sourceDigest(capture.authoredSource);
  const scope = { ...template.state.scope, source: capture.source };
  const summary: PublicRunSummary030 = { ...scope, flowInvocationId: 'flow', versions: capture.versions,
    revision: '9007199254740993', stopping: false, verdict: null, ownerStatus: 'live', interruptedAt: null,
    phaseCounts: [{ phase: 'done', count: '1' }, { phase: 'running', count: '1' }], physicalPending: '1' };
  const runtime: RuntimeProjectionPage030 = { scope, flowInvocationId: 'flow', revision: summary.revision,
    stopping: summary.stopping, verdict: summary.verdict, total: '2', items: [
      { kind: 'activation', value: activation('activation-1', ['first'], 'done', false) },
      { kind: 'activation', value: activation('activation-2', ['second'], 'running', true) },
    ], nextPage: null };
  return { capture, scope, summary, runtime };
}
export type Fixture = Awaited<ReturnType<typeof nativeRunFixture030>>;
export function nativeIntentFor030(f: Fixture, scope = { owner: f.capture.source.owner, conversationId: 'design-conversation' }): PublicExecutionIntent {
  const id = f.summary.systemStartId;
  const entry = { deliveryId: `entry-${id}`, messageJson: '{"text":"Start the synthetic sample"}' };
  return { formatVersion: '1', key: { scope: structuredClone(scope), intentId: `intent-${f.summary.systemStartId}` }, revision: '3',
    payload: { kind: 'start', request: { source: f.capture.source, profile: 'macro-agsdl-030-v1', requestId: `request-${id}`, associations: {}, entry } },
    state: { kind: 'admitted', admission: { kind: 'start030', receipt: { systemStartId: f.summary.systemStartId, flowInvocationId: f.summary.flowInvocationId,
      source: f.capture.source, versions: f.capture.versions, entryDeliveryId: entry.deliveryId } } } };
}
export function nativeTransportFor030(...fixtures: Fixture[]) {
  const calls: string[] = [];
  const nativeScope = { owner: structuredClone(fixtures[0].capture.source.owner), conversationId: 'design-conversation' };
  const retainedIntents = new Map(fixtures.map((f, index) => {
    const intent = nativeIntentFor030(f, nativeScope);
    if (index > 0 && intent.state.kind === 'admitted')
      intent.state = { kind: 'closed', disposition: 'acknowledged', admission: intent.state.admission };
    return [f.summary.systemStartId, intent] as const;
  }));
  const sameScope = (scope: typeof nativeScope, other: typeof nativeScope) =>
    scope.conversationId === other.conversationId && scope.owner.projectId === other.owner.projectId &&
    scope.owner.planId === other.owner.planId && scope.owner.branch === other.owner.branch;
  const transport: RunReadTransport030 = {
    async listExecutionRuns030() { calls.push('list'); return { runs: fixtures.map(item => item.summary), nextCursor: null }; },
    async readExecutionSnapshot030(id) { calls.push('snapshot'); return fixtures.find(item => item.capture.systemStartId === id)!.capture; },
    async readExecutionRuntimeProjection030(scope) { calls.push('runtime'); return fixtures.find(item => item.scope.systemStartId === scope.systemStartId)!.runtime; },
    async readExecutionHumans030() {
      calls.push('humans');
      // A true-flow Start has no legacy Stored row. This does not attest an empty human queue.
      throw { code: 'NOT_FOUND', message: 'True-flow has no legacy Stored row' };
    },
    async readExecutionIntentsVersioned({ scope }) {
      calls.push('intents');
      return structuredClone([...retainedIntents.values()].filter(intent => intent.state.kind !== 'closed' && sameScope(intent.key.scope, scope)));
    },
    async readExecutionRunCorrelation030(scope, id) {
      calls.push(`correlation:${id}`);
      const intent = retainedIntents.get(id);
      if (!fixtures.some(f => f.summary.systemStartId === id)) throw { code: 'NOT_FOUND', currentIntentKey: null };
      if (!intent || !sameScope(intent.key.scope, scope)) throw { code: 'SCOPE_INVALID', currentIntentKey: null };
      const state = intent.state;
      const admission = state.kind === 'admitted' || (state.kind === 'closed' && state.disposition === 'acknowledged') ? state.admission : null;
      if (admission?.kind !== 'start030') throw { code: 'STORAGE_UNCERTAIN', currentIntentKey: null };
      return structuredClone({ key: intent.key, receipt: admission.receipt });
    },
  };
  return { transport, calls, scope: structuredClone(nativeScope), retainedIntents };
}

/** Agent-only reducer states. Compose/join/ready states are not faked on an
 * admitted Agent. A queued delivery has a physically running shared owner. */
export async function nativeAgentRunFixture030(id = 'agent-run', phase = 'done') {
  if (!['done', 'running', 'stopping', 'queued', 'preparing'].includes(phase)) throw new Error('Not an admitted Agent fixture phase');
  const f = await nativeRunFixture030(id);
  const queued = phase === 'queued';
  const selector = queued ? 'shared' : 'new';
  f.capture.authoredSource = JSON.stringify({ contract: 'agsdl-0.3.0', id: 'agent-work', agents: { worker: { harness: 'example', permissions: 'read-only' } },
    flow: { entry: queued ? 'dispatch' : 'prepare', steps: { prepare: { type: 'agent', agent: 'worker', instance: selector,
      ...(phase === 'preparing' ? { next: 'after' } : {}) },
      ...(queued ? { dispatch: { type: 'call', command: 'echo dispatch', next: ['prepare', 'followup'] }, followup: { type: 'agent', agent: 'worker', instance: 'shared' } } : {}), ...(phase === 'preparing' ? { after: { type: 'call', command: 'echo after' } } : {}) } } });
  f.capture.source.sourceSha256 = await sourceDigest(f.capture.authoredSource);
  const physical = phase === 'running' || phase === 'stopping' || queued;
  const current = { ...activation('activation-1', ['prepare'], queued ? 'running' : phase, physical), agent: 'worker', instanceId: 'native-instance' };
  // Both deliveries come from graph targets, never Deliver on an entered flow.
  const pathContext = (index: number) => [{ kind: 'path' as const, pathId: `path-${index}`, departedGroups: [] }];
  const activations = queued ? [activation('activation-0', ['dispatch'], 'done', false),
    { ...current, context: pathContext(0), pathIds: ['path-0'] },
    { ...activation('activation-2', ['followup'], 'queued', false), agent: 'worker', instanceId: 'native-instance', context: pathContext(1), pathIds: ['path-1'] },
  ] : [current];
  const paths: RuntimeProjectionPage030['items'] = queued ? [0, 1].map(index => ({ kind: 'path', value: {
    id: `path-${index}`, batchId: 'batch', phase: 'live', context: [], nearestFanoutIndex: null, memberships: [],
  } })) : [];
  const counts = new Map<string, number>();
  activations.forEach(item => counts.set(item.phase, (counts.get(item.phase) ?? 0) + 1));
  f.summary = { ...f.summary, stopping: phase === 'stopping', physicalPending: physical ? '1' : '0',
    verdict: phase === 'done' ? 'succeeded' : null,
    phaseCounts: [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([phase, count]) => ({ phase, count: String(count) })) };
  f.runtime = { ...f.runtime, stopping: f.summary.stopping, verdict: f.summary.verdict, total: String(1 + activations.length + paths.length), items: [
    { kind: 'instance', value: { id: 'native-instance', agent: 'worker', selectorKind: selector, selectorName: null,
      currentActivationId: physical ? current.id : null, queueActivationIds: queued ? ['activation-2'] : [],
      // physical_end retires a new instance after success as well as failure.
      discarded: selector === 'new' && !physical } },
    ...activations.map(value => ({ kind: 'activation' as const, value })), ...paths,
  ] };
  return f;
}

export { nativeRunFixture030 as fixture, nativeIntentFor030 as intentFor, nativeTransportFor030 as transportFor };
