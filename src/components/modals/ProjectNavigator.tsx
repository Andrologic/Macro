import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  DndContext,
  DragEndEvent,
  DragOverlay,
  DragStartEvent,
  PointerSensor,
  closestCenter,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { useAppStore } from '../../stores/useAppStore';
import { getServiceRuntimeCapabilities } from '../../services';
import { toServiceError } from '../../services/contracts/errors';
import { Icon } from '../ui/Icon';
import { SpinnerIcon } from '../ui/SpinnerIcon';
import { SearchBar } from '../ui/SearchBar';
import { ConfirmPromptModal } from '../ui/ConfirmPromptModal';
import { GroupCombobox } from '../ui/GroupCombobox';
import { notify } from '../ui/toastService';
import { cn } from '../../utils/cn';
import { isDevelopmentBuild } from '../../utils/devLogger';
import type { Project, ProjectGroup } from '../../types';
import {
  getEmptyProjectOpenSelection,
  loadProjectOpenSettings,
  openProjectInExternalApp,
  PROJECT_OPEN_ACTIONS,
  shouldRenderProjectOpenAction,
  type ProjectOpenAction,
  type ProjectOpenAppSelection,
} from '../../services/projectOpeners';

interface ProjectNavigatorProps {
  isOpen: boolean;
  onClose: () => void;
}

interface ProjectItemProps {
  project: Project;
  groupId: string | null;
  onSelect: () => void;
  onMenuOpen: (e: React.MouseEvent<HTMLButtonElement>) => void;
  onOpenExternal: (action: ProjectOpenAction) => void;
  busyAction: ProjectOpenAction | null;
  visibleActions: ProjectOpenAction[];
  isSelected?: boolean;
}

interface MenuPosition {
  top: number;
  left: number;
}

type ProjectNavigatorMenuState =
  | { type: 'group'; group: ProjectGroup; position: MenuPosition }
  | { type: 'project'; project: Project; groupId: string | null; position: MenuPosition };

const PROJECT_NAV_MENU_WIDTH = 160;
const PROJECT_NAV_MENU_HEIGHT = 240;
const PROJECT_NAV_MENU_GAP = 4;
const PROJECT_NAV_MENU_VIEWPORT_PADDING = 12;
const PROJECT_DRAG_PREFIX = 'project:';
const PROJECT_DROP_PREFIX = 'project-drop:';
const GROUP_DROP_PREFIX = 'group-drop:';
const STANDALONE_DROP_ID = 'standalone-drop';
const INLINE_GROUP_DRAFT_DROP_ID = 'inline-group-draft-drop';

type ProjectDropData =
  | { type: 'project'; projectId: string; groupId: string | null }
  | { type: 'group'; groupId: string }
  | { type: 'standalone-root' }
  | { type: 'inline-group-draft' };

interface InlineGroupDraft {
  id: string;
  mode: 'drop' | 'manual';
  name: string;
  projectIds: string[];
  anchorProjectId: string | null;
  error: string | null;
}

const projectDragId = (projectId: string): string => `${PROJECT_DRAG_PREFIX}${projectId}`;
const projectDropId = (projectId: string): string => `${PROJECT_DROP_PREFIX}${projectId}`;
const groupDropId = (groupId: string): string => `${GROUP_DROP_PREFIX}${groupId}`;

const parseProjectDragId = (value: string): string | null =>
  value.startsWith(PROJECT_DRAG_PREFIX) ? value.slice(PROJECT_DRAG_PREFIX.length) : null;

const projectHasGitIntegration = (project: Project): boolean => {
  if (project.gitSetupState === 'not_git') return false;
  return project.readOnlyReason !== 'missing_git' && project.readOnlyReason !== 'manual_and_missing_git';
};

const getProjectNavMenuPosition = (trigger: HTMLElement | null): MenuPosition => {
  if (!trigger) {
    return {
      top: PROJECT_NAV_MENU_VIEWPORT_PADDING,
      left: PROJECT_NAV_MENU_VIEWPORT_PADDING,
    };
  }

  const rect = trigger.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const preferredLeft = rect.right - PROJECT_NAV_MENU_WIDTH;
  const left = Math.min(
    Math.max(PROJECT_NAV_MENU_VIEWPORT_PADDING, preferredLeft),
    viewportWidth - PROJECT_NAV_MENU_WIDTH - PROJECT_NAV_MENU_VIEWPORT_PADDING
  );
  const wouldOverflowBottom =
    rect.bottom + PROJECT_NAV_MENU_GAP + PROJECT_NAV_MENU_HEIGHT >
    viewportHeight - PROJECT_NAV_MENU_VIEWPORT_PADDING;
  const preferredTop = wouldOverflowBottom
    ? rect.top - PROJECT_NAV_MENU_HEIGHT - PROJECT_NAV_MENU_GAP
    : rect.bottom + PROJECT_NAV_MENU_GAP;
  const top = Math.min(
    Math.max(PROJECT_NAV_MENU_VIEWPORT_PADDING, preferredTop),
    viewportHeight - PROJECT_NAV_MENU_HEIGHT - PROJECT_NAV_MENU_VIEWPORT_PADDING
  );

  return { top, left };
};

const ProjectItem: React.FC<ProjectItemProps> = ({
  project,
  groupId,
  onSelect,
  onMenuOpen,
  onOpenExternal,
  busyAction,
  visibleActions,
  isSelected = false,
}) => {
  const { t } = useTranslation();
  const projectIconName = projectHasGitIntegration(project) ? 'folder-git-2' : 'folder';
  const {
    attributes,
    listeners,
    setNodeRef: setDraggableNodeRef,
    isDragging,
  } = useDraggable({
    id: projectDragId(project.id),
    data: {
      type: 'project',
      projectId: project.id,
      groupId,
    } satisfies ProjectDropData,
  });
  const { setNodeRef: setDroppableNodeRef, isOver } = useDroppable({
    id: projectDropId(project.id),
    data: {
      type: 'project',
      projectId: project.id,
      groupId,
    } satisfies ProjectDropData,
  });

  const renderQuickAction = (
    action: ProjectOpenAction,
    iconName: 'code' | 'terminal' | 'folder-open',
    title: string
  ) => {
    const isBusy = busyAction === action;
    return (
      <button
        type="button"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          if (!isBusy) {
            onOpenExternal(action);
          }
        }}
        title={title}
        aria-label={title}
        className={cn(
          'p-1 rounded hover:bg-accent transition-colors',
          isBusy && 'cursor-wait opacity-60'
        )}
      >
        {isBusy ? (
          <SpinnerIcon size={14} className="text-muted-foreground" />
        ) : (
          <Icon name={iconName} size={14} className="text-muted-foreground" />
        )}
      </button>
    );
  };

  return (
    <div
      ref={(node) => {
        setDraggableNodeRef(node);
        setDroppableNodeRef(node);
      }}
      data-project-id={project.id}
      onClick={onSelect}
      {...attributes}
      {...listeners}
      className={cn(
        'flex items-center justify-between px-3 py-2 rounded-lg transition-all duration-200 group cursor-pointer',
        'border border-transparent hover:bg-accent/40',
        isSelected && 'border-primary/30 bg-primary/10',
        isOver && !isDragging && 'border-primary/40 bg-primary/10',
        isDragging && 'opacity-40'
      )}
    >
      <div className="flex items-center gap-3 min-w-0">
        <div
          className={cn(
            'w-7 h-7 rounded-lg flex items-center justify-center shrink-0',
            project.status === 'active' ? 'bg-primary/10' : 'bg-muted'
          )}
        >
          <Icon
            name={projectIconName}
            size={14}
            className={cn(
              project.status === 'active'
                ? 'text-primary'
                : project.status === 'paused'
                  ? 'text-amber-500'
                  : 'text-muted-foreground'
            )}
          />
        </div>
        <span className="text-sm text-foreground truncate">{project.name}</span>
        {project.pathKind === 'wsl' && project.wslDistro && (
          <span className="rounded-full border border-border bg-muted/60 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
            WSL: {project.wslDistro}
          </span>
        )}
        {project.isReadOnly && (
          <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-300">
            Read-only
          </span>
        )}
      </div>

      <div className="flex items-center gap-2">
        {visibleActions.length > 0 && (
          <div className="pointer-events-none flex items-center gap-1 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
            {visibleActions.includes('editor') &&
              renderQuickAction(
                'editor',
                'code',
                t('projects.openInEditor', 'Open in code editor')
              )}
            {visibleActions.includes('terminal') &&
              renderQuickAction(
                'terminal',
                'terminal',
                t('projects.openInTerminal', 'Open in terminal')
              )}
            {visibleActions.includes('files') &&
              renderQuickAction(
                'files',
                'folder-open',
                t('projects.openInFiles', 'Open in file explorer')
              )}
          </div>
        )}
        <button
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onMenuOpen(e);
          }}
          data-project-nav-menu="true"
          className="p-1 rounded hover:bg-accent opacity-0 group-hover:opacity-100 transition-opacity"
        >
          <Icon name="more-vertical" size={14} className="text-muted-foreground" />
        </button>
      </div>
    </div>
  );
};

const StandaloneDropZone: React.FC<{
  isDragging: boolean;
  children: React.ReactNode;
}> = ({ isDragging, children }) => {
  const { t } = useTranslation();
  const { setNodeRef, isOver } = useDroppable({
    id: STANDALONE_DROP_ID,
    data: { type: 'standalone-root' } satisfies ProjectDropData,
  });

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'space-y-2 rounded-lg transition-colors',
        isDragging && 'border border-dashed border-border p-2',
        isDragging && isOver && 'border-primary/50 bg-primary/10'
      )}
    >
      {isDragging && (
        <div className="flex items-center gap-2 px-1 text-xs font-medium text-muted-foreground">
          <Icon name="folder" size={12} />
          {t('projects.standaloneDropZone', 'Standalone projects')}
        </div>
      )}
      {children}
    </div>
  );
};

const DroppableGroupSection: React.FC<{
  group: ProjectGroup;
  children: React.ReactNode;
}> = ({ group, children }) => {
  const { setNodeRef, isOver } = useDroppable({
    id: groupDropId(group.id),
    data: { type: 'group', groupId: group.id } satisfies ProjectDropData,
  });

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'rounded-lg border border-border overflow-visible transition-colors',
        isOver && 'border-primary/50 bg-primary/10'
      )}
    >
      {children}
    </div>
  );
};

const InlineDraftProjectRow: React.FC<{ project: Project }> = ({ project }) => {
  const projectIconName = projectHasGitIntegration(project) ? 'folder-git-2' : 'folder';
  const {
    attributes,
    listeners,
    setNodeRef,
    isDragging,
  } = useDraggable({
    id: projectDragId(project.id),
    data: {
      type: 'project',
      projectId: project.id,
      groupId: null,
    } satisfies ProjectDropData,
  });

  return (
    <div
      ref={setNodeRef}
      data-inline-draft-project-id={project.id}
      {...attributes}
      {...listeners}
      className={cn(
        'flex cursor-grab items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground hover:bg-accent/50 active:cursor-grabbing',
        isDragging && 'opacity-40'
      )}
    >
      <Icon name="grip-vertical" size={13} className="text-muted-foreground/70" />
      <Icon name={projectIconName} size={14} className="text-muted-foreground" />
      <span className="truncate">{project.name}</span>
    </div>
  );
};

const InlineGroupDraftCard: React.FC<{
  draft: InlineGroupDraft;
  projects: Project[];
  isSubmitting: boolean;
  onNameChange: (name: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}> = ({
  draft,
  projects,
  isSubmitting,
  onNameChange,
  onConfirm,
  onCancel,
}) => {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const { setNodeRef, isOver } = useDroppable({
    id: INLINE_GROUP_DRAFT_DROP_ID,
    data: { type: 'inline-group-draft' } satisfies ProjectDropData,
  });

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [draft.id]);

  return (
    <div
      ref={setNodeRef}
      data-inline-group-draft="true"
      className={cn(
        'rounded-lg border border-primary/35 bg-primary/5 overflow-hidden transition-colors',
        isOver && 'border-primary bg-primary/10'
      )}
    >
      <div className="flex items-center gap-2 border-b border-primary/20 px-3 py-2">
        <Icon name="layers" size={14} className="text-primary" />
        <input
          ref={inputRef}
          value={draft.name}
          onChange={(event) => onNameChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              onConfirm();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              onCancel();
            }
          }}
          placeholder={t('projects.groupNamePlaceholder', 'Group name')}
          className="min-w-0 flex-1 rounded-md border border-border bg-card px-2 py-1.5 text-sm font-medium text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
        />
        <button
          type="button"
          onClick={onConfirm}
          disabled={isSubmitting}
          title={t('common.confirm', 'Confirm')}
          className="flex h-7 w-7 items-center justify-center rounded-md text-primary hover:bg-primary/10 disabled:opacity-50"
        >
          <Icon name="check" size={14} />
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={isSubmitting}
          title={t('common.cancel', 'Cancel')}
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent disabled:opacity-50"
        >
          <Icon name="x" size={14} />
        </button>
      </div>

      <div className="space-y-2 bg-muted/20 px-2 py-2">
        <div className="space-y-1">
          {projects.map((project) => (
            <InlineDraftProjectRow key={project.id} project={project} />
          ))}
        </div>

        <div
          className={cn(
            'flex items-center gap-2 rounded-md border border-dashed border-border px-2 py-2 text-xs text-muted-foreground transition-colors',
            isOver && 'border-primary/60 bg-primary/10 text-foreground'
          )}
        >
          <Icon name="plus" size={13} />
          <div className="min-w-0">
            <div className="font-medium">{t('projects.dropProjectsHere', 'Drop projects here')}</div>
            <div className="truncate">
              {t('projects.dragOutToRemove', 'Drag a project out to remove it.')}
            </div>
          </div>
        </div>
      </div>

      {draft.error && (
        <div className="border-t border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {draft.error}
        </div>
      )}
    </div>
  );
};

export const ProjectNavigator: React.FC<ProjectNavigatorProps> = ({ isOpen, onClose }) => {
  const { t } = useTranslation();
  const runtimeCapabilities = getServiceRuntimeCapabilities();
  const {
    standaloneProjects,
    projectGroups,
    selectedGroupId,
    selectedProjectId,
    projectRegistryRepairSummary,
    isLoading,
    setSelectedGroup,
    setSelectedProject,
    toggleProjectGroup,
    renameProjectGroup,
    createProjectGroup,
    renameProject,
    moveProjectToGroup,
    removeProjectGroup,
    removeProject,
    debugResetProject,
    openProjectModal,
    openProjectGitFlowModal,
  } = useAppStore();

  const [searchQuery, setSearchQuery] = useState('');
  const [menuState, setMenuState] = useState<ProjectNavigatorMenuState | null>(null);
  const [draggedProject, setDraggedProject] = useState<Project | null>(null);
  const [inlineGroupDraft, setInlineGroupDraft] = useState<InlineGroupDraft | null>(null);
  const [renameTarget, setRenameTarget] = useState<
    { type: 'group'; group: ProjectGroup } | { type: 'project'; project: Project } | null
  >(null);
  const [removeTarget, setRemoveTarget] = useState<
    { type: 'group'; group: ProjectGroup } | { type: 'project'; project: Project } | null
  >(null);
  const [moveTarget, setMoveTarget] = useState<{
    project: Project;
    currentGroupId: string | null;
    selectedGroupId: string | null;
  } | null>(null);
  const [debugResetTarget, setDebugResetTarget] = useState<Project | null>(null);
  const [isSubmittingConfirm, setIsSubmittingConfirm] = useState(false);
  const [busyOpenActionByProjectId, setBusyOpenActionByProjectId] = useState<
    Record<string, ProjectOpenAction | null>
  >({});
  const [projectOpenSelection, setProjectOpenSelection] = useState<ProjectOpenAppSelection>({
    ...getEmptyProjectOpenSelection(),
  });
  const projectManagementDisabled = !runtimeCapabilities.projectMutation;
  const projectManagementDisabledTitle = t(
    'projects.remoteProjectManagementUnavailable',
    'Project creation and editing are unavailable in remote mode.'
  );

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    })
  );

  const filteredGroups = useMemo(() => {
    if (!searchQuery.trim()) {
      return projectGroups;
    }

    const query = searchQuery.toLowerCase();
    return projectGroups
      .map((group) => ({
        ...group,
        projects: group.projects.filter(
          (project) =>
            project.name.toLowerCase().includes(query) ||
            group.name.toLowerCase().includes(query)
        ),
      }))
      .filter((group) => group.projects.length > 0 || group.name.toLowerCase().includes(query));
  }, [projectGroups, searchQuery]);

  const filteredStandaloneProjects = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) {
      return standaloneProjects;
    }

    return standaloneProjects.filter((project) =>
      project.name.toLowerCase().includes(query)
    );
  }, [searchQuery, standaloneProjects]);

  const projectsById = useMemo(() => {
    const entries = [
      ...standaloneProjects,
      ...projectGroups.flatMap((group) => group.projects),
    ].map((project) => [project.id, project] as const);
    return new Map(entries);
  }, [projectGroups, standaloneProjects]);

  const getProjectLocation = (projectId: string): { project: Project; groupId: string | null } | null => {
    const standaloneProject = standaloneProjects.find((project) => project.id === projectId);
    if (standaloneProject) {
      return { project: standaloneProject, groupId: null };
    }

    for (const group of projectGroups) {
      const project = group.projects.find((candidate) => candidate.id === projectId);
      if (project) {
        return { project, groupId: group.id };
      }
    }

    return null;
  };

  const draftProjects = inlineGroupDraft
    ? inlineGroupDraft.projectIds
        .map((projectId) => projectsById.get(projectId))
        .filter((project): project is Project => Boolean(project))
    : [];
  const draftProjectIds = useMemo(
    () => new Set(inlineGroupDraft?.projectIds ?? []),
    [inlineGroupDraft?.projectIds]
  );
  const visibleStandaloneProjects = useMemo(
    () => filteredStandaloneProjects.filter((project) => !draftProjectIds.has(project.id)),
    [draftProjectIds, filteredStandaloneProjects]
  );

  const handleDragStart = (event: DragStartEvent) => {
    const activeData = event.active.data.current as ProjectDropData | undefined;
    const projectId =
      activeData?.type === 'project'
        ? activeData.projectId
        : parseProjectDragId(String(event.active.id));
    if (!projectId) {
      return;
    }

    const location = getProjectLocation(projectId);
    if (location) {
      setDraggedProject(location.project);
    }
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const activeData = event.active.data.current as ProjectDropData | undefined;
    const overData = event.over?.data.current as ProjectDropData | undefined;
    const activeProjectId =
      activeData?.type === 'project'
        ? activeData.projectId
        : parseProjectDragId(String(event.active.id));
    setDraggedProject(null);
    if (!activeProjectId || !overData || projectManagementDisabled) {
      return;
    }

    const activeLocation = getProjectLocation(activeProjectId);
    if (!activeLocation) {
      return;
    }
    const activeIsInDraft = draftProjectIds.has(activeProjectId);

    const removeProjectFromInlineDraft = () => {
      setInlineGroupDraft((current) =>
        current
          ? {
              ...current,
              projectIds: current.projectIds.filter((projectId) => projectId !== activeProjectId),
              error: null,
            }
          : current
      );
    };

    if (overData.type === 'project') {
      if (overData.projectId === activeProjectId) {
        return;
      }

      if (overData.groupId) {
        if (activeIsInDraft) {
          removeProjectFromInlineDraft();
        }
        if (activeLocation.groupId !== overData.groupId) {
          void handleMoveProjectToGroup(activeLocation.project, activeLocation.groupId, overData.groupId);
        }
        return;
      }

      if (activeIsInDraft) {
        setInlineGroupDraft((current) =>
          current
            ? {
                ...current,
                projectIds: Array.from(new Set([...current.projectIds, overData.projectId])),
                error: null,
              }
            : current
        );
        return;
      }

      setInlineGroupDraft({
        id: `draft-${Date.now()}`,
        mode: 'drop',
        name: '',
        projectIds: Array.from(new Set([activeProjectId, overData.projectId])),
        anchorProjectId: overData.projectId,
        error: null,
      });
      return;
    }

    if (overData.type === 'group') {
      if (activeIsInDraft) {
        removeProjectFromInlineDraft();
      }
      if (activeLocation.groupId !== overData.groupId) {
        void handleMoveProjectToGroup(activeLocation.project, activeLocation.groupId, overData.groupId);
      }
      return;
    }

    if (overData.type === 'inline-group-draft' && !activeLocation.groupId) {
      setInlineGroupDraft((current) =>
        current
          ? {
              ...current,
              projectIds: Array.from(new Set([...current.projectIds, activeProjectId])),
              error: null,
            }
          : current
      );
      return;
    }

    if (overData.type === 'standalone-root' && activeIsInDraft) {
      removeProjectFromInlineDraft();
      return;
    }

    if (overData.type === 'standalone-root' && activeLocation.groupId) {
      void handleMoveProjectToGroup(activeLocation.project, activeLocation.groupId, null);
    }
  };

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    let cancelled = false;

    const loadOpenSettings = async () => {
      const settings = await loadProjectOpenSettings();
      if (!cancelled) {
        setProjectOpenSelection(settings.selectedAppIdsByAction);
      }
    };

    void loadOpenSettings();

    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  const handleSelectGroup = (groupId: string) => {
    setSelectedGroup(groupId);
    onClose();
  };

  const handleSelectProject = (projectId: string) => {
    setSelectedProject(projectId);
    onClose();
  };

  const handleNewProject = () => {
    if (projectManagementDisabled) {
      return;
    }
    onClose();
    openProjectModal(null);
  };

  const handleAddSubproject = (groupId: string) => {
    if (projectManagementDisabled) {
      return;
    }
    onClose();
    openProjectModal(groupId);
  };

  const handleRenameGroup = async (group: ProjectGroup, nextName: string) => {
    if (!nextName || nextName.trim() === group.name) {
      return;
    }

    try {
      setIsSubmittingConfirm(true);
      await renameProjectGroup(group.id, nextName);
      setRenameTarget(null);
      notify.success(t('projects.groupRenamed', 'Project group renamed'));
    } catch (error) {
      const message = toServiceError(error).message || t('common.error', 'An error occurred');
      notify.error(message);
    } finally {
      setIsSubmittingConfirm(false);
    }
  };

  const handleRemoveGroup = async (group: ProjectGroup) => {
    try {
      setIsSubmittingConfirm(true);
      await removeProjectGroup(group.id);
      setMenuState(null);
      setRemoveTarget(null);
      notify.success(t('projects.groupDissolved', 'Group dissolved'));
    } catch (error) {
      const message = toServiceError(error).message || t('common.error', 'An error occurred');
      notify.error(message);
    } finally {
      setIsSubmittingConfirm(false);
    }
  };

  const handleMoveProjectToGroup = async (
    project: Project,
    currentGroupId: string | null,
    targetGroupId: string | null
  ) => {
    if (currentGroupId === targetGroupId) {
      setMoveTarget(null);
      return;
    }

    try {
      setIsSubmittingConfirm(true);
      await moveProjectToGroup(project.id, targetGroupId);
      setMenuState(null);
      setMoveTarget(null);
      notify.success(
        targetGroupId
          ? t('projects.projectMovedToGroup', 'Project moved to group')
          : t('projects.projectDetachedFromGroup', 'Project removed from group')
      );
    } catch (error) {
      const message = toServiceError(error).message || t('common.error', 'An error occurred');
      notify.error(message);
    } finally {
      setIsSubmittingConfirm(false);
    }
  };

  const handleStartManualGroupCreation = (anchorProjectId?: string) => {
    if (projectManagementDisabled) {
      return;
    }

    if (standaloneProjects.length < 2) {
      notify.error(
        t('projects.groupNeedsTwoProjects', 'Choose at least two standalone projects to create a group.')
      );
      return;
    }

    setInlineGroupDraft({
      id: `draft-${Date.now()}`,
      mode: 'manual',
      name: '',
      projectIds: anchorProjectId
        ? [
            anchorProjectId,
            ...standaloneProjects
              .filter((project) => project.id !== anchorProjectId)
              .slice(0, 1)
              .map((project) => project.id),
          ]
        : standaloneProjects.slice(0, 2).map((project) => project.id),
      anchorProjectId: anchorProjectId ?? null,
      error: null,
    });
  };

  const handleConfirmInlineGroup = async () => {
    if (!inlineGroupDraft || isSubmittingConfirm) {
      return;
    }

    const trimmedName = inlineGroupDraft.name.trim();
    const uniqueProjectIds = Array.from(new Set(inlineGroupDraft.projectIds));
    if (!trimmedName) {
      setInlineGroupDraft((current) =>
        current
          ? {
              ...current,
              error: t('projects.groupNameRequired', 'Group name is required'),
            }
          : current
      );
      return;
    }

    if (uniqueProjectIds.length < 2) {
      setInlineGroupDraft((current) =>
        current
          ? {
              ...current,
              error: t('projects.groupNeedsTwoProjects', 'Choose at least two projects to create a group.'),
            }
          : current
      );
      return;
    }

    try {
      setIsSubmittingConfirm(true);
      await createProjectGroup(trimmedName, uniqueProjectIds);
      setInlineGroupDraft(null);
      notify.success(t('projects.groupCreated', 'Group created'));
    } catch (error) {
      const message = toServiceError(error).message || t('common.error', 'An error occurred');
      setInlineGroupDraft((current) =>
        current ? { ...current, error: message } : current
      );
    } finally {
      setIsSubmittingConfirm(false);
    }
  };

  const handleRenameProject = async (project: Project, nextName: string) => {
    if (!nextName || nextName.trim() === project.name) {
      return;
    }

    try {
      setIsSubmittingConfirm(true);
      await renameProject(project.id, nextName);
      setRenameTarget(null);
      notify.success(t('projects.projectRenamed', 'Project renamed'));
    } catch (error) {
      const message = toServiceError(error).message || t('common.error', 'An error occurred');
      notify.error(message);
    } finally {
      setIsSubmittingConfirm(false);
    }
  };

  const handleOpenExternal = async (
    project: Project,
    action: ProjectOpenAction
  ): Promise<void> => {
    setBusyOpenActionByProjectId((current) => ({ ...current, [project.id]: action }));
    try {
      await openProjectInExternalApp({
        targetPath: project.path,
        action,
        appId: projectOpenSelection[action],
      });
    } catch (error) {
      const fallbackTitle =
        action === 'editor'
          ? t('projects.openInEditorFailed', 'Unable to open this project in the configured editor.')
          : action === 'terminal'
            ? t('projects.openInTerminalFailed', 'Unable to open this project in the configured terminal.')
            : t('projects.openInFilesFailed', 'Unable to open this project in the configured file explorer.');
      notify.error(fallbackTitle, {
        description: toServiceError(error).message,
      });
    } finally {
      setBusyOpenActionByProjectId((current) => ({ ...current, [project.id]: null }));
    }
  };

  const visibleQuickActions = PROJECT_OPEN_ACTIONS.filter(
    (action) => shouldRenderProjectOpenAction(projectOpenSelection, action)
  );

  const handleRemoveProject = async (project: Project) => {
    try {
      setIsSubmittingConfirm(true);
      await removeProject(project.id);
      setMenuState(null);
      setRemoveTarget(null);
      notify.success(t('projects.projectRemoved', 'Project removed from Macro'));
    } catch (error) {
      const message = toServiceError(error).message || t('common.error', 'An error occurred');
      notify.error(message);
    } finally {
      setIsSubmittingConfirm(false);
    }
  };

  const handleDebugResetProject = async (project: Project) => {
    try {
      setIsSubmittingConfirm(true);
      const report = await debugResetProject(project.id);
      setMenuState(null);
      setDebugResetTarget(null);
      notify.success(t('projects.debugResetSuccess', 'Macro data reset for {{name}}', {
        name: report.projectName || project.name,
      }), {
        description: t(
          'projects.debugResetSuccessDescription',
          '{{worktreeCount}} Macro worktree(s) removed. Shared @macro metadata was preserved.',
          {
            worktreeCount: report.removedTaskWorktrees,
          }
        ),
      });
      if (report.warnings.length > 0) {
        notify.warning(t('projects.debugResetWarning', 'Reset completed with warnings'), {
          description: report.warnings.slice(0, 2).join('\n'),
        });
      }
    } catch (error) {
      const message = toServiceError(error).message || t('common.error', 'An error occurred');
      notify.error(message);
    } finally {
      setIsSubmittingConfirm(false);
    }
  };

  React.useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('[data-project-nav-menu="true"]')) {
        return;
      }
      setMenuState(null);
    };

    if (menuState) {
      document.addEventListener('click', handleClickOutside);
      return () => document.removeEventListener('click', handleClickOutside);
    }
  }, [menuState]);

  React.useEffect(() => {
    if (!menuState) {
      return;
    }

    const handleDismiss = () => setMenuState(null);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuState(null);
      }
    };

    window.addEventListener('resize', handleDismiss);
    window.addEventListener('scroll', handleDismiss, true);
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('resize', handleDismiss);
      window.removeEventListener('scroll', handleDismiss, true);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [menuState]);

  if (!isOpen) return null;

  const projectMenuPortal =
    menuState && typeof document !== 'undefined'
      ? createPortal(
          <div
            className="fixed z-[9999] w-40 overflow-hidden rounded-lg border border-border bg-card py-1 shadow-2xl"
            style={{
              top: `${menuState.position.top}px`,
              left: `${menuState.position.left}px`,
            }}
            data-project-nav-menu="true"
            onClick={(event) => event.stopPropagation()}
          >
            {menuState.type === 'group' ? (
              <>
                <button
                  onClick={() => {
                    handleAddSubproject(menuState.group.id);
                  }}
                  disabled={projectManagementDisabled}
                  title={projectManagementDisabled ? projectManagementDisabledTitle : undefined}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-foreground hover:bg-accent"
                >
                  <Icon name="plus" size={12} />
                  {t('projects.addSubproject', 'Add project')}
                </button>
                <button
                  onClick={() => {
                    if (!projectManagementDisabled) {
                      setRenameTarget({ type: 'group', group: menuState.group });
                      setMenuState(null);
                    }
                  }}
                  disabled={projectManagementDisabled}
                  title={projectManagementDisabled ? projectManagementDisabledTitle : undefined}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-foreground hover:bg-accent"
                >
                  <Icon name="edit" size={12} />
                  {t('common.rename', 'Rename')}
                </button>
                <button
                  onClick={() => {
                    if (!projectManagementDisabled) {
                      setRemoveTarget({ type: 'group', group: menuState.group });
                      setMenuState(null);
                    }
                  }}
                  disabled={projectManagementDisabled}
                  title={projectManagementDisabled ? projectManagementDisabledTitle : undefined}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-destructive hover:bg-destructive/10"
                >
                  <Icon name="x" size={12} />
                  {t('projects.dissolveGroup', 'Dissolve group')}
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={() => {
                    if (!projectManagementDisabled) {
                      openProjectGitFlowModal(menuState.project.id);
                      setMenuState(null);
                    }
                  }}
                  disabled={projectManagementDisabled}
                  title={projectManagementDisabled ? projectManagementDisabledTitle : undefined}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-foreground hover:bg-accent"
                >
                  <Icon name="git-branch" size={12} />
                  {t('projects.projectSettings', 'Project settings')}
                </button>
                <button
                  onClick={() => {
                    if (!projectManagementDisabled) {
                      setRenameTarget({ type: 'project', project: menuState.project });
                      setMenuState(null);
                    }
                  }}
                  disabled={projectManagementDisabled}
                  title={projectManagementDisabled ? projectManagementDisabledTitle : undefined}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-foreground hover:bg-accent"
                >
                  <Icon name="edit" size={12} />
                  {t('common.rename', 'Rename')}
                </button>
                {menuState.groupId && (
                  <>
                    {projectGroups.some((group) => group.id !== menuState.groupId) && (
                      <button
                        onClick={() => {
                          if (!projectManagementDisabled) {
                            setMoveTarget({
                              project: menuState.project,
                              currentGroupId: menuState.groupId,
                              selectedGroupId: menuState.groupId,
                            });
                            setMenuState(null);
                          }
                        }}
                        disabled={projectManagementDisabled}
                        title={projectManagementDisabled ? projectManagementDisabledTitle : undefined}
                        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-foreground hover:bg-accent"
                      >
                        <Icon name="arrow-up-right" size={12} />
                        {t('projects.moveToGroup', 'Move to group')}
                      </button>
                    )}
                    <button
                      onClick={() => {
                        if (!projectManagementDisabled) {
                          void handleMoveProjectToGroup(menuState.project, menuState.groupId, null);
                        }
                      }}
                      disabled={projectManagementDisabled}
                      title={projectManagementDisabled ? projectManagementDisabledTitle : undefined}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-foreground hover:bg-accent"
                    >
                      <Icon name="x" size={12} />
                      {t('projects.removeFromGroup', 'Remove from group')}
                    </button>
                  </>
                )}
                {!menuState.groupId && projectGroups.length > 0 && (
                  <button
                    onClick={() => {
                      if (!projectManagementDisabled) {
                        setMoveTarget({
                          project: menuState.project,
                          currentGroupId: null,
                          selectedGroupId: null,
                        });
                        setMenuState(null);
                      }
                    }}
                    disabled={projectManagementDisabled}
                    title={projectManagementDisabled ? projectManagementDisabledTitle : undefined}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-foreground hover:bg-accent"
                  >
                    <Icon name="link" size={12} />
                    {t('projects.addToGroup', 'Add to group')}
                  </button>
                )}
                {!menuState.groupId && standaloneProjects.length >= 2 && (
                  <button
                    onClick={() => {
                      if (!projectManagementDisabled) {
                        handleStartManualGroupCreation(menuState.project.id);
                        setMenuState(null);
                      }
                    }}
                    disabled={projectManagementDisabled}
                    title={projectManagementDisabled ? projectManagementDisabledTitle : undefined}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-foreground hover:bg-accent"
                  >
                    <Icon name="layers" size={12} />
                    {t('projects.createGroup', 'Create group')}
                  </button>
                )}
                <button
                  onClick={() => {
                    if (!projectManagementDisabled) {
                      setRemoveTarget({ type: 'project', project: menuState.project });
                      setMenuState(null);
                    }
                  }}
                  disabled={projectManagementDisabled}
                  title={projectManagementDisabled ? projectManagementDisabledTitle : undefined}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-destructive hover:bg-destructive/10"
                >
                  <Icon name="x" size={12} />
                  {t('projects.removeFromMacro', 'Retirer de Macro')}
                </button>
                {isDevelopmentBuild && (
                  <>
                    <div className="my-1 h-px bg-border" />
                    <button
                      onClick={() => {
                        if (!projectManagementDisabled) {
                          setDebugResetTarget(menuState.project);
                          setMenuState(null);
                        }
                      }}
                      disabled={projectManagementDisabled}
                      title={projectManagementDisabled ? projectManagementDisabledTitle : undefined}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-destructive hover:bg-destructive/10"
                    >
                      <Icon name="x" size={12} />
                      {t('projects.debugResetMacroData', 'Reset Macro data')}
                    </button>
                  </>
                )}
              </>
            )}
          </div>,
          document.body
        )
      : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />

      <div className="relative flex max-h-[calc(100vh-2rem)] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
        <div className="flex shrink-0 items-center justify-between px-4 py-3 border-b border-border">
          <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
            {t('projects.title', 'Projects')}
          </h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-accent transition-colors"
          >
            <Icon name="x" size={16} className="text-muted-foreground" />
          </button>
        </div>

        <div className="shrink-0 px-4 py-3 border-b border-border">
          <SearchBar
            value={searchQuery}
            onChange={setSearchQuery}
            placeholder={t('projects.search', 'Search projects...')}
          />
          {projectRegistryRepairSummary && (
            <div className="mt-3 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
              {projectRegistryRepairSummary}
            </div>
          )}
        </div>

        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          <div className="min-h-0 flex-1 overflow-y-auto p-3 space-y-2">
            {visibleStandaloneProjects.length === 0 && filteredGroups.length === 0 && !inlineGroupDraft ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <Icon name="search" size={32} className="text-muted-foreground/70 mb-3" />
                <p className="text-sm text-muted-foreground">
                  {t('projects.noResults', 'No projects found')}
                </p>
              </div>
            ) : (
              <>
                <StandaloneDropZone isDragging={Boolean(draggedProject)}>
                  {inlineGroupDraft?.mode === 'manual' && !inlineGroupDraft.anchorProjectId && (
                    <InlineGroupDraftCard
                      draft={inlineGroupDraft}
                      projects={draftProjects}
                      isSubmitting={isSubmittingConfirm}
                      onNameChange={(name) =>
                        setInlineGroupDraft((current) =>
                          current ? { ...current, name, error: null } : current
                        )
                      }
                      onConfirm={() => void handleConfirmInlineGroup()}
                      onCancel={() => setInlineGroupDraft(null)}
                    />
                  )}
                  {inlineGroupDraft?.anchorProjectId &&
                    !filteredStandaloneProjects.some(
                      (project) => project.id === inlineGroupDraft.anchorProjectId
                    ) && (
                      <InlineGroupDraftCard
                        draft={inlineGroupDraft}
                        projects={draftProjects}
                        isSubmitting={isSubmittingConfirm}
                        onNameChange={(name) =>
                          setInlineGroupDraft((current) =>
                            current ? { ...current, name, error: null } : current
                          )
                        }
                        onConfirm={() => void handleConfirmInlineGroup()}
                        onCancel={() => setInlineGroupDraft(null)}
                      />
                    )}

                  {filteredStandaloneProjects.map((project) => {
                    const isInDraft = draftProjectIds.has(project.id);
                    const shouldRenderDraftHere =
                      inlineGroupDraft?.anchorProjectId === project.id;

                    return (
                      <React.Fragment key={project.id}>
                        {shouldRenderDraftHere && (
                          <InlineGroupDraftCard
                            draft={inlineGroupDraft}
                            projects={draftProjects}
                            isSubmitting={isSubmittingConfirm}
                            onNameChange={(name) =>
                              setInlineGroupDraft((current) =>
                                current ? { ...current, name, error: null } : current
                              )
                            }
                            onConfirm={() => void handleConfirmInlineGroup()}
                            onCancel={() => setInlineGroupDraft(null)}
                          />
                        )}
                        {!isInDraft && (
                          <ProjectItem
                            project={project}
                            groupId={null}
                            isSelected={!selectedGroupId && selectedProjectId === project.id}
                            onSelect={() => handleSelectProject(project.id)}
                            onOpenExternal={(action) => {
                              void handleOpenExternal(project, action);
                            }}
                            busyAction={busyOpenActionByProjectId[project.id] ?? null}
                            visibleActions={visibleQuickActions}
                            onMenuOpen={(e) => {
                              e.stopPropagation();
                              const trigger = e.currentTarget;
                              setMenuState((current) =>
                                current?.type === 'project' && current.project.id === project.id
                                  ? null
                                  : {
                                      type: 'project',
                                      project,
                                      groupId: null,
                                      position: getProjectNavMenuPosition(trigger),
                                    }
                              );
                            }}
                          />
                        )}
                      </React.Fragment>
                    );
                  })}
                </StandaloneDropZone>

                {filteredGroups.map((group) => {
                const isGroupSelected = selectedGroupId === group.id;

                return (
                  <DroppableGroupSection key={group.id} group={group}>
                    <div
                      className={cn(
                        'flex items-center justify-between px-3 py-2.5 cursor-pointer transition-colors relative',
                        'bg-transparent'
                      )}
                    >
                      <div
                        className="flex items-center gap-2 flex-1 min-w-0"
                        onClick={() => handleSelectGroup(group.id)}
                      >
                        <Icon
                          name="layers"
                          size={16}
                          className={cn(
                            isGroupSelected ? 'text-primary' : 'text-muted-foreground'
                          )}
                        />
                        <span className="text-sm font-medium text-foreground truncate">
                          {group.name}
                        </span>
                      </div>

                      <div className="flex items-center gap-1">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            const trigger = e.currentTarget;
                            setMenuState((current) =>
                              current?.type === 'group' && current.group.id === group.id
                                ? null
                                : {
                                    type: 'group',
                                    group,
                                    position: getProjectNavMenuPosition(trigger),
                                  }
                            );
                          }}
                          data-project-nav-menu="true"
                          className="p-1 rounded hover:bg-accent transition-colors"
                        >
                          <Icon name="more-vertical" size={14} className="text-muted-foreground" />
                        </button>

                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleProjectGroup(group.id);
                          }}
                          className="p-1 rounded hover:bg-accent transition-colors"
                        >
                          <Icon
                            name={group.isOpen ? 'chevron-down' : 'chevron-right'}
                            size={14}
                            className="text-muted-foreground"
                          />
                        </button>
                      </div>

                    </div>

                    {group.isOpen && (
                      <div className="px-2 py-2 space-y-1 bg-muted/30">
                        {group.projects.map((project) => {
                          return (
                            <div key={project.id} className="relative">
                              <ProjectItem
                                project={project}
                                groupId={group.id}
                                onSelect={() => handleSelectGroup(group.id)}
                                isSelected={false}
                                onOpenExternal={(action) => {
                                  void handleOpenExternal(project, action);
                                }}
                                busyAction={busyOpenActionByProjectId[project.id] ?? null}
                                visibleActions={visibleQuickActions}
                                onMenuOpen={(e) => {
                                  e.stopPropagation();
                                  const trigger = e.currentTarget;
                                  setMenuState((current) =>
                                    current?.type === 'project' && current.project.id === project.id
                                      ? null
                                      : {
                                          type: 'project',
                                          project,
                                          groupId: group.id,
                                          position: getProjectNavMenuPosition(trigger),
                                        }
                                  );
                                }}
                              />
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </DroppableGroupSection>
                );
              })}
              </>
            )}
          </div>

          <DragOverlay>
            {draggedProject && (
              <div className="px-3 py-2 rounded-lg bg-card border border-primary shadow-lg">
                <div className="flex items-center gap-2">
                  <Icon
                    name={projectHasGitIntegration(draggedProject) ? 'folder-git-2' : 'folder'}
                    size={14}
                    className="text-primary"
                  />
                  <span className="text-sm text-foreground">{draggedProject.name}</span>
                </div>
              </div>
            )}
          </DragOverlay>
        </DndContext>

        <div className="flex items-center gap-2 px-4 py-3 border-t border-border bg-muted/30">
          <button
            onClick={handleNewProject}
            disabled={isLoading || projectManagementDisabled}
            title={projectManagementDisabled ? projectManagementDisabledTitle : undefined}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium text-foreground hover:bg-accent transition-colors disabled:opacity-50"
          >
            <Icon name="plus" size={14} />
            {t('projects.new', 'New Project')}
          </button>
        </div>
      </div>

      <ConfirmPromptModal
        isOpen={!!renameTarget}
        title={t('common.rename', 'Rename')}
        description={
          renameTarget?.type === 'group'
            ? t('projects.renameGroupPrompt', 'Enter a new name for this project group.')
            : t('projects.renameProjectPrompt', 'Enter a new name for this project.')
        }
        confirmLabel={t('common.rename', 'Rename')}
        cancelLabel={t('common.cancel', 'Cancel')}
        initialValue={
          renameTarget?.type === 'group'
            ? renameTarget.group.name
            : renameTarget?.type === 'project'
              ? renameTarget.project.name
              : ''
        }
        inputPlaceholder={t('common.name', 'Name')}
        requireInput
        isSubmitting={isSubmittingConfirm}
        onCancel={() => {
          if (!isSubmittingConfirm) {
            setRenameTarget(null);
          }
        }}
        onConfirm={(value) => {
          if (!renameTarget || !value) {
            if (!isSubmittingConfirm) {
              setRenameTarget(null);
            }
            return;
          }

          if (renameTarget.type === 'group') {
            void handleRenameGroup(renameTarget.group, value);
          } else {
            void handleRenameProject(renameTarget.project, value);
          }
        }}
      />

      <ConfirmPromptModal
        isOpen={!!removeTarget}
        title={
          removeTarget?.type === 'group'
            ? t('projects.dissolveGroup', 'Dissolve group')
            : t('projects.removeFromMacro', 'Retirer de Macro')
        }
        description={
          removeTarget?.type === 'group'
            ? t(
                'projects.removeGroupPrompt',
                'Dissolve this group. Its projects stay in Macro as standalone projects.'
              )
            : t(
                'projects.removeProjectPrompt',
                'Remove this project from Macro without deleting local files.'
              )
        }
        confirmLabel={
          removeTarget?.type === 'group'
            ? t('projects.dissolveGroup', 'Dissolve group')
            : t('projects.removeFromMacro', 'Retirer de Macro')
        }
        cancelLabel={t('common.cancel', 'Cancel')}
        isSubmitting={isSubmittingConfirm}
        onCancel={() => {
          if (!isSubmittingConfirm) {
            setRemoveTarget(null);
          }
        }}
        onConfirm={() => {
          if (!removeTarget) {
            return;
          }
          if (removeTarget.type === 'group') {
            void handleRemoveGroup(removeTarget.group);
          } else {
            void handleRemoveProject(removeTarget.project);
          }
        }}
      />
      <ConfirmPromptModal
        isOpen={!!moveTarget}
        title={t('projects.moveToGroup', 'Move to group')}
        description={t(
          'projects.moveProjectToGroupPrompt',
          'Choose the group for this project, or no group to keep it standalone.'
        )}
        confirmLabel={t('common.confirm', 'Confirm')}
        cancelLabel={t('common.cancel', 'Cancel')}
        isSubmitting={isSubmittingConfirm}
        onCancel={() => {
          if (!isSubmittingConfirm) {
            setMoveTarget(null);
          }
        }}
        onConfirm={() => {
          if (!moveTarget) {
            return;
          }
          void handleMoveProjectToGroup(
            moveTarget.project,
            moveTarget.currentGroupId,
            moveTarget.selectedGroupId
          );
        }}
      >
        {moveTarget && (
          <GroupCombobox
            projectGroups={projectGroups.map((group) => ({ id: group.id, name: group.name }))}
            selectedGroupId={moveTarget.selectedGroupId}
            onSelect={(groupId) => {
              setMoveTarget((current) =>
                current ? { ...current, selectedGroupId: groupId } : current
              );
            }}
            placeholder={t('project.chooseGlobalProject', 'Choose a group...')}
          />
        )}
      </ConfirmPromptModal>
      <ConfirmPromptModal
        isOpen={!!debugResetTarget}
        title={t('projects.debugResetTitle', 'Reset Macro data')}
        description={t(
          'projects.debugResetPrompt',
          'This debug-only action removes this project from Macro and deletes its local Macro task worktrees. It preserves the shared @macro metadata branch/worktree, never deletes your source code or remote branches, but uncommitted changes inside Macro worktrees will be lost.'
        )}
        confirmLabel={t('projects.debugResetConfirm', 'Reset Macro data')}
        cancelLabel={t('common.cancel', 'Cancel')}
        confirmVariant="error"
        isSubmitting={isSubmittingConfirm}
        onCancel={() => {
          if (!isSubmittingConfirm) {
            setDebugResetTarget(null);
          }
        }}
        onConfirm={() => {
          if (debugResetTarget) {
            void handleDebugResetProject(debugResetTarget);
          }
        }}
      >
        {debugResetTarget && (
          <div className="rounded-lg border border-destructive/25 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {debugResetTarget.name}
            {debugResetTarget.path ? ` · ${debugResetTarget.path}` : ''}
          </div>
        )}
      </ConfirmPromptModal>
      {projectMenuPortal}
    </div>
  );
};
