import { expect, it } from 'bun:test';
import type { OperateThreadRow } from '../../services/operateInboxModel';
import {
  defaultOperateSnoozeInput, formatOperateElapsed, operateElapsed, operateSnoozeOptions, operateThreadState,
  parseOperateSnoozeInput, pruneOperateExpansion, visibleFinishedRuns,
} from './operateColumnModel';

const local = (...parts: [number, number, number, number, number]) => new Date(...parts).getTime();
const MINUTE = 60_000, HOUR = 60 * MINUTE;

it('keeps elapsed time to one short unit and calls anything under a minute "now"', () => {
  expect(operateElapsed(59_999)).toBeNull();
  expect(operateElapsed(12 * MINUTE + 5_000)).toEqual({ unit: 'minute', value: 12 });
  expect(operateElapsed(60 * MINUTE)).toEqual({ unit: 'hour', value: 1 });
  expect(operateElapsed(47 * HOUR + 59 * MINUTE)).toEqual({ unit: 'hour', value: 47 });
  expect(operateElapsed(72 * HOUR)).toEqual({ unit: 'day', value: 3 });
  expect(operateElapsed(-5)).toBeNull();
  expect(formatOperateElapsed(30_000, 'fr')).toBeNull();
  expect(formatOperateElapsed(3 * HOUR, 'fr')).toContain('3');
});

it('shows the five most recent finished runs, or all of them when asked or searching', () => {
  const runs = Array.from({ length: 8 }, (_, index) => index);
  expect(visibleFinishedRuns(runs, false, false)).toEqual({ shown: [0, 1, 2, 3, 4], older: 3 });
  expect(visibleFinishedRuns(runs, true, false)).toEqual({ shown: runs, older: 0 });
  expect(visibleFinishedRuns(runs, false, true)).toEqual({ shown: runs, older: 0 });
  expect(visibleFinishedRuns(runs.slice(0, 5), false, false).older).toBe(0);
});

it('forgets unfolded runs that no longer exist, never sections', () => {
  const kept = pruneOperateExpansion(['section:finished', 'run:a', 'run:gone'], new Set(['a']));
  expect(kept).toEqual(['section:finished', 'run:a']);
});

it('offers snooze choices that fit the moment of the day', () => {
  const monday10 = local(2026, 10, 23, 10, 0);
  const ids = (options: ReturnType<typeof operateSnoozeOptions>) => options.map(option => option.id);
  const plain = operateSnoozeOptions(monday10, null);
  expect(ids(plain)).toEqual(['hour', 'tonight', 'tomorrow', 'monday']);
  expect(plain.find(option => option.id === 'tonight')?.untilMs).toBe(local(2026, 10, 23, 18, 0));
  expect(plain.find(option => option.id === 'tomorrow')?.untilMs).toBe(local(2026, 10, 24, 9, 0));
  expect(plain.find(option => option.id === 'monday')?.untilMs).toBe(local(2026, 10, 30, 9, 0));
  expect(plain.some(option => option.warns)).toBe(false);
  // Too late for "this evening"; Monday is already tomorrow, so it is not offered twice.
  expect(ids(operateSnoozeOptions(local(2026, 10, 22, 17, 0), null))).toEqual(['hour', 'tomorrow']);
  expect(ids(operateSnoozeOptions(local(2026, 10, 26, 20, 0), null))).toEqual(['hour', 'tomorrow', 'monday']);
});

it('flags, never removes, choices that outlast an approval deadline', () => {
  const now = local(2026, 10, 23, 10, 0);
  const deadline = local(2026, 10, 23, 17, 0);
  const options = operateSnoozeOptions(now, deadline);
  expect(options[0]).toEqual({ id: 'beforeDeadline', untilMs: deadline - 30 * MINUTE, warns: false });
  expect(options.filter(option => option.warns).map(option => option.id)).toEqual(['tonight', 'tomorrow', 'monday']);
  expect(options.find(option => option.id === 'hour')?.warns).toBe(false);
  // Nothing sensible to propose just before an imminent deadline, but the others remain.
  const imminent = operateSnoozeOptions(now, now + 10 * MINUTE);
  expect(imminent.map(option => option.id)).not.toContain('beforeDeadline');
  expect(imminent.every(option => option.warns)).toBe(true);
});

it('defaults the custom date to tomorrow 09:00 and rejects incomplete input', () => {
  const input = defaultOperateSnoozeInput(local(2026, 10, 30, 22, 15));
  expect(input).toEqual({ date: '2026-12-01', time: '09:00' });
  expect(parseOperateSnoozeInput(input.date, input.time)).toBe(local(2026, 11, 1, 9, 0));
  expect(parseOperateSnoozeInput('', '09:00')).toBeNaN();
  expect(parseOperateSnoozeInput('2026-12-01', '')).toBeNaN();
});

it('describes a listed thread in words, never leaking the run-level "finished" motive', () => {
  const thread = (reason: OperateThreadRow['reason']) => ({ reason }) as OperateThreadRow;
  expect(operateThreadState(thread(undefined), false)).toBe('working');
  expect(operateThreadState(thread(undefined), true)).toBe('done');
  expect(operateThreadState(thread('question'), false)).toBe('question');
  expect(operateThreadState(thread('finished'), true)).toBe('done');
});
