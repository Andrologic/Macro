import { useTranslation } from 'react-i18next';
import type { Task } from '../../types';
import { Icon } from '../ui/Icon';
import { cn } from '../../utils/cn';
import { TaskStatusIndicator } from './TaskStatusIndicator';
import { resolveTaskStatusIndicatorState } from '../../services/taskStatusPresentation';

interface Props {
  task: Task;
  childrenTasks: readonly Task[];
  projectName?: string;
  selected: boolean;
  expanded: boolean;
  onSelect: () => void;
  onToggle: () => void;
}
export function WorkflowQueueCard({ task, childrenTasks, projectName, selected, expanded, onSelect, onToggle }: Props) {
  const { t } = useTranslation();
  const done = childrenTasks.filter(child => child.status === 'Completed').length;
  return <div className={cn('rounded-xl border bg-card/70 p-2', selected ? 'border-primary/30 bg-primary/10' : 'border-border/70')} data-workflow-id={task.id}>
    <button className="flex w-full items-center gap-2.5 text-left" onClick={onSelect}>
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><Icon name="workflow" size={17} /></span>
      <span className="min-w-0 flex-1 text-sm font-semibold leading-tight line-clamp-2">{task.title}</span>
      <TaskStatusIndicator state={resolveTaskStatusIndicatorState(task.status, false)} size={13} />
    </button>
    <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
      <span className="min-w-0 truncate">{projectName}</span>
      <button onClick={onToggle} aria-expanded={expanded} aria-label={t('implement.workflowTasks', 'Workflow tasks')} className="inline-flex shrink-0 items-center gap-1 rounded px-1 py-0.5 hover:bg-accent hover:text-foreground">
        <span>{t('implement.workflowProgress', '{{done}}/{{total}} tasks', { done, total: childrenTasks.length })}</span>
        <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={13} />
      </button>
    </div>
    <div className="mt-2 h-0.5 overflow-hidden rounded bg-muted" aria-hidden="true"><div className="h-full bg-primary/70 transition-all" style={{ width: `${childrenTasks.length ? done / childrenTasks.length * 100 : 0}%` }} /></div>
  </div>;
}

export function WorkflowChildRow({ task, selected, onSelect }: { task: Task; selected: boolean; onSelect: () => void }) {
  return <button onClick={onSelect} data-workflow-child={task.id} className={cn('ml-3 flex w-[calc(100%-12px)] items-center gap-2 rounded-lg border-l-2 px-2 py-2.5 text-left text-xs', selected ? 'border-primary bg-primary/10 text-foreground' : 'border-border text-muted-foreground hover:bg-accent/40')}>
    <TaskStatusIndicator state={resolveTaskStatusIndicatorState(task.status, false)} size={12} />
    <span className="min-w-0 truncate">{task.title}</span>
  </button>;
}
