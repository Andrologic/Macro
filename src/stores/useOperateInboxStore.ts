import { create } from 'zustand';
import type { RunHumanRequest030 } from '../types/agsdlRunUi030';
import type { OperateInboxAction } from '../types/generated/ipc';
import { retainedRunValue030 } from '../services/agsdl/runtimeProjection030';
import { runCaptureKey030 } from '../services/agsdl/runGraphProjection030';
import { sameHumanScope030 } from '../services/agsdl/humanRequests030';
import type { SystemStartId } from '../services/agsdlExecution/contracts';
import {
  isFinishedOperateRun, operateRunStatus, snoozeState, workflowHumanInstances030,
  type HiddenOperateAgents, type OperateInboxFilter, type OperateRunInput, type OperateRunRow,
  type OperateRunTarget, type OperateThreadRow,
} from '../services/operateInboxModel';
import { stopExecution030, updateOperateInbox } from '../services/tauriIpc';
import {
  openWorkflowRun030, subscribeWorkflowRunAccess030, workflowAgentTaskId,
  workflowRunAccessSnapshot030, type WorkflowRunRegistration030,
} from '../services/workflowAgentTasks';
import { useAppStore } from './useAppStore';
import { useTaskStore } from './useTaskStore';

interface OperateInboxState {
  runs: readonly OperateRunInput[];
  filter: OperateInboxFilter;
  hiddenAgents?: HiddenOperateAgents;
  nowMs: number;
  loading: boolean;
  readFailed: boolean;
  setFilter: (filter: OperateInboxFilter) => void;
  setHiddenAgents: (provider?: HiddenOperateAgents) => void;
}
export const useOperateInboxStore = create<OperateInboxState>(set => ({
  runs: [], filter: {}, nowMs: Date.now(), loading: false, readFailed: false,
  setFilter: filter => set({ filter }),
  setHiddenAgents: hiddenAgents => set({ hiddenAgents }),
}));

function readRunInputs(
  registration: WorkflowRunRegistration030, taskLabels: ReadonlyMap<string, string | null>,
): OperateRunInput[] {
  const snapshot = registration.access.getSnapshot();
  const entries = new Map(retainedRunValue030(snapshot.history)?.map(entry => [entry.scope.systemStartId, entry]));
  const ids = new Set([...snapshot.historyOrder, ...entries.keys(), ...Object.keys(snapshot.runs)]);
  return [...ids].flatMap(id => {
    const read = snapshot.runs[id];
    const inspection = read && retainedRunValue030(read);
    const history = entries.get(id);
    const state = inspection?.state;
    // The monitor can refresh one run independently of the history.
    const latest = inspection && (!history || (inspection.observation?.order ?? 0) >= (history.observation?.order ?? 0))
      ? { ...inspection.state, inbox: inspection.inbox, observation: inspection.observation } : history;
    if (!latest) return [];
    const { scope, verdict, physicalPending, stopping, inbox: facts, observation } = latest;
    if (state && runCaptureKey030(scope) !== runCaptureKey030(state.scope)) return [];
    const requestsByInstance = new Map<string, RunHumanRequest030[]>();
    const unlinkedRequests: RunHumanRequest030[] = [];
    const knownInstances = new Set(state?.instances.map(instance => instance.id));
    for (const request of retainedRunValue030(latest.humans) ?? []) {
      if (request.state.kind !== 'open' || !sameHumanScope030(request.scope, scope)) continue;
      const ids = inspection ? [...workflowHumanInstances030(inspection, request)].filter(id => knownInstances.has(id)) : [];
      if (!ids.length) unlinkedRequests.push(request);
      for (const id of ids) {
        if (!requestsByInstance.has(id)) requestsByInstance.set(id, []);
        requestsByInstance.get(id)!.push(request);
      }
    }
    const systemLabel = registration.systemLabel ?? (state?.instances[0]
      ? taskLabels.get(workflowAgentTaskId(id, state.instances[0].id)) : undefined) ?? scope.source.owner.planId;
    const failures = new Set(facts?.failedInstanceIds);
    return [{
      scope, conversationId: registration.scope.conversationId,
      location: registration.location ?? { kind: 'local' },
      systemLabel, status: operateRunStatus(verdict, physicalPending, stopping ?? false, facts?.stoppedByUser ?? false),
      facts, stale: snapshot.history.kind === 'stale' || read?.kind === 'stale' || !!snapshot.runFailures[id],
      observedAtMs: observation?.atMs ?? Date.now(), unlinkedRequests,
      threads: (state?.instances ?? []).map(instance => ({
        instanceId: instance.id, agentId: instance.agent, requests: requestsByInstance.get(instance.id) ?? [],
        agentLabel: instance.selectorName ? `${instance.agent} · ${instance.selectorName}` : instance.agent,
        reason: failures.has(instance.id) ? 'error' : undefined,
      })),
    }];
  });
}

/** Follow the same catalogue used by the existing Operate polling lifecycle. */
export function subscribeOperateInbox(): () => void {
  let subscriptions: (() => void)[] = [];
  let wakeTimer: ReturnType<typeof setTimeout> | undefined;
  const tick = () => {
    clearTimeout(wakeTimer);
    const nowMs = Date.now();
    let next = nowMs + 60_000;
    for (const run of useOperateInboxStore.getState().runs) {
      if (isFinishedOperateRun(run.status)) continue;
      for (const thread of run.facts?.threads ?? []) {
        if (thread.snoozeUntilMs !== null && snoozeState(thread, nowMs) === 'snoozed') {
          next = Math.min(next, thread.snoozeUntilMs);
        }
      }
    }
    useOperateInboxStore.setState({ nowMs });
    wakeTimer = setTimeout(tick, next - nowMs);
  };
  const publish = () => {
    const { standaloneProjects, projectGroups } = useAppStore.getState();
    const projects = new Set([...standaloneProjects, ...projectGroups.flatMap(group => group.projects)].map(project => project.id));
    const tasks = useTaskStore.getState();
    const taskLabels = new Map(tasks.tasks.filter(task => task.workflow_execution).map(task => [task.id, task.plan_title]));
    const registrations = workflowRunAccessSnapshot030().filter(item => projects.has(item.scope.owner.projectId) || item.location?.kind === 'remote');
    useOperateInboxStore.setState({
      runs: registrations.flatMap(item => readRunInputs(item, taskLabels)),
      loading: tasks.isLoading || registrations.some(item => item.access.getSnapshot().history.kind === 'loading'),
      readFailed: !!tasks.lastError || registrations.some(item => {
        const snapshot = item.access.getSnapshot();
        return !!item.catalogError || snapshot.history.kind === 'error' || snapshot.history.kind === 'stale' || Object.keys(snapshot.runFailures).length > 0;
      }),
    });
    tick();
  };
  const follow = () => {
    subscriptions.forEach(stop => stop());
    subscriptions = workflowRunAccessSnapshot030().map(({ access }) => access.subscribe(publish));
    publish();
  };
  const stopRegistry = subscribeWorkflowRunAccess030(follow);
  const stopTasks = useTaskStore.subscribe((next, previous) => {
    if (next.tasks !== previous.tasks || next.isLoading !== previous.isLoading || next.lastError !== previous.lastError) publish();
  });
  const stopProjects = useAppStore.subscribe((next, previous) => {
    if (next.standaloneProjects !== previous.standaloneProjects || next.projectGroups !== previous.projectGroups) publish();
  });
  follow();
  return () => {
    stopRegistry(); stopTasks(); stopProjects();
    subscriptions.forEach(stop => stop());
    clearTimeout(wakeTimer);
  };
}

function accessFor(target: OperateRunTarget) {
  const key = runCaptureKey030(target.scope);
  return workflowRunAccessSnapshot030().find(registration => {
    if (registration.scope.conversationId !== target.conversationId) return false;
    const snapshot = registration.access.getSnapshot();
    const { systemStartId } = target.scope;
    const read = snapshot.runs[systemStartId];
    const run = read && retainedRunValue030(read);
    return (run && runCaptureKey030(run.state.scope) === key) ||
      retainedRunValue030(snapshot.history)?.some(entry => runCaptureKey030(entry.scope) === key);
  })?.access;
}

async function update(target: OperateRunTarget, action: OperateInboxAction) {
  await updateOperateInbox(target.scope, action);
  // The write succeeded even if an unrelated intent read fails.
  await accessFor(target)?.refreshRun(target.scope.systemStartId).catch(() => {});
}

export function markOperateRunOpened(target: OperateRunTarget) {
  return update(target, { kind: 'markOpened' });
}

export function snoozeOperateThread(thread: OperateThreadRow, untilMs: number) {
  if (!thread.canSnooze) return Promise.reject(new Error('Thread unavailable'));
  return update(thread, { kind: 'snooze', instanceId: thread.instanceId, activity: thread.facts?.activity ?? 0,
    untilMs, forRequest: !!thread.requestId });
}

export function openOperateRun(target: OperateRunTarget, requestId?: string) {
  openWorkflowRun030({ scope: target.scope, conversationId: target.conversationId, ...(requestId ? { requestId } : {}) });
}

export async function openOperateThread(thread: OperateThreadRow) {
  const { scope, conversationId, instanceId, requestId, facts } = thread;
  const tasks = useTaskStore.getState().tasks;
  const taskId = workflowAgentTaskId(scope.systemStartId, instanceId);
  if (thread.location.kind === 'local' && tasks.some(task => task.id === taskId &&
    task.workflow_execution && sameHumanScope030(task.workflow_execution, scope))) {
    useAppStore.getState().setSelectedTask(taskId);
  } else {
    openWorkflowRun030({ scope, conversationId, instanceId, ...(requestId ? { requestId } : {}) });
  }
  if (facts?.snoozeUntilMs != null && facts.snoozedAtActivity != null && snoozeState(facts, Date.now()) !== 'snoozed') {
    await update(thread, { kind: 'dismissWake', instanceId,
      untilMs: facts.snoozeUntilMs, snoozedAtActivity: facts.snoozedAtActivity });
  }
}

const terminating = new Map<string, Promise<void>>();
/** Call after the user confirms. The next engine projection decides when Stop is complete. */
export function terminateOperateRun(run: OperateRunRow): Promise<void> {
  if (!run.canTerminate) return Promise.reject(new Error('Run unavailable'));
  const existing = terminating.get(run.key);
  if (existing) return existing;
  const { systemStartId, snapshotId } = run.scope;
  const operation = (async () => {
    try {
      const receipt = await stopExecution030({ systemStartId: systemStartId as SystemStartId, requestId: `operate-stop:${snapshotId}` });
      if (receipt.kind === 'none' || receipt.kind === 'uncertain') throw new Error('Stop confirmation unavailable');
    } finally {
      await accessFor(run)?.refreshRun(systemStartId).catch(() => {});
      terminating.delete(run.key);
    }
  })();
  terminating.set(run.key, operation);
  return operation;
}
