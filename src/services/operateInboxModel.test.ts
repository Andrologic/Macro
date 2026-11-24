import { expect, it } from 'bun:test';
import { humanFixture030 } from '../components/agsdl/HumanRequests030.test-fixtures';
import type { OperateRunFacts, OperateThreadFacts } from '../types/generated/ipc';
import { humanFixture030 as mappedHuman, inspectionFixture030, ready } from './agsdl/runInspection030.testSupport';
import {
  isOperateRequestSnoozed, operateRunStatus, operateSnoozeDeadlineWarning, selectOperateInbox,
  type OperateRunInput,
} from './operateInboxModel';

const scope = inspectionFixture030().state.scope;
const facts: OperateRunFacts = {
  opened: false, startedAtMs: 100, finishedAtMs: null, stoppedByUser: false, failedInstanceIds: [], threads: [],
};
const thread = { instanceId: 'writer-1', agentId: 'writer', agentLabel: 'Rédacteur', requests: [] };
const run: OperateRunInput = {
  scope, location: { kind: 'local' }, systemLabel: 'Articles', runName: 'October review', status: 'active',
  facts, threads: [thread], unlinkedRequests: [], stale: false, observedAtMs: 110,
};
const now = 150;
const question = humanFixture030({ content: { kind: 'question', question: '?', expectedResponse: '',
  answerContract: { kind: 'unavailable', gap: 'question-validator' } } });

it('shows open requests, failures and terminal unread runs, but treats ordinary agent completion as run activity', () => {
  expect(selectOperateInbox([run], {}, now).attention).toEqual([]);
  const needsAttention: OperateRunInput = { ...run, threads: [{ ...thread, requests: [question] },
    { ...thread, instanceId: 'other', reason: 'error' }] };
  expect(selectOperateInbox([needsAttention], {}, now).attention.map(item => item.reason)).toEqual(['question', 'error']);
  expect(selectOperateInbox([{ ...needsAttention, threads: [thread] }], {}, now).attention).toEqual([]);
  const finished: OperateRunInput = { ...run, status: 'succeeded', facts: { ...facts, finishedAtMs: 130 } };
  const unread = selectOperateInbox([finished], {}, now);
  expect(unread.attention).toMatchObject([{ kind: 'runAttention', reason: 'finished', elapsedMs: 20 }]);
  expect(unread.finished[0]?.unopened).toBe(true);
  expect(selectOperateInbox([{ ...finished, facts: { ...finished.facts!, opened: true } }], {}, now).attention).toEqual([]);
  expect(unread.scheduled).toEqual([]);
});

it('filters by system and accent-insensitive names while preserving hidden attention', () => {
  const hidden = () => new Set([thread.agentId]);
  const input = { ...run, threads: [{ ...thread, requests: [question] }] };
  const hits = selectOperateInbox([input], { query: ' REDACTEUR ' }, now, hidden);
  expect(hits.attention).toMatchObject([{ kind: 'thread', hidden: true }]);
  expect(hits.active).toEqual([]);
  const visible = selectOperateInbox([input], { query: 'october', showHidden: true }, now, hidden);
  expect(visible.active[0]?.threads).toMatchObject([{ hidden: true }]);
  expect(selectOperateInbox([input], { systemId: 'another' }, now).active).toEqual([]);
  expect(selectOperateInbox([input], { systemId: scope.source.owner.planId }, now).active).toHaveLength(1);
  expect(selectOperateInbox([input], { query: 'absent' }, now).attention).toEqual([]);
});

it('suppresses attention during a snooze and restores it on activity or expiry', () => {
  const saved: OperateThreadFacts = {
    instanceId: thread.instanceId, activity: 10, activityAtMs: 120,
    snoozedAtActivity: 10, snoozeUntilMs: 190, snoozedForRequest: true,
  };
  const approval = humanFixture030({ content: { kind: 'actionApproval', title: 'Apply?', actionJson: '{}' },
    clock: { kind: 'available', value: { openedAtMs: '0', observedAtMs: '10', timeoutMs: '75', works: [] } } });
  const input = { ...run, facts: { ...facts, threads: [saved] }, threads: [{ ...thread, requests: [approval] }] };
  const reported = selectOperateInbox([input], {}, now);
  expect(reported.attention).toEqual([]);
  expect(reported.snoozed).toHaveLength(1);
  expect(operateSnoozeDeadlineWarning(reported.snoozed[0], 190)).toBe(175);
  expect(operateSnoozeDeadlineWarning(reported.snoozed[0], 170)).toBeNull();
  expect(selectOperateInbox([input], {}, 190).attention.map(item => item.reason)).toEqual(['approval']);
  const woke = { ...input, facts: { ...facts, threads: [{ ...saved, activity: 11 }] } };
  expect(selectOperateInbox([woke], {}, now).attention.map(item => item.reason)).toEqual(['approval']);
  expect(selectOperateInbox([{ ...woke, threads: [thread] }], {}, now).attention).toEqual([]);
  const idle = { ...woke, threads: [thread], facts: { ...facts, threads: [{ ...saved, activity: 11, snoozedForRequest: false }] } };
  expect(selectOperateInbox([idle], {}, now).attention.map(item => item.reason)).toEqual(['activity']);
  expect(selectOperateInbox([{ ...idle, facts: { ...facts, threads: [{ ...saved, snoozedForRequest: false }] } }], {}, 190)
    .attention.map(item => item.reason)).toEqual(['snoozeElapsed']);
});

it('suppresses notifications only for mapped, effectively snoozed threads', () => {
  const base = inspectionFixture030();
  const instanceId = base.state.instances[0].id;
  const occurrence = base.state.occurrences.kind === 'ready' ? base.state.occurrences.value[0] : null;
  if (!occurrence) throw new Error('Missing activation');
  const run = { ...base, state: { ...base.state, occurrences: ready([{ ...occurrence,
    activation: { ...occurrence.activation, instanceId } }]) } };
  const mapped = mappedHuman(run);
  const request = { ...mapped, occurrences: [{ workId: mapped.workIds[0],
    activation: { kind: 'available' as const, scope: run.state.scope, activationId: occurrence.activation.id } }] };
  const snoozed = { ...run, inbox: { ...facts, threads: [{ instanceId, activity: 1, activityAtMs: 100,
    snoozeUntilMs: 200, snoozedAtActivity: 1, snoozedForRequest: true }] } };
  expect(isOperateRequestSnoozed(snoozed, request, 150)).toBe(true);
  expect(isOperateRequestSnoozed(snoozed, request, 200)).toBe(false);
  expect(isOperateRequestSnoozed(snoozed, { ...request, occurrences: [] }, 150)).toBe(false);
});

it('sorts recent work first and requires native Stop plus physical completion to report termination', () => {
  const newer = { ...run, scope: { ...scope, systemStartId: 'new' }, facts: { ...facts, startedAtMs: 140 } };
  expect(selectOperateInbox([run, newer], {}, now).active.map(item => item.startedAtMs)).toEqual([140, 100]);
  expect(operateRunStatus(null, '1', true, true)).toBe('stopping');
  expect(operateRunStatus('cancelled', '1', true, true)).toBe('stopping');
  expect(operateRunStatus('cancelled', '0', true, true)).toBe('terminated');
  expect(operateRunStatus('cancelled', '0', false, false)).toBe('failed');
  expect(operateRunStatus('failed', '0', false, true)).toBe('failed');
});
