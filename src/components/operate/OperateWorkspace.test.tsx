import { afterEach, expect, it, spyOn } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createWorkspaceSession, workspaceDefinitions } from '../../domains/shell/workspace';
import { resolveWorkspaceView } from '../../composition/workspaceViews';
import { configureWorkflowRunAccess030, getWorkflowRunAccess030, loadWorkflowAgentTasks, openWorkflowRun030, projectWorkflowAgentTasks030, workflowAgentTaskId, workflowRunAccessSnapshot030, workflowRunTargetSnapshot030 } from '../../services/workflowAgentTasks';
import { inspectionFixture030, monitorFixture030 } from '../../services/agsdl/runInspection030.testSupport';
import { nativeAgentRunFixture030, nativeTransportFor030 } from '../../services/agsdl/runAccess030.testSupport';
import { createRunInspectionAccess030 } from '../../services/agsdl/runAccess030';
import { subscribeRunAttention030 } from '../notifications/WorkflowAttentionNotifications';
import { notify } from '../ui/toastService';
import i18n from '../../i18n';
import { installTauriRuntimeMock, removeTauriRuntimeMock } from '../../test-utils/tauriRuntime';
import type { RunHumanRequest030 } from '../../types/agsdlRunUi030';
import { services } from '../../services';
import { defaultDesign } from '../../services/agsdl/design';
import { buildImplementTaskCatalog } from '../../services/implementTaskCatalog';
import { createLoadImplementTaskCatalog } from '../../services/loadImplementTaskCatalog';
import type { ArchitectPlanRecord } from '../../services/architectPlanService';
import { useAppStore } from '../../stores/useAppStore';
import { useTaskStore } from '../../stores/useTaskStore';
import OperateCenter from './OperateCenter';
import OperateNavigator from './OperateNavigator';

let root: Root | undefined;
let host: HTMLDivElement;
const originalApp = useAppStore.getState();
const originalTasks = useTaskStore.getState();
afterEach(() => {
  act(() => root?.unmount()); host?.remove();
  configureWorkflowRunAccess030(undefined);
  openWorkflowRun030(null);
  useAppStore.setState(originalApp);
  useTaskStore.setState(originalTasks);
});

it('restores the Implement view, filters code tasks and opens the exact run and agent', async () => {
  const first = inspectionFixture030('run-1');
  const second = inspectionFixture030('run-2');
  const empty = inspectionFixture030('run-empty');
  const emptyRun = { ...empty, state: { ...empty.state, instances: [] } };
  const owner = first.capture.source.owner;
  const scope = { owner, conversationId: 'design-conversation' };
  const access = monitorFixture030(first, second, emptyRun);
  configureWorkflowRunAccess030(() => ({ access }));
  getWorkflowRunAccess030(scope);
  const plan = { id: owner.planId, targetBranch: owner.branch, projectId: owner.projectId, title: 'Review system', status: 'draft' } as ArchitectPlanRecord;
  const tasks = [first, second].flatMap(run => projectWorkflowAgentTasks030(plan, run));
  const legacy = { ...tasks[0], id: 'legacy', title: 'Legacy development task', task_source: 'standalone' as const, workflow_execution: undefined };
  useTaskStore.setState({ tasks: [legacy, ...tasks] });
  const project = { id: owner.projectId, name: 'Project' } as typeof originalApp.standaloneProjects[number];
  useAppStore.setState({ mode: 'Implement', selectedTaskId: legacy.id, standaloneProjects: [project], projectGroups: [] });
  const session = createWorkspaceSession(workspaceDefinitions.Implement, {
    agentType: 'build', taskId: legacy.id, projectId: project.id, groupId: null, conversationId: null, planId: null,
  });
  const view = resolveWorkspaceView(session, 'view.implement');
  expect(view?.label).toBe('Operate');
  expect(view?.panels.right).toBeUndefined();
  expect(await view!.panels.left!.load()).toBe(OperateNavigator);
  expect(await view!.panels.center!.load()).toBe(OperateCenter);

  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(<><OperateNavigator /><OperateCenter /></>));
  expect(host.textContent).not.toContain(legacy.title);
  const sections = [...host.querySelectorAll('nav[data-tour-id="operate-executions"] section')];
  expect(sections).toHaveLength(3);
  await act(async () => sections[2].querySelector('button')!.click());
  expect(workflowRunTargetSnapshot030()).toMatchObject({ scope: { systemStartId: 'run-empty' }, conversationId: scope.conversationId });
  await act(async () => sections[1].querySelectorAll('button')[1].click());
  expect(useAppStore.getState().selectedTaskId).toBe(tasks[1].id);
  expect(access.reads).toContain('run-2');
  expect(access.reads).not.toContain('run-1');
  expect(host.querySelector('details[open] button[aria-pressed=true]')?.textContent).toContain('worker');
});

it('discovers two runs and a later human request while Operate stays mounted', async () => {
  const first = await nativeAgentRunFixture030('first', 'running');
  const second = await nativeAgentRunFixture030('second', 'running');
  const { transport, calls, scope } = nativeTransportFor030(first, second);
  const plan: ArchitectPlanRecord = {
    id: scope.owner.planId, slug: 'workflow', title: 'Workflow', description: '', status: 'draft',
    targetBranch: scope.owner.branch, projectIds: [scope.owner.projectId], conversationId: scope.conversationId,
    createdAt: '', updatedAt: '', nodes: [], predictedBranches: [],
    agsdl: { revision: 1, source: first.capture.authoredSource, annexes: {}, design: {
      ...defaultDesign(), origin: { planId: 'blueprint', branchName: scope.owner.branch, name: 'Blueprint', revision: 1 },
    } },
  };
  const project = { id: scope.owner.projectId, name: 'Project' } as typeof originalApp.standaloneProjects[number];
  let plans: ArchitectPlanRecord[] = [];
  let runs: (typeof first)[] = [];
  let requested = false;
  let failSecond = false;
  transport.listExecutionRuns030 = async () => {
    calls.push('discovery');
    return { runs: runs.map(run => run.summary), nextCursor: null };
  };
  const readIntents = transport.readExecutionIntentsVersioned;
  transport.readExecutionIntentsVersioned = request => runs.length ? readIntents(request) : Promise.resolve([]);
  const readProjection = transport.readExecutionRuntimeProjection030;
  transport.readExecutionRuntimeProjection030 = (request, page) => {
    if (failSecond && request.systemStartId === second.scope.systemStartId) throw new Error('Projection offline');
    return readProjection(request, page);
  };
  const humanScope = { systemStartId: second.scope.systemStartId, source: second.scope.source };
  const human: RunHumanRequest030 = {
    scope: humanScope, id: 'human-second', revision: '1', workIds: ['activation-1'],
    occurrences: [{ workId: 'activation-1', activation: { kind: 'available', scope: second.scope, activationId: 'activation-1' } }],
    content: { kind: 'flowChoice', title: 'Continue?', description: '', messageJson: '{}', choices: ['continue'] },
    state: { kind: 'open' }, clock: { kind: 'unavailable', gap: 'human-clock-observation' },
  };
  transport.readExecutionHumans030 = async query => {
    const requests = requested && query.systemStartId === humanScope.systemStartId ? [{
      id: human.id, revision: human.revision, workIds: ['activation-1'], status: 'open' as const,
      content: { kind: 'plan' as const, plan: 'Continue?' }, flowJson: JSON.stringify(human),
    }] : [];
    return { scope: query, cursor: String(requests.length), requests, total: String(requests.length), nextPage: null };
  };
  configureWorkflowRunAccess030(candidate => ({
    access: createRunInspectionAccess030({ owner: candidate.owner, conversationId: candidate.conversationId! }, transport),
  }));
  const loadCatalog = createLoadImplementTaskCatalog({
    getAppState: () => useAppStore.getState(),
    listArchitectPlans: async () => ({ activePlanId: null, plans: plans.map(plan => ({ ...plan, hasAgsdl: true, nodeCount: 0 })) }),
    listArchitectPlanTargetBranches: async () => [scope.owner.branch],
    getArchitectPlan: async (_branch, id) => plans.find(plan => plan.id === id) ?? null,
    getGitFlowBaseBranch: () => scope.owner.branch,
    resolveTargetBranch: () => scope.owner.branch,
    buildImplementTaskCatalog,
    loadWorkflowAgentTasks: (plans, projects) => loadWorkflowAgentTasks(plans, projects, {
      runs: async () => { throw new Error('Operate must discover 0.3 runs through the shared access'); },
      snapshot: transport.readExecutionSnapshot030,
    }),
  });
  const list = spyOn(services, 'listTasks').mockImplementation(options => loadCatalog([], options));
  installTauriRuntimeMock();
  const timers = new Map<ReturnType<typeof setTimeout>, () => void>();
  let onScheduled: (() => void) | undefined;
  const schedule = globalThis.setTimeout;
  const scheduleSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
    if (delay !== 3000 || typeof callback !== 'function') return schedule(callback, delay, ...args);
    const id = schedule(() => {}, 60_000);
    timers.set(id, () => callback(...args));
    onScheduled?.();
    return id;
  }) as typeof setTimeout);
  const clearSpy = spyOn(globalThis, 'clearTimeout');
  const tick = async () => {
    expect(timers.size).toBe(1);
    const [id, callback] = timers.entries().next().value!;
    timers.delete(id);
    clearTimeout(id);
    await act(async () => {
      const finished = new Promise<void>(resolve => { onScheduled = resolve; });
      callback();
      await finished;
      onScheduled = undefined;
    });
  };
  useAppStore.setState({ mode: 'Chat', selectedTaskId: null, standaloneProjects: [project], projectGroups: [] });
  useTaskStore.setState({ tasks: [], isLoading: false });
  const stop = useTaskStore.getState().startAppSync();
  const attention = spyOn(notify, 'actionRequired').mockReturnValue('synthetic-attention');
  let stopAttention: (() => void) | undefined;
  try {
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    await act(async () => {
      useAppStore.setState({ mode: 'Implement' });
      root!.render(<><OperateNavigator /><OperateCenter /></>);
    });
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith({ persistedOnly: true });
    expect(host.querySelectorAll('nav section')).toHaveLength(0);
    expect(workflowRunAccessSnapshot030()).toHaveLength(0);
    plans = [plan];
    runs = [first];
    await tick();
    expect(host.querySelectorAll('nav section')).toHaveLength(1);
    expect(useTaskStore.getState().tasks.map(task => task.id)).toEqual([workflowAgentTaskId('first', 'native-instance')]);
    const registry = workflowRunAccessSnapshot030();
    stopAttention = subscribeRunAttention030(registry, i18n.getFixedT('en', 'agsdl'));

    runs.push(second);
    await tick();
    expect(workflowRunAccessSnapshot030()).toBe(registry);
    expect(host.querySelectorAll('nav section')).toHaveLength(2);
    expect(useTaskStore.getState().planSummaries[0]?.taskCount).toBe(2);
    expect(useTaskStore.getState().tasks.map(task => task.id)).toEqual([
      workflowAgentTaskId('first', 'native-instance'), workflowAgentTaskId('second', 'native-instance'),
    ]);

    requested = true;
    second.summary.revision = second.runtime.revision = '9007199254740994';
    const instance = second.runtime.items.find(item => item.kind === 'instance')!;
    if (instance.kind !== 'instance') throw new Error('Missing native instance');
    second.runtime.items.splice(1, 0, { kind: 'instance', value: {
      ...instance.value, id: 'other-instance', currentActivationId: null, discarded: true,
    } });
    second.runtime.total = '3';
    await tick();
    const firstId = workflowAgentTaskId('first', 'native-instance');
    const secondId = workflowAgentTaskId('second', 'native-instance');
    expect(useTaskStore.getState().getTaskById(firstId)?.workflow_execution?.interactionRequired).toBe(false);
    expect(useTaskStore.getState().getTaskById(secondId)?.workflow_execution?.interactionRequired).toBe(true);
    expect(useTaskStore.getState().getTaskById(workflowAgentTaskId('second', 'other-instance'))).toBeDefined();
    expect(attention).toHaveBeenCalledTimes(1);
    const actions = attention.mock.calls[0]?.[1].actions;
    expect(actions).toHaveLength(1);
    await act(async () => { await actions![0].onClick(); });
    expect(workflowRunTargetSnapshot030()).toEqual({ scope: humanScope, requestId: human.id, conversationId: scope.conversationId });
    expect(calls.filter(call => call === 'discovery')).toHaveLength(3);

    const secondRun = host.querySelectorAll('nav section')[1];
    await act(async () => secondRun.querySelector('button')!.click());
    expect(workflowRunTargetSnapshot030()).toEqual({ scope: second.scope, conversationId: scope.conversationId });
    await act(async () => secondRun.querySelectorAll('button')[1].click());
    expect(useAppStore.getState().selectedTaskId).toBe(secondId);
    expect(host.querySelector('details[open] button[aria-pressed=true]')?.textContent).toContain('worker');

    failSecond = true;
    await tick();
    expect(host.querySelector('nav [role=alert]')).not.toBeNull();
    expect(useTaskStore.getState().getTaskById(secondId)?.workflow_execution?.stale).toBe(true);
    expect(useTaskStore.getState().getTaskById(firstId)?.workflow_execution?.stale).toBeUndefined();
    expect(timers.size).toBe(1);
    const pendingTimer = timers.keys().next().value!;
    await act(async () => useAppStore.setState({ mode: 'Chat' }));
    expect(clearSpy).toHaveBeenCalledWith(pendingTimer);
  } finally {
    stopAttention?.();
    stop();
    await useTaskStore.getState().drainAppSync();
    scheduleSpy.mockRestore();
    clearSpy.mockRestore();
    list.mockRestore();
    attention.mockRestore();
    removeTauriRuntimeMock();
  }
});
