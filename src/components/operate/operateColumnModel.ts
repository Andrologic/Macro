import type { IconName } from '../ui/Icon';
import type { OperateReason, OperateRunStatus, OperateThreadRow } from '../../services/operateInboxModel';

/**
 * Presentation rules of the Operate left column. Classification itself stays in
 * `selectOperateInbox`; this module only decides how a classified row looks and
 * which shortcuts a gesture offers, so both can be tested without rendering.
 */

export type OperateTone = 'amber' | 'orange' | 'red' | 'emerald' | 'primary' | 'muted';
export const operateToneClass: Record<OperateTone, string> = {
  amber: 'text-amber-500',
  orange: 'text-orange-500',
  red: 'text-red-500',
  emerald: 'text-emerald-500',
  primary: 'text-primary',
  muted: 'text-muted-foreground',
};

export interface OperatePresentation { icon: IconName; tone: OperateTone }

/** One icon and one colour per motive; the word always accompanies them. */
export const operateReasonPresentation: Record<OperateReason, OperatePresentation> = {
  question: { icon: 'message-circle-question', tone: 'amber' },
  approval: { icon: 'shield', tone: 'amber' },
  interrupted: { icon: 'triangle-alert', tone: 'orange' },
  error: { icon: 'circle-x', tone: 'red' },
  finished: { icon: 'check-circle', tone: 'emerald' },
  activity: { icon: 'bell', tone: 'primary' },
  snoozeElapsed: { icon: 'clock', tone: 'primary' },
  snoozed: { icon: 'clock', tone: 'muted' },
};

export const operateRunPresentation: Record<OperateRunStatus, OperatePresentation & { spin?: boolean }> = {
  active: { icon: 'loader', tone: 'primary', spin: true },
  paused: { icon: 'pause', tone: 'amber' },
  interrupted: { icon: 'triangle-alert', tone: 'orange' },
  stopping: { icon: 'loader', tone: 'amber', spin: true },
  succeeded: { icon: 'check-circle', tone: 'emerald' },
  terminated: { icon: 'square', tone: 'muted' },
  failed: { icon: 'circle-x', tone: 'red' },
};

/** Words used for a thread listed under its run. */
export type OperateThreadState = 'working' | 'done' | 'question' | 'approval' | 'interrupted'
  | 'error' | 'snoozed' | 'activity' | 'snoozeElapsed';
export function operateThreadState(thread: OperateThreadRow, runFinished: boolean): OperateThreadState {
  const reason = thread.reason === 'finished' ? undefined : thread.reason;
  return reason ?? (runFinished ? 'done' : 'working');
}

export type OperateElapsed = { unit: 'minute' | 'hour' | 'day'; value: number } | null;
/** Short durations only: a fresh minute rounds down, so "now" is anything under one minute. */
export function operateElapsed(ms: number): OperateElapsed {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return null;
  if (minutes < 60) return { unit: 'minute', value: minutes };
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? { unit: 'hour', value: hours } : { unit: 'day', value: Math.floor(hours / 24) };
}

/** `null` stands for "less than a minute"; the caller supplies the localized words. */
export function formatOperateElapsed(ms: number, locale: string | undefined): string | null {
  const parts = operateElapsed(ms);
  return parts && new Intl.NumberFormat(locale, { style: 'unit', unit: parts.unit, unitDisplay: 'short' }).format(parts.value);
}

/** Terminated runs keep the five most recent visible; searching shows every match. */
export const OPERATE_FINISHED_PAGE = 5;
export function visibleFinishedRuns<T>(runs: readonly T[], showAll: boolean, searching: boolean): { shown: readonly T[]; older: number } {
  if (showAll || searching || runs.length <= OPERATE_FINISHED_PAGE) return { shown: runs, older: 0 };
  return { shown: runs.slice(0, OPERATE_FINISHED_PAGE), older: runs.length - OPERATE_FINISHED_PAGE };
}

// ── Expansion memory ────────────────────────────────────────────────────
export type OperateSectionId = 'active' | 'snoozed' | 'finished' | 'scheduled';
export const operateSectionExpansionId = (section: OperateSectionId) => `section:${section}`;
export const operateRunExpansionId = (runKey: string) => `run:${runKey}`;
const MAX_REMEMBERED_RUNS = 200;
/** Forget runs that no longer exist so the preference cannot grow without bound. */
export function pruneOperateExpansion(expanded: readonly string[], knownRunKeys: ReadonlySet<string>): string[] {
  const kept = expanded.filter(id => !id.startsWith('run:') || knownRunKeys.has(id.slice(4)));
  const sections = kept.filter(id => id.startsWith('section:'));
  return [...sections, ...kept.filter(id => id.startsWith('run:')).slice(-MAX_REMEMBERED_RUNS)];
}

// ── Snooze ──────────────────────────────────────────────────────────────
export type OperateSnoozeChoice = 'hour' | 'beforeDeadline' | 'tonight' | 'tomorrow' | 'monday';
export interface OperateSnoozeOption { id: OperateSnoozeChoice; untilMs: number; warns: boolean }

const MINUTE = 60_000;
const atLocalTime = (base: Date, dayOffset: number, hours: number, minutes = 0) =>
  new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayOffset, hours, minutes).getTime();

/**
 * Quick choices of the Reporter menu. Nothing is forbidden: a choice that
 * outlasts an approval deadline is only flagged (`warns`), and a first choice
 * that ends just before the deadline is proposed when there is room for it.
 */
export function operateSnoozeOptions(nowMs: number, deadlineMs: number | null): OperateSnoozeOption[] {
  const now = new Date(nowMs);
  const flagged = (id: OperateSnoozeChoice, untilMs: number): OperateSnoozeOption =>
    ({ id, untilMs, warns: deadlineMs !== null && deadlineMs <= untilMs });
  const options: OperateSnoozeOption[] = [];
  if (deadlineMs !== null) {
    const safe = deadlineMs - 30 * MINUTE;
    if (safe > nowMs + 5 * MINUTE) options.push(flagged('beforeDeadline', safe));
  }
  options.push(flagged('hour', nowMs + 60 * MINUTE));
  const tonight = atLocalTime(now, 0, 18);
  if (tonight - nowMs >= 90 * MINUTE) options.push(flagged('tonight', tonight));
  options.push(flagged('tomorrow', atLocalTime(now, 1, 9)));
  const untilMonday = (8 - now.getDay()) % 7 || 7;
  if (untilMonday > 1) options.push(flagged('monday', atLocalTime(now, untilMonday, 9)));
  return options;
}

const pad = (value: number) => String(value).padStart(2, '0');
/** Default of the custom date dialog: tomorrow 09:00, as `type="date"` / `type="time"` values. */
export function defaultOperateSnoozeInput(nowMs: number): { date: string; time: string } {
  const tomorrow = new Date(atLocalTime(new Date(nowMs), 1, 9));
  return { date: `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}`, time: '09:00' };
}
/** `NaN` when either field is empty or malformed. */
export function parseOperateSnoozeInput(date: string, time: string): number {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date), clock = /^(\d{2}):(\d{2})$/.exec(time);
  if (!day || !clock) return Number.NaN;
  return new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]), Number(clock[1]), Number(clock[2])).getTime();
}
