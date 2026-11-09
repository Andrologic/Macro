import { afterEach, expect, it } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ExecutionMonitor030 } from './ExecutionMonitor030';
import { available, ready, historyFixture030, humanFixture030, inspectionFixture030, monitorFixture030 } from '../../services/agsdl/runInspection030.testSupport';
import type { RunGraphBridge030 } from './RunInspector030';

let root: Root | undefined;
let host: HTMLDivElement;
afterEach(() => { act(() => root?.unmount()); host?.remove(); });
async function mount(access: ReturnType<typeof monitorFixture030>, props = {}) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(<ExecutionMonitor030 access={access} refreshIntervalMs={0} {...props} />));
}
async function click(text: string) {
  const button = [...host.querySelectorAll('button')].find(item => item.textContent?.includes(text));
  expect(button).toBeDefined(); await act(async () => button!.click());
}
it('opens only read access and keeps occurrence selection on a revision conflict and run switches', async () => {
  const run = inspectionFixture030(); const old = inspectionFixture030('run-old');
  const access = monitorFixture030(run, old); let bridge: RunGraphBridge030 | undefined;
  await mount(access, { currentSource: '{"current":"edited"}', renderGraph: (value: RunGraphBridge030) => { bridge = value; return null; } });
  expect(access.reads).toEqual(['history', 'run-current']);
  await act(async () => bridge!.selectStep('/flow/steps/review'));
  expect(bridge!.occurrences.filter(item => item.staticOccurrenceId === '/flow/steps/review')).toHaveLength(2);
  const second = bridge!.occurrences[1];
  await act(async () => bridge!.selectOccurrence(second.key));
  expect(host.textContent).toContain('Late work.');
  const stale = { kind: 'stale' as const, revision: '9', retained: run, refusal: { code: 'REVISION_CONFLICT' as const, message: 'Changed', currentRevision: '10' } };
  await act(async () => access.publish({ ...access.snapshot, runs: { ...access.snapshot.runs, 'run-current': stale } }));
  expect(host.textContent).toContain('Out-of-date data.');
  expect(bridge!.selectedOccurrenceKey).toBe(second.key);
  expect(host.textContent).toContain('Captured source');
  expect(host.textContent).toContain('Current document');
  await click('run-old'); await click('run-current');
  expect(bridge!.selectedOccurrenceKey).toBe(second.key);
  expect(bridge!.capture.authoredSource).toBe(run.capture.authoredSource);
  await act(async () => access.publish({ ...access.snapshot, history: { kind: 'loading', retained: [] } }));
  expect(bridge!.selectedOccurrenceKey).toBe(second.key);
  expect(host.textContent).toContain('Previously selected run');
});
it('does not pick the newest run before human waits across the full history are qualified', async () => {
  const run = inspectionFixture030(); const waiting = inspectionFixture030('run-waiting');
  const access = monitorFixture030(run, waiting);
  await act(async () => access.publish({ ...access.snapshot, history: { kind: 'loading', retained: [historyFixture030(run)] } }));
  await mount(access);
  expect(access.reads).toEqual(['history']);
  expect(host.textContent).toContain('Initial selection awaits');
  const human = humanFixture030(waiting);
  await act(async () => access.publish({ ...access.snapshot, history: ready([historyFixture030(run), { ...historyFixture030(waiting), humans: ready([human]) }]) }));
  expect(access.reads).toEqual(['history', 'run-waiting']);
  await click('run-current');
  await click('Refresh observations');
  expect(host.querySelector('button[aria-pressed="true"]')?.textContent).toContain('run-current');
});
it('keeps stop proof, physical work and final verdict independent and compares exact captures', async () => {
  const run = inspectionFixture030(); const old = inspectionFixture030('run-old');
  const changed = { ...old, capture: { ...old.capture, authoredSource: old.capture.authoredSource.replace('echo synthetic', 'echo earlier') } };
  const access = monitorFixture030(run, changed);
  await mount(access);
  expect(host.textContent).toContain('Run succeeded');
  expect(host.textContent).toContain('Stop uncertain');
  expect(host.textContent).toContain('Required agreement not reached');
  expect(host.textContent).toContain('Handled error');
  expect(host.querySelectorAll('button[type="submit"]')).toHaveLength(0);
  const select = host.querySelector('select')!;
  await act(async () => { select.value = 'run-old'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(host.textContent).toContain('The captured sources differ.');
  expect(host.textContent).toContain('Date unknown');
  await act(async () => access.publish({ ...access.snapshot, runs: { ...access.snapshot.runs, 'run-current': ready({ ...run, state: { ...run.state, verdict: 'failed', stop: available({ kind: 'stopped', requestId: 's', receiptId: 'receipt' }) } }) } }));
  expect(host.textContent).toContain('Run failed');
  expect(host.textContent).toContain('Stop confirmed');
});
it('never publishes a paginated occurrence subset as a complete fan-out', async () => {
  const run = inspectionFixture030(); const access = monitorFixture030({ ...run, state: { ...run.state, occurrences: { kind: 'loading', retained: null } } });
  await mount(access);
  expect(host.textContent).toContain('Partial pages do not describe all work.');
  expect(host.textContent).not.toContain('Recorded occurrences: 0');
  expect(host.textContent).not.toContain('No recorded occurrence');
  await act(async () => access.publish({ ...access.snapshot, runs: { 'run-current': ready(run) } }));
  expect(host.textContent).toContain('Recorded occurrences: 2');
});
it('uses only attested human occurrence mappings and retains unknown mappings', async () => {
  const run = inspectionFixture030(); const human = humanFixture030(run);
  const mapped = { ...human, workIds: ['activation-1', 'work-2'], occurrences: [
    { workId: 'activation-1', activation: { kind: 'unavailable' as const, gap: 'human-occurrence-mapping' as const } },
    { workId: 'work-2', activation: { kind: 'available' as const, scope: run.state.scope, activationId: 'activation-2' } },
  ] };
  const access = monitorFixture030({ ...run, state: { ...run.state, humans: ready([mapped]) } }); let bridge: RunGraphBridge030 | undefined;
  await mount(access, { renderGraph: (value: RunGraphBridge030) => { bridge = value; return null; } });
  expect(host.textContent).toContain('Occurrence association not available');
  await click('Waiting for a person · Review');
  expect(bridge!.selectedOccurrenceKey).toBe(bridge!.occurrences[1].key);
  expect(bridge!.selectedOccurrenceKey).not.toBe(bridge!.occurrences[0].key);
});
it('detaches read observation on unmount', async () => {
  const access = monitorFixture030(); await mount(access);
  const reads = access.reads.length;
  expect(access.listeners.size).toBe(1);
  await act(async () => root!.unmount()); root = undefined;
  expect(access.listeners.size).toBe(0);
  window.dispatchEvent(new Event('focus'));
  expect(access.reads).toHaveLength(reads);
});
