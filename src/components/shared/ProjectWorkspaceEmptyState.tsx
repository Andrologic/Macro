import React from 'react';
import { useTranslation } from 'react-i18next';
import type { ProjectWorkspaceStateKind } from '../../services/projectWorkspaceState';
import { cn } from '../../utils/cn';
import { Icon } from '../ui/Icon';

interface ProjectWorkspaceEmptyStateProps {
  stateKind: Extract<ProjectWorkspaceStateKind, 'noProjectAvailable' | 'noProjectSelected'>;
  className?: string;
  compact?: boolean;
  onPrimaryAction?: () => void;
}

export const ProjectWorkspaceEmptyState: React.FC<ProjectWorkspaceEmptyStateProps> = ({
  stateKind,
  className,
  compact = false,
  onPrimaryAction,
}) => {
  const { t } = useTranslation();
  const isNoProjectAvailable = stateKind === 'noProjectAvailable';

  return (
    <div
      className={cn(
        'flex h-full w-full items-center justify-center px-6 text-center',
        compact ? 'py-5' : 'py-10',
        className
      )}
    >
      <div className="max-w-sm">
        <div
          className={cn(
            'mx-auto mb-4 flex items-center justify-center rounded-2xl border border-border bg-card/70',
            compact ? 'h-12 w-12' : 'h-16 w-16'
          )}
        >
          <Icon name="layers" size={compact ? 20 : 26} className="text-primary" />
        </div>
        <h3 className="text-sm font-semibold text-foreground">
          {isNoProjectAvailable
            ? t('project.emptyWorkspaceTitle', 'Ajoutez un sous-projet pour commencer avec Macro.')
            : t('project.noProjectSelectedTitle', 'Sélectionnez un projet pour continuer.')}
        </h3>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          {isNoProjectAvailable
            ? t(
                'project.emptyWorkspaceBody',
                'Architect et Implement ont besoin d’un sous-projet pour créer des plans, des tâches, des branches et des worktrees.'
              )
            : t(
                'project.noProjectSelectedBody',
                'Choisissez un projet existant ou ajoutez un sous-projet pour débloquer les actions Macro.'
              )}
        </p>
        {onPrimaryAction && (
          <button
            type="button"
            onClick={onPrimaryAction}
            className="mt-4 inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            <Icon name="plus" size={12} />
            {isNoProjectAvailable
              ? t('project.addSubproject', 'Add subproject')
              : t('project.addOrSelectSubproject', 'Add subproject')}
          </button>
        )}
      </div>
    </div>
  );
};

export default ProjectWorkspaceEmptyState;
