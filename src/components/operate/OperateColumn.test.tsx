import { afterEach, beforeEach, expect, it, spyOn } from 'bun:test';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import i18n from '../../i18n';
import { inspectionFixture030 } from '../../services/agsdl/runInspection030.testSupport';
import type { OperateInboxFilter, OperateRunInput } from '../../services/operateInboxModel';
import { openWorkflowRun030, workflowRunTargetSnapshot030 } from '../../services/workflowAgentTasks';
import { installTauriRuntimeMock, removeTauriRuntimeMock } from '../../test-utils/tauriRuntime';
import type { OperateRunFacts } from '../../types/generated/ipc';
import { humanFixture030 } from '../agsdl/HumanRequests030.test-fixtures';
import { notify } from '../ui/toastService';
import { OperateColumn } from './OperateNavigator';
import { OPERATE_EXPANSION_STORAGE_KEY } from './useOperateExpansion';

const MINUTE = 60_000, HOUR = 60 * MINUTE;
const text = (key: string, values?: Record<string, unknown>) => i18n.t(`agsdl.inbox.${key}`, { ns: 'agsdl', ...values }) as string;

let root: Root | undefined;
let host: HTMLDivElement;
let now = Date.now();
beforeEach(() => { now = Date.now(); window.localStorage.clear(); });
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  document.querySelectorAll('[role="menu"], [role="dialog"]').forEach(node => node.remove());
  openWorkflowRun030(null);
  removeTauriRuntimeMock();
  window.localStorage.clear();
});

const facts = (over: Partial<OperateRunFacts> = {}): OperateRunFacts => ({
  opened: false, startedAtMs: now - HOUR, finishedAtMs: null, stoppedByUser: false, failedInstanceIds: [], threads: [], ...over,
});
function run(id: string, over: Partial<OperateRunInput> = {}, planId = 'sample-plan'): OperateRunInput {
  const base = inspectionFixture030(id).state.scope;
  return {
    scope: { ...base, source: { ...base.source, owner: { ...base.source.owner, planId } } },
    location: { kind: 'local' }, systemLabel: planId === 'sample-plan' ? 'Articles' : 'Veille', runName: `Run ${id}`,
    status: 'active', facts: facts(), threads: [], unlinkedRequests: [], stale: false, observedAtMs: now, ...over,
  };
}
const question = humanFixture030({ content: { kind: 'question', question: 'Which tone?', expectedResponse: '',
  answerContract: { kind: 'unavailable', gap: 'question-validator' } } });
/** An approval that expires 30 minutes after the run was observed. */
const approval = humanFixture030({ content: { kind: 'actionApproval', title: 'Apply?', actionJson: '{}' },
  clock: { kind: 'available', value: { openedAtMs: '0', observedAtMs: '0', timeoutMs: String(30 * MINUTE), works: [] } } });
const thread = (instanceId: string, agentLabel: string, over: Partial<OperateRunInput['threads'][number]> = {}) =>
  ({ instanceId, agentId: agentLabel.toLowerCase(), agentLabel, requests: [], ...over });

function Harness({ runs, initial = {}, ...rest }: { runs: readonly OperateRunInput[]; initial?: OperateInboxFilter;
  loading?: boolean; readFailed?: boolean; hidden?: string[] }) {
  const [filter, setFilter] = useState<OperateInboxFilter>(initial);
  const hidden = rest.hidden;
  return <OperateColumn runs={runs} filter={filter} nowMs={now} loading={rest.loading ?? false} readFailed={rest.readFailed ?? false}
    setFilter={setFilter} hiddenAgents={hidden ? () => new Set(hidden) : undefined} />;
}
async function mount(props: Parameters<typeof Harness>[0]) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(<Harness {...props} />));
}
const click = (element: Element | null | undefined) => act(async () => (element as HTMLElement).click());
const press = (element: Element, key: string) => act(async () => { element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); });
const typeInto = (input: HTMLInputElement, value: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
});
const section = (id: string) => host.querySelector<HTMLElement>(`[data-operate-section="${id}"]`);
const header = (id: string) => section(id)!.querySelector<HTMLButtonElement>('h3 button')!;
const rowTitles = (within: ParentNode) => [...within.querySelectorAll('[data-operate-row]')]
  .map(row => row.querySelector('.truncate')?.textContent);
const runTitles = () => [...host.querySelectorAll('[data-operate-run]')]
  .map(row => row.querySelector(':scope > button:not([aria-expanded]) .truncate')?.textContent);
const buttonByText = (within: ParentNode, label: string) => [...within.querySelectorAll<HTMLElement>('button, [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]')]
  .find(item => item.textContent?.trim() === label)!;
const menuItem = (label: string) => buttonByText(document.querySelector('[role="menu"]')!, label);
const rightClick = (element: Element) => act(async () => { element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); });

const fleet = () => [
  run('run-a', { threads: [thread('writer-1', 'Writer', { requests: [question] }), thread('rev-1', 'Reviewer')],
    facts: facts({ startedAtMs: now - 30 * MINUTE }) }),
  run('run-b', { facts: facts({ startedAtMs: now - 5 * MINUTE, threads: [{ instanceId: 'scribe-1', activity: 1, activityAtMs: now - 2 * MINUTE,
    snoozedAtActivity: 1, snoozeUntilMs: now + 3 * HOUR, snoozedForRequest: false }] }),
  threads: [thread('scribe-1', 'Scribe')] }, 'watch'),
  run('run-c', { status: 'succeeded', facts: facts({ startedAtMs: now - 2 * HOUR, finishedAtMs: now - 10 * MINUTE }) }),
];

it('orders the five sections, newest first, and folds the quiet ones by default', async () => {
  await mount({ runs: fleet() });
  expect([...host.querySelectorAll('[data-operate-section]')].map(node => node.getAttribute('data-operate-section')))
    .toEqual(['attention', 'active', 'snoozed', 'finished', 'scheduled']);
  // À traiter: the unread finished run (10 min) is newer than the open question (30 min); count is a warning badge.
  expect(rowTitles(section('attention')!)).toEqual(['Articles · Run run-c', 'Writer']);
  expect(section('attention')!.querySelector('h3')!.textContent).toContain('2');
  expect(section('attention')!.querySelector('h3 button')).toBeNull();
  // En cours is open, newest run first, runs folded; the other sections are folded.
  expect(header('active').getAttribute('aria-expanded')).toBe('true');
  expect(runTitles()).toEqual(['Veille · Run run-b', 'Articles · Run run-a']);
  expect(host.querySelector('[data-operate-open-thread][aria-label^="Reviewer"]')).toBeNull();
  for (const id of ['snoozed', 'finished', 'scheduled']) expect(header(id).getAttribute('aria-expanded')).toBe('false');
  expect(section('snoozed')!.querySelector('[data-operate-row]')).toBeNull();

  await click(header('snoozed'));
  await click(header('finished'));
  await click(header('scheduled'));
  expect(rowTitles(section('snoozed')!)).toEqual(['Scribe']);
  expect(section('snoozed')!.textContent).toContain(text('returns', { time: 'XYZ' }).replace('XYZ', '').trim());
  expect(runTitles()).toContain('Articles · Run run-c');
  expect(section('scheduled')!.textContent).toContain(text('scheduledEmpty'));
  expect(window.localStorage.getItem(OPERATE_EXPANSION_STORAGE_KEY)).toContain('section:finished');
});

it('hides Reportés and Terminés when empty and says so when nothing waits', async () => {
  await mount({ runs: [run('run-a', { threads: [thread('rev-1', 'Reviewer')] })] });
  expect(section('snoozed')).toBeNull();
  expect(section('finished')).toBeNull();
  expect(section('attention')!.textContent).toContain(text('nothingWaiting'));
  expect(section('scheduled')).not.toBeNull();
});

it('keeps a row to agent, motive, time and discreet markers, with two distinct click targets', async () => {
  const runs = [run('run-a', { location: { kind: 'remote', machineId: 'm1', label: 'Workshop' },
    threads: [thread('writer-1', 'Writer', { requests: [question] })], facts: facts({ startedAtMs: now - 30 * MINUTE }) })];
  await mount({ runs, hidden: ['writer'], initial: { showHidden: true } });
  const row = host.querySelector<HTMLElement>('[data-operate-row]')!;
  expect(row.textContent).toContain('Writer');
  expect(row.textContent).toContain('Articles · Run run-a');
  expect(row.textContent).toContain(text('reason.question'));
  expect(row.textContent).toContain('30');
  expect(row.textContent).toContain('Workshop');
  expect(row.textContent).toContain(text('hidden'));

  await click(buttonByText(row, 'Articles · Run run-a'));
  expect(workflowRunTargetSnapshot030()).toMatchObject({ scope: { systemStartId: 'run-a' } });
  expect(workflowRunTargetSnapshot030()).not.toHaveProperty('instanceId');
  openWorkflowRun030(null);
  await click(row.querySelector('[data-operate-open-thread]'));
  expect(workflowRunTargetSnapshot030()).toMatchObject({ scope: { systemStartId: 'run-a' }, instanceId: 'writer-1' });
});

it('marks a finished run as read from its menu and flags it as unread until then', async () => {
  const calls: unknown[] = [];
  installTauriRuntimeMock(async (command, input) => {
    if (command !== 'execution_update_operate_inbox') throw new Error(`Unexpected command ${command}`);
    calls.push(input);
  });
  const finished = run('run-c', { status: 'succeeded', facts: facts({ finishedAtMs: now - 10 * MINUTE }) });
  await mount({ runs: [finished] });
  const row = section('attention')!.querySelector<HTMLElement>('[data-operate-row]')!;
  expect(row.querySelector(`[aria-label="${text('unread')}"]`)).not.toBeNull();
  expect(row.querySelector('.font-semibold')).not.toBeNull();
  await click(header('finished'));
  expect(host.querySelector('[data-operate-run] [role="img"]')?.getAttribute('aria-label')).toBe(text('unread'));

  await rightClick(row);
  expect(menuItem(text('menu.openRun'))).toBeDefined();
  expect(document.querySelector('[role="menu"]')!.textContent).not.toContain(text('menu.snooze'));
  await click(menuItem(text('menu.markRead')));
  expect(calls).toEqual([{ systemStartId: finished.scope.systemStartId, snapshotId: finished.scope.snapshotId, action: { kind: 'markOpened' } }]);
});

it('searches thread and run names, expanding matches, and filters by system and hidden threads', async () => {
  const runs = [...fleet().slice(0, 2), run('run-e', { threads: [thread('x-1', 'Archivist')] }, 'watch')];
  await mount({ runs, hidden: ['reviewer'] });
  await click(host.querySelector(`button[aria-label="${text('search')}"]`));
  const input = host.querySelector<HTMLInputElement>('input[type="text"]')!;
  await typeInto(input, 'ARCHIVIST');
  expect(runTitles()).toEqual(['Veille · Run run-e']);
  expect(host.querySelector('[data-operate-run]')!.parentElement!.textContent).toContain('Archivist');
  expect(section('scheduled')).toBeNull();
  await typeInto(input, 'zzz');
  expect(host.textContent).toContain(text('noResultsQuery', { query: 'zzz' }));
  await press(input, 'Escape');
  expect(host.querySelector('input[type="text"]')).toBeNull();
  expect(runTitles()).toHaveLength(3);

  await click(host.querySelector(`button[aria-label="${text('filter')}"]`));
  await click(menuItem('Veille'));
  expect(runTitles()).toEqual(['Veille · Run run-b', 'Veille · Run run-e']);
  const chip = buttonByText(host, text('chipSystem', { name: 'Veille' }));
  await click(chip);
  expect(runTitles()).toHaveLength(3);

  // A hidden thread stays out of its run until the filter asks for it.
  const articles = [...host.querySelectorAll<HTMLElement>('[data-operate-run]')].find(row => row.textContent?.includes('Run run-a'))!;
  await click(articles.querySelector(':scope > button[aria-expanded]'));
  expect(articles.parentElement!.textContent).not.toContain('Reviewer');
  await click(host.querySelector(`button[aria-label="${text('filter')}"]`));
  await click(menuItem(text('showHidden')));
  expect(host.textContent).toContain(text('chipHidden'));
  expect(articles.parentElement!.textContent).toContain('Reviewer');
  expect(articles.parentElement!.textContent).toContain(text('hidden'));
});

it('offers quick snooze choices, flags the ones past an approval deadline and keeps them selectable', async () => {
  const calls: { action: { kind: string; instanceId: string; untilMs: number; forRequest: boolean } }[] = [];
  installTauriRuntimeMock(async (command, input) => {
    if (command !== 'execution_update_operate_inbox') throw new Error(`Unexpected command ${command}`);
    calls.push(input as never);
  });
  const toast = spyOn(notify, 'error');
  await mount({ runs: [run('run-d', { threads: [thread('ap-1', 'Approver', { requests: [approval] })] })] });
  expect(host.querySelector('[data-operate-row]')!.textContent).toContain(text('reason.approval'));
  await click(host.querySelector(`button[aria-label="${text('snooze')}"]`));
  const menu = document.querySelector('[role="menu"]')!;
  const hour = buttonByText(menu, text('snoozeMenu.hour'));
  expect(hour.getAttribute('title')).toContain(':');
  expect(hour.querySelectorAll('svg')).toHaveLength(2); // clock + warning
  expect(buttonByText(menu, text('snoozeMenu.custom')).querySelectorAll('svg')).toHaveLength(1);
  expect(menu.textContent).toContain(text('snoozeMenu.custom'));
  expect(menu.textContent).toContain(text('snoozeMenu.deadlineNote', { time: 'XYZ' }).split('XYZ')[0].trim());
  await click(hour);
  expect(calls).toHaveLength(1);
  expect(calls[0].action).toMatchObject({ kind: 'snooze', instanceId: 'ap-1', forRequest: true });
  expect(Math.abs(calls[0].action.untilMs - (Date.now() + HOUR))).toBeLessThan(5_000);
  expect(toast).not.toHaveBeenCalled();
  toast.mockRestore();
});

it('validates the custom snooze date and warns without blocking when an approval would expire', async () => {
  const calls: { action: { untilMs: number } }[] = [];
  installTauriRuntimeMock(async (command, input) => {
    if (command !== 'execution_update_operate_inbox') throw new Error(`Unexpected command ${command}`);
    calls.push(input as never);
  });
  await mount({ runs: [run('run-d', { threads: [thread('ap-1', 'Approver', { requests: [approval] })] })] });
  await click(host.querySelector(`button[aria-label="${text('snooze')}"]`));
  await click(menuItem(text('snoozeMenu.custom')));
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  const date = dialog.querySelector<HTMLInputElement>('input[type="date"]')!;
  const time = dialog.querySelector<HTMLInputElement>('input[type="time"]')!;
  const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(9, 0, 0, 0);
  const iso = (value: Date) => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  expect(date.value).toBe(iso(tomorrow));
  expect(time.value).toBe('09:00');
  expect(dialog.querySelector('[role="status"]')?.textContent).toContain(text('snoozeDialog.deadlineWarning', { time: 'XYZ' }).split('XYZ')[0].trim());

  const past = new Date(now - 2 * 24 * HOUR);
  await typeInto(date, iso(past));
  await click(buttonByText(dialog, text('snooze')));
  expect(dialog.querySelector('[role="alert"]')?.textContent).toBe(text('snoozeDialog.past'));
  expect(dialog.querySelector('[role="status"]')).toBeNull();
  expect(calls).toEqual([]);

  await typeInto(date, iso(tomorrow));
  await click(buttonByText(dialog, text('snooze')));
  expect(calls).toHaveLength(1);
  expect(calls[0].action.untilMs).toBe(tomorrow.getTime());
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it('terminates only after a confirmation that names the run, and keeps the dialog open on failure', async () => {
  let receipt: unknown = { kind: 'none', requestId: 'stop' };
  const stops: unknown[] = [];
  installTauriRuntimeMock(async (command, input) => {
    if (command !== 'execution_stop') throw new Error(`Unexpected command ${command}`);
    stops.push(input);
    return receipt;
  });
  const active = run('run-a', { threads: [thread('writer-1', 'Writer', { requests: [question] })] });
  await mount({ runs: [active, run('run-c', { status: 'succeeded', facts: facts({ finishedAtMs: now - MINUTE, opened: true }) })] });
  await click(header('finished'));
  const rows = [...host.querySelectorAll<HTMLElement>('[data-operate-run]')];
  await click(rows[1].querySelector('button[aria-haspopup="menu"]'));
  expect(document.querySelector('[role="menu"]')!.textContent).not.toContain(text('menu.terminate'));
  await click(rows[0].querySelector('button[aria-haspopup="menu"]'));
  await click(menuItem(text('menu.terminate')));
  expect(stops).toEqual([]);
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(dialog.textContent).toContain('Articles · Run run-a');
  expect(dialog.textContent).toContain(text('terminateDialog.waiting'));
  await click(buttonByText(dialog, text('terminateDialog.confirm')));
  expect(stops).toHaveLength(1);
  expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toBe(text('terminateDialog.failed'));

  receipt = { kind: 'confirmed', requestId: 'stop' };
  await click(buttonByText(document.querySelector('[role="dialog"]')!, text('terminateDialog.confirm')));
  expect(stops).toHaveLength(2);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it('shows only the five latest finished runs until the older ones are asked for', async () => {
  const finished = Array.from({ length: 7 }, (_, index) => run(`done-${index}`, { status: 'succeeded',
    facts: facts({ opened: true, finishedAtMs: now - (index + 1) * HOUR }) }));
  await mount({ runs: finished });
  await click(header('finished'));
  expect(runTitles()).toEqual(finished.slice(0, 5).map(item => `Articles · ${item.runName}`));
  expect(header('finished').textContent).toContain('7');
  await click(buttonByText(section('finished')!, text('showOlder', { count: 2 })));
  expect(runTitles()).toHaveLength(7);
});

it('says what is happening when there is nothing to list', async () => {
  await mount({ runs: [], loading: true });
  expect(host.querySelector('[role="status"]')?.getAttribute('aria-label')).toBe(i18n.t('agsdl.run030.loading', { ns: 'agsdl' }));
  await act(async () => root!.render(<Harness runs={[]} readFailed />));
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(i18n.t('agsdl.run030.readFailed', { ns: 'agsdl' }));
  expect(host.textContent).toContain(text('emptyTitle'));
  expect(host.textContent).toContain(text('emptyHint'));
});

it('explains an empty filtered view and clears the filters from there', async () => {
  await mount({ runs: [run('run-a')], initial: { systemId: 'another-plan', showHidden: true } });
  expect(host.textContent).toContain(text('noResultsFilters'));
  expect(host.textContent).toContain(text('chipSystem', { name: 'another-plan' }));
  await click(buttonByText(host, text('clearFilters')));
  expect(host.textContent).not.toContain(text('noResultsFilters'));
  expect(runTitles()).toEqual(['Articles · Run run-a']);
});

it('folds with the arrow keys and restores what was unfolded on the next visit', async () => {
  await mount({ runs: [run('run-a', { threads: [thread('rev-1', 'Reviewer')] })] });
  const chevron = host.querySelector<HTMLButtonElement>('[data-operate-run] > button[aria-expanded]')!;
  expect(chevron.getAttribute('aria-expanded')).toBe('false');
  await press(chevron, 'ArrowRight');
  expect(chevron.getAttribute('aria-expanded')).toBe('true');
  await press(chevron, 'ArrowRight');
  expect(chevron.getAttribute('aria-expanded')).toBe('true');
  await press(header('active'), 'ArrowLeft');
  expect(header('active').getAttribute('aria-expanded')).toBe('false');

  act(() => root!.unmount()); host.remove();
  await mount({ runs: [run('run-a', { threads: [thread('rev-1', 'Reviewer')] })] });
  expect(section('active')).not.toBeNull();
  expect(header('active').getAttribute('aria-expanded')).toBe('false');
  await click(header('active'));
  expect(host.querySelector<HTMLButtonElement>('[data-operate-run] > button[aria-expanded]')!.getAttribute('aria-expanded')).toBe('true');
});
