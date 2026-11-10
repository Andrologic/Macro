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
  expect(host.textContent).toContain('No final verdict');
  expect(host.textContent).toContain('Stop uncertain');
  expect(host.textContent).toContain('Required agreement not reached');
  expect(host.textContent).toContain('Handled error');
  expect(host.querySelectorAll('button[type="submit"]')).toHaveLength(0);
  const select = host.querySelector('select')!;
  await act(async () => { select.value = 'run-old'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(host.textContent).toContain('The captured sources differ.');
  expect(host.textContent).toContain('Date unknown');
  await act(async () => access.publish({ ...access.snapshot, runs: { ...access.snapshot.runs, 'run-current': ready({ ...run, state: { ...run.state, verdict: 'cancelled', physicalPending: '0', occurrences: run.state.occurrences.kind === 'ready' ? ready(run.state.occurrences.value.map(item => ({ ...item, activation: { ...item.activation, phase: 'done', physical: false } }))) : run.state.occurrences,
    paths: run.state.paths.map(path => path.phase === 'live' ? { ...path, phase: 'withdrawn', memberships: path.memberships.map(item => ({ ...item, phase: 'withdrawn' })) } : path),
    stop: available({ kind: 'stopped', requestId: 's', receiptId: 'receipt' }) } }) } }));
  expect(host.textContent).toContain('Run cancelled');
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

it('ties diagnostics to attested visits, retains run-level facts and navigates to the cause', async () => {
  const run = inspectionFixture030();
  const base = run.state.diagnostics.kind === 'ready' ? run.state.diagnostics.value[0] : undefined;
  const diagnostics = [
    { ...base!, id: 'visit-one', message: 'First visit failed', causeId: 'visit-two', effectsJson: available('{"filesWritten":["report.txt"],"bytes":900719925474099312345}') },
    { ...base!, id: 'visit-two', activationId: 'activation-2', message: 'Second visit cause' },
    { ...base!, id: 'run-level', activationId: 'not-attested', message: 'Run-level issue' },
  ];
  const access = monitorFixture030({ ...run, state: { ...run.state, diagnostics: ready(diagnostics) } });
  let bridge: RunGraphBridge030 | undefined;
  await mount(access, { renderGraph: (value: RunGraphBridge030) => { bridge = value; return null; } });
  await act(async () => bridge!.selectOccurrence(bridge!.occurrences[0].key));
  const article = host.querySelector('[data-diagnostic-id="visit-one"]')!;
  expect(article.querySelector('button')?.textContent).toContain('Inspect this visit · Review · Visit 1');
  expect([...article.querySelectorAll('p')].map(p => p.textContent).join(' ')).toContain('Followed recovery step: vote');
  expect(article.querySelector('div')?.textContent).toContain('Second visit cause');
  expect([...article.querySelectorAll('dd')].map(dd => dd.textContent)).toEqual(['report.txt']);
  expect(article.querySelector('pre')?.textContent).toContain('900719925474099312345');
  expect(host.querySelector('[data-diagnostic-id="visit-two"]')).toBeNull();
  expect(host.querySelector('[data-diagnostic-id="run-level"]')?.textContent).toContain('No occurrence association is attested.');
  await click('Inspect the cause visit');
  expect(bridge!.selectedOccurrenceKey).toBe(bridge!.occurrences[1].key);
  expect(host.querySelector('[data-diagnostic-id="visit-one"]')).toBeNull();
  expect(host.querySelector('[data-diagnostic-id="visit-two"]')).not.toBeNull();
  expect(host.querySelector('[data-diagnostic-id="run-level"]')).not.toBeNull();
});

it('passes availability, completeness, revision and staleness to the graph, including outer conflicts', async () => {
  const run = inspectionFixture030();
  const access = monitorFixture030(run); let bridge: RunGraphBridge030 | undefined;
  await mount(access, { renderGraph: (value: RunGraphBridge030) => { bridge = value; return null; } });
  expect(bridge!.occurrenceRead).toEqual({ availability: 'ready', complete: true, revision: '9', stale: false, projectionAvailable: true });
  for (const [occurrences, expected] of [
    [{ kind: 'loading', retained: null }, { availability: 'loading', complete: false, revision: null, stale: false }],
    [{ kind: 'unavailable', gap: 'occurrence-details' }, { availability: 'unavailable', complete: false, revision: null, stale: false }],
    [ready([], '10'), { availability: 'ready', complete: true, revision: '10', stale: false }],
    [{ kind: 'stale', revision: '8', retained: [], refusal: { code: 'REVISION_CONFLICT', message: 'Changed', currentRevision: '9' } }, { availability: 'ready', complete: true, revision: '8', stale: true }],
  ] as const) {
    await act(async () => access.publish({ ...access.snapshot, runs: { 'run-current': ready({ ...run, state: { ...run.state, occurrences } }) } }));
    expect(bridge!.occurrences).toHaveLength(0);
    expect(bridge!.occurrenceRead).toEqual({ ...expected, projectionAvailable: true });
  }
  await act(async () => access.publish({ ...access.snapshot, runs: { 'run-current': { kind: 'stale', revision: '9', retained: run,
    refusal: { code: 'REVISION_CONFLICT', message: 'Changed', currentRevision: '10' } } } }));
  expect(bridge!.occurrenceRead).toMatchObject({ availability: 'ready', complete: true, revision: '9', stale: true });
  await act(async () => access.publish({ ...access.snapshot, runs: { 'run-current': { kind: 'loading', retained: run } } }));
  expect(bridge!.occurrenceRead).toMatchObject({ availability: 'loading', complete: false, revision: '9', stale: true });
});

it('explains the coexistence of a pending verdict, stopping work and a human wait', async () => {
  const run = inspectionFixture030(); const human = humanFixture030(run);
  await mount(monitorFixture030({ ...run, state: { ...run.state, humans: ready([human]) } }));
  expect(host.textContent).toContain('The flow has no final verdict yet. Some work is still stopping and its physical completion has not been confirmed. The stop remains uncertain. A person still needs to respond.');
  expect(host.querySelector('[title^="Physical completion"]')).not.toBeNull();
  expect(host.querySelector('[title^="The runtime host"]')).not.toBeNull();
  expect(host.querySelector('[title^="An occurrence"]')).not.toBeNull();
});

import i18n from '../../i18n';
it('covers every Intl plural category for zero, one, two and one million in all six locales', () => {
  const expected: Record<string, string[]> = {
    en: ['No recorded occurrences', 'Recorded occurrence: 1', 'Recorded occurrences: 2', 'Recorded occurrences: 1000000'],
    fr: ['Aucune occurrence', '1 occurrence', '2 occurrences', '1000000 occurrences'],
    es: ['Ninguna ocurrencia', '1 ocurrencia', '2 ocurrencias', '1000000 ocurrencias'],
    de: ['Keine Vorkommen', '1 Vorkommen', '2 Vorkommen', '1000000 Vorkommen'],
    ja: ['実行箇所なし', '1 件の実行箇所', '2 件の実行箇所', '1000000 件の実行箇所'],
    ko: ['실행 항목 없음', '실행 항목 1개', '실행 항목 2개', '실행 항목 1000000개'],
  };
  for (const [locale, labels] of Object.entries(expected)) {
    const t = i18n.getFixedT(locale, 'agsdl');
    const counts = [0, 1, 2, 1000000];
    const rules = new Intl.PluralRules(locale);
    expect([...new Set(counts.map(count => rules.select(count)))].sort()).toEqual(rules.resolvedOptions().pluralCategories.sort());
    for (const count of counts) expect(i18n.getResource(locale, 'agsdl', `agsdl.run030.occurrenceCount_${rules.select(count)}`)).toBeDefined();
    expect(counts.map(count => t('agsdl.run030.occurrenceCount', { count }))).toEqual(labels);
  }
});

it('uses the business handler title and readable known effects while keeping unknown fields folded', async () => {
  const run = inspectionFixture030();
  const base = run.state.diagnostics.kind === 'ready' ? run.state.diagnostics.value[0] : undefined;
  const capture = { ...run.capture, authoredSource: run.capture.authoredSource.replace('"vote":{"type":"join"', '"vote":{"title":"Réunir les avis","type":"join"') };
  await mount(monitorFixture030({ ...run, capture, state: { ...run.state, diagnostics: ready([
    { ...base!, effectsJson: available('{"filesWritten":["review.txt","report.txt"],"workContinues":true,"internalField":{"ticket":"opaque"}}') },
  ]) } }));
  const article = host.querySelector('[data-diagnostic-id="diagnostic-handled"]')!;
  expect([...article.querySelectorAll('p')].map(p => p.textContent).join(' ')).toContain('Followed recovery step: Réunir les avis');
  expect([...article.querySelectorAll('dt')].map(dt => dt.textContent)).toEqual(['Written files', 'Work continuation']);
  expect([...article.querySelectorAll('li')].map(li => li.textContent)).toEqual(['review.txt', 'report.txt']);
  expect([...article.querySelectorAll('dd')].map(dd => dd.textContent)).toEqual(['review.txtreport.txt', 'The work continues']);
  const technical = article.querySelector('details')!;
  expect(technical.open).toBe(false);
  expect(technical.textContent).toContain('internalField');
  const plain = article.cloneNode(true) as HTMLElement; plain.querySelectorAll('details').forEach(node => node.remove());
  expect(plain.textContent).not.toContain('internalField');
  expect(plain.textContent).not.toContain('filesWritten / 0');
});

it('clears the previous static filter when the graph selects external work and marks its row', async () => {
  const run = inspectionFixture030();
  const originals = run.state.occurrences.kind === 'ready' ? run.state.occurrences.value : [];
  const external = { ...originals[0], activation: { ...originals[0].activation, id: 'external-activation', step: null, agent: 'External reviewer' },
    details: originals[0].details.kind === 'available' ? available({ ...originals[0].details.value, occurrenceId: 'external-occurrence' }) : originals[0].details };
  const access = monitorFixture030({ ...run, state: { ...run.state, occurrences: ready([...originals, external]) } });
  let bridge: RunGraphBridge030 | undefined;
  await mount(access, { renderGraph: (value: RunGraphBridge030) => { bridge = value; return null; } });
  await act(async () => bridge!.selectStep('/flow/steps/review'));
  expect(bridge!.selectedStepId).toBe('/flow/steps/review');
  expect([...host.querySelectorAll('ol button')].some(button => button.textContent?.includes('External reviewer'))).toBe(false);
  const key = bridge!.occurrences.find(item => item.activationId === external.activation.id)!.key;
  await act(async () => bridge!.selectOccurrence(key));
  expect(bridge!.selectedStepId).toBeUndefined();
  expect(bridge!.selectedOccurrenceKey).toBe(key);
  expect(host.querySelector('ol button[aria-pressed="true"]')?.textContent).toContain('External reviewer');
});

it('shows the command exit code and complete text for a failed normal outcome', async () => {
  const run = inspectionFixture030();
  if (run.state.occurrences.kind !== 'ready') throw new Error('Fixture unavailable');
  const occurrences = run.state.occurrences.value.map(item => item.details.kind === 'available' ? { ...item, details: available({ ...item.details.value, outputJson: '{"outcome":"failed","data":{"exitCode":7,"output":"tests failed\\n<script>untrusted</script>"}}' }) } : item);
  let bridge: RunGraphBridge030 | undefined;
  await mount(monitorFixture030({ ...run, state: { ...run.state, occurrences: ready(occurrences) } }), { renderGraph: (value: RunGraphBridge030) => { bridge = value; return null; } });
  await act(async () => bridge!.selectOccurrence(bridge!.occurrences[0].key));
  expect(host.textContent).toContain('Exit code: 7');
  expect(host.textContent).toContain('tests failed');
  expect(host.textContent).toContain('<script>untrusted</script>');
  expect(host.querySelector('script')).toBeNull();
});
