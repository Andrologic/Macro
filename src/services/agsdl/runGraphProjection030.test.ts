import { expect, it } from 'bun:test';
import { projectStaticSemantics030 } from './staticSemantics030';
import { validateDocumentBytes } from './document';
import { normalRunOutcome030, projectRunGraph030, runOccurrenceKey030 } from './runGraphProjection030';
import { available, inspectionFixture030 } from './runInspection030.testSupport';

it('keeps native activation and occurrence identities separate from source ownership and revisions', () => {
  const { capture, state } = inspectionFixture030();
  expect(validateDocumentBytes(new TextEncoder().encode(capture.authoredSource)).valid).toBe(true);
  const semantics = projectStaticSemantics030(capture.authoredSource);
  const occurrences = state.occurrences.kind === 'ready' ? state.occurrences.value : [];
  const graph = projectRunGraph030(state.scope, semantics, occurrences);
  expect(graph.map(item => item.staticOccurrenceId)).toEqual(['/flow/steps/review', '/flow/steps/review']);
  expect(graph.map(item => item.activationId)).toEqual(['activation-1', 'activation-2']);
  expect(graph.map(item => item.nativeOccurrenceId)).toEqual(['native-visit-0', 'native-visit-1']);
  expect(graph[0].key).not.toBe(graph[1].key);
  expect(graph[0].occurrence.activation.instanceId).toBeNull();
  const otherCapture = { ...occurrences[0], scope: { ...state.scope, snapshotId: 'another-capture' } };
  expect(projectRunGraph030(state.scope, semantics, [otherCapture])).toEqual([]);
  expect(runOccurrenceKey030(otherCapture)).not.toBe(graph[0].key);
  expect(normalRunOutcome030(occurrences[0])).toBe('failed');
  expect(state.verdict).toBeNull();
});
it('matches expanded composition addresses instead of merging a shared source pointer', () => {
  const run = inspectionFixture030();
  const source = JSON.stringify({ contract: 'agsdl-0.3.0', id: 'nested', agents: {}, flow: { entry: 'first', steps: {
    first: { type: 'compose', composition: 'part', agents: {}, next: { done: 'second' } },
    second: { type: 'compose', composition: 'part', agents: {}, next: { done: [] } },
  } }, compositions: { part: { parameters: [], entry: 'work', steps: { work: { type: 'call', command: 'echo synthetic', next: { output: 'done' } } }, outputs: ['done'] } } });
  expect(validateDocumentBytes(new TextEncoder().encode(source)).valid).toBe(true);
  const originals = run.state.occurrences.kind === 'ready' ? run.state.occurrences.value : [];
  const visits = originals.map((occurrence, index) => ({ ...occurrence, activation: { ...occurrence.activation, step: [index === 0 ? 'first' : 'second', 'work'] },
    details: occurrence.details.kind === 'available' ? available({ ...occurrence.details.value, sourcePointer: '/compositions/part/steps/work' }) : occurrence.details }));
  const projected = projectRunGraph030(run.state.scope, projectStaticSemantics030(source), visits);
  expect(new Set(projected.map(item => item.staticOccurrenceId)).size).toBe(2);
  expect(new Set(projected.map(item => item.sourcePointer)).size).toBe(1);
  expect(projected.map(item => item.occurrence)).toEqual(visits);
});
it('preserves unmapped external work and unavailable details without inventing an agent or visit', () => {
  const run = inspectionFixture030();
  const occurrence = run.state.occurrences.kind === 'ready' ? run.state.occurrences.value[0] : undefined;
  const external = { ...occurrence!, activation: { ...occurrence!.activation, step: null }, details: { kind: 'unavailable' as const, gap: 'occurrence-details' as const } };
  const graph = projectRunGraph030(run.state.scope, projectStaticSemantics030(run.capture.authoredSource), [external]);
  expect(graph[0].staticOccurrenceId).toBeNull();
  expect(graph[0].nativeOccurrenceId).toBeNull();
  expect(graph[0].occurrence.activation.agent).toBeNull();
  expect(normalRunOutcome030(external)).toBeNull();
});

it('keeps the inspection double consistent with context-derived paths and an unfinished physical stop', () => {
  const { capture, state } = inspectionFixture030();
  const document = JSON.parse(capture.authoredSource);
  const occurrences = state.occurrences.kind === 'ready' ? state.occurrences.value : [];
  expect(state.verdict).toBeNull();
  expect(state.stopping).toBe(true);
  expect(state.physicalPending).toBe(String(occurrences.filter(item => item.activation.physical).length));
  for (const { activation } of occurrences) {
    const pathIds = activation.context.flatMap(frame => frame.kind === 'path' ? [frame.pathId] : []);
    expect(activation.pathIds).toEqual(pathIds);
    const fanout = state.groups.flatMap(group => group.branches).find(branch => branch.fanout && branch.pathIds.includes(pathIds[0]));
    expect(activation.nearestFanoutIndex).toBe(fanout ? String(fanout.pathIds.indexOf(pathIds[0])) : null);
    if (activation.physical) expect(activation).toMatchObject({ phase: 'stopping', stopRequested: true });
  }
  for (const path of state.paths) {
    if (path.context.length === 0) expect(path.nearestFanoutIndex).toBeNull();
  }
  for (const instance of state.instances) {
    expect(Object.hasOwn(document.agents, instance.agent)).toBe(true);
    expect(instance.selectorKind).toBe(document.flow.steps.prepare.instance);
    expect(instance.selectorName).toBeNull();
    expect(instance.discarded).toBe(true);
    expect(instance.currentActivationId).toBeNull();
  }
});
