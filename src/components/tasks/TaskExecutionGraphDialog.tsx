import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CatalogedImplementTask } from '../../services/implementTaskCatalog';
import { loadTaskExecutionGraph, refreshTaskExecutionGraph, type TaskExecutionGraph } from '../../services/taskExecutionGraph';
import { projectViewer } from '../../services/agsdl/viewer';
import { projectSystemOverview } from '../../services/agsdl/systemOverview';
import { nativeCardActivations } from '../../services/agsdl/executionView';
import type { TrackedTask } from '../../services/agsdl/taskTracking';
import { resolveTaskQueueSupervision, selectTaskQueueRequestSignature } from '../../services/taskQueueAttention';
import { resolveRunningTaskIds, resolveTaskStatusIndicatorState } from '../../services/taskStatusPresentation';
import { resolveTaskMergeWorkflowPresentationState } from '../../services/taskMergeWorkflowPresentation';
import { useTaskStore } from '../../stores/useTaskStore';
import { useChatStore } from '../../stores/useChatStore';
import { useAppStore } from '../../stores/useAppStore';
import { WorkflowGraph } from '../agsdl/WorkflowGraph';
import { Dialog } from '../ui/Dialog';
import { Icon } from '../ui/Icon';
import { SpinnerIcon } from '../ui/SpinnerIcon';
import '../agsdl/agsdl.css';

export default function TaskExecutionGraphDialog({ task, onClose }: { task: CatalogedImplementTask; onClose: () => void }) {
  const { t } = useTranslation();
  const tasks = useTaskStore(state => state.tasks);
  const mergeRuntime = useTaskStore(state => state.mergeWorkflowRuntimeByTaskId);
  const conversations = useChatStore(state => state.conversations);
  const conversationRuntimeById = useChatStore(state => state.conversationRuntimeById);
  const conversationCompactionStatusById = useChatStore(state => state.conversationCompactionStatusById);
  const pendingToolApprovalByConversationId = useChatStore(state => state.pendingToolApprovalByConversationId);
  const requestSignature = useChatStore(selectTaskQueueRequestSignature);
  const [view, setView] = useState<TaskExecutionGraph | null>();
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [selected, setSelected] = useState('');
  const [graphIndex, setGraphIndex] = useState<number | null>(null);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setView(undefined); setError(false);
    void loadTaskExecutionGraph(task, useTaskStore.getState().tasks, controller.signal).then(result => {
      if (!active) return;
      setView(result); setSelected(result?.selectedPath ?? ''); setGraphIndex(null);
    }).catch(() => { if (active) setError(true); });
    return () => { active = false; controller.abort(); };
  }, [task, attempt]);
  useEffect(() => {
    if (!view?.snapshot) return;
    let active = true;
    const timer = setTimeout(() => void refreshTaskExecutionGraph(view).then(next => {
      if (active) { setView(next); setError(false); }
    }).catch(() => { if (active) setError(true); }), 2000);
    return () => { active = false; clearTimeout(timer); };
  }, [view]);
  const source = view?.source;
  const display = view?.display;
  const migration = view?.migration;
  const document = useMemo(() => {
    if (!source) return;
    try { return projectViewer(source, { display, migration }); }
    catch { return; }
  }, [source, display, migration]);
  const graphs = document?.graphs ?? [];
  const initialGraph = graphs.findIndex(graph => graph.cards.some(card => card.path === view?.selectedPath));
  const graph = graphs[Math.min(graphIndex ?? Math.max(initialGraph, 0), graphs.length - 1)];
  const system = useMemo(() => projectSystemOverview(graph, document?.declarations.filter(card => ['Agent', 'System'].includes(card.kind)) ?? []), [graph, document]);
  const running = useMemo(() => resolveRunningTaskIds({ tasks, conversations, conversationRuntimeById, conversationCompactionStatusById }), [tasks, conversations, conversationRuntimeById, conversationCompactionStatusById]);
  const supervision = useMemo(() => resolveTaskQueueSupervision({ tasks, conversations, runningTaskIds: running, requestStateByConversationId: Object.fromEntries(JSON.parse(requestSignature)), questionnaireDraftsByConversationId: {}, pendingToolApprovalByConversationId, mergeWorkflowRuntimeByTaskId: mergeRuntime }), [tasks, conversations, running, requestSignature, pendingToolApprovalByConversationId, mergeRuntime]);
  const tracked = useMemo(() => Object.fromEntries(Object.entries(view?.taskPaths ?? {}).flatMap(([path, id]) => {
    const task = tasks.find(task => task.id === id);
    if (!task) return [];
    return [[path, { taskId: task.id, title: task.title, state: resolveTaskStatusIndicatorState(task.status, running.has(task.id), task.task_source, resolveTaskMergeWorkflowPresentationState(mergeRuntime[task.id], task.merge_workflow_summary, task.status), task.is_blocked, Boolean(supervision.attentionByTaskId.get(task.id) && supervision.attentionByTaskId.get(task.id)?.kind !== 'review'), supervision.resolvedWaitTaskIds.has(task.id)) } satisfies TrackedTask]];
  })), [view, tasks, running, mergeRuntime, supervision]);
  const native = useMemo(() => view?.projection ? nativeCardActivations(system.cards, view.projection, view.approvals ?? []) : view?.activity ?? {}, [system, view]);
  const title = t('implement.executionGraph', 'Workflow execution');
  return <Dialog title={title} onClose={onClose} closeOnBackdropClick panelClassName="flex h-[min(85vh,900px)] w-[min(94vw,1200px)] min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
    <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-5 py-4">
      <div className="min-w-0"><h2 className="truncate text-sm font-semibold">{view?.title || title}</h2><p className="truncate text-xs text-muted-foreground">{task.title}</p></div>
      <button type="button" onClick={onClose} aria-label={t('common.close', 'Close')} className="rounded-md p-1.5 text-muted-foreground hover:bg-accent"><Icon name="x" size={16} /></button>
    </header>
    {graphs.length > 1 && <div className="px-4 pt-3"><select aria-label={t('implement.workflowGraph', 'Workflow graph')} value={graph?.path} onChange={event => { setGraphIndex(graphs.findIndex(graph => graph.path === event.target.value)); setSelected(''); }} className="rounded-md border border-border bg-card px-2 py-1 text-xs">{graphs.map(graph => <option key={graph.path} value={graph.path}>{graph.title}</option>)}</select></div>}
    <div className="agsdl-viewer relative flex min-h-0 flex-1 flex-col">
      {error || (view && !document) ? <div role="alert" className="m-auto flex items-center gap-2 text-sm text-muted-foreground"><Icon name="alert-circle" size={16} />{t('implement.executionGraphError', 'The workflow could not be loaded.')}<button className="text-primary" onClick={() => setAttempt(value => value + 1)}>{t('common.retry', 'Retry')}</button></div>
        : view === undefined ? <div role="status" className="m-auto"><SpinnerIcon size={20} /></div>
        : !view ? <p className="m-auto px-6 text-center text-sm text-muted-foreground">{t('implement.executionGraphEmpty', 'No AgSDL execution is linked to this task.')}</p>
        : <WorkflowGraph selectionMode="select" cards={system.cards} edges={system.edges} selected={selected} select={setSelected} title={card => tracked[card.path]?.title || card.title} trackedTasks={tracked} nativeActivations={native} />}
      {selected && tracked[selected] && <button type="button" className="absolute bottom-4 right-4 z-10 flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-xs text-primary shadow-lg transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" onClick={() => { void useTaskStore.getState().activateTask(tracked[selected].taskId).then(() => { useAppStore.getState().setMode('Implement'); onClose(); }).catch(() => setError(true)); }}><Icon name="message-square" size={14} />{t('implement.openGraphTask', 'Open task')}</button>}
    </div>
  </Dialog>;
}
