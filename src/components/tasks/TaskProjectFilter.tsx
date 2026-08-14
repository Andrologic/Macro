import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { cn } from '../../utils/cn';
import { Icon } from '../ui/Icon';

export interface TaskProjectFilterOption {
  id: string;
  name: string;
  path: string;
  groupName: string | null;
  taskCount: number;
  isReadOnly: boolean;
}

interface TaskProjectFilterProps {
  projects: TaskProjectFilterOption[];
  selectedProjectId: string | null;
  totalTaskCount: number;
  onSelect: (projectId: string | null) => void;
}

interface DropdownPosition {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
}

export const TaskProjectFilter: React.FC<TaskProjectFilterProps> = ({
  projects,
  selectedProjectId,
  totalTaskCount,
  onSelect,
}) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [position, setPosition] = useState<DropdownPosition | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? null;

  const filteredProjects = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) return projects;
    return projects.filter((project) =>
      [project.name, project.groupName, project.path]
        .filter(Boolean)
        .some((value) => value?.toLocaleLowerCase().includes(normalizedQuery))
    );
  }, [projects, query]);

  const groupedProjects = useMemo(() => {
    const groups = new Map<string, TaskProjectFilterOption[]>();
    filteredProjects.forEach((project) => {
      const key = project.groupName || t('implement.independentProjects', 'Independent projects');
      groups.set(key, [...(groups.get(key) || []), project]);
    });
    return Array.from(groups.entries());
  }, [filteredProjects, t]);

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current?.getBoundingClientRect();
    if (!trigger) return;
    const margin = 8;
    const gap = 6;
    const width = Math.min(Math.max(trigger.width, 300), window.innerWidth - margin * 2);
    const preferredHeight = 420;
    const spaceBelow = window.innerHeight - trigger.bottom - margin;
    const spaceAbove = trigger.top - margin;
    const opensUp = spaceBelow < 260 && spaceAbove > spaceBelow;
    const maxHeight = Math.max(220, Math.min(preferredHeight, (opensUp ? spaceAbove : spaceBelow) - gap));
    const left = Math.min(Math.max(margin, trigger.left), window.innerWidth - width - margin);
    setPosition({
      top: opensUp ? Math.max(margin, trigger.top - maxHeight - gap) : trigger.bottom + gap,
      left,
      width,
      maxHeight,
    });
  }, []);

  const closeDropdown = useCallback((restoreTriggerFocus = false) => {
    setIsOpen(false);
    if (restoreTriggerFocus) {
      queueMicrotask(() => triggerRef.current?.focus());
    }
  }, []);

  useEffect(() => {
    if (!isOpen) {
      setPosition(null);
      setQuery('');
      return;
    }
    updatePosition();
    queueMicrotask(() => searchRef.current?.focus());
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    const handleOutsideClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !dropdownRef.current?.contains(target)) {
        closeDropdown();
      }
    };
    document.addEventListener('mousedown', handleOutsideClick);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
      document.removeEventListener('mousedown', handleOutsideClick);
    };
  }, [closeDropdown, isOpen, updatePosition]);

  const selectProject = (projectId: string | null) => {
    onSelect(projectId);
    closeDropdown(true);
  };

  const handleDropdownKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeDropdown(true);
      return;
    }

    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const options = Array.from(
      dropdownRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []
    );
    if (options.length === 0) return;

    event.preventDefault();
    const currentIndex = options.findIndex((option) => option === document.activeElement);
    let nextIndex: number;
    if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = options.length - 1;
    } else if (event.key === 'ArrowUp') {
      nextIndex = currentIndex <= 0 ? options.length - 1 : currentIndex - 1;
    } else {
      nextIndex = currentIndex < 0 || currentIndex === options.length - 1 ? 0 : currentIndex + 1;
    }
    options[nextIndex]?.focus();
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setIsOpen((current) => !current)}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        data-tour-id="implement-project-filter"
        className={cn(
          'group flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors',
          isOpen
            ? 'border-primary/60 bg-primary/5 ring-1 ring-primary/20'
            : 'border-border bg-background hover:border-primary/40 hover:bg-accent/40'
        )}
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Icon name={selectedProject ? 'folder-git-2' : 'layers'} size={15} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-foreground">
            {selectedProject?.name || t('implement.projectFilterAll', 'All projects')}
          </span>
          <span className="block truncate text-[11px] text-muted-foreground">
            {selectedProject
              ? selectedProject.groupName || t('implement.independentProject', 'Independent project')
              : t('implement.projectFilterAllDescription', '{{count}} active tasks across the workspace', {
                  count: totalTaskCount,
                })}
          </span>
        </span>
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors group-hover:bg-accent group-hover:text-foreground">
          <Icon
            name="chevron-down"
            size={14}
            className={cn('transition-transform', isOpen && 'rotate-180')}
          />
        </span>
      </button>

      {isOpen && position && createPortal(
        <div
          ref={dropdownRef}
          role="listbox"
          aria-label={t('implement.projectFilterLabel', 'Filter tasks by project')}
          onKeyDown={handleDropdownKeyDown}
          style={{
            top: position.top,
            left: position.left,
            width: position.width,
            maxHeight: position.maxHeight,
          }}
          className="fixed z-[80] flex flex-col overflow-hidden rounded-xl border border-border bg-popover shadow-2xl"
        >
          <div className="border-b border-border p-2">
            <div className="flex items-center gap-2 rounded-md border border-border bg-background px-2.5">
              <Icon name="search" size={13} className="text-muted-foreground" />
              <input
                ref={searchRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('implement.searchProjects', 'Search projects...')}
                className="h-9 min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
              />
            </div>
          </div>

          <div className="overflow-y-auto p-1.5">
            <button
              type="button"
              role="option"
              aria-selected={selectedProjectId === null}
              onClick={() => selectProject(null)}
              className={cn(
                'flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors',
                selectedProjectId === null
                  ? 'border-primary/30 bg-primary/10'
                  : 'border-transparent hover:border-border hover:bg-accent/60'
              )}
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                <Icon name="layers" size={15} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-foreground">
                  {t('implement.projectFilterAll', 'All projects')}
                </span>
                <span className="block text-[11px] text-muted-foreground">
                  {t('implement.projectFilterAllHelp', 'Show every task from every project')}
                </span>
              </span>
              <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] tabular-nums text-muted-foreground">
                {totalTaskCount}
              </span>
              {selectedProjectId === null && <Icon name="check" size={14} className="text-primary" />}
            </button>

            {groupedProjects.map(([groupName, groupProjects]) => (
              <div key={groupName} className="mt-2">
                <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {groupName}
                </div>
                {groupProjects.map((project) => (
                  <button
                    key={project.id}
                    type="button"
                    role="option"
                    aria-selected={selectedProjectId === project.id}
                    onClick={() => selectProject(project.id)}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors',
                      selectedProjectId === project.id
                        ? 'border-primary/30 bg-primary/10'
                        : 'border-transparent hover:border-border hover:bg-accent/60'
                    )}
                  >
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                      <Icon name={project.isReadOnly ? 'folder' : 'folder-git-2'} size={15} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-foreground">{project.name}</span>
                        {project.isReadOnly && (
                          <span className="shrink-0 rounded bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-amber-400">
                            {t('implement.readOnlyBadge', 'Read-only')}
                          </span>
                        )}
                      </span>
                      <span className="block truncate text-[11px] text-muted-foreground">{project.path}</span>
                    </span>
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] tabular-nums text-muted-foreground">
                      {project.taskCount}
                    </span>
                    {selectedProjectId === project.id && <Icon name="check" size={14} className="text-primary" />}
                  </button>
                ))}
              </div>
            ))}

            {filteredProjects.length === 0 && (
              <div className="px-3 py-8 text-center text-sm text-muted-foreground">
                {t('implement.noProjectsFound', 'No project matches this search.')}
              </div>
            )}
          </div>
        </div>,
        document.body
      )}
    </>
  );
};
