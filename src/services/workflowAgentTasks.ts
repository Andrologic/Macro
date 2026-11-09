import type { RunInspectionAccess030, RunInspection030 } from './agsdl/runtimeProjection030';
import type { HumanRequestClient030 } from './agsdl/humanRequests030';
import type { RunCapture030, RunHumanRequest030 } from '../types/agsdlRunUi030';
import type { TaskStatus } from '../types';
import type { ArchitectPlanRecord } from './architectPlanService';
import type { CatalogedImplementTask } from './implementTaskCatalog';
import type { WorkflowAgentTaskReference, WorkflowAgentTaskState } from '../types/workflowAgentTask';
import type { PublicApproval } from '../types/generated/ipc';
import type { AgentInstanceId, PublicActivation, PublicProjection, PublicSnapshot, SourceRevision, SystemStartId } from './agsdlExecution/contracts';
import * as ipc from './ipc/agsdlExecution';
import { assertProjection, appendProjection } from './agsdl/executionView';
import { sourceDigest } from './agsdlExecution/compiler';
import { compareSequence, sameWork } from './agsdlExecution/invariants';
import { runCaptureKey030 } from './agsdl/runGraphProjection030';
import { object, readDocument } from './agsdl/document';

export function sameWorkflowSource030(a: { owner: WorkflowRunScope030['owner']; revision: string; sourceSha256: string }, b: { owner: WorkflowRunScope030['owner']; revision: string; sourceSha256: string }): boolean {
  return a.owner.projectId === b.owner.projectId && a.owner.planId === b.owner.planId && a.owner.branch === b.owner.branch && a.revision === b.revision && a.sourceSha256 === b.sourceSha256;
}

/** Single integration point for lot 6a. Factory creation grants no run authority.
 * Stable bundles are shared by the shell, task readers and attention observer. */
export interface WorkflowRunScope030 {
  owner: { projectId: string; planId: string; branch: string };
  conversationId?: string;
}
export interface WorkflowRunAccess030 {
  access: RunInspectionAccess030;
  humanClient?: HumanRequestClient030;
}
export interface WorkflowRunRegistration030 extends WorkflowRunAccess030 { scope: WorkflowRunScope030 }
let runFactory030: ((scope: WorkflowRunScope030) => WorkflowRunAccess030) | undefined;
let runAccesses030: readonly WorkflowRunRegistration030[] = [];
const runAccessListeners030 = new Set<() => void>();
export const subscribeWorkflowRunAccess030 = (listener: () => void) => {
  runAccessListeners030.add(listener);
  return () => { runAccessListeners030.delete(listener); };
};
export const workflowRunAccessSnapshot030 = () => runAccesses030;
export function configureWorkflowRunAccess030(factory: typeof runFactory030): void {
  runFactory030 = factory;
  runAccesses030 = [];
  runAccessListeners030.forEach(listener => listener());
}
export function getWorkflowRunAccess030(scope: WorkflowRunScope030): WorkflowRunAccess030 | undefined {
  const key = JSON.stringify([scope.owner.projectId, scope.owner.planId, scope.owner.branch, scope.conversationId ?? null]);
  const existing = runAccesses030.find(item => JSON.stringify([item.scope.owner.projectId, item.scope.owner.planId, item.scope.owner.branch, item.scope.conversationId ?? null]) === key);
  if (existing) return existing;
  if (!runFactory030) return;
  const bundle: WorkflowRunRegistration030 = { scope, ...runFactory030(scope) };
  runAccesses030 = [...runAccesses030, bundle];
  runAccessListeners030.forEach(listener => listener());
  return bundle;
}
export type WorkflowRunTarget030 = Pick<RunHumanRequest030, 'scope'> & { requestId?: string; conversationId?: string };
let runTarget030: WorkflowRunTarget030 | null = null;
const runTargetListeners030 = new Set<() => void>();
export const workflowRunTargetSnapshot030 = () => runTarget030;
export const subscribeWorkflowRunTarget030 = (listener: () => void) => {
  runTargetListeners030.add(listener);
  return () => { runTargetListeners030.delete(listener); };
};
export function openWorkflowRun030(target: WorkflowRunTarget030 | null): void {
  runTarget030 = target;
  runTargetListeners030.forEach(listener => listener());
}
export type WorkflowCapture = PublicSnapshot | RunCapture030;
export const isCapture030 = (snapshot: WorkflowCapture): snapshot is RunCapture030 => snapshot.versions.contract === 'agsdl-0.3.0';
export async function readWorkflowRun030(snapshot: RunCapture030): Promise<RunInspection030> {
  if (!isCapture030(snapshot) || snapshot.versions.snapshot !== '2' || snapshot.versions.profile !== 'macro-agsdl-030-v1') throw new Error('Unsupported workflow capture');
  const bundle = getWorkflowRunAccess030({ owner: snapshot.source.owner, conversationId: snapshot.associations.conversationId ?? undefined });
  if (!bundle) throw new Error('Run inspection access unavailable');
  await bundle.access.refreshRun(snapshot.systemStartId);
  const read = bundle.access.getSnapshot().runs[snapshot.systemStartId];
  if (!read || read.kind !== 'ready') throw new Error('Incomplete workflow projection');
  const inspection = read.value;
  if (inspection.capture.systemStartId !== snapshot.systemStartId || !sameWorkflowSource030(inspection.capture.source, snapshot.source) ||
      inspection.capture.authoredSource !== snapshot.authoredSource || inspection.state.scope.systemStartId !== snapshot.systemStartId ||
      !sameWorkflowSource030(inspection.state.scope.source, snapshot.source)) throw new Error('Workflow capture differs');
  return inspection;
}

export const workflowAgentTaskId = (system: string, agent: string): string =>
  `task:agsdl:v1:${encodeURIComponent(system)}:${encodeURIComponent(agent)}`;
export const isWorkflowAgentTask = (task: { task_source?: string; workflow_execution?: WorkflowAgentTaskReference } | null | undefined): boolean =>
  task?.task_source === 'agsdl' && task.workflow_execution !== undefined;
export const isWorkflowPlan = (plan: ArchitectPlanRecord): boolean =>
  plan.agsdl?.design?.kind === 'system' && !!plan.agsdl.design.origin?.branchName;

export interface WorkflowAgentTaskPorts {
  runs: typeof ipc.listExecutionRuns;
  snapshot: typeof ipc.readExecutionSnapshot;
  projection: typeof ipc.readExecutionProjection;
  approvals: typeof ipc.readExecutionApprovals;
}
const nativePorts: WorkflowAgentTaskPorts = { runs: ipc.listExecutionRuns, snapshot: ipc.readExecutionSnapshot,
  projection: ipc.readExecutionProjection, approvals: ipc.readExecutionApprovals };

function agentState(items: PublicActivation[], approvals: readonly PublicApproval[], system: PublicProjection['systemStop']): WorkflowAgentTaskState {
  const unresolved = items.filter(item => item.workState !== 'terminal');
  if (unresolved.some(item => item.workState === 'uncertain' || item.stopState.kind === 'uncertain') ||
    (unresolved.length > 0 && system.kind === 'uncertain')) return 'uncertain';
  if (unresolved.some(item => item.stopState.kind === 'requested') ||
    (unresolved.length > 0 && system.kind === 'requested')) return 'stopRequested';
  if (approvals.some(approval => approval.status === 'pending' && unresolved.some(item => item.work.activationId === approval.work.activationId))) return 'approval';
  if (unresolved.some(item => item.workState === 'active')) return 'active';
  if (unresolved.some(item => item.workState === 'queued')) return 'queued';
  const last = items.reduce<PublicActivation | undefined>((previous, next) =>
    !previous || compareSequence(previous.queueSequence, next.queueSequence) < 0 ? next : previous, undefined);
  if (last) {
    if (!last.terminalKind) throw new Error('Native terminal activation has no outcome');
    return last.terminalKind;
  }
  return system.kind === 'confirmed' ? 'stopped' : system.kind === 'none' ? 'idle' :
    system.kind === 'uncertain' ? 'uncertain' : 'stopRequested';
}
const statuses: Record<WorkflowAgentTaskState, TaskStatus> = { idle: 'Blocked', queued: 'Pending', active: 'InProgress',
  approval: 'AwaitingResponse', uncertain: 'Blocked', stopRequested: 'Blocked', stopped: 'Blocked', completed: 'Completed', failed: 'Failed' };

/** One Task per native instance, across all visits and deliveries in this run.
 * Pure/Call/Condition steps do not fabricate Agent tasks. */
export function projectWorkflowAgentTasks(plan: ArchitectPlanRecord, snapshot: PublicSnapshot, projection: PublicProjection,
  approvals: readonly PublicApproval[]): CatalogedImplementTask[] {
  if (isCapture030(snapshot)) throw new Error('Use the 0.3 workflow projection');
  if (projection.systemStartId !== snapshot.systemStartId || !sameWorkflowSource030(projection.source, snapshot.source) ||
    projection.activations.some(item => item.work.systemStartId !== snapshot.systemStartId)) throw new Error('Workflow projection scope differs');
  if (projection.nextPage) throw new Error('Incomplete workflow projection');
  const owner = snapshot.source.owner;
  if (owner.planId !== plan.id || owner.branch !== plan.targetBranch ||
    !(plan.projectIds ?? (plan.projectId ? [plan.projectId] : [])).includes(owner.projectId)) throw new Error('Workflow project scope differs');
  const instances = new Set<string>(), names = new Set<string>(), activations = new Set<string>(), positions = new Set<string>();
  for (const agent of projection.agents) {
    if (!agent.agentInstanceId || !agent.agentName || instances.has(agent.agentInstanceId) || names.has(agent.agentName)) throw new Error('Duplicate native Agent');
    instances.add(agent.agentInstanceId); names.add(agent.agentName);
  }
  for (const activation of projection.activations) {
    compareSequence(activation.queueSequence, activation.queueSequence);
    // SQLite numbers each Agent's FIFO independently. Pure steps use the
    // system cursor and therefore share only the null-instance position space.
    const position = JSON.stringify([activation.work.agentInstanceId, activation.queueSequence]);
    if (activations.has(activation.work.activationId) || positions.has(position) ||
      activation.work.agentInstanceId !== null && !instances.has(activation.work.agentInstanceId)) throw new Error('Invalid native activation identity');
    activations.add(activation.work.activationId); positions.add(position);
  }
  for (const approval of approvals) {
    if (approval.work.systemStartId !== snapshot.systemStartId) throw new Error('Approval scope differs');
    const activation = projection.activations.find(item => item.work.activationId === approval.work.activationId);
    if (!activation || !sameWork(activation.work, approval.work as PublicActivation['work'])) throw new Error('Approval activation differs');
  }
  const document = readDocument(snapshot.authoredSource);
  const agents = object(document.agents);
  const steps = object(object(document.flow).steps);
  // A committed failure with onError atomically schedules its authored successor.
  // Historical failures on that path are not unresolved requests for the run.
  const unownedProblems = projection.activations.filter(item => {
    if (item.work.agentInstanceId !== null) return false;
    if (item.workState !== 'terminal') return item.workState === 'uncertain' || item.stopState.kind === 'uncertain';
    const onError = item.work.step?.length === 1 ? object(steps[item.work.step[0]]).onError : undefined;
    return item.terminalKind === 'failed' && !(Array.isArray(onError) && onError.length > 0);
  });
  const runAttention: WorkflowAgentTaskReference['runAttention'] = unownedProblems.length ? {
    state: unownedProblems.some(item => item.workState !== 'terminal') ? 'uncertain' : 'failed',
    activationIds: unownedProblems.map(item => item.work.activationId),
  } : undefined;
  return projection.agents.map((agent, index) => {
    if (!Object.hasOwn(agents, agent.agentName)) throw new Error('Agent is absent from captured source');
    const items = projection.activations.filter(item => item.work.agentInstanceId === agent.agentInstanceId);
    const state = agentState(items, approvals, projection.systemStop);
    const reference: WorkflowAgentTaskReference = { systemStartId: snapshot.systemStartId, source: snapshot.source,
      agentInstanceId: agent.agentInstanceId, agentName: agent.agentName, cursor: projection.cursor, state,
      activationIds: items.map(item => item.work.activationId),
      runAttention: index === 0 ? runAttention : undefined,
      interactionRequired: ['approval', 'uncertain', 'failed'].includes(state) || index === 0 && !!runAttention };
    return { id: workflowAgentTaskId(snapshot.systemStartId, agent.agentInstanceId), plan_id: plan.id,
      project_id: owner.projectId, project_ids: [owner.projectId], context_project_ids: [], title: agent.agentName,
      description: '', status: statuses[state], dependencies: [], estimated_changes: [], workflow_execution: reference,
      task_source: 'agsdl', plan_title: plan.label || plan.title, plan_status: plan.status, plan_storage_branch: owner.branch,
      plan_target_branch: owner.branch, plan_target_branches_by_project_id: { [owner.projectId]: owner.branch },
      draft: false, standalone_kind: 'legacy', task_kind: null, base_branch: owner.branch, feature_slug: null,
      conversation_id: null, archived_at: plan.archivedAt ?? null, archive_reason: null, merged_at: null,
      assigned_branch: owner.branch, branch_name: owner.branch, branch_id: null, branch_task_index: index,
      blocked_by_task_ids: [], blocked_by: [], is_blocked: statuses[state] === 'Blocked', is_ready: false,
      needs_revalidation: false, sequence_index: index, execution_targets: [] };
  });
}

export function projectWorkflowAgentTasks030(plan: ArchitectPlanRecord, inspection: RunInspection030): CatalogedImplementTask[] {
  const { capture, state } = inspection;
  const owner = capture.source.owner;
  if (owner.planId !== plan.id || owner.branch !== plan.targetBranch ||
      !(plan.projectIds ?? (plan.projectId ? [plan.projectId] : [])).includes(owner.projectId) ||
      state.scope.systemStartId !== capture.systemStartId || !sameWorkflowSource030(state.scope.source, capture.source)) throw new Error('Workflow project scope differs');
  if (state.occurrences.kind !== 'ready' || state.occurrences.revision !== state.revision || state.humans.kind !== 'ready') throw new Error('Incomplete workflow projection');
  const occurrences = state.occurrences.value;
  const humans = state.humans.value;
  const activationIds = new Set<string>();
  for (const item of occurrences) {
    if (runCaptureKey030(item.scope) !== runCaptureKey030(state.scope) || activationIds.has(item.activation.id)) throw new Error('Workflow occurrence scope differs');
    activationIds.add(item.activation.id);
  }
  const ids = new Set<string>();
  return state.instances.map((instance, index) => {
    if (!instance.id || ids.has(instance.id)) throw new Error('Duplicate native Agent');
    ids.add(instance.id);
    const items = occurrences.filter(item => item.activation.instanceId === instance.id);
    const attention = humans.some(request => request.state.kind === 'open' && request.occurrences.some(item =>
      item.activation.kind === 'available' && runCaptureKey030(item.activation.scope) === runCaptureKey030(state.scope) && items.some(visit => item.activation.kind === 'available' && visit.activation.id === item.activation.activationId)));
    const physical = items.some(item => item.activation.physical);
    const active = instance.currentActivationId !== null || instance.queueActivationIds.length > 0 || physical;
    const terminal = new Set(['completed', 'succeeded', 'failed', 'cancelled', 'excluded', 'withdrawn', 'escaped']);
    const taskState: WorkflowAgentTaskState = attention ? 'approval' : active ? state.stopping ? 'stopRequested' : 'active'
      : items.some(item => !terminal.has(item.activation.phase)) ? 'uncertain'
      : instance.discarded || items.some(item => item.activation.phase === 'cancelled') ? 'stopped'
      : items.some(item => item.activation.phase === 'failed') ? 'failed'
      : items.length ? 'completed' : 'idle';
    const reference: WorkflowAgentTaskReference = {
      systemStartId: capture.systemStartId as SystemStartId, source: capture.source as SourceRevision,
      agentInstanceId: instance.id as AgentInstanceId, agentName: instance.agent, cursor: state.revision as WorkflowAgentTaskReference['cursor'],
      state: taskState, activationIds: items.map(item => item.activation.id as WorkflowAgentTaskReference['activationIds'][number]),
      interactionRequired: attention || taskState === 'failed',
    };
    return { id: workflowAgentTaskId(capture.systemStartId, instance.id), plan_id: plan.id, project_id: owner.projectId,
      project_ids: [owner.projectId], context_project_ids: [], title: instance.agent, description: '', status: statuses[taskState],
      dependencies: [], estimated_changes: [], workflow_execution: reference, task_source: 'agsdl',
      plan_title: plan.label || plan.title, plan_status: plan.status, plan_storage_branch: owner.branch, plan_target_branch: owner.branch,
      plan_target_branches_by_project_id: { [owner.projectId]: owner.branch }, draft: false, standalone_kind: 'legacy', task_kind: null,
      base_branch: owner.branch, feature_slug: null, conversation_id: null, archived_at: plan.archivedAt ?? null, archive_reason: null,
      merged_at: null, assigned_branch: owner.branch, branch_name: owner.branch, branch_id: null, branch_task_index: index,
      blocked_by_task_ids: [], blocked_by: [], is_blocked: statuses[taskState] === 'Blocked', is_ready: false,
      needs_revalidation: false, sequence_index: index, execution_targets: [] };
  });
}

async function tasksForCapture(plan: ArchitectPlanRecord, snapshot: WorkflowCapture, ports: WorkflowAgentTaskPorts) {
  if (await sourceDigest(snapshot.authoredSource) !== snapshot.source.sourceSha256) throw new Error('Workflow capture differs');
  if (isCapture030(snapshot)) return projectWorkflowAgentTasks030(plan, await readWorkflowRun030(snapshot));
  let projection = await ports.projection(snapshot.systemStartId);
  assertProjection(projection, snapshot);
  while (projection.nextPage) projection = appendProjection(projection, await ports.projection(snapshot.systemStartId, projection.nextPage), snapshot);
  const approvals = await ports.approvals({ systemStartId: snapshot.systemStartId, source: snapshot.source });
  if (approvals.incomplete) throw new Error('Incomplete workflow approvals');
  return projectWorkflowAgentTasks(plan, snapshot, projection, approvals.approvals);
}

/** Re-read only known executions. Polling never scans metadata or creates Tasks. */
export async function refreshWorkflowAgentTasks(tasks: CatalogedImplementTask[], ports: WorkflowAgentTaskPorts = nativePorts): Promise<CatalogedImplementTask[]> {
  const groups = new Map<string, CatalogedImplementTask>();
  for (const task of tasks.filter(isWorkflowAgentTask)) {
    const ref = task.workflow_execution!;
    if (task.id !== workflowAgentTaskId(ref.systemStartId, ref.agentInstanceId) || task.plan_id !== ref.source.owner.planId ||
      task.project_id !== ref.source.owner.projectId || task.plan_storage_branch !== ref.source.owner.branch) throw new Error('Workflow Task identity differs');
    const old = groups.get(ref.systemStartId);
    if (old && !sameWorkflowSource030(old.workflow_execution!.source, ref.source)) throw new Error('Workflow source differs');
    groups.set(ref.systemStartId, task);
  }
  const result: CatalogedImplementTask[] = [];
  for (const [system, task] of groups) {
    const ref = task.workflow_execution!;
    const plan: ArchitectPlanRecord = { id: task.plan_id, slug: task.plan_id, title: task.plan_title || task.title,
      description: '', status: task.plan_status || 'draft', targetBranch: ref.source.owner.branch, projectIds: [task.project_id],
      archivedAt: task.archived_at ?? undefined, createdAt: '', updatedAt: '', nodes: [], predictedBranches: [] };
    const snapshot = await ports.snapshot(system as SystemStartId);
    if (snapshot.systemStartId !== system || !sameWorkflowSource030(snapshot.source, ref.source)) throw new Error('Workflow capture differs');
    result.push(...await tasksForCapture(plan, snapshot, ports));
  }
  return result;
}

/** Refuse delayed native reads instead of overwriting a newer projection. */
export function retainWorkflowTaskOrder(previous: readonly CatalogedImplementTask[], next: CatalogedImplementTask[]): CatalogedImplementTask[] {
  const byId = new Map(previous.map(task => [task.id, task]));
  return next.map(task => {
    const old = byId.get(task.id)?.workflow_execution;
    const ref = task.workflow_execution;
    if (old && ref && (!sameWorkflowSource030(old.source, ref.source) || old.agentInstanceId !== ref.agentInstanceId ||
      compareSequence(ref.cursor, old.cursor) < 0)) throw new Error('Workflow Task projection regressed');
    return task;
  });
}

/** Full native pagination is required before deriving completion or absence.
 * No status is persisted outside SQLite and no execution is dispatched here. */
export async function loadWorkflowAgentTasks(plans: ArchitectPlanRecord[], projectIds: string[] | null,
  ports: WorkflowAgentTaskPorts = nativePorts): Promise<CatalogedImplementTask[]> {
  const tasks = new Map<string, CatalogedImplementTask>();
  const seenPlans = new Set<string>();
  // The durable owner is independent of mutable design kind and provenance.
  for (const plan of plans) {
    const planKey = JSON.stringify([plan.targetBranch, plan.id]);
    if (seenPlans.has(planKey)) continue;
    seenPlans.add(planKey);
    for (const projectId of plan.projectIds ?? (plan.projectId ? [plan.projectId] : [])) {
      if (projectIds && !projectIds.includes(projectId)) continue;
      const owner = { projectId, planId: plan.id, branch: plan.targetBranch };
      let after: string | null = null;
      const cursors = new Set<string>(), runs = new Set<string>();
      do {
        const page = await ports.runs({ owner, after, limit: 100 });
        for (const run of page.runs) {
          if (runs.has(run.systemStartId)) throw new Error('Repeated workflow run');
          runs.add(run.systemStartId);
          const snapshot = await ports.snapshot(run.systemStartId as SystemStartId);
          if (snapshot.systemStartId !== run.systemStartId || !sameWorkflowSource030(snapshot.source, run.source as SourceRevision) ||
            snapshot.source.owner.projectId !== owner.projectId || snapshot.source.owner.planId !== owner.planId ||
            snapshot.source.owner.branch !== owner.branch) throw new Error('Workflow capture differs');
          for (const task of await tasksForCapture(plan, snapshot, ports)) tasks.set(task.id, task);
        }
        after = page.nextCursor;
        if (after && cursors.has(after)) throw new Error('Repeated workflow cursor');
        if (after) cursors.add(after);
      } while (after);
    }
  }
  return [...tasks.values()];
}

export function workflowTaskAgentPaths(snapshot: PublicSnapshot, projection: PublicProjection): Record<string, AgentInstanceId> {
  const paths: Record<string, AgentInstanceId> = {};
  const doc = readDocument(snapshot.authoredSource);
  const instances = new Map(projection.agents.map(agent => [agent.agentName, agent.agentInstanceId]));
  const escape = (value: string) => value.replaceAll('~', '~0').replaceAll('/', '~1');
  for (const [name, instance] of instances) paths[`/agents/${escape(name)}`] = instance;
  for (const [name, value] of Object.entries(object(object(doc.flow).steps))) {
    const step = object(value);
    const instance = typeof step.agent === 'string' && instances.get(step.agent);
    if (step.type === 'agent' && instance) paths[`/flow/steps/${escape(name)}`] = instance;
  }
  return paths;
}
