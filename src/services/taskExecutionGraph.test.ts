import { afterEach, expect, it, mock } from 'bun:test';
import { installTauriRuntimeMock, removeTauriRuntimeMock } from '../test-utils/tauriRuntime';
import { createExampleDocument } from './agsdl/examples';
import { projectViewer } from './agsdl/viewer';
import { loadTaskExecutionGraph } from './taskExecutionGraph';
import type { CatalogedImplementTask } from './implementTaskCatalog';

const task = { id: 'task', plan_id: 'plan', project_id: 'project', plan_storage_branch: 'main', plan_title: 'Workflow', title: 'Same label' } as CatalogedImplementTask;
const source = { owner: { projectId: 'project', planId: 'plan', branch: 'main' }, revision: '1', sourceSha256: 'hash' };
const authoredSource = createExampleDocument('feature').source;
const path = projectViewer(authoredSource).graphs[0].cards.find(card => card.kind === 'agent')!.path;
const snapshot = (id: string) => ({ systemStartId: id, source, authoredSource, associations: {}, versions: {} });
afterEach(removeTauriRuntimeMock);

it('opens the exact native Agent run directly, without historical Task hints or latest-run guessing', async () => {
  const { workflowTaskFixture } = await import('./workflowAgentTasks.fixtures');
  const { projectWorkflowAgentTasks } = await import('./workflowAgentTasks');
  const f = await workflowTaskFixture();
  const tasks = projectWorkflowAgentTasks(f.plan, f.snapshot, f.projection, []);
  const seen: string[] = [];
  installTauriRuntimeMock(mock(async command => {
    seen.push(command);
    if (command === 'execution_read_snapshot') return f.snapshot;
    if (command === 'execution_read_projection') return f.projection;
    if (command === 'execution_pending_approvals') return { approvals: [], incomplete: false };
    throw new Error(`Unexpected ${command}`);
  }));
  const graph = await loadTaskExecutionGraph(tasks[0], tasks);
  expect(graph?.selectedPath).toBe('/flow/steps/work');
  expect(graph?.taskPaths['/agents/worker']).toBe(tasks[0].id);
  expect(graph?.taskPaths['/flow/steps/work']).toBe(tasks[0].id);
  expect(graph?.taskPaths['/agents/reviewer']).toBe(tasks[1].id);
  expect(seen).toEqual(['execution_read_snapshot', 'execution_read_projection', 'execution_pending_approvals']);
});

it('opens only an exact historical task association, including a run on the next page', async () => {
  const seen: string[] = [];
  installTauriRuntimeMock(mock(async (command, args) => {
    seen.push(command);
    if (command === 'execution_list_runs') return args?.request.after ? { runs: [{ systemStartId: 'matching', source }], nextCursor: null } : { runs: [{ systemStartId: 'unrelated', source }], nextCursor: 'next' };
    if (command === 'execution_read_snapshot') return snapshot(String(args?.systemStartId));
    if (command === 'execution_resolve_card_task') return args?.request.systemStartId === 'matching' && args.request.path === path ? { taskId: 'task', projectId: 'project', planId: 'plan', branch: 'main' } : null;
    if (command === 'execution_read_projection') return { systemStartId: 'matching', source, agents: [], activations: [], nextPage: null, cursor: '0', systemStop: { kind: 'none' } };
    if (command === 'execution_pending_approvals') return { approvals: [], incomplete: false };
    throw new Error(command);
  }));
  const result = await loadTaskExecutionGraph(task, [task]);
  expect(result?.selectedPath).toBe(path);
  expect(result?.taskPaths[path]).toBe('task');
  expect(String(result?.snapshot?.systemStartId)).toBe('matching');
  expect(result?.source).toBe(authoredSource);
  expect(seen.filter(command => command === 'execution_list_runs')).toHaveLength(2);
  expect(seen.every(command => command.startsWith('execution_read') || command === 'execution_list_runs' || command === 'execution_resolve_card_task' || command === 'execution_pending_approvals')).toBe(true);
});

it('does not substitute the latest blueprint or a task with the same display title', async () => {
  installTauriRuntimeMock(mock(async (command, args) => {
    if (command === 'execution_list_runs') return { runs: [{ systemStartId: 'run', source }], nextCursor: null };
    if (command === 'execution_read_snapshot') return snapshot('run');
    if (command === 'execution_resolve_card_task') return args?.request.path === path ? { taskId: 'other', projectId: 'project', planId: 'plan', branch: 'main' } : null;
    throw new Error(command);
  }));
  expect(await loadTaskExecutionGraph(task, [task, { ...task, id: 'other' }])).toBeNull();
});

it('rejects a snapshot from another scope and stops discovery after closing the dialog', async () => {
  installTauriRuntimeMock(mock(async (command) => {
    if (command === 'execution_list_runs') return { runs: [{ systemStartId: 'run', source }], nextCursor: null };
    if (command === 'execution_read_snapshot') return { ...snapshot('run'), source: { ...source, owner: { ...source.owner, projectId: 'other' } } };
    throw new Error(command);
  }));
  await expect(loadTaskExecutionGraph(task, [task])).rejects.toThrow('Execution scope differs');
  const controller = new AbortController();
  const invoke = mock(async () => { controller.abort(); return { runs: [{ systemStartId: 'run', source }], nextCursor: null }; });
  installTauriRuntimeMock(invoke);
  await expect(loadTaskExecutionGraph(task, [task], controller.signal)).rejects.toThrow();
  expect(invoke).toHaveBeenCalledTimes(1);
});
