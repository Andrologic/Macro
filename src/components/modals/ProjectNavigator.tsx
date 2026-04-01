import React, { useMemo, useState } from 'react';
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
  onMenuOpen: (e: React.MouseEvent) => void;
}

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
  const [menuOpenFor, setMenuOpenFor] = useState<string | null>(null);
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
      setMenuOpenFor(null);
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
      setMenuOpenFor(null);
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
      setMenuOpenFor(null);
    };

    if (menuOpenFor) {
      document.addEventListener('click', handleClickOutside);
      return () => document.removeEventListener('click', handleClickOutside);
    }
  }, [menuOpenFor]);

  if (!isOpen) return null;

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
                            setMenuOpenFor(menuOpenFor === group.id ? null : group.id);
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

                      {menuOpenFor === group.id && (
                        <div
                          className="absolute right-2 top-full mt-1 w-40 bg-card border border-border rounded-lg shadow-lg py-1 z-20"
                          data-project-nav-menu="true"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button
                            onClick={() => {
                              handleAddSubproject(group.id);
                            }}
                            className="w-full px-3 py-1.5 text-left text-sm text-foreground hover:bg-accent flex items-center gap-2"
                          >
                            <Icon name="plus" size={12} />
                            {t('projects.addSubproject', 'Add subproject')}
                          </button>
                          <button
                            onClick={() => {
                              setRenameTarget({ type: 'group', group });
                              setMenuOpenFor(null);
                            }}
                            className="w-full px-3 py-1.5 text-left text-sm text-foreground hover:bg-accent flex items-center gap-2"
                          >
                            <Icon name="edit" size={12} />
                            {t('common.rename', 'Rename')}
                          </button>
                          <button
                            onClick={() => {
                              setRemoveTarget({ type: 'group', group });
                              setMenuOpenFor(null);
                            }}
                            className="w-full px-3 py-1.5 text-left text-sm text-destructive hover:bg-destructive/10 flex items-center gap-2"
                          >
                            <Icon name="x" size={12} />
                            {t('projects.removeFromMacro', 'Retirer de Macro')}
                          </button>
                        </div>
                      )}
                    </div>

                    {group.isOpen && (
                      <div className="px-2 py-2 space-y-1 bg-muted/30">
                        {group.projects.map((project) => {
                          const isProjectMenuOpen = menuOpenFor === project.id;

                          return (
                            <div key={project.id} className="relative">
                              <ProjectItem
                                project={project}
                                onSelect={() => handleSelectGroup(group.id)}
                                onMenuOpen={(e) => {
                                  e.stopPropagation();
                                  setMenuOpenFor(isProjectMenuOpen ? null : project.id);
                                }}
                              />

                              {isProjectMenuOpen && (
                                <div
                                  className="absolute right-2 top-full mt-1 w-40 bg-card border border-border rounded-lg shadow-lg py-1 z-20"
                                  data-project-nav-menu="true"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <button
                                    onClick={() => {
                                      openProjectGitFlowModal(project.id);
                                      setMenuOpenFor(null);
                                    }}
                                    className="w-full px-3 py-1.5 text-left text-sm text-foreground hover:bg-accent flex items-center gap-2"
                                  >
                                    <Icon name="git-branch" size={12} />
                                    {t('projects.gitFlowSettings', 'GitFlow settings')}
                                  </button>
                                  <button
                                    onClick={() => {
                                      setRenameTarget({ type: 'project', project });
                                      setMenuOpenFor(null);
                                    }}
                                    className="w-full px-3 py-1.5 text-left text-sm text-foreground hover:bg-accent flex items-center gap-2"
                                  >
                                    <Icon name="edit" size={12} />
                                    {t('common.rename', 'Rename')}
                                  </button>
                                  <button
                                    onClick={() => {
                                      setRemoveTarget({ type: 'project', project });
                                      setMenuOpenFor(null);
                                    }}
                                    className="w-full px-3 py-1.5 text-left text-sm text-destructive hover:bg-destructive/10 flex items-center gap-2"
                                  >
                                    <Icon name="x" size={12} />
                                    {t('projects.removeFromMacro', 'Retirer de Macro')}
                                  </button>
                                </div>
                              )}
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
    </div>
  );
};
