import type { CatalogedImplementTask } from './implementTaskCatalog';
import type { AgsdlDisplayMetadata, AgsdlMigrationMetadata } from '../types/agsdl';
import type { PublicApproval } from '../types/generated/ipc';
import type { PublicProjection, PublicSnapshot, SystemStartId } from './agsdlExecution/contracts';
import { projectViewer } from './agsdl/viewer';
import { appendProjection, assertProjection, type NativeCardActivation } from './agsdl/executionView';
import { sameSource } from './agsdl/runtimeSelection';
import { resolveTaskReference } from './durableIdentity';
import * as ipc from './tauriIpc';
import { isWorkflowAgentTask, workflowAgentTaskId, workflowTaskAgentPaths } from './workflowAgentTasks';
import { sourceDigest } from './agsdlExecution/compiler';
import { pointerPart } from './agsdl/document';

export interface TaskExecutionGraph {
  title: string;
  source: string;
  display?: AgsdlDisplayMetadata;
  migration?: AgsdlMigrationMetadata;
  taskPaths: Record<string, string>;
  selectedPath: string;
  simulated?: boolean;
  activity?: Record<string, NativeCardActivation>;
  snapshot?: PublicSnapshot;
  projection?: PublicProjection;
  approvals?: PublicApproval[];
}

async function projectionFor(snapshot: PublicSnapshot, signal?: AbortSignal): Promise<PublicProjection> {
  let projection = await ipc.readExecutionProjection(snapshot.systemStartId);
  signal?.throwIfAborted();
  assertProjection(projection, snapshot);
  while (projection.nextPage) {
    projection = appendProjection(projection, await ipc.readExecutionProjection(snapshot.systemStartId, projection.nextPage), snapshot);
    signal?.throwIfAborted();
  }
  return projection;
}

/** Read historical associations, never infer an execution from a title or a task's position. */
export async function loadTaskExecutionGraph(task: CatalogedImplementTask, tasks: CatalogedImplementTask[], signal?: AbortSignal): Promise<TaskExecutionGraph | null> {
  signal?.throwIfAborted();
  if (import.meta.env.DEV && import.meta.env.VITE_MACRO_DEMO === '1') {
    return (await import('../demo/taskExecutionGraph')).readDemoTaskExecutionGraph(task.id);
  }
  if (isWorkflowAgentTask(task)) {
    const ref = task.workflow_execution!;
    const snapshot = await ipc.readExecutionSnapshot(ref.systemStartId);
    signal?.throwIfAborted();
    if (snapshot.systemStartId !== ref.systemStartId || !sameSource(snapshot.source, ref.source) ||
      task.id !== workflowAgentTaskId(ref.systemStartId, ref.agentInstanceId) ||
      task.project_id !== ref.source.owner.projectId || task.plan_id !== ref.source.owner.planId ||
      task.plan_storage_branch !== ref.source.owner.branch || await sourceDigest(snapshot.authoredSource) !== snapshot.source.sourceSha256) throw new Error('Workflow Task identity differs');
    const projection = await projectionFor(snapshot, signal);
    const agent = projection.agents.find(agent => agent.agentInstanceId === ref.agentInstanceId && agent.agentName === ref.agentName);
    if (!agent) throw new Error('Workflow Agent is absent');
    const taskPaths: Record<string, string> = {};
    for (const [path, instance] of Object.entries(workflowTaskAgentPaths(snapshot, projection))) {
      const linked = tasks.find(candidate => candidate.id === workflowAgentTaskId(snapshot.systemStartId, instance) &&
        candidate.workflow_execution?.systemStartId === snapshot.systemStartId &&
        sameSource(candidate.workflow_execution.source, snapshot.source));
      if (linked) taskPaths[path] = linked.id;
    }
    const problem = projection.activations.find(item => ref.runAttention?.activationIds.includes(item.work.activationId));
    const problemPath = problem?.work.step?.length === 1 ? `/flow/steps/${pointerPart(problem.work.step[0])}` : undefined;
    const selectedPath = problemPath ?? Object.keys(taskPaths).find(path => path.startsWith('/flow/') && taskPaths[path] === task.id) ??
      Object.keys(taskPaths).find(path => taskPaths[path] === task.id);
    if (!selectedPath) throw new Error('Workflow Agent path is absent');
    const approvals = await ipc.readExecutionApprovals({ systemStartId: snapshot.systemStartId, source: snapshot.source });
    signal?.throwIfAborted();
    if (approvals.incomplete) throw new Error('Incomplete workflow approvals');
    return { title: task.plan_title || task.title, source: snapshot.authoredSource, snapshot, projection, taskPaths, selectedPath,
      approvals: approvals.approvals };
  }
  const branch = task.plan_storage_branch || task.plan_target_branch;
  if (!task.plan_id || !task.project_id || !branch) return null;
  let after: string | null = null;
  const cursors = new Set<string>();
  do {
    const page = await ipc.listExecutionRuns({ owner: { projectId: task.project_id, planId: task.plan_id, branch }, after, limit: 100 });
    signal?.throwIfAborted();
    for (const run of page.runs) {
      signal?.throwIfAborted();
      const snapshot = await ipc.readExecutionSnapshot(run.systemStartId as SystemStartId);
      if (snapshot.systemStartId !== run.systemStartId || !sameSource(snapshot.source, run.source as PublicSnapshot["source"]) || snapshot.source.owner.projectId !== task.project_id || snapshot.source.owner.planId !== task.plan_id || snapshot.source.owner.branch !== branch) throw new Error('Execution scope differs');
      const document = projectViewer(snapshot.authoredSource);
      const cards = [...document.graphs.flatMap(graph => graph.cards), ...document.declarations];
      const taskPaths: Record<string, string> = {};
      for (const path of new Set(cards.map(card => card.path))) {
        signal?.throwIfAborted();
        const linked = await ipc.resolveExecutionCardTask({ systemStartId: run.systemStartId, source: snapshot.source, path });
        const resolved = linked && resolveTaskReference(tasks, linked.taskId);
        if (resolved && linked.projectId === task.project_id && linked.planId === task.plan_id && linked.branch === branch) taskPaths[path] = resolved.id;
      }
      const selectedPath = Object.keys(taskPaths).find(path => taskPaths[path] === task.id);
      if (selectedPath) return { title: task.plan_title || document.title, source: snapshot.authoredSource, snapshot, projection: await projectionFor(snapshot), approvals: (await ipc.readExecutionApprovals({ systemStartId: snapshot.systemStartId, source: snapshot.source })).approvals, taskPaths, selectedPath };
    }
    if (!page.nextCursor) return null;
    if (cursors.has(page.nextCursor)) throw new Error('Repeated execution page');
    cursors.add(page.nextCursor);
    after = page.nextCursor;
  } while (after);
  return null;
}

export async function refreshTaskExecutionGraph(graph: TaskExecutionGraph): Promise<TaskExecutionGraph> {
  return graph.snapshot ? { ...graph, projection: await projectionFor(graph.snapshot), approvals: (await ipc.readExecutionApprovals({ systemStartId: graph.snapshot.systemStartId, source: graph.snapshot.source })).approvals } : graph;
}
