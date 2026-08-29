import React from 'react';
import { useTranslation } from 'react-i18next';
import type {
  StandaloneTaskLaunchProgress,
  StandaloneTaskLaunchStep,
} from '../../types';
import { cn } from '../../utils/cn';
import { Icon } from '../ui/Icon';

const STEPS: StandaloneTaskLaunchStep[] = [
  'preparing_task',
  'creating_name',
  'creating_workspace',
  'preparing_project',
  'starting_agent',
];

const STEP_LABELS: Record<StandaloneTaskLaunchStep, [string, string]> = {
  preparing_task: ['implement.standaloneLaunch.preparingTask', 'Préparation de la tâche'],
  creating_name: ['implement.standaloneLaunch.creatingName', 'Création du nom'],
  creating_workspace: [
    'implement.standaloneLaunch.creatingWorkspace',
    'Création de l’espace de travail',
  ],
  preparing_project: [
    'implement.standaloneLaunch.preparingProject',
    'Préparation du projet',
  ],
  starting_agent: ['implement.standaloneLaunch.startingAgent', 'Démarrage de l’agent'],
};

export const StandaloneTaskLaunchProgressCard: React.FC<{
  progress: StandaloneTaskLaunchProgress;
  onRetry: () => void;
}> = ({ progress, onRetry }) => {
  const { t } = useTranslation();
  const completed = new Set(progress.completedSteps);

  return (
    <div
      data-testid="standalone-task-launch-progress"
      data-status={progress.status}
      className="mt-2 rounded-md border border-border/60 bg-background/55 px-2.5 py-2 text-[11px]"
    >
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="font-medium text-foreground/90">
          {t('implement.standaloneLaunch.title', 'Préparation de la tâche')}
        </span>
        {progress.status === 'completed' && (
          <span className="text-muted-foreground">
            {t('implement.standaloneLaunch.ready', 'Prête')}
          </span>
        )}
      </div>

      <ol className="space-y-1" aria-label={t('implement.standaloneLaunch.title', 'Préparation de la tâche')}>
        {STEPS.map((step) => {
          const isCompleted = completed.has(step);
          const isActive = progress.status === 'running' && progress.activeStep === step;
          const isFailed = progress.status === 'error' && progress.activeStep === step;
          const [translationKey, fallback] = STEP_LABELS[step];

          return (
            <li
              key={step}
              data-step={step}
              data-step-state={isFailed ? 'error' : isCompleted ? 'completed' : isActive ? 'active' : 'future'}
              className={cn(
                'flex min-w-0 items-center gap-1.5',
                isCompleted && 'text-foreground/80',
                isActive && 'text-foreground',
                isFailed && 'text-destructive',
                !isCompleted && !isActive && !isFailed && 'text-muted-foreground/50',
              )}
            >
              <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                {isCompleted ? (
                  <Icon name="check-circle" size={12} className="text-emerald-500" />
                ) : isActive ? (
                  <Icon name="loader" size={12} className="animate-spin motion-reduce:animate-none text-primary" />
                ) : isFailed ? (
                  <Icon name="circle-x" size={12} />
                ) : (
                  <Icon name="circle" size={9} />
                )}
              </span>
              <span className="truncate">{t(translationKey, fallback)}</span>
            </li>
          );
        })}
      </ol>

      {progress.status === 'error' && progress.error && (
        <div className="mt-2 border-t border-border/50 pt-2">
          <details>
            <summary className="cursor-pointer select-none text-muted-foreground hover:text-foreground">
              {t('implement.standaloneLaunch.details', 'Détails')}
            </summary>
            <p className="mt-1 break-words text-destructive/90">{progress.error}</p>
          </details>
          {progress.canRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="mt-2 inline-flex h-6 items-center gap-1 rounded-md border border-border bg-background px-2 font-medium text-foreground transition-colors hover:bg-accent"
            >
              <Icon name="refresh-cw" size={11} />
              {t('implement.standaloneLaunch.retry', 'Réessayer')}
            </button>
          )}
        </div>
      )}
    </div>
  );
};
