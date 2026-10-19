import type { CatalogedImplementTask } from './implementTaskCatalog';
import type { AgsdlDisplayMetadata, AgsdlMigrationMetadata } from '../types/agsdl';
import type { PublicApproval } from '../types/generated/ipc';
import type { PublicProjection, PublicSnapshot, SystemStartId } from './agsdlExecution/contracts';
import { projectViewer } from './agsdl/viewer';
import { appendProjection, assertProjection } from './agsdl/executionView';
import { sameSource } from './agsdl/runtimeSelection';
import { resolveTaskReference } from './durableIdentity';
import * as ipc from './tauriIpc';

export interface TaskExecutionGraph {
  title: string;
  source: string;
  display?: AgsdlDisplayMetadata;
  migration?: AgsdlMigrationMetadata;
  taskPaths: Record<string, string>;
  selectedPath: string;
  simulated?: boolean;
  snapshot?: PublicSnapshot;
  projection?: PublicProjection;
  approvals?: PublicApproval[];
}

async function projectionFor(snapshot: PublicSnapshot): Promise<PublicProjection> {
  let projection = await ipc.readExecutionProjection(snapshot.systemStartId);
  assertProjection(projection, snapshot);
  while (projection.nextPage) {
    projection = appendProjection(projection, await ipc.readExecutionProjection(snapshot.systemStartId, projection.nextPage), snapshot);
  }
  return projection;
}

/** Read historical associations, never infer an execution from a title or a task's position. */
export async function loadTaskExecutionGraph(task: CatalogedImplementTask, tasks: CatalogedImplementTask[], signal?: AbortSignal): Promise<TaskExecutionGraph | null> {
  signal?.throwIfAborted();
  if (import.meta.env.DEV && import.meta.env.VITE_MACRO_DEMO === '1') {
    return (await import('../demo/taskExecutionGraph')).readDemoTaskExecutionGraph(task.id);
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
