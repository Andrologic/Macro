import type { PublicExecutionIntent, PublicRunSummary030, RuntimeProjectionPage030 } from '../../types/generated/ipc';
import { sourceDigest } from '../agsdlExecution/compiler';
import type { RunReadTransport030 } from './runAccess030';
import { inspectionFixture030 } from './runInspection030.testSupport';

export async function fixture(id = 'run') {
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
      value: { ...item.activation, phase: item.activation.phase === 'completed' ? 'done' : item.activation.phase } })) : [], nextPage: null };
  return { capture, scope, summary, runtime };
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;
export function intentFor(f: Fixture, scope = { owner: f.capture.source.owner, conversationId: 'sample-chat' }): PublicExecutionIntent {
  const id = f.summary.systemStartId;
  const entry = { deliveryId: `entry-${id}`, messageJson: '{"text":"Start the synthetic sample"}' };
  return { formatVersion: '1', key: { scope: structuredClone(scope), intentId: `intent-${f.summary.systemStartId}` }, revision: '3',
    payload: { kind: 'start', request: { source: f.capture.source, profile: 'macro-agsdl-030-v1', requestId: `request-${id}`, associations: {}, entry } },
    state: { kind: 'admitted', admission: { kind: 'start030', receipt: { systemStartId: f.summary.systemStartId, flowInvocationId: f.summary.flowInvocationId,
      source: f.capture.source, versions: f.capture.versions, entryDeliveryId: entry.deliveryId } } } };
}
export function transportFor(...fixtures: Fixture[]) {
  const calls: string[] = [];
  const nativeScope = { owner: structuredClone(fixtures[0].capture.source.owner), conversationId: 'sample-chat' };
  const retainedIntents = new Map(fixtures.map((f, index) => {
    const intent = intentFor(f, nativeScope);
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
    async readExecutionHumans030(scope) { calls.push('humans'); return { scope, cursor: 'native-human-cursor', total: '0', requests: [], nextPage: null }; },
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
