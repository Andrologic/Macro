import React from 'react';
import { useAppStore } from '../../stores/useAppStore';
import { Icon } from '../ui/Icon';
import { cn } from '../../utils/cn';

export const LeftPanel: React.FC = () => {
  const { projectGroups, toggleProjectGroup, selectedGroupId, setSelectedGroup } =
    useAppStore();

  return (
    <aside className="w-[280px] h-full bg-zinc-900 border-r border-zinc-800 flex flex-col">
      {/* Header */}
      <div className="h-12 border-b border-zinc-800 flex items-center justify-between px-4">
        <h1 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
          <Icon name="layers" size={16} className="text-indigo-500" />
          Projects
        </h1>
        <button className="p-1 hover:bg-zinc-800 rounded-md transition-colors">
          <Icon name="plus" size={16} className="text-zinc-500" />
        </button>
      </div>

      {/* Project Groups */}
      <div className="flex-1 overflow-y-auto">
        {projectGroups.map((group) => (
          <div
            key={group.id}
            className={cn(
              'border-b border-zinc-800/50',
              selectedGroupId === group.id && 'bg-zinc-800/30'
            )}
          >
            {/* Group Header - Click to select group */}
            <div
              onClick={() => setSelectedGroup(group.id)}
              className={cn(
                'w-full h-10 px-4 flex items-center justify-between',
                'hover:bg-zinc-800/50 transition-colors',
                'text-xs font-medium cursor-pointer',
                selectedGroupId === group.id
                  ? 'text-indigo-500'
                  : 'text-zinc-400'
              )}
            >
              <div className="flex items-center gap-2">
                <Icon
                  name="folder"
                  size={14}
                  className={cn(
                    selectedGroupId === group.id
                      ? 'text-indigo-500'
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
        ))}
      </div>

      {/* Footer */}
      <div className="h-12 border-t border-zinc-800 flex items-center justify-between px-4 bg-zinc-900">
        <div className="flex items-center gap-2">
          <Icon name="code" size={14} className="text-zinc-500" />
          <span className="text-xs text-zinc-500">
            {projectGroups.reduce((acc, g) => acc + g.projects.length, 0)}{' '}
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
