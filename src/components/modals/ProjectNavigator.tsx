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
import { Icon } from '../ui/Icon';
import { SearchBar } from '../ui/SearchBar';
import { cn } from '../../utils/cn';
import type { Project, ProjectGroup, ProjectActivity } from '../../types';

// Mock activity data - in real app would come from a store
const mockProjectActivity: Record<string, ProjectActivity> = {
  'proj-1': 'ai-active',
  'proj-2': 'completed',
  'proj-3': 'idle',
};

interface ProjectNavigatorProps {
  isOpen: boolean;
  onClose: () => void;
}

interface ProjectItemProps {
  project: Project;
  activity: ProjectActivity;
  isSelected: boolean;
  onSelect: () => void;
  onMenuOpen: (e: React.MouseEvent) => void;
}

const ProjectItem: React.FC<ProjectItemProps> = ({
  project,
  activity,
  isSelected,
  onSelect,
  onMenuOpen,
}) => {
  return (
    <div
      onClick={onSelect}
      className={cn(
        'flex items-center justify-between px-3 py-2 rounded-lg cursor-pointer transition-all duration-200 group',
        isSelected
          ? 'bg-primary/10 border border-primary/30'
          : 'hover:bg-accent border border-transparent'
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
        {/* Activity indicator */}
        {activity === 'ai-active' && (
          <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-emerald-500/10">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
            <span className="text-xs text-emerald-500">IA</span>
          </div>
        )}
        {activity === 'completed' && (
          <Icon name="check" size={14} className="text-primary" />
        )}
        {activity === 'error' && (
          <Icon name="alert-circle" size={14} className="text-destructive" />
        )}

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

  const handleSelectProject = (groupId: string, projectId: string) => {
    setSelectedGroup(groupId);
    setSelectedProject(projectId);
    onClose();
  };

  const handleNewProject = () => {
    onClose();
    openProjectModal();
  };

  const getGroupActivityCount = (group: ProjectGroup): number => {
    return group.projects.filter(
      p => mockProjectActivity[p.id] === 'ai-active'
    ).length;
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
                const activeCount = getGroupActivityCount(group);
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
                        {activeCount > 0 && (
                          <span className="px-1.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-500 text-xs">
                            {activeCount} actif{activeCount > 1 ? 's' : ''}
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
                            activity={mockProjectActivity[project.id] || 'idle'}
                            isSelected={selectedProjectId === project.id}
                            onSelect={() => handleSelectProject(group.id, project.id)}
                            onMenuOpen={(e) => {
                              e.stopPropagation();
                              setMenuOpenFor(menuOpenFor === project.id ? null : project.id);
                            }}
                          />
                        ))}

                        {/* View all group button */}
                        <button
                          onClick={() => handleSelectGroup(group.id)}
                          className={cn(
                            'w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition-colors',
                            isGroupSelected
                              ? 'bg-primary/20 text-primary'
                              : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                          )}
                        >
                          <Icon name="layers" size={12} />
                          {t('projects.viewAll', 'View entire group')}
                        </button>
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
