import React, { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  DndContext,
  DragEndEvent,
  DragOverlay,
  DragStartEvent,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { useAppStore } from '../../stores/useAppStore';
import { toServiceError } from '../../services/contracts/errors';
import { Icon } from '../ui/Icon';
import { SearchBar } from '../ui/SearchBar';
import { ConfirmPromptModal } from '../ui/ConfirmPromptModal';
import { toast } from '../ui/Toaster';
import { cn } from '../../utils/cn';
import type { Project, ProjectGroup } from '../../types';

interface ProjectNavigatorProps {
  isOpen: boolean;
  onClose: () => void;
}

interface ProjectItemProps {
  project: Project;
  onSelect: () => void;
  onMenuOpen: (e: React.MouseEvent<HTMLButtonElement>) => void;
}

interface MenuPosition {
  top: number;
  left: number;
}

type ProjectNavigatorMenuState =
  | { type: 'group'; group: ProjectGroup; position: MenuPosition }
  | { type: 'project'; project: Project; position: MenuPosition };

const PROJECT_NAV_MENU_WIDTH = 160;
const PROJECT_NAV_MENU_HEIGHT = 120;
const PROJECT_NAV_MENU_GAP = 4;
const PROJECT_NAV_MENU_VIEWPORT_PADDING = 12;

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
  onSelect,
  onMenuOpen,
}) => {
  return (
    <div
      onClick={onSelect}
      className={cn(
        'flex items-center justify-between px-3 py-2 rounded-lg transition-all duration-200 group cursor-pointer',
        'border border-transparent hover:bg-accent/40'
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
            name="folder-open"
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
        {project.isReadOnly && (
          <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-300">
            Read-only
          </span>
        )}
      </div>

      <div className="flex items-center gap-2">
        <button
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

export const ProjectNavigator: React.FC<ProjectNavigatorProps> = ({ isOpen, onClose }) => {
  const { t } = useTranslation();
  const {
    projectGroups,
    selectedGroupId,
    projectRegistryRepairSummary,
    isLoading,
    setSelectedGroup,
    toggleProjectGroup,
    renameProjectGroup,
    renameProject,
    removeProjectGroup,
    removeProject,
    openProjectModal,
    openProjectGitFlowModal,
  } = useAppStore();

  const [searchQuery, setSearchQuery] = useState('');
  const [menuState, setMenuState] = useState<ProjectNavigatorMenuState | null>(null);
  const [draggedProject, setDraggedProject] = useState<Project | null>(null);
  const [renameTarget, setRenameTarget] = useState<
    { type: 'group'; group: ProjectGroup } | { type: 'project'; project: Project } | null
  >(null);
  const [removeTarget, setRemoveTarget] = useState<
    { type: 'group'; group: ProjectGroup } | { type: 'project'; project: Project } | null
  >(null);
  const [isSubmittingConfirm, setIsSubmittingConfirm] = useState(false);

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

  const handleDragStart = (event: DragStartEvent) => {
    const projectId = event.active.id as string;
    for (const group of projectGroups) {
      const project = group.projects.find((candidate) => candidate.id === projectId);
      if (project) {
        setDraggedProject(project);
        break;
      }
    }
  };

  const handleDragEnd = (_event: DragEndEvent) => {
    setDraggedProject(null);
  };

  const handleSelectGroup = (groupId: string) => {
    setSelectedGroup(groupId);
    onClose();
  };

  const handleNewProject = () => {
    onClose();
    openProjectModal(null);
  };

  const handleAddSubproject = (groupId: string) => {
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
      toast.success(t('projects.groupRenamed', 'Project group renamed'));
    } catch (error) {
      const message = toServiceError(error).message || t('common.error', 'An error occurred');
      toast.error(message);
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
      toast.success(t('projects.groupRemoved', 'Projet global retire de Macro'));
    } catch (error) {
      const message = toServiceError(error).message || t('common.error', 'An error occurred');
      toast.error(message);
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
      toast.success(t('projects.projectRenamed', 'Project renamed'));
    } catch (error) {
      const message = toServiceError(error).message || t('common.error', 'An error occurred');
      toast.error(message);
    } finally {
      setIsSubmittingConfirm(false);
    }
  };

  const handleRemoveProject = async (project: Project) => {
    try {
      setIsSubmittingConfirm(true);
      await removeProject(project.id);
      setMenuState(null);
      setRemoveTarget(null);
      toast.success(t('projects.projectRemoved', 'Sous-projet retire de Macro'));
    } catch (error) {
      const message = toServiceError(error).message || t('common.error', 'An error occurred');
      toast.error(message);
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
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-foreground hover:bg-accent"
                >
                  <Icon name="plus" size={12} />
                  {t('projects.addSubproject', 'Add subproject')}
                </button>
                <button
                  onClick={() => {
                    setRenameTarget({ type: 'group', group: menuState.group });
                    setMenuState(null);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-foreground hover:bg-accent"
                >
                  <Icon name="edit" size={12} />
                  {t('common.rename', 'Rename')}
                </button>
                <button
                  onClick={() => {
                    setRemoveTarget({ type: 'group', group: menuState.group });
                    setMenuState(null);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-destructive hover:bg-destructive/10"
                >
                  <Icon name="x" size={12} />
                  {t('projects.removeFromMacro', 'Retirer de Macro')}
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={() => {
                    openProjectGitFlowModal(menuState.project.id);
                    setMenuState(null);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-foreground hover:bg-accent"
                >
                  <Icon name="git-branch" size={12} />
                  {t('projects.projectSettings', 'Project settings')}
                </button>
                <button
                  onClick={() => {
                    setRenameTarget({ type: 'project', project: menuState.project });
                    setMenuState(null);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-foreground hover:bg-accent"
                >
                  <Icon name="edit" size={12} />
                  {t('common.rename', 'Rename')}
                </button>
                <button
                  onClick={() => {
                    setRemoveTarget({ type: 'project', project: menuState.project });
                    setMenuState(null);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-destructive hover:bg-destructive/10"
                >
                  <Icon name="x" size={12} />
                  {t('projects.removeFromMacro', 'Retirer de Macro')}
                </button>
              </>
            )}
          </div>,
          document.body
        )
      : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />

      <div className="relative w-full max-w-lg bg-card border border-border rounded-xl shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <Icon name="layers" size={16} className="text-primary" />
            {t('projects.title', 'Projects')}
          </h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-accent transition-colors"
          >
            <Icon name="x" size={16} className="text-muted-foreground" />
          </button>
        </div>

        <div className="px-4 py-3 border-b border-border">
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
          <div className="max-h-[400px] overflow-y-auto p-3 space-y-2">
            {filteredGroups.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <Icon name="search" size={32} className="text-muted-foreground/70 mb-3" />
                <p className="text-sm text-muted-foreground">
                  {t('projects.noResults', 'No projects found')}
                </p>
              </div>
            ) : (
              filteredGroups.map((group) => {
                const isGroupSelected = selectedGroupId === group.id;

                return (
                  <div key={group.id} className="rounded-lg border border-border overflow-visible">
                    <div
                      className={cn(
                        'flex items-center justify-between px-3 py-2.5 cursor-pointer transition-colors relative',
                        isGroupSelected ? 'bg-primary/10' : 'bg-card hover:bg-accent/50'
                      )}
                    >
                      <div
                        className="flex items-center gap-2 flex-1 min-w-0"
                        onClick={() => handleSelectGroup(group.id)}
                      >
                        <Icon
                          name="folder"
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
                                onSelect={() => handleSelectGroup(group.id)}
                                onMenuOpen={(e) => {
                                  e.stopPropagation();
                                  const trigger = e.currentTarget;
                                  setMenuState((current) =>
                                    current?.type === 'project' && current.project.id === project.id
                                      ? null
                                      : {
                                          type: 'project',
                                          project,
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
                  </div>
                );
              })
            )}
          </div>

          <DragOverlay>
            {draggedProject && (
              <div className="px-3 py-2 rounded-lg bg-card border border-primary shadow-lg">
                <div className="flex items-center gap-2">
                  <Icon name="folder-open" size={14} className="text-primary" />
                  <span className="text-sm text-foreground">{draggedProject.name}</span>
                </div>
              </div>
            )}
          </DragOverlay>
        </DndContext>

        <div className="flex items-center px-4 py-3 border-t border-border bg-muted/30">
          <button
            onClick={handleNewProject}
            disabled={isLoading}
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
        title={t('projects.removeFromMacro', 'Retirer de Macro')}
        description={
          removeTarget?.type === 'group'
            ? t(
                'projects.removeGroupPrompt',
                'Retire ce projet global et ses sous-projets de Macro sans supprimer les fichiers locaux.'
              )
            : t(
                'projects.removeProjectPrompt',
                'Retire ce sous-projet de Macro sans supprimer les fichiers locaux.'
              )
        }
        confirmLabel={t('projects.removeFromMacro', 'Retirer de Macro')}
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
      {projectMenuPortal}
    </div>
  );
};
