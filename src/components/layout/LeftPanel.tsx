import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../stores/useAppStore';
import { getServiceRuntimeCapabilities } from '../../services';
import { Icon } from '../ui/Icon';
import { SearchBar } from '../ui/SearchBar';
import { cn } from '../../utils/cn';

interface LeftPanelProps {
  className?: string;
  width?: number;
}

export const LeftPanel: React.FC<LeftPanelProps> = ({ className, width }) => {
  const { t } = useTranslation();
  const runtimeCapabilities = getServiceRuntimeCapabilities();
  const { projectGroups, toggleProjectGroup, selectedGroupId, setSelectedGroup, openProjectModal } =
    useAppStore();
  const [searchQuery, setSearchQuery] = useState('');
  const projectManagementDisabled = !runtimeCapabilities.projectMutation;
  const projectManagementDisabledTitle = t(
    'projects.remoteProjectManagementUnavailable',
    'Project creation and editing are unavailable in remote mode.'
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
            project.path.toLowerCase().includes(query) ||
            group.name.toLowerCase().includes(query)
        ),
      }))
      .filter(
        (group) =>
          group.projects.length > 0 || group.name.toLowerCase().includes(query)
      );
  }, [projectGroups, searchQuery]);

  const hasNoResults = searchQuery.trim() && filteredGroups.length === 0;
  const projectCount = filteredGroups.reduce((count, group) => count + group.projects.length, 0);

  return (
    <aside
      className={cn('h-full bg-card border-r border-border flex flex-col', className)}
      style={{ width: width ? `${width}px` : '280px' }}
    >
      <div className="h-12 border-b border-border flex items-center justify-between px-4">
        <h1 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <Icon name="layers" size={16} className="text-primary" />
          {t('project.projects', 'Projects')}
        </h1>
        <button
          onClick={() => {
            if (!projectManagementDisabled) {
              openProjectModal(null);
            }
          }}
          disabled={projectManagementDisabled}
          title={projectManagementDisabled ? projectManagementDisabledTitle : undefined}
          className={cn(
            'rounded-md p-1 transition-colors',
            projectManagementDisabled
              ? 'cursor-not-allowed opacity-50'
              : 'hover:bg-accent'
          )}
        >
          <Icon name="plus" size={16} className="text-muted-foreground" />
        </button>
      </div>

      <div className="p-3 border-b border-border">
        <SearchBar
          value={searchQuery}
          onChange={setSearchQuery}
          placeholder={t('project.searchPlaceholder', 'Search projects...')}
        />
      </div>

      <div className="flex-1 overflow-y-auto">
        {hasNoResults ? (
          <div className="flex flex-col items-center justify-center h-48 px-4 text-center">
            <Icon name="search" size={32} className="text-muted-foreground/70 mb-3" />
            <p className="text-sm text-muted-foreground">{t('project.noProjectsFound', 'No projects found')}</p>
            <p className="text-xs text-muted-foreground/70 mt-1">
              {t('project.tryDifferentSearch', 'Try a different search term')}
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
              <div
                onClick={() => setSelectedGroup(group.id)}
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
                  onClick={(event) => {
                    event.stopPropagation();
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

              {group.isOpen && (
                <div className="py-1">
                  {group.projects.map((project) => (
                    <div
                      key={project.id}
                      onClick={() => setSelectedGroup(group.id)}
                      className="w-full h-9 px-6 flex items-center justify-between text-sm text-muted-foreground cursor-pointer hover:bg-accent/20"
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
          ))
        )}
      </div>

      <div className="h-12 border-t border-border flex items-center px-4 bg-card">
        <div className="flex items-center gap-2">
          <Icon name="code" size={14} className="text-muted-foreground" />
          <span className="text-xs text-muted-foreground">
            {t('project.count', '{{count}} projects', { count: projectCount })}
          </span>
        </div>
      </div>
    </aside>
  );
};
