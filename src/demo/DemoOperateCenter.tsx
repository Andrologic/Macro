import { useTranslation } from 'react-i18next';
import { useAppStore } from '../stores/useAppStore';
import { useTaskStore } from '../stores/useTaskStore';
import ImplementCenter from '../components/implement/ImplementCenter';
import { Icon } from '../components/ui/Icon';

export default function DemoOperateCenter() {
  const { t } = useTranslation();
  const selected = useAppStore(state => state.selectedTaskId);
  const tasks = useTaskStore(state => state.tasks);
  const child = tasks.find(task => task.id === selected);
  const parent = tasks.find(task => task.id === child?.parent_task_id);
  return <div className="flex h-full min-h-0 flex-col">
    {parent && <div className="flex shrink-0 items-center border-b border-border px-4 py-2">
      <button className="inline-flex min-w-0 items-center gap-2 text-xs text-muted-foreground hover:text-foreground" onClick={() => void useTaskStore.getState().activateTask(parent.id)} aria-label={t('implement.backToWorkflow', 'Back to workflow')}>
        <Icon name="chevron-left" size={14} /><Icon name="workflow" size={14} /><span className="truncate">{parent.title}</span>
      </button>
    </div>}
    <div className="min-h-0 flex-1"><ImplementCenter /></div>
  </div>;
}
