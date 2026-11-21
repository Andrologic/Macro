import { afterEach, expect, it } from 'bun:test';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import i18n from '../../i18n';
import { createRunInspectionAccess030 } from '../../services/agsdl/runAccess030';
import { fixture, transportFor } from '../../services/agsdl/runAccess030.testSupport';
import type { RunInspectionAccess030, RunReadFailure030 } from '../../services/agsdl/runtimeProjection030';
import { ready } from '../../services/agsdl/runInspection030.testSupport';
import { ExecutionMonitor030 } from './ExecutionMonitor030';
import { RunHistory030 } from './RunHistory030';

let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(async () => {
  await act(async () => { root?.unmount(); await i18n.changeLanguage('en'); });
  root = undefined; host?.remove(); host = undefined;
});
async function render(node: ReactNode) {
  if (!host) { host = document.createElement('div'); document.body.append(host); root = createRoot(host); }
  await act(async () => root!.render(node));
}

it('shows a translated middle-run failure through the real adapter, monitor and history, then shows all three failures', async () => {
  await i18n.changeLanguage('fr');
  const fixtures = await Promise.all(['a', 'b', 'c'].map(id => fixture(id)));
  const { transport, scope } = transportFor(...fixtures);
  const nativeRead = transport.readExecutionRunCorrelation030;
  const failures = new Map<string, string>([['b', 'NOT_FOUND']]);
  transport.readExecutionRunCorrelation030 = async (query, id) => {
    const code = failures.get(id);
    if (code) throw { code, currentIntentKey: null };
    return nativeRead(query, id);
  };
  // Use the public monitor contract, not the concrete adapter's richer type.
  const access: RunInspectionAccess030 = createRunInspectionAccess030(scope, transport);
  await render(<ExecutionMonitor030 access={access} initialRunId="a" refreshIntervalMs={0} />);
  await act(async () => { await access.refreshHistory(); });
  const history = () => host!.querySelector('section[aria-label="Historique des exécutions"]')!;
  const rows = () => [...history().querySelectorAll('li[data-run-id]')];
  expect(rows()).toHaveLength(3);
  expect(rows().map(row => row.getAttribute('data-run-id'))).toEqual(['a', 'b', 'c']);
  expect(history().querySelector('[data-run-id="b"]')?.textContent).toContain('Exécution introuvable');
  expect(history().querySelector('[data-run-id="a"] button')).not.toBeNull();
  const healthyButton = history().querySelector('[data-run-id="c"] button') as HTMLButtonElement;
  expect(healthyButton).not.toBeNull();
  await act(async () => healthyButton.click());
  await act(async () => { await access.refreshRun('c'); });
  expect(history().querySelector('[data-run-id="c"] button')?.getAttribute('aria-pressed')).toBe('true');
  expect(access.getSnapshot().runs.c.kind).toBe('ready');
  expect(history().textContent).not.toContain('Aucune exécution dans ce périmètre');
  expect(history().textContent).not.toContain('NOT_FOUND');

  // Native discovery can also order ids differently from lexical ordering.
  transport.listExecutionRuns030 = async () => ({ runs: [...fixtures].reverse().map(f => f.summary), nextCursor: null });
  await act(async () => { await access.refreshHistory(); });
  expect(rows().map(row => row.getAttribute('data-run-id'))).toEqual(['c', 'b', 'a']);
  transport.listExecutionRuns030 = async () => ({ runs: fixtures.map(f => f.summary), nextCursor: null });

  failures.set('a', 'NOT_FOUND'); failures.set('b', 'STORAGE_UNCERTAIN'); failures.set('c', 'STORAGE_UNCERTAIN');
  for (const f of fixtures) { f.summary.revision = '9007199254740994'; f.runtime.revision = f.summary.revision; }
  await act(async () => { await access.refreshHistory(); });
  expect(rows()).toHaveLength(3);
  expect(rows().map(row => row.getAttribute('data-run-id'))).toEqual(['a', 'b', 'c']);
  expect(history().querySelectorAll('[data-run-read-state="failed"]')).toHaveLength(3);
  expect(history().querySelector('[data-run-id="a"]')?.textContent).toContain('Exécution introuvable');
  for (const id of ['b', 'c']) expect(history().querySelector(`[data-run-id="${id}"]`)?.textContent).toContain("L'état du stockage est incertain.");
  expect(history().textContent).not.toContain('Aucune exécution dans ce périmètre');
  expect(history().textContent).not.toContain('STORAGE_UNCERTAIN');
  expect(access.getSnapshot().history).toMatchObject({ kind: 'ready', value: [] });
});

it('renders each real history failure row in all six languages and restores the true empty state after recovery', async () => {
  const labels = {
    en: ['Run not found', 'The storage state is uncertain.'],
    fr: ['Exécution introuvable', "L'état du stockage est incertain."],
    es: ['Ejecución no encontrada', 'El estado del almacenamiento es incierto.'],
    de: ['Ausführung nicht gefunden', 'Der Zustand des Speichers ist ungewiss.'],
    ja: ['実行が見つかりません', 'ストレージの状態が不確かです。'],
    ko: ['실행을 찾을 수 없습니다', '저장소 상태가 불확실합니다.'],
  };
  const runFailures: Record<string, RunReadFailure030> = {
    a: { kind: 'notFound', code: 'NOT_FOUND', message: 'Private native diagnostic', revision: '1' },
    b: { kind: 'uncertain', code: 'STORAGE_UNCERTAIN', message: 'Private native diagnostic', revision: '1' },
    c: { kind: 'notFound', code: 'NOT_FOUND', message: 'Private native diagnostic', revision: '1' },
  };
  for (const [locale, [notFound, uncertain]] of Object.entries(labels)) {
    await act(async () => { await i18n.changeLanguage(locale); });
    await render(<RunHistory030 history={ready([])} historyOrder={['a', 'b', 'c']} runFailures={runFailures} select={() => {}} compare={() => {}} />);
    expect(host!.querySelectorAll('li[data-run-id]')).toHaveLength(3);
    expect(host!.querySelector('[data-run-id="a"]')?.textContent).toContain(notFound);
    expect(host!.querySelector('[data-run-id="b"]')?.textContent).toContain(uncertain);
    expect(host!.textContent).not.toContain(i18n.getFixedT(locale, 'agsdl')('agsdl.run030.noRuns'));
    expect(host!.textContent).not.toContain('Private native diagnostic');
    expect(host!.textContent).not.toContain('NOT_FOUND');
    expect(host!.textContent).not.toContain('STORAGE_UNCERTAIN');
  }
  await render(<RunHistory030 history={ready([])} historyOrder={[]} runFailures={{}} select={() => {}} compare={() => {}} />);
  expect(host!.querySelectorAll('li[data-run-id]')).toHaveLength(0);
  expect(host!.textContent).toContain(i18n.t('agsdl.run030.noRuns', { ns: 'agsdl' }));
});
