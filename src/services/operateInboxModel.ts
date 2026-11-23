import type { RunHumanRequest030, RunScope030, RunVerdict030 } from '../types/agsdlRunUi030';
import type { OperateRunFacts, OperateThreadFacts } from '../types/generated/ipc';
import { sameHumanScope030, humanRemainingMs030 } from './agsdl/humanRequests030';
import { runCaptureKey030 } from './agsdl/runGraphProjection030';
import type { RunOperatorAction030 } from './ipc/agsdlExecution030';
import type { RunInspection030 } from './agsdl/runtimeProjection030';

export type OperateReason = 'question' | 'approval' | 'error' | 'interrupted'
  | 'finished' | 'activity' | 'snoozeElapsed' | 'snoozed';
export type OperateRunStatus = 'active' | 'paused' | 'stopping' | 'succeeded' | 'terminated' | 'failed' | 'interrupted';
export type OperateLocation = { kind: 'local' } | { kind: 'remote'; machineId: string; label: string };

export interface OperateRunTarget {
  scope: RunScope030;
  conversationId?: string;
}
export interface OperateRunInput extends OperateRunTarget {
  location: OperateLocation;
  systemLabel: string;
  runName?: string;
  status: OperateRunStatus;
  facts?: OperateRunFacts;
  operatorAction?: RunOperatorAction030;
  physicalPending?: string;
  stale: boolean;
  threads: readonly {
    instanceId: string;
    agentId: string;
    agentLabel: string;
    requests: readonly RunHumanRequest030[];
    reason?: 'error' | 'interrupted';
    operatorAction?: RunOperatorAction030;
  }[];
  unlinkedRequests: readonly RunHumanRequest030[];
  observedAtMs: number;
}

export interface OperateRunRow extends OperateRunTarget {
  kind: 'run';
  key: string;
  location: OperateLocation;
  systemId: string;
  systemLabel: string;
  runLabel: string;
  status: OperateRunStatus;
  stale: boolean;
  unopened: boolean;
  canTerminate: boolean;
  canDelete: boolean;
  operatorAction?: RunOperatorAction030;
  startedAtMs: number | null;
  finishedAtMs: number | null;
  threads: readonly OperateThreadRow[];
}
export interface OperateThreadRow extends OperateRunTarget {
  kind: 'thread';
  key: string;
  runKey: string;
  instanceId: string;
  agentId: string;
  agentLabel: string;
  systemLabel: string;
  runLabel: string;
  location: OperateLocation;
  reason?: OperateReason;
  requestId?: string;
  hidden: boolean;
  stale: boolean;
  canSnooze: boolean;
  operatorAction?: RunOperatorAction030;
  elapsedMs: number | null;
  activityAtMs: number | null;
  responseDeadlineMs: number | null;
  facts?: OperateThreadFacts;
}
export type OperateAttentionRow = OperateThreadRow | {
  kind: 'runAttention';
  key: string;
  run: OperateRunRow;
  reason: 'finished' | 'approval' | 'question';
  requestId?: string;
  elapsedMs: number | null;
};
export interface OperateInboxFilter {
  systemId?: string;
  query?: string;
  showHidden?: boolean;
}
export interface OperateInboxSections {
  attention: readonly OperateAttentionRow[];
  active: readonly OperateRunRow[];
  snoozed: readonly OperateThreadRow[];
  finished: readonly OperateRunRow[];
  scheduled: readonly never[];
  systems: readonly { id: string; label: string }[];
}

export type HiddenOperateAgents = (scope: RunScope030) => ReadonlySet<string>;
const emptyHiddenAgents = new Set<string>();
const noHiddenAgents: HiddenOperateAgents = () => emptyHiddenAgents;

export function operateRunStatus(
  verdict: RunVerdict030, physicalPending: string, stopping: boolean, stoppedByUser: boolean, paused = false,
): OperateRunStatus {
  if (verdict === 'interrupted') return 'interrupted';
  if (verdict === null || physicalPending !== '0') return stopping || stoppedByUser ? 'stopping' : paused ? 'paused' : 'active';
  if (verdict === 'cancelled' && stoppedByUser) return 'terminated';
  return verdict === 'succeeded' ? 'succeeded' : 'failed';
}
export const isFinishedOperateRun = (status: OperateRunStatus) => status !== 'active' && status !== 'paused' && status !== 'stopping';

export function snoozeState(facts: OperateThreadFacts | undefined, now: number): 'snoozed' | 'activity' | 'snoozeElapsed' | undefined {
  if (!facts || facts.snoozeUntilMs === null) return undefined;
  if (facts.activity !== facts.snoozedAtActivity) return 'activity';
  return facts.snoozeUntilMs <= now ? 'snoozeElapsed' : 'snoozed';
}

/** Shared by the workflow task catalogue, notification observer, and inbox. */
export function workflowHumanInstances030(inspection: RunInspection030, request: RunHumanRequest030): ReadonlySet<string> {
  const { scope, occurrences, revision } = inspection.state;
  if (!sameHumanScope030(request.scope, scope) || occurrences.kind !== 'ready' || occurrences.revision !== revision) return new Set();
  const key = runCaptureKey030(scope);
  const links = new Set(request.occurrences.flatMap(({ activation }) =>
    activation.kind === 'available' && runCaptureKey030(activation.scope) === key ? [activation.activationId] : []));
  return new Set(occurrences.value.flatMap(item =>
    item.activation.instanceId && links.has(item.activation.id) && runCaptureKey030(item.scope) === key
      ? [item.activation.instanceId] : []));
}

export function isOperateRequestSnoozed(inspection: RunInspection030 | undefined, request: RunHumanRequest030, now = Date.now()): boolean {
  if (!inspection?.inbox) return false;
  const instances = workflowHumanInstances030(inspection, request);
  return instances.size > 0 && [...instances].every(id =>
    snoozeState(inspection.inbox?.threads.find(thread => thread.instanceId === id), now) === 'snoozed');
}

const requestReason = (request: RunHumanRequest030) =>
  request.content.kind === 'question' ? 'question' : 'approval';
const elapsed = (at: number | null, now: number) => at === null ? null : Math.max(0, now - at);
const newestFirst = (a: number | null, b: number | null) => (b ?? -1) - (a ?? -1);
const searchKey = (value: string) => value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

function responseDeadline(requests: readonly RunHumanRequest030[], observedAtMs: number): number | null {
  const times = requests.flatMap(request => {
    if (!['flowChoice', 'actionApproval'].includes(request.content.kind) || request.clock.kind !== 'available') return [];
    const remaining = humanRemainingMs030(request.clock.value);
    return remaining === null ? [] : [observedAtMs + Number(remaining)];
  });
  return times.length ? Math.min(...times) : null;
}

export function operateSnoozeDeadlineWarning(thread: OperateThreadRow, untilMs: number): number | null {
  const deadline = thread.responseDeadlineMs;
  return deadline !== null && deadline <= untilMs ? deadline : null;
}

export function selectOperateInbox(
  runs: readonly OperateRunInput[], filter: OperateInboxFilter, now: number,
  hiddenAgents: HiddenOperateAgents = noHiddenAgents,
  formatStart: (time: number) => string = time => new Date(time).toLocaleString(),
): OperateInboxSections {
  const attention: { row: OperateAttentionRow; at: number | null }[] = [];
  const active: OperateRunRow[] = [], snoozed: OperateThreadRow[] = [], finished: OperateRunRow[] = [];
  const systems = new Map<string, string>();
  const query = searchKey(filter.query?.trim() ?? '');

  for (const input of runs) {
    const { scope, location, status, systemLabel, facts, stale, conversationId } = input;
    const systemId = scope.source.owner.planId;
    systems.set(systemId, systemLabel);
    if (filter.systemId && filter.systemId !== systemId) continue;
    const key = JSON.stringify([location.kind === 'remote' ? location.machineId : null, runCaptureKey030(scope)]);
    const startedAtMs = facts?.startedAtMs ?? null, finishedAtMs = facts?.finishedAtMs ?? null;
    const runLabel = input.runName?.trim() || (startedAtMs === null ? scope.systemStartId : formatStart(startedAtMs));
    const runMatches = !query || searchKey(`${systemLabel} ${runLabel}`).includes(query);
    const terminal = isFinishedOperateRun(status);
    const canAct = !terminal && !stale && facts !== undefined && location.kind === 'local';
    const hidden = hiddenAgents(scope);
    const threadFacts = new Map(facts?.threads.map(item => [item.instanceId, item]));
    const threads: OperateThreadRow[] = [];
    const row: OperateRunRow = { kind: 'run', key, scope, conversationId, location, systemId, systemLabel, runLabel,
      status, stale, unopened: terminal && !facts?.opened, canTerminate: canAct,
      canDelete: terminal && !stale && location.kind === 'local' && input.physicalPending === '0',
      operatorAction: canAct ? input.operatorAction : undefined, startedAtMs, finishedAtMs, threads };

    for (const thread of input.threads) {
      if (!runMatches && !searchKey(thread.agentLabel).includes(query)) continue;
      const meta = threadFacts.get(thread.instanceId);
      const snooze = terminal ? undefined : snoozeState(meta, now);
      const request = terminal ? undefined : thread.requests.find(item => item.content.kind !== 'question') ?? thread.requests[0];
      const wake = meta?.snoozedForRequest ? undefined : snooze;
      const failure = status === 'terminated' ? undefined : thread.reason;
      const reason = snooze === 'snoozed' ? snooze : request ? requestReason(request) : failure ?? wake;
      const at = reason === 'snoozeElapsed' ? meta?.snoozeUntilMs ?? null
        : meta?.activityAtMs ?? startedAtMs;
      const item: OperateThreadRow = { kind: 'thread', key: JSON.stringify([key, thread.instanceId]), runKey: key,
        scope, conversationId, location, systemLabel, runLabel, instanceId: thread.instanceId,
        agentId: thread.agentId, agentLabel: thread.agentLabel, hidden: hidden.has(thread.agentId), stale,
        reason, requestId: request?.id, canSnooze: canAct, operatorAction: canAct ? thread.operatorAction : undefined, elapsedMs: elapsed(at, now), activityAtMs: at,
        facts: meta, responseDeadlineMs: responseDeadline(thread.requests, input.observedAtMs) };
      const visible = !item.hidden || filter.showHidden;
      if (visible && snooze !== 'snoozed') threads.push(item);
      if (snooze === 'snoozed') {
        if (visible || request || thread.reason) snoozed.push(item);
      } else if (reason && !(terminal && facts?.opened)) attention.push({ row: item, at });
    }
    threads.sort((a, b) => newestFirst(a.activityAtMs, b.activityAtMs));
    if (!runMatches && !threads.length) continue;
    (terminal ? finished : active).push(row);
    if (row.unopened) attention.push({ row: { kind: 'runAttention', key, run: row, reason: 'finished',
      elapsedMs: elapsed(finishedAtMs, now) }, at: finishedAtMs });
    for (const request of terminal ? [] : input.unlinkedRequests) {
      attention.push({ row: { kind: 'runAttention', key: JSON.stringify([key, request.id]), run: row,
        reason: requestReason(request), requestId: request.id, elapsedMs: elapsed(startedAtMs, now) }, at: startedAtMs });
    }
  }
  return { attention: attention.sort((a, b) => newestFirst(a.at, b.at)).map(item => item.row),
    active: active.sort((a, b) => newestFirst(a.startedAtMs, b.startedAtMs)),
    snoozed: snoozed.sort((a, b) => newestFirst(a.activityAtMs, b.activityAtMs)),
    finished: finished.sort((a, b) => newestFirst(a.finishedAtMs, b.finishedAtMs)),
    scheduled: [], systems: [...systems].map(([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label)) };
}
