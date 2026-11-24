import { afterEach, expect, it, mock, spyOn } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createHumanRequestClient030, humanRequestKey030 } from '../../services/agsdl/humanRequests030';
import { notifiedHumanRequests030 } from '../../services/agsdl/humanAttention030';
import { humanFixture030, inspectionFixture030, monitorFixture030, ready } from '../../services/agsdl/runInspection030.testSupport';
import type { ArchitectPlanRecord } from '../../services/architectPlanService';
import { configureWorkflowRunAccess030, getWorkflowRunAccess030, openWorkflowRun030, projectWorkflowAgentTasks030, staleWorkflowTask, workflowRunTargetSnapshot030 } from '../../services/workflowAgentTasks';
import { useAppStore } from '../../stores/useAppStore';
import { useTaskStore } from '../../stores/useTaskStore';
import { installTauriRuntimeMock, removeTauriRuntimeMock } from '../../test-utils/tauriRuntime';
import { memoryDraftStorage030 } from '../agsdl/HumanRequests030.test-fixtures';
import { WorkflowAttentionNotifications } from '../notifications/WorkflowAttentionNotifications';
import { notify } from '../ui/toastService';
import OperateCenter from './OperateCenter';

let root: Root | undefined;
let host: HTMLDivElement;
const originalApp = useAppStore.getState();
const originalTasks = useTaskStore.getState();
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  notifiedHumanRequests030.clear();
  configureWorkflowRunAccess030(undefined);
  openWorkflowRun030(null);
  useAppStore.setState(originalApp);
  useTaskStore.setState(originalTasks);
  removeTauriRuntimeMock();
});

async function mountInstances({ graphless = false, withInspector = false } = {}) {
  const run = inspectionFixture030('isolated-flow');
  const scope = run.state.scope;
  const [original] = run.state.instances;
  const first = { ...original, id: 'instance-first', selectorKind: 'named', selectorName: 'first inbox', discarded: false };
  const second = { ...first, id: 'instance-second', selectorName: 'second inbox' };
  if (run.state.occurrences.kind !== 'ready') throw new Error('Fixture unavailable');
  const [a, b] = run.state.occurrences.value;
  const firstActivation = { ...a.activation, step: ['first-step'], agent: first.agent, instanceId: first.id,
    message: { sequence: '1', delivery: 'queue', sender: 'prepare', messageJson: '{"prompt":"First mission","resources":{"sample":{"value":"First resource"}}}', statuses: ['sent', 'delivered'], targetActivationId: null },
    workText: 'First final text' };
  const secondActivation = { ...b.activation, step: ['second-step'], agent: second.agent, instanceId: second.id, workText: 'Second final text' };
  const relatedRequest = (id: string, activationId: string) => ({ ...humanFixture030(run), id, workIds: [`work-${id}`],
    occurrences: [{ workId: `work-${id}`, activation: { kind: 'available' as const, scope, activationId } }] });
  const firstRequest = relatedRequest('first-request', firstActivation.id);
  const secondRequest = relatedRequest('second-request', secondActivation.id);
  const unlinked = { ...humanFixture030(run), id: 'unlinked', workIds: [firstActivation.id],
    occurrences: [{ workId: firstActivation.id, activation: { kind: 'unavailable' as const, gap: 'human-occurrence-mapping' as const } }] };
  const wrongCapture = { ...firstRequest, id: 'wrong-capture', occurrences: firstRequest.occurrences.map(link =>
    ({ ...link, activation: { ...link.activation, scope: { ...scope, snapshotId: 'other-capture' } } })) };
  const capture = graphless ? { ...run.capture,
    authoredSource: '{"contract":"agsdl-0.3.0","id":"inboxes","agents":{"worker":{"harness":"example","permissions":"read-only"}}}' } : run.capture;
  const inspection = { capture, state: { ...run.state, stopping: false, instances: [first, second],
    occurrences: ready([{ ...a, activation: firstActivation }, { ...b, activation: secondActivation }]),
    humans: ready([firstRequest, secondRequest, unlinked, wrongCapture]) } };
  const access = monitorFixture030(inspection);
  const read = mock(async () => ({ ...firstRequest, revision: '2' }));
  const submit = mock(async () => ({ kind: 'refused' as const,
    refusal: { code: 'INPUT_CONSTRAINT' as const, message: 'Synthetic refusal', currentRevision: null } }));
  const humanClient = createHumanRequestClient030({ read, submit, storage: memoryDraftStorage030() });
  const owner = run.capture.source.owner;
  const conversationId = 'source-conversation';
  configureWorkflowRunAccess030(() => ({ access, humanClient }));
  getWorkflowRunAccess030({ owner, conversationId });
  const plan = { id: owner.planId, projectId: owner.projectId, targetBranch: owner.branch, title: 'Sample plan' } as ArchitectPlanRecord;
  const tasks = projectWorkflowAgentTasks030(plan, inspection);
  useTaskStore.setState({ tasks });
  useAppStore.setState({ selectedTaskId: tasks[0].id });

  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<>{withInspector && <WorkflowAttentionNotifications />}<OperateCenter /></>));
  return { access, inspection, tasks, read, submit, firstRequest, secondRequest, conversationId };
}

const card = (id: string, parent: ParentNode = host) => parent.querySelector<HTMLElement>(`[data-human-request="${id}"]`);
const trace = () => host.querySelector('section[aria-label="Instance exchanges"]')!;
const button = (label: string, parent: ParentNode = host) => [...parent.querySelectorAll('button')].find(item => item.textContent === label)!;
const requests = (parent: ParentNode = host) => [...parent.querySelectorAll<HTMLElement>('[data-human-request]')].map(item => item.dataset.humanRequest);
const dialog = () => document.body.querySelector<HTMLElement>('[role="dialog"]')!;

async function draftMessage() {
  const message = trace().querySelector('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(message, 'A new message');
    message.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(button('Send', trace()).disabled).toBe(false);
  return message;
}

it('isolates flow exchanges and native human requests by instance before opening the run', async () => {
  const { access, inspection, tasks, submit, firstRequest, conversationId } = await mountInstances({ withInspector: true });
  await act(async () => access.publish({ ...access.snapshot, history: { kind: 'error', error: { code: 'TRANSPORT', message: 'History unavailable' } } }));
  expect(trace().textContent).toContain('First mission');
  expect(trace().textContent).toContain('First final text');
  expect(trace().textContent).toContain('First resource');
  expect(trace().textContent).not.toContain('Second final text');
  expect(trace().querySelector('textarea')).toBeNull();
  expect(requests()).toEqual(['first-request']);
  expect(host.textContent).toContain('Some requests cannot be linked');
  await act(async () => button('View related step 1', card('first-request')!).click());
  expect(host.querySelector('button[aria-pressed=true]')?.textContent).toContain('first-step');
  await act(async () => button('Approve', card('first-request')!).click());
  expect(submit).toHaveBeenCalledWith({ scope: firstRequest.scope, requestId: firstRequest.id, expectedRevision: firstRequest.revision,
    answer: { kind: 'decision', decision: 'yes', comment: '' } });
  expect(workflowRunTargetSnapshot030()).toBeNull();

  await act(async () => useAppStore.setState({ selectedTaskId: tasks[1].id }));
  expect(trace().textContent).toContain('Second final text');
  expect(trace().textContent).not.toContain('First mission');
  expect(trace().textContent).not.toContain('First final text');
  expect(requests()).toEqual(['second-request']);
  await act(async () => button('Open run inspector').click());
  expect(workflowRunTargetSnapshot030()).toEqual({ scope: firstRequest.scope, conversationId });
  expect(dialog().querySelector('[aria-label="Run status"]')?.textContent).toContain(inspection.state.scope.snapshotId);
  expect(requests(dialog())).toEqual(['first-request', 'second-request', 'unlinked', 'wrong-capture']);
});

it('keeps the reassigned request on B after navigating and remounting A', async () => {
  const { access, read, submit, tasks, firstRequest, secondRequest } = await mountInstances({ withInspector: true });
  const reassigned = { ...firstRequest, revision: '2', content: { kind: 'plan' as const, plan: 'Second instance revision' },
    occurrences: secondRequest.occurrences.map(link => ({ ...link, workId: firstRequest.workIds[0] })) };
  read.mockResolvedValue(reassigned);
  await act(async () => button('Read current status', card(firstRequest.id)!).click());
  expect(read).toHaveBeenCalledWith({ scope: firstRequest.scope, requestId: firstRequest.id });
  expect(requests()).toEqual([]);
  expect(host.textContent).not.toContain('Second instance revision');

  await act(async () => useAppStore.setState({ selectedTaskId: tasks[1].id }));
  expect(card(firstRequest.id)?.textContent).toContain('Second instance revision');
  expect(button('Approve', card(firstRequest.id)!).disabled).toBe(false);
  expect(trace().textContent).toContain('Second final text');
  read.mockResolvedValue(firstRequest);
  await act(async () => button('Read current status', card(firstRequest.id)!).click());
  expect(card(firstRequest.id)?.textContent).toContain('Second instance revision');

  await act(async () => useAppStore.setState({ selectedTaskId: tasks[0].id }));
  await act(async () => access.publish({ ...access.snapshot }));
  const remainingCard = card(firstRequest.id);
  if (remainingCard) await act(async () => button('Approve', remainingCard).click());
  expect(submit).not.toHaveBeenCalled();
  expect(requests()).toEqual([]);
  expect(trace().textContent).toContain('First final text');

  await act(async () => button('Open run inspector').click());
  expect(card(firstRequest.id, dialog())?.textContent).toContain('Second instance revision');
  expect(button('Approve', card(firstRequest.id, dialog())!).disabled).toBe(false);
});

it('keeps a notification focused on its exact request without an available history', async () => {
  const notification = spyOn(notify, 'actionRequired').mockReturnValue('test');
  try {
    const { access, firstRequest, secondRequest } = await mountInstances({ withInspector: true });
    const action = notification.mock.calls.find(([, options]) => options?.notificationKey === `human030:${humanRequestKey030(secondRequest)}`)?.[1]?.actions?.[0];
    expect(action).toBeDefined();

    await act(async () => access.publish({ ...access.snapshot, history: { kind: 'error', error: { code: 'TRANSPORT', message: 'History unavailable' } } }));
    await act(async () => action!.onClick());
    await act(async () => { await new Promise(resolve => requestAnimationFrame(resolve)); });
    expect(requests(dialog())).toContain(firstRequest.id);
    expect((document.activeElement as HTMLElement).dataset.humanRequest).toBe(secondRequest.id);
    expect(dialog().contains(document.activeElement)).toBe(true);
    const other = inspectionFixture030('other-run');
    const otherRequest = { ...humanFixture030(other), id: secondRequest.id,
      content: { kind: 'plan' as const, plan: 'A different run with the same request ID' } };
    const otherSnapshot = monitorFixture030({ ...other, state: { ...other.state, humans: ready([otherRequest]) } }).snapshot;
    await act(async () => access.publish({ ...access.snapshot, history: otherSnapshot.history, runs: { ...access.snapshot.runs, ...otherSnapshot.runs } }));
    expect(requests(dialog())).toContain(firstRequest.id);
    expect(dialog().textContent).not.toContain('A different run with the same request ID');
    const otherButton = dialog().querySelector<HTMLButtonElement>('[data-run-id="other-run"] button')!;
    await act(async () => otherButton.click());
    expect(otherButton.getAttribute('aria-pressed')).toBe('true');
    await act(async () => action!.onClick());
    await act(async () => { await new Promise(resolve => requestAnimationFrame(resolve)); });
    expect(dialog().textContent).not.toContain('A different run with the same request ID');
    expect(requests(dialog())).toContain(firstRequest.id);
    expect((document.activeElement as HTMLElement).dataset.humanRequest).toBe(secondRequest.id);
  } finally { notification.mockRestore(); }
});

it('keeps both instance views scoped and read-only when the run becomes stale', async () => {
  const { access, inspection, tasks, submit, firstRequest, secondRequest } = await mountInstances({ graphless: true });
  const message = await draftMessage();
  expect(button('Approve', card(firstRequest.id)!).disabled).toBe(false);

  await act(async () => access.publish({ ...access.snapshot, runs: { [inspection.capture.systemStartId]: {
    kind: 'stale', retained: inspection, revision: inspection.state.revision,
    refusal: { code: 'REVISION_CONFLICT', message: 'The runtime changed', currentRevision: '10' },
  } } }));
  expect(button('Send', trace()).disabled).toBe(true);
  expect(message.readOnly).toBe(true);
  for (const [index, request, own, foreign] of [
    [0, firstRequest, 'First final text', 'Second final text'],
    [1, secondRequest, 'Second final text', 'First final text'],
  ] as const) {
    if (index === 1) await act(async () => useAppStore.setState({ selectedTaskId: tasks[1].id }));
    expect(trace().textContent).toContain(own);
    expect(trace().textContent).not.toContain(foreign);
    expect(requests()).toEqual([request.id]);
    const approve = button('Approve', card(request.id)!);
    expect(approve.disabled).toBe(true);
    expect(button('View related step 1', card(request.id)!).disabled).toBe(true);
    await act(async () => approve.click());
  }
  expect(submit).not.toHaveBeenCalled();
});

for (const source of ['history', 'task'] as const) {
  it(`keeps a ready run's instance actions read-only when only its ${source} is stale`, async () => {
    const invoke = mock(async (_command: string) => undefined);
    installTauriRuntimeMock(invoke);
    const { access, tasks, submit, inspection, firstRequest } = await mountInstances({ graphless: true });
    const message = await draftMessage();
    expect(button('Approve', card(firstRequest.id)!).disabled).toBe(false);

    const { history } = access.snapshot;
    if (history.kind !== 'ready') throw new Error('Expected ready history');
    await act(async () => {
      if (source === 'history') access.publish({
        ...access.snapshot,
        history: { kind: 'stale', revision: history.revision, retained: history.value,
          refusal: { code: 'NOT_FOUND', message: 'Discovery failed', currentRevision: null } },
      });
      else useTaskStore.setState({ tasks: [staleWorkflowTask(tasks[0]), tasks[1]] });
    });

    expect(access.snapshot.runs[inspection.capture.systemStartId].kind).toBe('ready');
    expect(trace().textContent).toContain('First final text');
    expect(message.readOnly).toBe(true);
    const approve = button('Approve', card(firstRequest.id)!);
    const send = button('Send', trace());
    expect(approve.disabled).toBe(true);
    expect(send.disabled).toBe(true);
    await act(async () => { approve.click(); send.click(); });
    expect(submit).not.toHaveBeenCalled();
    expect(invoke.mock.calls.some(([command]) => command === 'execution_deliver030')).toBe(false);

    await act(async () => {
      access.publish({ ...access.snapshot, history });
      useTaskStore.setState({ tasks });
    });
    expect(approve.disabled).toBe(false);
    expect(send.disabled).toBe(false);
  });
}

it('keeps freshly published history and run actions available when the intent read fails', async () => {
  const { access, firstRequest } = await mountInstances({ graphless: true });
  const message = await draftMessage();
  const failIntent = async () => {
    access.publish({ ...access.snapshot, retainedAdmission: { kind: 'unavailable', gap: 'qualification' } });
    throw new Error('Intent read failed after publication');
  };
  access.onHistory = failIntent;
  access.onRun = failIntent;
  await act(async () => button('Refresh observations').click());
  expect(host.textContent).toContain('Read failed.');
  expect(trace().textContent).toContain('First final text');
  expect(message.readOnly).toBe(false);
  expect(button('Approve', card(firstRequest.id)!).disabled).toBe(false);
  expect(button('Send', trace()).disabled).toBe(false);
});
