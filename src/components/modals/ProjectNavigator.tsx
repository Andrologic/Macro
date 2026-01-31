import React, { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DndContext,
  DragEndEvent,
  DragOverlay,
  DragStartEvent,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { useAppStore } from '../../stores/useAppStore';
import { useTaskStore } from '../../stores/useTaskStore';
import { Icon } from '../ui/Icon';
import { SearchBar } from '../ui/SearchBar';
import { cn } from '../../utils/cn';
import type { Project, ProjectGroup, TaskStatus } from '../../types';

interface ProjectNavigatorProps {
  isOpen: boolean;
  onClose: () => void;
}

interface ProjectItemProps {
  project: Project;
  badges: { label: string; variant: 'default' | 'success' | 'warning' | 'attention' }[];
  onMenuOpen: (e: React.MouseEvent) => void;
}

const ProjectItem: React.FC<ProjectItemProps> = ({
  project,
  badges,
  onMenuOpen,
}) => {
  return (
    <div
      className={cn(
        'flex items-center justify-between px-3 py-2 rounded-lg transition-all duration-200 group',
        'border border-transparent'
      )}
    >
      <div className="flex items-center gap-3 min-w-0">
        <div className={cn(
          'w-7 h-7 rounded-lg flex items-center justify-center shrink-0',
          project.status === 'active' ? 'bg-primary/10' : 'bg-muted'
        )}>
          <Icon
            name="folder-open"
            size={14}
            className={cn(
              project.status === 'active' ? 'text-primary' :
              project.status === 'paused' ? 'text-amber-500' :
              'text-muted-foreground'
            )}
          />
        </div>
        <span className="text-sm text-foreground truncate">{project.name}</span>
      </div>

      <div className="flex items-center gap-2">
        {/* Task status badges */}
        {badges.map((badge) => (
          <span
            key={`${project.id}-${badge.label}`}
            className={cn(
              'px-2 py-0.5 rounded-full text-[11px] font-medium border',
              badge.variant === 'success' && 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20',
              badge.variant === 'warning' && 'bg-amber-500/10 text-amber-500 border-amber-500/20',
              badge.variant === 'attention' && 'bg-destructive/10 text-destructive border-destructive/20',
              badge.variant === 'default' && 'bg-muted/60 text-muted-foreground border-border/50'
            )}
          >
            {badge.label}
          </span>
        ))}

        {/* Menu button */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onMenuOpen(e);
          }}
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
    selectedProjectId,
    setSelectedGroup,
    setSelectedProject,
    toggleProjectGroup,
    openProjectModal,
  } = useAppStore();
  const tasks = useTaskStore((state) => state.tasks);

  const [searchQuery, setSearchQuery] = useState('');
  const [menuOpenFor, setMenuOpenFor] = useState<string | null>(null);
  const [draggedProject, setDraggedProject] = useState<Project | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    })
  );

  // Filter groups and projects based on search query
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
      const project = group.projects.find(p => p.id === projectId);
      if (project) {
        setDraggedProject(project);
        break;
      }
    }
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setDraggedProject(null);

    if (!over || active.id === over.id) return;

    // Here we would handle merge logic when dropping on another project
    console.log('Merge projects:', active.id, 'into', over.id);
  };

  const handleSelectGroup = (groupId: string) => {
    setSelectedGroup(groupId);
    setSelectedProject(null);
    onClose();
  };

  const handleNewProject = () => {
    onClose();
    openProjectModal();
  };

  const getProjectTaskCounts = (projectId: string) => {
    const projectTasks = tasks.filter((task) => task.project_id === projectId);
    const counts: Record<TaskStatus, number> = {
      Pending: 0,
      InProgress: 0,
      AwaitingResponse: 0,
      Completed: 0,
      Failed: 0,
      Blocked: 0,
    };

    projectTasks.forEach((task) => {
      counts[task.status] += 1;
    });

    const needsAttention = counts.AwaitingResponse + counts.Blocked + counts.Failed;

    return {
      counts,
      needsAttention,
      total: projectTasks.length,
    };
  };

  const getProjectBadges = (projectId: string) => {
    const { counts, needsAttention, total } = getProjectTaskCounts(projectId);
    if (total === 0) return [] as { label: string; variant: 'default' | 'success' | 'warning' | 'attention' }[];

    const badges = [] as { label: string; variant: 'default' | 'success' | 'warning' | 'attention' }[];

    if (counts.InProgress > 0) {
      badges.push({
        label: `${counts.InProgress} ${t('tasks.inProgress', 'In Progress')}`,
        variant: 'warning',
      });
    }

    if (counts.Pending > 0) {
      badges.push({
        label: `${counts.Pending} ${t('tasks.pending', 'Pending')}`,
        variant: 'default',
      });
    }

    if (counts.Completed > 0) {
      badges.push({
        label: `${counts.Completed} ${t('tasks.completed', 'Completed')}`,
        variant: 'success',
      });
    }

    if (needsAttention > 0) {
      badges.unshift({
        label: `${needsAttention} ${t('tasks.actionRequired', 'Action required')}`,
        variant: 'attention',
      });
    }

    return badges;
  };

  const getGroupAttentionCount = (group: ProjectGroup): number => {
    return group.projects.reduce((count, project) => {
      const { needsAttention } = getProjectTaskCounts(project.id);
      return count + needsAttention;
    }, 0);
  };

  // Close menu on click outside
  React.useEffect(() => {
    const handleClickOutside = () => setMenuOpenFor(null);
    if (menuOpenFor) {
      document.addEventListener('click', handleClickOutside);
      return () => document.removeEventListener('click', handleClickOutside);
    }
  }, [menuOpenFor]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative w-full max-w-lg bg-card border border-border rounded-xl shadow-2xl overflow-hidden">
        {/* Header */}
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

        {/* Search */}
        <div className="px-4 py-3 border-b border-border">
          <SearchBar
            value={searchQuery}
            onChange={setSearchQuery}
            placeholder={t('projects.search', 'Search projects...')}
          />
        </div>

        {/* Project List */}
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
                const attentionCount = getGroupAttentionCount(group);
                const isGroupSelected = selectedGroupId === group.id && !selectedProjectId;

                return (
                  <div
                    key={group.id}
                    className="rounded-lg border border-border overflow-hidden"
                  >
                    {/* Group Header */}
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
                        {attentionCount > 0 && (
                          <span className="px-1.5 py-0.5 rounded-full bg-destructive/10 text-destructive text-xs">
                            {attentionCount} {t('tasks.actionRequired', 'Action required')}
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-1">
                        {/* Group menu */}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setMenuOpenFor(menuOpenFor === group.id ? null : group.id);
                          }}
                          className="p-1 rounded hover:bg-accent transition-colors"
                        >
                          <Icon name="more-vertical" size={14} className="text-muted-foreground" />
                        </button>

                        {/* Expand/collapse */}
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

                      {/* Group Context Menu */}
                      {menuOpenFor === group.id && (
                        <div
                          className="absolute right-2 top-full mt-1 w-40 bg-card border border-border rounded-lg shadow-lg py-1 z-20"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button className="w-full px-3 py-1.5 text-left text-sm text-foreground hover:bg-accent flex items-center gap-2">
                            <Icon name="edit" size={12} />
                            {t('common.rename', 'Rename')}
                          </button>
                          <button className="w-full px-3 py-1.5 text-left text-sm text-foreground hover:bg-accent flex items-center gap-2">
                            <Icon name="settings" size={12} />
                            {t('common.settings', 'Settings')}
                          </button>
                          <button className="w-full px-3 py-1.5 text-left text-sm text-destructive hover:bg-destructive/10 flex items-center gap-2">
                            <Icon name="archive" size={12} />
                            {t('common.archive', 'Archive')}
                          </button>
                        </div>
                      )}
                    </div>

                    {/* Projects */}
                    {group.isOpen && (
                      <div className="px-2 py-2 space-y-1 bg-muted/30">
                        {group.projects.map((project) => (
                          <ProjectItem
                            key={project.id}
                            project={project}
                            badges={getProjectBadges(project.id)}
                            onMenuOpen={(e) => {
                              e.stopPropagation();
                              setMenuOpenFor(menuOpenFor === project.id ? null : project.id);
                            }}
                          />
                        ))}
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

        {/* Footer Actions */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-border bg-muted/30">
          <button
            onClick={handleNewProject}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium text-foreground hover:bg-accent transition-colors"
          >
            <Icon name="plus" size={14} />
            {t('projects.new', 'New Project')}
          </button>
          <button className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium text-foreground hover:bg-accent transition-colors">
            <Icon name="git-branch" size={14} />
            {t('projects.import', 'Import from Git')}
          </button>
        </div>
      </div>
    </div>
  );
};
