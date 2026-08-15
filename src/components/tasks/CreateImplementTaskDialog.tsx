import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { StandaloneTaskKind } from '../../types';
import { cn } from '../../utils/cn';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Icon } from '../ui/Icon';
import type { TaskProjectFilterOption } from './TaskProjectFilter';

interface CreateImplementTaskDialogProps {
  projects: TaskProjectFilterOption[];
  initialProjectId: string | null;
  isCreating: boolean;
  onClose: () => void;
  onCreate: (input: { projectId: string; taskKind: StandaloneTaskKind }) => void;
}

const TASK_KIND_OPTIONS: Array<{
  kind: StandaloneTaskKind;
  icon: 'sparkles' | 'tool' | 'zap';
}> = [
  { kind: 'feature', icon: 'sparkles' },
  { kind: 'bugfix', icon: 'tool' },
  { kind: 'hotfix', icon: 'zap' },
];

export const CreateImplementTaskDialog: React.FC<CreateImplementTaskDialogProps> = ({
  projects,
  initialProjectId,
  isCreating,
  onClose,
  onCreate,
}) => {
  const { t } = useTranslation();
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(initialProjectId);
  const [selectedTaskKind, setSelectedTaskKind] = useState<StandaloneTaskKind | null>(null);
  const [hoveredTaskKind, setHoveredTaskKind] = useState<StandaloneTaskKind | null>(null);
  const [focusedTaskKind, setFocusedTaskKind] = useState<StandaloneTaskKind | null>(null);
  const [query, setQuery] = useState('');
  const editableProjects = projects.filter((project) => !project.isReadOnly);
  const filteredProjects = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return editableProjects;
    return editableProjects.filter((project) =>
      [project.name, project.groupName, project.path]
        .filter(Boolean)
        .some((value) => value?.toLocaleLowerCase().includes(normalized))
    );
  }, [editableProjects, query]);
  const canCreate = Boolean(selectedProjectId && selectedTaskKind) && !isCreating;
  const taskKindDescriptions: Record<StandaloneTaskKind, string> = {
    feature: t('implement.taskKindFeatureHelp', 'Feature creates a branch from the configured development branch and merges it back into that branch.'),
    bugfix: t('implement.taskKindBugfixHelp', 'Bugfix creates a branch from the configured development branch and merges it back into that branch.'),
    hotfix: t('implement.taskKindHotfixHelp', 'Hotfix creates a branch from the configured production branch and merges it back into that branch.'),
  };
  const activeTooltipKind = hoveredTaskKind ?? focusedTaskKind;

  return (
    <Dialog
      title={t('implement.createTaskDialogTitle', 'Create a task')}
      onClose={onClose}
      panelClassName="w-full max-w-lg overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
    >
      <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
        <div>
          <h2 className="text-base font-semibold text-foreground">
            {t('implement.createTaskDialogTitle', 'Create a task')}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t(
              'implement.createTaskDialogDescription',
              'Choose the target project and the task type.'
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label={t('common.close', 'Close')}
        >
          <Icon name="x" size={16} />
        </button>
      </div>

      <div className="space-y-4 px-5 py-4">
        <div className="space-y-2">
          <div>
            <div className="text-xs font-medium text-foreground">
              {t('implement.targetProject', 'Target project')}
            </div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              {t('implement.targetProjectRequiredHelp', 'A project is required. Macro will not select one automatically.')}
            </div>
          </div>
          <div className="flex items-center gap-2 rounded-md border border-border bg-background px-2.5">
            <Icon name="search" size={13} className="text-muted-foreground" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('implement.searchProjects', 'Search projects...')}
              className="h-9 min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
            />
          </div>
          <div className="max-h-56 space-y-1 overflow-y-auto rounded-lg border border-border p-1.5">
            {filteredProjects.map((project) => (
              <button
                key={project.id}
                type="button"
                aria-pressed={selectedProjectId === project.id}
                onClick={() => setSelectedProjectId(project.id)}
                className={cn(
                  'flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left transition-colors',
                  selectedProjectId === project.id
                    ? 'border-primary/30 bg-primary/10'
                    : 'border-transparent hover:border-border hover:bg-accent/60'
                )}
              >
                <Icon name="folder-git-2" size={15} className="shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-foreground">{project.name}</span>
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {project.groupName || project.path}
                  </span>
                </span>
                {selectedProjectId === project.id && <Icon name="check" size={14} className="text-primary" />}
              </button>
            ))}
            {filteredProjects.length === 0 && (
              <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                {t('implement.noEditableProjectsFound', 'No editable project matches this search.')}
              </div>
            )}
          </div>
        </div>

        <fieldset className="space-y-2">
          <legend className="text-xs font-medium text-foreground">
            {t('implement.taskKindLabel', 'Task type')}
          </legend>
          <div className="relative">
            <div className="grid grid-cols-3 gap-2">
              {TASK_KIND_OPTIONS.map(({ kind, icon }) => {
                const selected = selectedTaskKind === kind;
                const label = kind === 'feature'
                  ? t('implement.taskKindFeature', 'Feature')
                  : kind === 'bugfix'
                    ? t('implement.taskKindBugfix', 'Bugfix')
                    : t('implement.taskKindHotfix', 'Hotfix');
                const descriptionId = `implement-task-kind-${kind}-description`;

                return (
                  <button
                    key={kind}
                    type="button"
                    aria-pressed={selected}
                    aria-describedby={descriptionId}
                    onClick={() => setSelectedTaskKind(kind)}
                    onFocus={() => setFocusedTaskKind(kind)}
                    onBlur={() => setFocusedTaskKind(null)}
                    onMouseEnter={() => setHoveredTaskKind(kind)}
                    onMouseLeave={() => setHoveredTaskKind(null)}
                    className={cn(
                      'flex h-10 items-center justify-center gap-2 rounded-md border text-xs font-medium transition-colors',
                      selected
                        ? 'border-primary/40 bg-primary/10 text-foreground'
                        : 'border-border bg-background text-muted-foreground hover:bg-accent hover:text-foreground'
                    )}
                  >
                    <Icon name={icon} size={14} className={selected ? 'text-primary' : undefined} />
                    {label}
                  </button>
                );
              })}
            </div>
            {activeTooltipKind && (
              <div
                role="tooltip"
                className="pointer-events-none absolute bottom-full left-0 right-0 z-20 mb-1.5 rounded-md border border-border bg-popover px-2.5 py-2 text-[11px] leading-snug text-popover-foreground shadow-md"
              >
                {taskKindDescriptions[activeTooltipKind]}
              </div>
            )}
          </div>
          {TASK_KIND_OPTIONS.map(({ kind }) => (
            <span key={kind} id={`implement-task-kind-${kind}-description`} className="sr-only">
              {taskKindDescriptions[kind]}
            </span>
          ))}
        </fieldset>
      </div>

      <div className="flex justify-end gap-2 border-t border-border bg-muted/20 px-5 py-3">
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          {t('common.cancel', 'Cancel')}
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={!canCreate}
          isLoading={isCreating}
          onClick={() => {
            if (selectedProjectId && selectedTaskKind) {
              onCreate({ projectId: selectedProjectId, taskKind: selectedTaskKind });
            }
          }}
        >
          {t('implement.createTaskAction', 'Create task')}
        </Button>
      </div>
    </Dialog>
  );
};
