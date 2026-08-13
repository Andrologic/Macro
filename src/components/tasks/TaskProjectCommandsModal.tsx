import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Switch } from '../ui/Switch';
import { cn } from '../../utils/cn';

interface TaskProjectCommandModalProject {
  projectId: string;
  projectName: string;
  projectPath: string;
  command: string;
  worktreeSetupCommand: string;
  openTerminalOnRun: boolean;
  requiredForTask: boolean;
}

interface TaskProjectCommandsModalProps {
  isOpen: boolean;
  projectGroupName: string;
  projects: TaskProjectCommandModalProject[];
  isSubmitting?: boolean;
  requireRunCommand?: boolean;
  onClose: () => void;
  onSave: (
    projects: Array<{
      projectId: string;
      projectName: string;
      projectPath: string;
      command: string;
      worktreeSetupCommand: string;
      openTerminalOnRun: boolean;
    }>
  ) => void;
}

export const TaskProjectCommandsModal: React.FC<TaskProjectCommandsModalProps> = ({
  isOpen,
  projectGroupName,
  projects,
  isSubmitting = false,
  requireRunCommand = false,
  onClose,
  onSave,
}) => {
  const { t } = useTranslation();
  const [drafts, setDrafts] = useState(projects);

  useEffect(() => {
    if (isOpen) {
      setDrafts(projects);
    }
  }, [isOpen, projects]);

  const hasMissingCommand = useMemo(
    () =>
      requireRunCommand
        ? drafts.some((project) => project.requiredForTask && !project.command.trim())
        : drafts.some(
            (project) =>
              project.requiredForTask &&
              !project.command.trim() &&
              !project.worktreeSetupCommand.trim()
          ),
    [drafts, requireRunCommand]
  );

  if (!isOpen) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[95] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/50"
        onClick={() => {
          if (!isSubmitting) {
            onClose();
          }
        }}
      />

      <div className="relative flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-foreground">
              {t('project.projectSettings', 'Paramètres du projet')}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {t(
                'implement.taskCommandsModalDescription',
                'Définis une commande par projet pour {{project}}. Ces commandes seront réutilisées par toutes les tâches.',
                { project: projectGroupName }
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            title={t('common.close', 'Close')}
          >
            <Icon name="x" size={16} />
          </button>
        </header>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {drafts.map((project, index) => (
            <section
              key={project.projectId}
              className="rounded-xl border border-border bg-background/40 p-4"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-foreground">{project.projectName}</div>
                  <div className="mt-1 truncate text-xs text-muted-foreground">
                    {project.projectPath}
                  </div>
                </div>
                <span
                  className={cn(
                    'inline-flex rounded-full border px-2 py-0.5 text-[11px]',
                    project.command.trim() || project.worktreeSetupCommand.trim()
                      ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-500'
                      : 'border-amber-500/20 bg-amber-500/10 text-amber-500'
                  )}
                >
                  {project.command.trim() || project.worktreeSetupCommand.trim()
                    ? t('implement.taskCommandConfigured', 'Configured')
                    : t('implement.taskCommandMissing', 'Missing')}
                </span>
              </div>

              <div className="mt-3">
                <label className="mb-2 block text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t('implement.worktreeSetupCommandLabel', 'Worktree setup command')}
                </label>
                <textarea
                  value={project.worktreeSetupCommand}
                  onChange={(event) => {
                    const value = event.target.value;
                    setDrafts((current) =>
                      current.map((entry, entryIndex) =>
                        entryIndex === index ? { ...entry, worktreeSetupCommand: value } : entry
                      )
                    );
                  }}
                  rows={3}
                  className="min-h-[88px] w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  placeholder={t(
                    'implement.worktreeSetupCommandPlaceholder',
                    'Ex: bun install'
                  )}
                />
              </div>

              <div className="mt-3">
                <label className="mb-2 block text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t('implement.taskCommandLabel', 'Run command')}
                </label>
                <textarea
                  value={project.command}
                  onChange={(event) => {
                    const value = event.target.value;
                    setDrafts((current) =>
                      current.map((entry, entryIndex) =>
                        entryIndex === index ? { ...entry, command: value } : entry
                      )
                    );
                  }}
                  rows={3}
                  className="min-h-[88px] w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  placeholder={t(
                    'implement.taskCommandPlaceholder',
                    'Ex: bun test'
                  )}
                />
              </div>

              <div className="mt-4 flex items-center justify-between rounded-lg border border-border bg-card/40 px-3 py-2">
                <div className="pr-3">
                  <div className="text-sm font-medium text-foreground">
                    {t('terminal.openOnLaunch', 'Open terminal when launched')}
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {t(
                      'terminal.openOnLaunchDescription',
                      'Automatically reveal the split when this command starts for the project.'
                    )}
                  </p>
                </div>
                <Switch
                  checked={project.openTerminalOnRun}
                  onCheckedChange={(checked) => {
                    setDrafts((current) =>
                      current.map((entry, entryIndex) =>
                        entryIndex === index
                          ? { ...entry, openTerminalOnRun: checked }
                          : entry
                      )
                    );
                  }}
                />
              </div>
            </section>
          ))}
        </div>

        <footer className="flex shrink-0 flex-col gap-3 border-t border-border px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">
            {hasMissingCommand
              ? requireRunCommand
                ? t(
                    'implement.taskCommandsModalRunIncomplete',
                    'Renseigne une commande de run pour chaque projet requis avant de sauvegarder.'
                  )
                : t(
                    'implement.taskCommandsModalIncomplete',
                    'Renseigne une commande ou un setup pour chaque projet avant de sauvegarder.'
                  )
              : t(
                  'implement.taskCommandsModalReady',
                  'Les commandes seront exécutées dans le worktree de la tâche pour chaque projet concerné.'
                )}
          </p>
          <div className="flex shrink-0 items-center justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={onClose} disabled={isSubmitting}>
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button
              size="sm"
              isLoading={isSubmitting}
              disabled={isSubmitting || hasMissingCommand}
              onClick={() =>
                onSave(
                  drafts.map((project) => ({
                    projectId: project.projectId,
                    projectName: project.projectName,
                    projectPath: project.projectPath,
                    command: project.command.trim(),
                    worktreeSetupCommand: project.worktreeSetupCommand.trim(),
                    openTerminalOnRun: project.openTerminalOnRun,
                  }))
                )
              }
            >
              {t('common.save', 'Save')}
            </Button>
          </div>
        </footer>
      </div>
    </div>
  );
};

export default TaskProjectCommandsModal;
