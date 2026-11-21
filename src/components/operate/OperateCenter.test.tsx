import { afterEach, expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createHumanRequestClient030 } from '../../services/agsdl/humanRequests030';
import { humanFixture030, inspectionFixture030, monitorFixture030, ready } from '../../services/agsdl/runInspection030.testSupport';
import type { ArchitectPlanRecord } from '../../services/architectPlanService';
import { configureWorkflowRunAccess030, getWorkflowRunAccess030, openWorkflowRun030, projectWorkflowAgentTasks030, workflowRunTargetSnapshot030 } from '../../services/workflowAgentTasks';
import { useAppStore } from '../../stores/useAppStore';
import { useTaskStore } from '../../stores/useTaskStore';
import { memoryDraftStorage030 } from '../agsdl/HumanRequests030.test-fixtures';
import OperateCenter from './OperateCenter';

let root: Root | undefined;
let host: HTMLDivElement;
const originalApp = useAppStore.getState();
const originalTasks = useTaskStore.getState();
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  configureWorkflowRunAccess030(undefined);
  openWorkflowRun030(null);
  useAppStore.setState(originalApp);
  useTaskStore.setState(originalTasks);
});

it('isolates flow exchanges and native human requests by instance before opening the run', async () => {
  const run = inspectionFixture030('isolated-flow');
  const scope = run.state.scope;
  const [original] = run.state.instances;
  const first = { ...original, id: 'instance-first' };
  const second = { ...original, id: 'instance-second' };
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
  const inspection = { ...run, state: { ...run.state, stopping: false, instances: [first, second],
    occurrences: ready([{ ...a, activation: firstActivation }, { ...b, activation: secondActivation }]),
    humans: ready([firstRequest, secondRequest, unlinked, wrongCapture]) } };
  const access = monitorFixture030(inspection);
  const snapshot = access.getSnapshot();
  access.publish({ ...snapshot, history: { kind: 'error', error: { code: 'TRANSPORT', message: 'History unavailable' } } });
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
  await act(async () => root!.render(<OperateCenter />));
  const trace = () => host.querySelector('section[aria-label="Instance exchanges"]')!;
  const button = (label: string, parent: ParentNode = host) => [...parent.querySelectorAll('button')].find(item => item.textContent === label)!;
  const requests = () => [...host.querySelectorAll<HTMLElement>('[data-human-request]')].map(item => item.dataset.humanRequest);
  expect(trace().textContent).toContain('First mission');
  expect(trace().textContent).toContain('First final text');
  expect(trace().textContent).toContain('First resource');
  expect(trace().textContent).not.toContain('Second final text');
  expect(trace().querySelector('textarea')).toBeNull();
  expect(requests()).toEqual(['first-request']);
  expect(host.textContent).toContain('Some requests cannot be linked');
  await act(async () => button('View related step 1', host.querySelector('[data-human-request="first-request"]')!).click());
  expect(host.querySelector('button[aria-pressed=true]')?.textContent).toContain('first-step');
  await act(async () => button('Approve', host.querySelector('[data-human-request="first-request"]')!).click());
  expect(submit).toHaveBeenCalledWith({ scope: firstRequest.scope, requestId: firstRequest.id, expectedRevision: firstRequest.revision,
    answer: { kind: 'decision', decision: 'yes', comment: '' } });
  expect(workflowRunTargetSnapshot030()).toBeNull();

  await act(async () => useAppStore.setState({ selectedTaskId: tasks[1].id }));
  expect(trace().textContent).toContain('Second final text');
  expect(trace().textContent).not.toContain('First mission');
  expect(trace().textContent).not.toContain('First final text');
  expect(requests()).toEqual(['second-request']);
  await act(async () => access.publish(snapshot));
  await act(async () => button('Open run inspector').click());
  expect(workflowRunTargetSnapshot030()).toEqual({ scope: firstRequest.scope, conversationId });
});
