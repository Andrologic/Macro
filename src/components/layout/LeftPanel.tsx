import React from 'react';
import { useAppStore } from '../../stores/useAppStore';
import { Icon } from '../ui/Icon';
import { cn } from '../../utils/cn';

export const LeftPanel: React.FC = () => {
  const { projectGroups, toggleProjectGroup, selectedProjectId } =
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
          <div key={group.id} className="border-b border-zinc-800/50">
            {/* Group Header */}
            <button
              onClick={() => toggleProjectGroup(group.id)}
              className={cn(
                'w-full h-10 px-4 flex items-center justify-between',
                'hover:bg-zinc-800/50 transition-colors',
                'text-xs font-medium text-zinc-400'
              )}
            >
              <span>{group.name}</span>
              <Icon
                name={group.isOpen ? 'chevron-down' : 'chevron-right'}
                size={14}
                className="text-zinc-500"
              />
            </button>

            {/* Project List */}
            {group.isOpen && (
              <div className="py-1">
                {group.projects.map((project) => (
                  <button
                    key={project.id}
                    className={cn(
                      'w-full h-9 px-6 flex items-center justify-between',
                      'transition-colors text-sm',
                      selectedProjectId === project.id
                        ? 'bg-indigo-500/10 text-indigo-500 border-r-2 border-indigo-500'
                        : 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/30'
                    )}
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
                  </button>
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
