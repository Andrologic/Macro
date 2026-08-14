import React, { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../utils/cn';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Icon } from '../ui/Icon';
import { Textarea } from '../ui/Textarea';
import type { TaskProjectFilterOption } from './TaskProjectFilter';

interface CreateImplementTaskDialogProps {
  projects: TaskProjectFilterOption[];
  initialProjectId: string | null;
  isCreating: boolean;
  onClose: () => void;
  onCreate: (input: { projectId: string; request: string }) => void;
}

export const CreateImplementTaskDialog: React.FC<CreateImplementTaskDialogProps> = ({
  projects,
  initialProjectId,
  isCreating,
  onClose,
  onCreate,
}) => {
  const { t } = useTranslation();
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(initialProjectId);
  const [request, setRequest] = useState('');
  const [query, setQuery] = useState('');
  const requestInputRef = useRef<HTMLTextAreaElement>(null);
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
  const canCreate = Boolean(selectedProjectId && request.trim()) && !isCreating;

  return (
    <Dialog
      title={t('implement.createTaskDialogTitle', 'Create a task')}
      onClose={onClose}
      panelClassName="w-full max-w-lg overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
      initialFocusRef={requestInputRef}
    >
      <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
        <div>
          <h2 className="text-base font-semibold text-foreground">
            {t('implement.createTaskDialogTitle', 'Create a task')}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t(
              'implement.createTaskDialogDescription',
              'Choose the project. The agent will then determine the task type from your request.'
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

      <div className="space-y-5 px-5 py-4">
        <label className="block space-y-2">
          <span className="text-xs font-medium text-foreground">
            {t('implement.taskRequest', 'Request for the agent')}
          </span>
          <Textarea
            ref={requestInputRef}
            value={request}
            onChange={(event) => setRequest(event.target.value)}
            placeholder={t(
              'implement.taskRequestPlaceholder',
              'Describe what the agent should implement or fix...'
            )}
            rows={4}
            maxLength={4000}
            className="min-h-24 resize-y"
          />
          <span className="flex items-start gap-2 rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-[11px] text-muted-foreground">
            <Icon name="sparkles" size={13} className="mt-0.5 shrink-0 text-primary" />
            <span>
              {t(
                'implement.taskKindAutomaticHelp',
                'The agent will analyze this request and classify it as a feature, bugfix, or hotfix.'
              )}
            </span>
          </span>
        </label>

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
            if (selectedProjectId && request.trim()) {
              onCreate({ projectId: selectedProjectId, request: request.trim() });
            }
          }}
        >
          {t('implement.analyzeAndCreateTaskAction', 'Analyze and create task')}
        </Button>
      </div>
    </Dialog>
  );
};
