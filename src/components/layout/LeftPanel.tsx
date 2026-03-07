import React, { useState, useMemo } from 'react';
import { useAppStore } from '../../stores/useAppStore';
import { Icon } from '../ui/Icon';
import { SearchBar } from '../ui/SearchBar';
import { cn } from '../../utils/cn';

interface LeftPanelProps {
  className?: string;
  width?: number;
}

export const LeftPanel: React.FC<LeftPanelProps> = ({ className, width }) => {
  const { projectGroups, toggleProjectGroup, selectedGroupId, switchProjectContext, openProjectModal } =
    useAppStore();
  const [searchQuery, setSearchQuery] = useState('');

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
            project.path.toLowerCase().includes(query) ||
            group.name.toLowerCase().includes(query)
        ),
      }))
      .filter((group) => group.projects.length > 0);
  }, [projectGroups, searchQuery]);

  const hasNoResults = searchQuery.trim() && filteredGroups.length === 0;

  return (
    <aside
      className={cn('h-full bg-card border-r border-border flex flex-col', className)}
      style={{ width: width ? `${width}px` : '280px' }}
    >
      {/* Header */}
      <div className="h-12 border-b border-border flex items-center justify-between px-4">
        <h1 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <Icon name="layers" size={16} className="text-primary" />
          Projects
        </h1>
        <button onClick={openProjectModal} className="p-1 hover:bg-accent rounded-md transition-colors">
          <Icon name="plus" size={16} className="text-muted-foreground" />
        </button>
      </div>

      {/* Search Bar */}
      <div className="p-3 border-b border-border">
        <SearchBar
          value={searchQuery}
          onChange={setSearchQuery}
          placeholder="Search projects..."
        />
      </div>

      {/* Project Groups */}
      <div className="flex-1 overflow-y-auto">
        {hasNoResults ? (
          <div className="flex flex-col items-center justify-center h-48 px-4 text-center">
            <Icon name="search" size={32} className="text-muted-foreground/70 mb-3" />
            <p className="text-sm text-muted-foreground">No projects found</p>
            <p className="text-xs text-muted-foreground/70 mt-1">
              Try a different search term
            </p>
          </div>
        ) : (
          filteredGroups.map((group) => (
          <div
            key={group.id}
            className={cn(
              'border-b border-border/50 transition-all duration-200',
              selectedGroupId === group.id
                ? 'bg-primary/10 border-l-2 border-l-primary border-r-0 border-t-0 border-b-0'
                : 'hover:bg-accent/30'
            )}
          >
            {/* Group Header - Click to select group */}
            <div
              onClick={() => {
                const fallbackProjectId = group.projects[0]?.id ?? null;
                void switchProjectContext(fallbackProjectId);
              }}
              className={cn(
                'w-full h-10 px-4 flex items-center justify-between',
                'transition-colors cursor-pointer',
                'text-xs font-medium',
                selectedGroupId === group.id
                  ? 'text-foreground'
                  : 'text-muted-foreground'
              )}
            >
              <div className="flex items-center gap-2">
                <Icon
                  name="folder"
                  size={14}
                  className={cn(
                    selectedGroupId === group.id
                      ? 'text-primary'
                      : 'text-muted-foreground'
                  )}
                />
                <span>{group.name}</span>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  toggleProjectGroup(group.id);
                }}
                className="p-1 hover:bg-accent rounded transition-colors"
              >
                <Icon
                  name={group.isOpen ? 'chevron-down' : 'chevron-right'}
                  size={14}
                  className="text-muted-foreground"
                />
              </button>
            </div>

            {/* Project List - Collapsible */}
            {group.isOpen && (
              <div className="py-1">
                {group.projects.map((project) => (
                  <div
                    key={project.id}
                    className="w-full h-9 px-6 flex items-center justify-between text-sm text-muted-foreground"
                  >
                    <div className="flex items-center gap-2">
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
                      <span>{project.name}</span>
                    </div>
                    {project.status === 'active' && (
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )))}
      </div>

      {/* Footer */}
      <div className="h-12 border-t border-border flex items-center px-4 bg-card">
        <div className="flex items-center gap-2">
          <Icon name="code" size={14} className="text-muted-foreground" />
          <span className="text-xs text-muted-foreground">
            {filteredGroups.reduce((acc, g) => acc + g.projects.length, 0)}{' '}
            projects
          </span>
        </div>
      </div>
    </aside>
  );
};
