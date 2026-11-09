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

it('opens the signalled pure activation in the exact captured run without attributing it to an Agent', async () => {
  const { workflowCallFailureFixture } = await import('./workflowAgentTasks.fixtures');
  const { projectWorkflowAgentTasks } = await import('./workflowAgentTasks');
  const f = await workflowCallFailureFixture();
  const tasks = projectWorkflowAgentTasks(f.plan, f.snapshot, f.projection, []);
  const seen: string[] = [];
  installTauriRuntimeMock(mock(async (command, args) => {
    seen.push(command);
    if (command === 'execution_read_snapshot') { expect(args?.systemStartId).toBe(f.snapshot.systemStartId); return f.snapshot; }
    if (command === 'execution_read_projection') return f.projection;
    if (command === 'execution_pending_approvals') return { approvals: [], incomplete: false };
    throw new Error(`Unexpected ${command}`);
  }));
  const graph = await loadTaskExecutionGraph(tasks[0], tasks);
  expect(graph?.selectedPath).toBe('/flow/steps/inspect');
  expect(graph?.source).toBe(f.snapshot.authoredSource);
  expect(graph?.taskPaths['/flow/steps/inspect']).toBeUndefined();
  expect(seen).not.toContain('execution_list_runs');
});

it('opens the native 0.3 capture through receipt-attested scope without Start associations', async () => {
  const { configureWorkflowRunAccess030, configureProductionWorkflowRunAccess030, readWorkflowRun030, projectWorkflowAgentTasks030 } = await import('./workflowAgentTasks');
  const { nativeAgentRunFixture030, nativeIntentFor030, nativeTransportFor030 } = await import('./agsdl/runAccess030.testSupport');
  const { staticReportForSource030 } = await import('./agsdl/staticSemantics030');
  const f = await nativeAgentRunFixture030();
  const { transport } = nativeTransportFor030(f);
  const seen: string[] = [];
  installTauriRuntimeMock(mock(async (command, args) => {
    seen.push(command);
    if(command === 'execution_read_snapshot') return f.capture;
    if(command === 'execution_list_runs030') return {runs:[f.summary],nextCursor:null};
    if(command === 'execution_read_intents') return [nativeIntentFor030(f)];
    if(command === 'execution_read_run_correlation030') return transport.readExecutionRunCorrelation030(args?.scope, args?.systemStartId);
    if(command === 'execution_read_runtime_projection030') return f.runtime;
    if(command === 'execution_read_humans030') throw {code:'NOT_FOUND',message:'No legacy human row'};
    throw new Error(command);
  }));
  configureProductionWorkflowRunAccess030();
  try {
    const run = await readWorkflowRun030(f.capture,'design-conversation');
    const { plan } = await (await import('./workflowAgentTasks.fixtures')).workflowTaskFixture();
    const tasks = projectWorkflowAgentTasks030({...plan,id:'sample-plan',targetBranch:'develop',projectIds:['sample-project']},run);
    const result = await loadTaskExecutionGraph(tasks[0],tasks);
    expect(result?.access030).toBeDefined();
    expect(f.capture.associations).toEqual({});
    expect(seen).toContain('execution_read_intents');
    expect(seen.filter(command => command === 'execution_read_run_correlation030')).toHaveLength(1);
    expect(seen).not.toContain('execution_read_projection');
    expect(seen).not.toContain('execution_pending_approvals');
    expect(staticReportForSource030(f.capture.authoredSource,result!.reports!)).toBeDefined();
    expect(staticReportForSource030(f.capture.authoredSource+' ',result!.reports!)).toBeUndefined();
  } finally { configureWorkflowRunAccess030(undefined); }
});
