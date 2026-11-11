import { afterEach, expect, it } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CapturedRunGraph030 } from './CapturedRunGraph030';
import { inspectionFixture030 } from '../../services/agsdl/runInspection030.testSupport';
import { projectRunGraph030 } from '../../services/agsdl/runGraphProjection030';
import { projectStaticSemantics030 } from '../../services/agsdl/staticSemantics030';
import type { RunGraphBridge030 } from './RunInspector030';
let root: Root | undefined;
let host: HTMLDivElement;
afterEach(() => { act(() => root?.unmount()); host?.remove(); });
it('keeps a join and its physical barrier active without inventing uncertainty', async () => {
  const run = inspectionFixture030();
  if (run.state.occurrences.kind !== 'ready') throw new Error('Fixture occurrences unavailable');
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  for (const phase of ['group', 'barrier', 'unrecognized']) {
    const occurrence = { ...run.state.occurrences.value[0], activation: { ...run.state.occurrences.value[0].activation,
      step: ['vote'], phase, physical: false, stopRequested: false } };
    const bridge: RunGraphBridge030 = { capture: run.capture,
      occurrences: projectRunGraph030(run.state.scope, projectStaticSemantics030(run.capture.authoredSource), [occurrence]),
      occurrenceRead: { availability: 'ready', complete: true, revision: run.state.revision, stale: false, projectionAvailable: true },
      selectStep: () => {}, selectOccurrence: () => {} };
    await act(async () => root!.render(<CapturedRunGraph030 bridge={bridge} />));
    const join = [...host.querySelectorAll<HTMLButtonElement>('.agsdl-graph-node')].find(node => node.textContent?.includes('vote'))!;
    expect(join.querySelector('[role="img"]')?.getAttribute('aria-label')).toContain(phase === 'unrecognized' ? 'Uncertain' : 'Running');
  }
});
it('uses the captured source and native visit identity when the design has changed', async () => {
  const run = inspectionFixture030();
  const occurrences = run.state.occurrences.kind === 'ready' ? run.state.occurrences.value : [];
  const visits = projectRunGraph030(run.state.scope, projectStaticSemantics030(run.capture.authoredSource), occurrences);
  const selected: string[] = [];
  const bridge: RunGraphBridge030 = { capture: run.capture, occurrences: visits,
    occurrenceRead: { availability: 'ready', complete: true, revision: run.state.revision, stale: false, projectionAvailable: true },
    selectStep: id => { if (id) selected.push(id); }, selectOccurrence: key => { selected.push(key); } };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(<CapturedRunGraph030 bridge={bridge} currentSource='{"contract":"agsdl-0.3.0","id":"new-design","agents":{}}' />));
  expect(host.querySelector('[data-captured-run]')?.getAttribute('data-captured-run')).toBe(run.capture.systemStartId);
  expect(host.textContent).toContain('Captured graph differs from design');
  const review = [...host.querySelectorAll<HTMLButtonElement>('.agsdl-graph-node')].find(node => node.textContent?.includes('Review'))!;
  expect(review.textContent).not.toContain('activation-1');
  expect(review.textContent).not.toContain('/flow/steps/review');
  await act(async () => { review.click(); });
  const details = host.querySelector<HTMLButtonElement>('[aria-label="Component details"]')!;
  await act(async () => details.click());
  expect(selected).toEqual([visits[1].staticOccurrenceId!, visits[1].key]);
});
