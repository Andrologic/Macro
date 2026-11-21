import { afterEach, expect, it } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createWorkspaceSession, workspaceDefinitions } from '../../domains/shell/workspace';
import { resolveWorkspaceView } from '../../composition/workspaceViews';
import { configureWorkflowRunAccess030, getWorkflowRunAccess030, openWorkflowRun030, projectWorkflowAgentTasks030, workflowRunTargetSnapshot030 } from '../../services/workflowAgentTasks';
import { inspectionFixture030, monitorFixture030 } from '../../services/agsdl/runInspection030.testSupport';
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
  const sections = [...host.querySelectorAll('nav section')];
  expect(sections).toHaveLength(3);
  await act(async () => sections[2].querySelector('button')!.click());
  expect(workflowRunTargetSnapshot030()).toMatchObject({ scope: { systemStartId: 'run-empty' }, conversationId: scope.conversationId });
  await act(async () => sections[1].querySelectorAll('button')[1].click());
  expect(useAppStore.getState().selectedTaskId).toBe(tasks[1].id);
  expect(access.reads).toContain('run-2');
  expect(access.reads).not.toContain('run-1');
  expect(host.querySelector('details[open] button[aria-pressed=true]')?.textContent).toContain('worker');
});
