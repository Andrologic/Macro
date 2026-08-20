import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { StandaloneTaskKind } from '../../types';
import { cn } from '../../utils/cn';
import { getCreatableStandaloneTaskKinds } from '../../services/standaloneTaskKinds';
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

const TOOLTIP_OFFSET = 12;
const TOOLTIP_VIEWPORT_MARGIN = 8;
const TOOLTIP_ESTIMATED_SIZE = { width: 320, height: 80 };

type TaskKindTooltipAnchor =
  | { kind: StandaloneTaskKind; source: 'pointer'; x: number; y: number }
  | { kind: StandaloneTaskKind; source: 'focus'; rect: DOMRect };

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.max(minimum, Math.min(value, maximum));

const resolveTooltipPosition = (
  anchor: TaskKindTooltipAnchor,
  size: { width: number; height: number }
): { left: number; top: number } => {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const maximumLeft = Math.max(TOOLTIP_VIEWPORT_MARGIN, viewportWidth - size.width - TOOLTIP_VIEWPORT_MARGIN);
  const maximumTop = Math.max(TOOLTIP_VIEWPORT_MARGIN, viewportHeight - size.height - TOOLTIP_VIEWPORT_MARGIN);

  if (anchor.source === 'pointer') {
    const preferredLeft = anchor.x + TOOLTIP_OFFSET;
    const preferredTop = anchor.y + TOOLTIP_OFFSET;
    return {
      left: clamp(
        preferredLeft + size.width > viewportWidth - TOOLTIP_VIEWPORT_MARGIN
          ? anchor.x - size.width - TOOLTIP_OFFSET
          : preferredLeft,
        TOOLTIP_VIEWPORT_MARGIN,
        maximumLeft
      ),
      top: clamp(
        preferredTop + size.height > viewportHeight - TOOLTIP_VIEWPORT_MARGIN
          ? anchor.y - size.height - TOOLTIP_OFFSET
          : preferredTop,
        TOOLTIP_VIEWPORT_MARGIN,
        maximumTop
      ),
    };
  }

  const preferredTop = anchor.rect.bottom + TOOLTIP_OFFSET;
  return {
    left: clamp(anchor.rect.left, TOOLTIP_VIEWPORT_MARGIN, maximumLeft),
    top: clamp(
      preferredTop + size.height > viewportHeight - TOOLTIP_VIEWPORT_MARGIN
        ? anchor.rect.top - size.height - TOOLTIP_OFFSET
        : preferredTop,
      TOOLTIP_VIEWPORT_MARGIN,
      maximumTop
    ),
  };
};

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
  const [pointerTooltipAnchor, setPointerTooltipAnchor] = useState<TaskKindTooltipAnchor | null>(null);
  const [focusTooltipAnchor, setFocusTooltipAnchor] = useState<TaskKindTooltipAnchor | null>(null);
  const [tooltipSize, setTooltipSize] = useState(TOOLTIP_ESTIMATED_SIZE);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const editableProjects = useMemo(
    () => projects.filter((project) => !project.isReadOnly),
    [projects],
  );
  const filteredProjects = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return editableProjects;
    return editableProjects.filter((project) =>
      [project.name, project.groupName, project.path]
        .filter(Boolean)
        .some((value) => value?.toLocaleLowerCase().includes(normalized))
    );
  }, [editableProjects, query]);
  const selectedProject = editableProjects.find((project) => project.id === selectedProjectId) ?? null;
  const isDirectEditProject = Boolean(
    selectedProject?.directEdit && selectedProject.gitSetupState === 'not_git'
  );
  const creatableTaskKinds = useMemo(
    () => selectedProject
      ? isDirectEditProject
        ? ['feature'] as StandaloneTaskKind[]
        : getCreatableStandaloneTaskKinds(selectedProject.gitFlowSettings)
      : [],
    [isDirectEditProject, selectedProject],
  );
  const visibleTaskKindOptions = isDirectEditProject
    ? TASK_KIND_OPTIONS.filter(({ kind }) => kind === 'feature')
    : TASK_KIND_OPTIONS;
  const selectedTaskKindIsCreatable = selectedTaskKind
    ? creatableTaskKinds.includes(selectedTaskKind)
    : false;
  const canCreate = Boolean(selectedProject && selectedTaskKindIsCreatable) && !isCreating;
  const taskKindDescriptions: Record<StandaloneTaskKind, string> = {
    feature: t('implement.taskKindFeatureHelp', 'Feature creates a branch from the configured development branch and merges it back into that branch.'),
    bugfix: t('implement.taskKindBugfixHelp', 'Bugfix creates a branch from the configured development branch and merges it back into that branch.'),
    hotfix: t('implement.taskKindHotfixHelp', 'Hotfix creates a branch from the configured production branch and merges it back into that branch.'),
  };
  const getTaskKindDescription = (kind: StandaloneTaskKind): string => {
    if (!selectedProject) {
      return t(
        'implement.taskKindSelectProjectHelp',
        'Select a target project to see which task types are available.',
      );
    }
    if (!creatableTaskKinds.includes(kind)) {
      return t(
        'implement.taskKindBugfixUnavailableMainlineHelp',
        'Bugfix requires a development branch distinct from the production branch. This project uses a mainline workflow.',
      );
    }
    return taskKindDescriptions[kind];
  };
  const tooltipAnchor = pointerTooltipAnchor ?? focusTooltipAnchor;
  const tooltipPosition = tooltipAnchor
    ? resolveTooltipPosition(tooltipAnchor, tooltipSize)
    : null;

  useLayoutEffect(() => {
    const tooltip = tooltipRef.current;
    if (!tooltipAnchor || !tooltip) return;
    const rect = tooltip.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0 &&
      (rect.width !== tooltipSize.width || rect.height !== tooltipSize.height)) {
      setTooltipSize({ width: rect.width, height: rect.height });
    }
  }, [tooltipAnchor, tooltipSize.height, tooltipSize.width]);

  useEffect(() => {
    if (isDirectEditProject && selectedTaskKind !== 'feature') {
      setSelectedTaskKind('feature');
      return;
    }
    if (selectedTaskKind && !creatableTaskKinds.includes(selectedTaskKind)) {
      setSelectedTaskKind(null);
    }
  }, [creatableTaskKinds, isDirectEditProject, selectedTaskKind]);

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
                <Icon
                  name={project.directEdit ? 'folder' : 'folder-git-2'}
                  size={15}
                  className="shrink-0 text-muted-foreground"
                />
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
          <div className={cn('grid gap-2', isDirectEditProject ? 'grid-cols-1' : 'grid-cols-3')}>
            {visibleTaskKindOptions.map(({ kind, icon }) => {
              const selected = selectedTaskKind === kind;
              const label = isDirectEditProject
                ? t('implement.taskKindDirectEdit', 'Direct edit')
                : kind === 'feature'
                ? t('implement.taskKindFeature', 'Feature')
                : kind === 'bugfix'
                  ? t('implement.taskKindBugfix', 'Bugfix')
                  : t('implement.taskKindHotfix', 'Hotfix');
              const descriptionId = `implement-task-kind-${kind}-description`;
              const isCreatable = creatableTaskKinds.includes(kind);

              return (
                  <button
                    key={kind}
                    type="button"
                    aria-pressed={selected}
                    aria-disabled={!isCreatable}
                    aria-describedby={descriptionId}
                    data-task-kind-available={isCreatable ? 'true' : 'false'}
                    onClick={() => {
                      if (isCreatable) setSelectedTaskKind(kind);
                    }}
                    onFocus={(event) => setFocusTooltipAnchor({
                      kind,
                      source: 'focus',
                      rect: event.currentTarget.getBoundingClientRect(),
                    })}
                    onBlur={() => setFocusTooltipAnchor(null)}
                    onMouseEnter={(event) => setPointerTooltipAnchor({
                      kind,
                      source: 'pointer',
                      x: event.clientX,
                      y: event.clientY,
                    })}
                    onMouseMove={(event) => setPointerTooltipAnchor({
                      kind,
                      source: 'pointer',
                      x: event.clientX,
                      y: event.clientY,
                    })}
                    onMouseLeave={() => setPointerTooltipAnchor(null)}
                    className={cn(
                      'flex h-10 items-center justify-center gap-2 rounded-md border text-xs font-medium transition-colors',
                      selected
                        ? 'border-primary/40 bg-primary/10 text-foreground'
                        : isCreatable
                          ? 'border-border bg-background text-muted-foreground hover:bg-accent hover:text-foreground'
                          : 'cursor-not-allowed border-border/60 bg-muted/20 text-muted-foreground/50'
                    )}
                  >
                    <Icon name={icon} size={14} className={selected ? 'text-primary' : undefined} />
                    {label}
                  </button>
              );
            })}
          </div>
          {visibleTaskKindOptions.map(({ kind }) => (
            <span key={kind} id={`implement-task-kind-${kind}-description`} className="sr-only">
              {isDirectEditProject
                ? t(
                    'implement.taskKindDirectEditHelp',
                    'Macro edits the project folder directly without branches, worktrees, or Git commits.'
                  )
                : getTaskKindDescription(kind)}
            </span>
          ))}
        </fieldset>
      </div>

      {tooltipAnchor && tooltipPosition && createPortal(
        <div
          ref={tooltipRef}
          role="tooltip"
          className="pointer-events-none fixed z-[100] max-w-80 rounded-md border border-border bg-popover px-2.5 py-2 text-[11px] leading-snug text-popover-foreground shadow-md"
          style={{ left: tooltipPosition.left, top: tooltipPosition.top }}
        >
          {getTaskKindDescription(tooltipAnchor.kind)}
        </div>,
        document.body
      )}

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
