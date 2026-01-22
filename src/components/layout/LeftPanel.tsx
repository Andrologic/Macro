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
  const { projectGroups, toggleProjectGroup, selectedGroupId, setSelectedGroup, openProjectModal } =
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
      className={cn('h-full bg-zinc-900 border-r border-zinc-800 flex flex-col', className)}
      style={{ width: width ? `${width}px` : '280px' }}
    >
      {/* Header */}
      <div className="h-12 border-b border-zinc-800 flex items-center justify-between px-4">
        <h1 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
          <Icon name="layers" size={16} className="text-indigo-500" />
          Projects
        </h1>
        <button onClick={openProjectModal} className="p-1 hover:bg-zinc-800 rounded-md transition-colors">
          <Icon name="plus" size={16} className="text-zinc-500" />
        </button>
      </div>

      {/* Search Bar */}
      <div className="p-3 border-b border-zinc-800">
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
            <Icon name="search" size={32} className="text-zinc-600 mb-3" />
            <p className="text-sm text-zinc-500">No projects found</p>
            <p className="text-xs text-zinc-600 mt-1">
              Try a different search term
            </p>
          </div>
        ) : (
          filteredGroups.map((group) => (
          <div
            key={group.id}
            className={cn(
              'border-b border-zinc-800/50 transition-all duration-200',
              selectedGroupId === group.id
                ? 'bg-indigo-500/10 border-l-2 border-l-indigo-500 border-r-0 border-t-0 border-b-0'
                : 'hover:bg-zinc-800/30'
            )}
          >
            {/* Group Header - Click to select group */}
            <div
              onClick={() => setSelectedGroup(group.id)}
              className={cn(
                'w-full h-10 px-4 flex items-center justify-between',
                'transition-colors cursor-pointer',
                'text-xs font-medium',
                selectedGroupId === group.id
                  ? 'text-zinc-100'
                  : 'text-zinc-400'
              )}
            >
              <div className="flex items-center gap-2">
                <Icon
                  name="folder"
                  size={14}
                  className={cn(
                    selectedGroupId === group.id
                      ? 'text-indigo-400'
                      : 'text-zinc-500'
                  )}
                />
                <span>{group.name}</span>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  toggleProjectGroup(group.id);
                }}
                className="p-1 hover:bg-zinc-700 rounded transition-colors"
              >
                <Icon
                  name={group.isOpen ? 'chevron-down' : 'chevron-right'}
                  size={14}
                  className="text-zinc-500"
                />
              </button>
            </div>

            {/* Project List - Collapsible */}
            {group.isOpen && (
              <div className="py-1">
                {group.projects.map((project) => (
                  <div
                    key={project.id}
                    className="w-full h-9 px-6 flex items-center justify-between text-sm text-zinc-400"
                  >
                    <div className="flex items-center gap-2">
                      <Icon
                        name="folder-open"
                        size={14}
                        className={cn(
                          project.status === 'active'
                            ? 'text-indigo-500'
                            : project.status === 'paused'
                            ? 'text-amber-500'
                            : 'text-zinc-500'
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
      <div className="h-12 border-t border-zinc-800 flex items-center justify-between px-4 bg-zinc-900">
        <div className="flex items-center gap-2">
          <Icon name="code" size={14} className="text-zinc-500" />
          <span className="text-xs text-zinc-500">
            {filteredGroups.reduce((acc, g) => acc + g.projects.length, 0)}{' '}
            projects
          </span>
        </div>
        <button className="p-1 hover:bg-zinc-800 rounded-md transition-colors">
          <Icon name="settings" size={14} className="text-zinc-500" />
        </button>
      </div>
    </aside>
  );
};
