import React from 'react';
import { useTranslation } from 'react-i18next';
import type { ProjectWorkspaceStateKind } from '../../services/projectWorkspaceState';
import { cn } from '../../utils/cn';
import { Icon } from '../ui/Icon';

interface ProjectWorkspaceEmptyStateProps {
  stateKind: Extract<ProjectWorkspaceStateKind, 'noProjectAvailable' | 'noProjectSelected'>;
  className?: string;
  compact?: boolean;
  variant?: 'primary' | 'secondary';
  panelKind?: 'needs' | 'strategy' | 'tasks' | 'changes' | 'generic';
  onPrimaryAction?: () => void;
}

export const ProjectWorkspaceEmptyState: React.FC<ProjectWorkspaceEmptyStateProps> = ({
  stateKind,
  className,
  compact = false,
  variant = 'primary',
  panelKind = 'generic',
  onPrimaryAction,
}) => {
  const { t } = useTranslation();
  const isNoProjectAvailable = stateKind === 'noProjectAvailable';
  const isSecondary = variant === 'secondary';
  const secondaryCopy = {
    needs: t('project.emptyWorkspaceNeedsPanel', 'Les besoins seront disponibles après l’ajout d’un projet.'),
    strategy: t('project.emptyWorkspaceStrategyPanel', 'La stratégie sera disponible après l’ajout d’un projet.'),
    tasks: t('project.emptyWorkspaceTasksPanel', 'Les tâches seront disponibles après l’ajout d’un projet.'),
    changes: t('project.emptyWorkspaceChangesPanel', 'Les changements seront disponibles après l’ajout d’un projet.'),
    generic: t('project.emptyWorkspaceSecondary', 'Ce panneau sera disponible après l’ajout d’un projet.'),
  }[panelKind];

  return (
    <div
      className={cn(
        'flex h-full w-full items-center justify-center px-6 text-center',
        compact ? 'py-5' : 'py-10',
        className
      )}
    >
      <div className={cn(isSecondary ? 'max-w-[240px]' : 'max-w-sm')}>
        <div
          className={cn(
            'mx-auto flex items-center justify-center rounded-2xl border border-border bg-card/70',
            isSecondary
              ? 'mb-3 h-10 w-10 rounded-xl'
              : compact
                ? 'mb-4 h-12 w-12'
                : 'mb-4 h-16 w-16'
          )}
        >
          <Icon
            name={isSecondary ? 'lock' : 'layers'}
            size={isSecondary ? 16 : compact ? 20 : 26}
            className={isSecondary ? 'text-muted-foreground' : 'text-primary'}
          />
        </div>
        {isSecondary ? (
          <p className="text-xs leading-relaxed text-muted-foreground">{secondaryCopy}</p>
        ) : (
          <>
            <h3 className="text-sm font-semibold text-foreground">
              {isNoProjectAvailable
                ? t('project.emptyWorkspaceTitle', 'Ajoutez un projet pour commencer avec Macro.')
                : t('project.noProjectSelectedTitle', 'Sélectionnez un projet pour continuer.')}
            </h3>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              {isNoProjectAvailable
                ? t(
                    'project.emptyWorkspaceBody',
                    'Architect et Implement ont besoin d’un projet pour créer des plans, des tâches, des branches et des worktrees.'
                  )
                : t(
                    'project.noProjectSelectedBody',
                    'Choisissez un projet existant ou ajoutez-en un pour débloquer les actions Macro.'
                  )}
            </p>
          </>
        )}
        {!isSecondary && onPrimaryAction && (
          <button
            type="button"
            onClick={onPrimaryAction}
            className="mt-4 inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            <Icon name="plus" size={12} />
            {isNoProjectAvailable
              ? t('project.addProject', 'Add project')
              : t('project.addOrSelectProject', 'Add project')}
          </button>
        )}
      </div>
    </div>
  );
};

export default ProjectWorkspaceEmptyState;
