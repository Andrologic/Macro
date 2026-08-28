import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { StandaloneTaskKind } from '../../types';
import { cn } from '../../utils/cn';
import { getCreatableStandaloneTaskKinds } from '../../services/standaloneTaskKinds';
import { resolveProjectExecutionMode } from '../../services/projectExecutionMode';
import {
  gitTaskStartPoints,
  type GitAvailableTaskBranchDto,
  type GitAvailableWorktreeDto,
} from '../../services/tauriIpc';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Icon } from '../ui/Icon';
import { ProjectIcon } from '../project/ProjectIcon';
import type { TaskProjectFilterOption } from './TaskProjectFilter';

interface CreateImplementTaskDialogProps {
  projects: TaskProjectFilterOption[];
  initialProjectId: string | null;
  isCreating: boolean;
  onClose: () => void;
  onCreate: (input: {
    projectId: string;
    taskKind: StandaloneTaskKind;
    startPoint:
      | { kind: 'new' }
      | { kind: 'worktree'; worktree: GitAvailableWorktreeDto }
      | { kind: 'branch'; branch: GitAvailableTaskBranchDto };
  }) => void;
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
  const [worktrees, setWorktrees] = useState<GitAvailableWorktreeDto[]>([]);
  const [branches, setBranches] = useState<GitAvailableTaskBranchDto[]>([]);
  const [workspaceChoice, setWorkspaceChoice] = useState<'new' | 'existing'>('new');
  const [selectedStartPointKey, setSelectedStartPointKey] = useState<string | null>(null);
  const [startPointQuery, setStartPointQuery] = useState('');
  const [isLoadingWorktrees, setIsLoadingWorktrees] = useState(false);
  const [startPointLoadFailed, setStartPointLoadFailed] = useState(false);
  const [startPointLoadRequest, setStartPointLoadRequest] = useState(0);
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
  const selectedWorktree = worktrees.find(
    (worktree) => selectedStartPointKey === `worktree:${worktree.path}`
  ) ?? null;
  const selectedBranch = branches.find(
    (branch) => selectedStartPointKey === `branch:${branch.name}`
  ) ?? null;
  const normalizedStartPointQuery = startPointQuery.trim().toLocaleLowerCase();
  const filteredWorktrees = normalizedStartPointQuery
    ? worktrees.filter((worktree) =>
        `${worktree.branchName} ${worktree.path}`.toLocaleLowerCase().includes(normalizedStartPointQuery)
      )
    : worktrees;
  const filteredBranches = normalizedStartPointQuery
    ? branches.filter((branch) => branch.name.toLocaleLowerCase().includes(normalizedStartPointQuery))
    : branches;
  const isDirectEditProject = selectedProject
    ? resolveProjectExecutionMode({
        project: {
          ...selectedProject,
          userReadOnly: false,
        },
      }).mode === 'direct'
    : false;
  const creatableTaskKinds = useMemo(
    () => selectedProject
      ? isDirectEditProject
        ? TASK_KIND_OPTIONS.map(({ kind }) => kind)
        : getCreatableStandaloneTaskKinds(selectedProject.gitFlowSettings)
      : [],
    [isDirectEditProject, selectedProject],
  );
  const visibleTaskKindOptions = TASK_KIND_OPTIONS;
  const selectedTaskKindIsCreatable = selectedTaskKind
    ? creatableTaskKinds.includes(selectedTaskKind)
    : false;
  const canCreate = Boolean(
    selectedProject &&
    selectedTaskKindIsCreatable &&
    (workspaceChoice === 'new' || selectedWorktree || selectedBranch)
  ) && !isCreating;
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

  const startPointPicker = (
    <aside
      aria-label={t('implement.taskWorkspaceExisting', 'Resume work')}
      className="flex h-full min-h-0 w-full flex-col border-l border-border bg-muted/10"
    >
      <div className="shrink-0 border-b border-border px-4 py-4">
        <div className="flex items-center gap-2">
          <Icon name="folder-git-2" size={14} className="text-primary" />
          <h3 className="text-sm font-semibold text-foreground">
            {t('implement.taskWorkspaceExisting', 'Resume work')}
          </h3>
        </div>
      </div>
      <div className="shrink-0 p-3 pb-2">
        <div className="flex items-center gap-2 rounded-md border border-border bg-background px-2.5">
          <Icon name="search" size={12} className="text-muted-foreground" />
          <input
            value={startPointQuery}
            onChange={(event) => setStartPointQuery(event.target.value)}
            placeholder={t('implement.taskWorkspaceSearch', 'Search branches and worktrees...')}
            className="h-8 min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 pb-3">
        {filteredWorktrees.length > 0 && (
          <div className="space-y-1">
            <div className="px-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              {t('implement.taskWorkspaceWorktreesSection', 'Existing worktrees')}
            </div>
            {filteredWorktrees.map((worktree) => (
              <button
                key={worktree.path}
                type="button"
                aria-pressed={selectedStartPointKey === `worktree:${worktree.path}`}
                onClick={() => setSelectedStartPointKey(`worktree:${worktree.path}`)}
                className={cn(
                  'flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left',
                  selectedStartPointKey === `worktree:${worktree.path}`
                    ? 'border-primary/30 bg-primary/10'
                    : 'border-border bg-background hover:bg-accent/60'
                )}
              >
                <Icon name="folder-git-2" size={14} className="text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-foreground">{worktree.branchName}</span>
                  <span className="block truncate text-[11px] text-muted-foreground">{worktree.path}</span>
                </span>
                <span className={cn('text-[10px]', worktree.isDirty ? 'text-amber-500' : 'text-muted-foreground')}>
                  {worktree.isDirty
                    ? t('implement.taskWorkspaceModified', 'Modified')
                    : t('implement.taskWorkspaceClean', 'Clean')}
                </span>
              </button>
            ))}
          </div>
        )}

        {filteredBranches.length > 0 && (
          <div className="space-y-1">
            <div className="px-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              {t('implement.taskWorkspaceBranchesSection', 'Branches without a worktree')}
            </div>
            {filteredBranches.map((branch) => {
              const isBaseBranch = [
                selectedProject?.gitFlowSettings?.baseBranch,
                selectedProject?.gitFlowSettings?.mainBranch,
              ].some((candidate) => candidate?.trim() === branch.name);
              return (
                <button
                  key={branch.name}
                  type="button"
                  aria-pressed={selectedStartPointKey === `branch:${branch.name}`}
                  onClick={() => setSelectedStartPointKey(`branch:${branch.name}`)}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left',
                    selectedStartPointKey === `branch:${branch.name}`
                      ? 'border-primary/30 bg-primary/10'
                      : 'border-border bg-background hover:bg-accent/60'
                  )}
                >
                  <Icon name="git-branch" size={14} className="text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-foreground">{branch.name}</span>
                    <span className="block text-[11px] text-muted-foreground">
                      {t('implement.taskWorkspaceBranchHelp', 'A worktree will be created for this branch.')}
                    </span>
                  </span>
                  {isBaseBranch && (
                    <span className="text-[10px] text-amber-500">
                      {t('implement.taskWorkspaceBaseBranch', 'Base branch')}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {!isLoadingWorktrees && !startPointLoadFailed && filteredWorktrees.length === 0 && filteredBranches.length === 0 && (
          <p className="px-2 py-4 text-center text-[11px] text-muted-foreground">
            {normalizedStartPointQuery
              ? t('implement.taskWorkspaceNoMatch', 'No branch or worktree matches this search.')
              : t('implement.taskWorkspaceNone', 'No external worktree or free local branch is available.')}
          </p>
        )}
        {isLoadingWorktrees && (
          <p className="px-2 py-4 text-center text-[11px] text-muted-foreground">
            {t('implement.taskWorkspaceLoading', 'Loading branches and worktrees...')}
          </p>
        )}
        {startPointLoadFailed && (
          <div className="flex items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2">
            <span className="text-[11px] text-destructive">
              {t('implement.taskWorkspaceLoadFailed', 'Branches and worktrees could not be loaded.')}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setStartPointLoadRequest((request) => request + 1)}
            >
              {t('common.retry', 'Retry')}
            </Button>
          </div>
        )}
      </div>
    </aside>
  );

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
    if (selectedTaskKind && !creatableTaskKinds.includes(selectedTaskKind)) {
      setSelectedTaskKind(null);
    }
  }, [creatableTaskKinds, selectedTaskKind]);

  useEffect(() => {
    let cancelled = false;
    setWorkspaceChoice('new');
    setSelectedStartPointKey(null);
    setStartPointQuery('');
    setWorktrees([]);
    setBranches([]);
    setStartPointLoadFailed(false);
    if (!selectedProject || isDirectEditProject) return () => { cancelled = true; };
    setIsLoadingWorktrees(true);
    void gitTaskStartPoints({ repoPath: selectedProject.path })
      .then((startPoints) => {
        if (!cancelled) {
          setWorktrees(startPoints.worktrees);
          setBranches(startPoints.branches);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setWorktrees([]);
          setBranches([]);
          setStartPointLoadFailed(true);
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoadingWorktrees(false);
      });
    return () => { cancelled = true; };
  }, [isDirectEditProject, selectedProject, startPointLoadRequest]);

  return (
    <Dialog
      title={t('implement.createTaskDialogTitle', 'Create a task')}
      onClose={onClose}
      panelClassName={cn(
        'flex h-[min(46rem,calc(100vh-2rem))] w-full flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl transition-[max-width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
        workspaceChoice === 'existing' && !isDirectEditProject && selectedProject
          ? 'max-w-5xl'
          : 'max-w-2xl'
      )}
    >
      <div className="flex shrink-0 items-start justify-between gap-4 border-b border-border px-5 py-4">
        <div>
          <h2 className="text-base font-semibold text-foreground">
            {t('implement.createTaskDialogTitle', 'Create a task')}
          </h2>
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

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col gap-4 overflow-hidden px-5 py-4">
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <div>
            <div className="text-xs font-medium text-foreground">
              {t('implement.targetProject', 'Target project')}
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
          <div
            aria-label={t('implement.targetProject', 'Target project')}
            className="min-h-36 flex-1 space-y-1 overflow-y-auto rounded-lg border border-border p-1.5"
          >
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
                <ProjectIcon
                  project={project}
                  fallbackIcon={project.directEdit ? 'folder' : 'folder-git-2'}
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
          <div className="grid grid-cols-3 gap-2">
            {visibleTaskKindOptions.map(({ kind, icon }) => {
              const selected = selectedTaskKind === kind;
              const label = kind === 'feature'
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

        {!isDirectEditProject && selectedProject && (
          <fieldset className="space-y-2">
            <legend className="text-xs font-medium text-foreground">
              {t('implement.taskWorkspaceLabel', 'Starting point')}
            </legend>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                aria-pressed={workspaceChoice === 'new'}
                onClick={() => {
                  setWorkspaceChoice('new');
                  setSelectedStartPointKey(null);
                }}
                className={cn(
                  'flex min-h-16 items-center gap-3 rounded-md border px-3 py-2 text-left',
                  workspaceChoice === 'new' ? 'border-primary/30 bg-primary/10' : 'border-border bg-background hover:bg-accent/60'
                )}
              >
                <Icon name="plus" size={14} className="text-muted-foreground" />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-foreground">
                    {t('implement.taskWorkspaceNew', 'New work')}
                  </span>
                  <span className="block text-[11px] text-muted-foreground">
                    {t('implement.taskWorkspaceNewHelp', 'Create a branch and a worktree.')}
                  </span>
                </span>
              </button>
              <button
                type="button"
                aria-pressed={workspaceChoice === 'existing'}
                onClick={() => setWorkspaceChoice('existing')}
                className={cn(
                  'flex min-h-16 items-center gap-3 rounded-md border px-3 py-2 text-left',
                  workspaceChoice === 'existing' ? 'border-primary/30 bg-primary/10' : 'border-border bg-background hover:bg-accent/60'
                )}
              >
                <Icon name="folder-git-2" size={14} className="text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-foreground">
                    {t('implement.taskWorkspaceExisting', 'Resume work')}
                  </span>
                  {(selectedWorktree || selectedBranch) && (
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {selectedWorktree?.branchName || selectedBranch?.name}
                    </span>
                  )}
                  {!selectedWorktree && !selectedBranch && (
                    <span className="block text-[11px] text-muted-foreground">
                      {t(
                        'implement.taskWorkspaceExistingHelp',
                        'Reuse a worktree or create one from an existing branch.'
                      )}
                    </span>
                  )}
                </span>
              </button>
            </div>
          </fieldset>
        )}
        </div>
        <div
          aria-hidden={workspaceChoice !== 'existing'}
          className={cn(
            'min-h-0 shrink-0 overflow-hidden transition-[width,max-width,opacity] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
            workspaceChoice === 'existing' && !isDirectEditProject && selectedProject
              ? 'w-[26rem] max-w-[44vw] opacity-100'
              : 'w-0 max-w-0 opacity-0'
          )}
        >
          {workspaceChoice === 'existing' && !isDirectEditProject && selectedProject && startPointPicker}
        </div>
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

      <div className="flex shrink-0 justify-end gap-2 border-t border-border bg-muted/20 px-5 py-3">
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
              onCreate({
                projectId: selectedProjectId,
                taskKind: selectedTaskKind,
                startPoint: workspaceChoice === 'new'
                  ? { kind: 'new' }
                  : selectedWorktree
                    ? { kind: 'worktree', worktree: selectedWorktree }
                    : { kind: 'branch', branch: selectedBranch! },
              });
            }
          }}
        >
          {t('implement.createTaskAction', 'Create task')}
        </Button>
      </div>
    </Dialog>
  );
};
