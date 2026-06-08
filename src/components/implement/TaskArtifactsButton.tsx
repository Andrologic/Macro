import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../stores/useAppStore';
import { useTaskStore } from '../../stores/useTaskStore';
import {
  getArchitectPlan,
  getGitFlowBaseBranch,
  resolveTargetBranch,
  type ArchitectPlanRecord,
} from '../../services/architectPlanService';
import {
  listVisibleTaskArtifactReviewEntries,
  type VisiblePlanTaskArtifactReviewEntry,
} from '../../services/architectPlanArtifactService';
import type { CatalogedImplementTask } from '../../services/implementTaskCatalog';
import { isPlanFinalizationTaskSource } from '../../services/planFinalization';
import { cn } from '../../utils/cn';
import { Icon } from '../ui/Icon';
import { ArtifactDiffModal } from '../modals/ArtifactDiffModal';

const getTaskArtifactBranchName = (
  task: Pick<CatalogedImplementTask, 'plan_storage_branch' | 'plan_target_branch'>
): string => resolveTargetBranch(task.plan_storage_branch || task.plan_target_branch || getGitFlowBaseBranch());

const canShowTaskArtifacts = (
  task: Pick<CatalogedImplementTask, 'task_source' | 'plan_id'> | null | undefined
): task is CatalogedImplementTask =>
  Boolean(
    task?.plan_id &&
      (task.task_source === 'architect' || isPlanFinalizationTaskSource(task.task_source))
  );

export const TaskArtifactsButton: React.FC = () => {
  const { t } = useTranslation();
  const selectedTaskId = useAppStore((state) => state.selectedTaskId);
  const selectedTask = useTaskStore(
    (state) => state.tasks.find((task) => task.id === selectedTaskId) ?? null
  );
  const [plan, setPlan] = useState<ArchitectPlanRecord | null>(null);
  const [entries, setEntries] = useState<VisiblePlanTaskArtifactReviewEntry[]>([]);
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const branchName = useMemo(
    () => (canShowTaskArtifacts(selectedTask) ? getTaskArtifactBranchName(selectedTask) : null),
    [selectedTask]
  );

  useEffect(() => {
    let disposed = false;
    setIsOpen(false);
    setSelectedArtifactId(null);
    setEntries([]);
    setPlan(null);

    if (!selectedTask || !canShowTaskArtifacts(selectedTask) || !branchName || !selectedTask.plan_id) {
      setIsLoading(false);
      return () => {
        disposed = true;
      };
    }

    setIsLoading(true);
    void (async () => {
      const loadedPlan = await getArchitectPlan(branchName, selectedTask.plan_id);
      if (!loadedPlan) {
        return;
      }
      const loadedEntries = await listVisibleTaskArtifactReviewEntries({
        branchName,
        plan: loadedPlan,
        task: selectedTask,
        includeInherited: true,
        includeOwn: true,
      });
      if (disposed) {
        return;
      }
      setPlan(loadedPlan);
      setEntries(loadedEntries);
    })()
      .catch(() => {
        if (!disposed) {
          setPlan(null);
          setEntries([]);
        }
      })
      .finally(() => {
        if (!disposed) {
          setIsLoading(false);
        }
      });

    return () => {
      disposed = true;
    };
  }, [branchName, selectedTask]);

  if (!selectedTask || !canShowTaskArtifacts(selectedTask) || entries.length === 0 || !plan || !branchName) {
    return null;
  }

  const currentArtifactId = selectedArtifactId ?? entries[0]?.artifact.id ?? null;

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setSelectedArtifactId(currentArtifactId);
          setIsOpen(true);
        }}
        disabled={isLoading || !currentArtifactId}
        className={cn(
          'inline-flex h-8 items-center gap-2 rounded-md border border-border bg-background/40 px-2.5 text-xs font-medium text-muted-foreground transition-colors',
          'hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50'
        )}
        title={t('implement.artifacts.openTaskArtifacts', 'Open artifacts')}
        aria-label={t('implement.artifacts.openTaskArtifacts', 'Open artifacts')}
      >
        <Icon name="file-text" size={14} className="text-primary" />
        <span>{t('implement.artifacts.title', 'Artifacts')}</span>
        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">
          {entries.length}
        </span>
      </button>

      {isOpen && currentArtifactId && (
        <ArtifactDiffModal
          branchName={branchName}
          plan={plan}
          task={selectedTask}
          entries={entries}
          artifactId={currentArtifactId}
          context="readOnly"
          onSelectArtifact={setSelectedArtifactId}
          onClose={() => setIsOpen(false)}
        />
      )}
    </>
  );
};

export default TaskArtifactsButton;
