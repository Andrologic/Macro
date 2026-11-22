import { useSyncExternalStore } from 'react';
import { useAppStore } from '../../stores/useAppStore';
import { useTaskStore } from '../../stores/useTaskStore';
import { retainedRunValue030 } from '../../services/agsdl/runtimeProjection030';
import {
  isWorkflowAgentTask, openWorkflowRun030, sameWorkflowSource030, subscribeWorkflowRunAccess030,
  workflowRunAccessSnapshot030, type WorkflowRunRegistration030,
} from '../../services/workflowAgentTasks';
import type { CatalogedImplementTask } from '../../services/implementTaskCatalog';
import { useAgsdlTranslation } from '../agsdl/useAgsdlTranslation';

function InstanceRow({ task }: { task: CatalogedImplementTask }) {
  const { t } = useAgsdlTranslation();
  const selected = useAppStore(state => state.selectedTaskId === task.id);
  const ref = task.workflow_execution;
  return <button type="button" aria-current={selected}
    className="block w-full rounded px-2 py-1.5 text-left hover:bg-accent aria-[current=true]:bg-accent"
    onClick={() => useAppStore.getState().setSelectedTask(task.id)}>
    <span className="block break-words font-medium">{task.title}</span>
    <span className="block truncate text-muted-foreground" title={ref?.agentInstanceId}>{ref?.agentInstanceId ?? task.plan_title}</span>
    {ref?.stale && <span>{t('agsdl.run030.staleShort')}</span>}
    {!ref?.stale && ref?.interactionRequired && <span>{t('agsdl.run030.waitingHuman')}</span>}
  </button>;
}

function RunList({ registration, tasks }: { registration: WorkflowRunRegistration030; tasks: CatalogedImplementTask[] }) {
  const { t } = useAgsdlTranslation();
  const { access, scope } = registration;
  const snapshot = useSyncExternalStore(access.subscribe, access.getSnapshot);
  const history = retainedRunValue030(snapshot.history) ?? [];
  const entries = new Map(history.map(run => [run.scope.systemStartId, run]));
  const runIds = new Set([...snapshot.historyOrder, ...entries.keys(), ...Object.keys(snapshot.runFailures)]);
  return <>
    {snapshot.history.kind === 'loading' && !history.length && <p role="status">{t('agsdl.run030.loading')}</p>}
    {snapshot.history.kind === 'stale' && <p role="status">{t('agsdl.run030.stale')}</p>}
    {(registration.catalogError || snapshot.history.kind === 'error') && <p role="alert">{t('agsdl.run030.readFailed')}</p>}
    {[...runIds].map(id => {
      const entry = entries.get(id);
      const read = Object.hasOwn(snapshot.runs, id) ? snapshot.runs[id] : undefined;
      const execution = entry?.scope ?? (read && retainedRunValue030(read)?.state.scope);
      const failed = Object.hasOwn(snapshot.runFailures, id);
      if (!execution && !failed) return null;
      const rows = execution ? tasks.filter(({ workflow_execution: ref }) =>
        ref && ref.systemStartId === id && sameWorkflowSource030(ref.source, execution.source)) : [];
      const humans = entry?.humans;
      return <section className="mb-2" key={id}>
        {execution ? <button type="button" className="w-full rounded px-2 py-1 text-left hover:bg-accent"
          onClick={() => openWorkflowRun030({ scope: execution, conversationId: scope.conversationId })}>
          <strong className="block truncate">{rows[0]?.plan_title || scope.owner.planId}</strong>
          <span className="block truncate text-muted-foreground" title={id}>{id}</span>
        </button> : <p className="break-all px-2">{id}</p>}
        {failed && <p className="px-2" role="alert">{t('agsdl.run030.readFailed')}</p>}
        {humans?.kind === 'ready' && humans.value.some(request => request.state.kind === 'open') &&
          !rows.some(task => task.workflow_execution?.interactionRequired) &&
          <p className="px-2">{t('agsdl.run030.waitingHuman')}</p>}
        <div className="ml-2 border-l border-border pl-1">{rows.map(task => <InstanceRow key={task.id} task={task} />)}</div>
      </section>;
    })}
    {snapshot.history.kind === 'ready' && runIds.size === 0 && !registration.catalogError &&
      <p className="p-2 text-muted-foreground">{scope.owner.planId} · {t('agsdl.run030.noRuns')}</p>}
  </>;
}

export default function OperateNavigator() {
  const { t } = useAgsdlTranslation();
  const tasks = useTaskStore(state => state.tasks);
  const loading = useTaskStore(state => state.isLoading);
  const error = useTaskStore(state => state.lastError);
  const projects = useAppStore(state => state.standaloneProjects);
  const groups = useAppStore(state => state.projectGroups);
  const registrations = useSyncExternalStore(subscribeWorkflowRunAccess030, workflowRunAccessSnapshot030);
  const scoped = registrations.filter(({ scope }) => projects.some(project => project.id === scope.owner.projectId) ||
    groups.some(group => group.projects.some(project => project.id === scope.owner.projectId)));
  const instances = tasks.filter(isWorkflowAgentTask);
  return <nav className="flex h-full min-h-0 flex-col" aria-label={t('agsdl.shell030.executions')} data-tour-id="operate-executions">
    <header className="flex min-h-12 items-center justify-between border-b border-border px-3">
      <h2 className="text-sm font-medium">{t('agsdl.shell030.executions')}</h2>
    </header>
    <div className="min-h-0 flex-1 overflow-auto p-2 text-xs">
      {error && <p role="alert">{error}</p>}
      {!scoped.length && <p role="status" className="p-2 text-muted-foreground">{t(loading ? 'agsdl.run030.loading' : 'agsdl.run030.noRuns')}</p>}
      {scoped.map(registration => <RunList key={registration.access.scopeKey} registration={registration} tasks={instances} />)}
    </div>
  </nav>;
}
