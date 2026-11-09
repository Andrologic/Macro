import type { NativeFact030, RunCapture030, RunHumanRequest030, RunOccurrence030, RunRead030, RunStateUi030 } from '../../types/agsdlRunUi030';
import type { RunHistoryEntry030, RunInspection030, RunInspectionAccess030, RunMonitorSnapshot030 } from './runtimeProjection030';

export const available = <T,>(value: T): NativeFact030<T> => ({ kind: 'available', value });
export const ready = <T,>(value: T, revision = '9'): RunRead030<T> => ({ kind: 'ready', value, revision });
export function inspectionFixture030(id = 'run-current'): RunInspection030 {
  const source = { owner: { projectId: 'sample-project', planId: 'sample-plan', branch: 'develop' }, revision: '2', sourceSha256: 'a'.repeat(64) };
  const capture: RunCapture030 = { systemStartId: id, source, authoredSource: JSON.stringify({ contract: 'agsdl-0.3.0', id: 'review', agents: { worker: { harness: 'example', permissions: 'read-only' } }, flow: { entry: 'split', steps: {
    split: { type: 'call', command: 'printf \'[1,2]\'', parse: 'json', next: { step: 'prepare', each: ['data', 'value'], concurrency: 1, max: 200 } },
    prepare: { type: 'agent', agent: 'worker', instance: 'new', next: 'review' },
    review: { type: 'call', title: 'Review', command: 'echo synthetic', next: { passed: 'vote', failed: 'review' } },
    vote: { type: 'join', quorum: { count: 2, accept: ['accept'] }, remaining: 'finish', next: { reached: [], missed: [] } },
  } } }), versions: { snapshot: '2', contract: 'agsdl-0.3.0', profile: 'macro-agsdl-030-v1', compiler: 'c', runtime: 'r', registry: 'v' }, associations: {} };
  const scope = { systemStartId: id, snapshotId: `capture-${id}`, source };
  const occurrences: RunOccurrence030[] = ['activation-1', 'activation-2'].map((activationId, index) => ({ scope,
    activation: { id: activationId, step: ['review'], agent: null, instanceId: null, phase: index === 0 ? 'done' : 'stopping', physical: index === 1,
      stopRequested: index === 1, context: [{ kind: 'path', pathId: `path-${index}`, departedGroups: [] }], pathIds: [`path-${index}`], physicalWaitGroupIds: [], composeActivationIds: [], nearestFanoutIndex: String(index) },
    details: available({ sourcePointer: '/flow/steps/review', occurrenceId: `native-visit-${index}`, visit: String(index + 1), countsForFlow: index === 0,
      receivedMessageJson: '{"text":"Inspect the synthetic sample"}', senderJson: '{"step":"entry"}', outputJson: index === 0 ? '{"outcome":"failed","exitCode":1}' : null,
      diagnosticIds: [], deliveryActivationId: null, targetActivationId: null }) }));
  const state: RunStateUi030 = { scope, flowInvocationId: 'flow', revision: '9', verdict: null, ownerStatus: 'live', stopping: true, physicalPending: '1',
    stop: available({ kind: 'uncertain', requestId: 'stop-request', diagnosticIds: [] }), uncertainties: available([{ id: 'uncertainty', subject: 'stop', receiptId: null, diagnosticIds: [], state: 'unresolved' }]),
    humans: ready([]), occurrences: ready(occurrences), instances: [{ id: 'conversation', agent: 'worker', selectorKind: 'new', selectorName: null, currentActivationId: null, queueActivationIds: [], discarded: true }],
    groups: [{ id: 'native-group', join: ['vote'], originActivationId: 'origin', activationId: 'join-activation', decision: 'missed', released: true, context: [], parentPathIds: [], branches: [{ name: 'review', fanout: true, pathIds: ['path-0', 'path-1'] }] }],
    paths: [0, 1].map(index => ({ id: `path-${index}`, batchId: 'batch', phase: index === 0 ? 'ended' : 'live', context: [], nearestFanoutIndex: null, memberships: [{ groupId: 'native-group', branch: 'review', phase: index === 0 ? 'ended' : 'live', accepted: false, failed: false }] })),
    diagnostics: ready([{ id: 'diagnostic-handled', code: 'BRANCH_FAILED', message: 'A synthetic branch error was retained.', severity: 'error', activationId: 'activation-1', sourcePointer: '/flow/steps/review', step: ['review'], disposition: 'handled', causeId: null, handlerStep: ['vote'], effectsJson: available('{"filesWritten":[]}') }]),
    chronology: { kind: 'unavailable', gap: 'chronology' } };
  return { capture, state };
}
export function humanFixture030(inspection: RunInspection030): RunHumanRequest030 {
  return { scope: { systemStartId: inspection.capture.systemStartId, source: inspection.capture.source }, id: 'human-request', revision: '1', workIds: ['work-1'],
    occurrences: [{workId: 'work-1', activation: {kind: 'unavailable', gap: 'human-occurrence-mapping'}}], content: { kind: 'plan', plan: 'Review the sample' }, state: { kind: 'open' }, clock: { kind: 'unavailable', gap: 'human-clock-observation' } };
}
export function historyFixture030(inspection: RunInspection030): RunHistoryEntry030 {
  return { capture: inspection.capture, scope: inspection.state.scope, verdict: inspection.state.verdict, physicalPending: inspection.state.physicalPending, humans: inspection.state.humans, chronology: inspection.state.chronology };
}

/** Synthetic read transport, shared by component tests and the temporary browser harness. */
export class RunInspectionDouble030 implements RunInspectionAccess030 {
  readonly scopeKey = 'sample-project/sample-plan/develop/design-conversation';
  readonly listeners = new Set<() => void>();
  readonly reads: string[] = [];
  onHistory?: () => Promise<void>;
  onRun?: (id: string) => Promise<void>;
  constructor(public snapshot: RunMonitorSnapshot030) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  publish(snapshot: RunMonitorSnapshot030) { this.snapshot = snapshot; this.listeners.forEach(listener => listener()); }
  async refreshHistory() { this.reads.push('history'); await this.onHistory?.(); }
  async refreshRun(id: string) { this.reads.push(id); await this.onRun?.(id); }
}
export function monitorFixture030(...inspections: RunInspection030[]): RunInspectionDouble030 {
  const runs = inspections.length ? inspections : [inspectionFixture030()];
  return new RunInspectionDouble030({ history: ready(runs.map(historyFixture030)), historyOrder: runs.map(run => run.capture.systemStartId), retainedAdmission: available(null), runFailures: {},
    runs: Object.fromEntries(runs.map(run => [run.capture.systemStartId, ready(run)])) });
}
