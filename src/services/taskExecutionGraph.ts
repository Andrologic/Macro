import type { AgsdlDisplayMetadata,AgsdlMigrationMetadata,AgsdlReport } from '../types/agsdl';
import type { PublicApproval } from '../types/generated/ipc';
import { validateDocument } from './agsdl/document';
import { type NativeCardActivation } from './agsdl/executionView';
import { sameSource } from './agsdl/runtimeSelection';
import type { PublicProjection,SourceRevision } from './agsdlExecution/contracts';
import { sourceDigest } from './agsdlExecution/sourceDigest';
import type { CatalogedImplementTask } from './implementTaskCatalog';
import * as ipc from './tauriIpc';
import { isCapture030,isWorkflowAgentTask,workflowAccessForCapture030,workflowAgentTaskId,type WorkflowRunAccess030 } from './workflowAgentTasks';

export interface TaskExecutionGraph {
  access030?: WorkflowRunAccess030;
  reports?: AgsdlReport[];
  title: string;
  source: string;
  display?: AgsdlDisplayMetadata;
  migration?: AgsdlMigrationMetadata;
  taskPaths: Record<string, string>;
  selectedPath: string;
  simulated?: boolean;
  activity?: Record<string, NativeCardActivation>;
  snapshot?: import("./ipc/agsdlExecution030").PublicSnapshot030;
  projection?: PublicProjection;
  approvals?: PublicApproval[];
}

/** Read historical associations, never infer an execution from a title or a task's position. */
export async function loadTaskExecutionGraph(task: CatalogedImplementTask, _tasks: CatalogedImplementTask[], signal?: AbortSignal): Promise<TaskExecutionGraph | null> {
  signal?.throwIfAborted();
  if (import.meta.env.DEV && import.meta.env.VITE_MACRO_DEMO === '1') {
    return (await import('../demo/taskExecutionGraph')).readDemoTaskExecutionGraph(task.id);
  }
  if (isWorkflowAgentTask(task)) {
    const ref = task.workflow_execution!;
    const snapshot = await ipc.readExecutionSnapshot030(ref.systemStartId);
    signal?.throwIfAborted();
    if (snapshot.systemStartId !== ref.systemStartId || !sameSource(snapshot.source as SourceRevision, ref.source) ||
      task.id !== workflowAgentTaskId(ref.systemStartId, ref.agentInstanceId) ||
      task.project_id !== ref.source.owner.projectId || task.plan_id !== ref.source.owner.planId ||
      task.plan_storage_branch !== ref.source.owner.branch || await sourceDigest(snapshot.authoredSource) !== snapshot.source.sourceSha256) throw new Error('Workflow Task identity differs');
    const reports = await validateDocument(snapshot.authoredSource);
    signal?.throwIfAborted();
    if (isCapture030(snapshot)) {
      const access030 = await workflowAccessForCapture030(snapshot);
      if (!access030) throw new Error('Run inspection access unavailable');
      return { reports, title: task.plan_title || task.title, source: snapshot.authoredSource, snapshot, access030, taskPaths: {}, selectedPath: '' };
    }
    throw new Error('Unsupported AgSDL execution edition.');
  }
  return null;
}

export async function refreshTaskExecutionGraph(graph: TaskExecutionGraph): Promise<TaskExecutionGraph> {
  if (graph.access030 && graph.snapshot) { await graph.access030.access.refreshRun(graph.snapshot.systemStartId); return graph; }
  return graph;
}
