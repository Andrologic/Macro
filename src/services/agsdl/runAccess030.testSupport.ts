import type { PublicExecutionIntent, PublicRunSummary030, RuntimeProjectionPage030 } from '../../types/generated/ipc';
import { sourceDigest } from '../agsdlExecution/compiler';
import type { RunReadTransport030 } from './runAccess030';
import { inspectionFixture030 } from './runInspection030.testSupport';
export async function nativeRunFixture030(id = 'run') {
  const inspection = inspectionFixture030(id);
  const capture = { ...structuredClone(inspection.capture), associations: {} };
  capture.source.sourceSha256 = await sourceDigest(capture.authoredSource);
  const scope = { ...inspection.state.scope, source: capture.source };
  const summary: PublicRunSummary030 = { ...scope, flowInvocationId: 'flow', versions: capture.versions,
    revision: '9007199254740993', stopping: true, verdict: 'succeeded', ownerStatus: 'live',
    phaseCounts: [{ phase: 'done', count: '1' }, { phase: 'running', count: '1' }], physicalPending: '1' };
  const runtime: RuntimeProjectionPage030 = { scope, flowInvocationId: 'flow', revision: summary.revision,
    stopping: summary.stopping, verdict: summary.verdict, total: '2',
    items: inspection.state.occurrences.kind === 'ready' ? inspection.state.occurrences.value.map(item => ({ kind: 'activation',
      value: item.activation })) : [], nextPage: null };
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
  const transport: RunReadTransport030 = {
    async listExecutionRuns030() { calls.push('list'); return { runs: fixtures.map(item => item.summary), nextCursor: null }; },
    async readExecutionSnapshot030(id) { calls.push('snapshot'); return fixtures.find(item => item.capture.systemStartId === id)!.capture; },
    async readExecutionRuntimeProjection030(scope) { calls.push('runtime'); return fixtures.find(item => item.scope.systemStartId === scope.systemStartId)!.runtime; },
    async readExecutionHumans030(scope) { calls.push('humans'); return { scope, cursor: 'native-human-cursor', total: '0', requests: [], nextPage: null }; },
    async readExecutionIntentsVersioned() { calls.push('intents'); return [nativeIntentFor030(fixtures[0], nativeScope)]; },
  };
  return { transport, calls, scope: structuredClone(nativeScope) };
}


/** A native Agent activation, with no forbidden Start associations. */
export async function nativeAgentRunFixture030(id = 'agent-run', phase = 'done') {
  const f = await nativeRunFixture030(id);
  const activation = f.runtime.items.find(item => item.kind === 'activation')!;
  if (activation.kind !== 'activation') throw new Error('Missing activation fixture');
  const physical = phase === 'running' || phase === 'stopping';
  f.summary = { ...f.summary, stopping: phase === 'stopping', physicalPending: physical ? '1' : '0',
    verdict: phase === 'done' ? 'succeeded' : null, phaseCounts: [{phase,count:'1'}] };
  f.runtime = { ...f.runtime, stopping: f.summary.stopping, verdict: f.summary.verdict, total:'2', items:[
    {kind:'instance',value:{id:'native-instance',agent:'worker',selectorKind:'shared',selectorName:null,
      currentActivationId: physical ? activation.value.id : null,queueActivationIds:phase === 'queued' ? [activation.value.id] : [],discarded:false}},
    {kind:'activation',value:{...activation.value,agent:'worker',step:['prepare'],instanceId:'native-instance',phase,physical}},
  ] };
  return f;
}
