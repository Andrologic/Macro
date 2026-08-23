import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Project } from '../../types';
import { cn } from '../../utils/cn';
import { Icon, type IconName } from '../ui/Icon';
import { ProjectIcon } from '../project/ProjectIcon';

interface TerminalTargetSplitButtonProps {
  variant: 'header' | 'icon' | 'empty';
  icon: IconName;
  label?: string;
  title?: string;
  isActive?: boolean;
  disabled?: boolean;
  badge?: React.ReactNode;
  projects: Project[];
  preferredProjectId: string | null;
  focusedProjectId: string | null;
  onPrimaryClick: () => void;
  onProjectSelect: (projectId: string) => void;
}

export const TerminalTargetSplitButton: React.FC<TerminalTargetSplitButtonProps> = ({
  variant,
  icon,
  label,
  title,
  isActive = false,
  disabled = false,
  badge,
  projects,
  preferredProjectId,
  focusedProjectId,
  onPrimaryClick,
  onProjectSelect,
}) => {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const showMenuTrigger = !disabled && projects.length > 1;

  useEffect(() => {
    if (!menuOpen) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [menuOpen]);

  const handleSelect = (projectId: string) => {
    onProjectSelect(projectId);
    setMenuOpen(false);
  };

  if (variant === 'header') {
    const baseButtonClassName = cn(
      'relative inline-flex h-8 items-center gap-2 border px-3 text-xs font-medium transition-colors',
      disabled
        ? 'cursor-not-allowed border-border bg-card/30 text-muted-foreground/60'
        : isActive
        ? 'border-primary/30 bg-primary/10 text-primary'
        : 'border-border bg-card/40 text-muted-foreground hover:bg-accent hover:text-foreground'
    );

    return (
      <div ref={containerRef} className="relative inline-flex">
        <button
          type="button"
          disabled={disabled}
          onClick={onPrimaryClick}
          title={title}
          className={cn(baseButtonClassName, showMenuTrigger ? 'rounded-l-md rounded-r-none border-r-0' : 'rounded-md')}
        >
          <Icon name={icon} size={12} />
          {label}
          {badge}
        </button>

        {showMenuTrigger && (
          <>
            <button
              type="button"
              disabled={disabled}
              onClick={() => setMenuOpen((current) => !current)}
              title={t('terminal.chooseProject', 'Choose sub-project')}
              aria-expanded={menuOpen}
              className={cn(
                baseButtonClassName,
                'rounded-l-none rounded-r-md px-2',
                isActive ? 'border-l-primary/30' : 'border-l-border'
              )}
            >
              <Icon name="chevron-down" size={12} />
            </button>

            {menuOpen && (
              <div className="absolute right-0 top-full z-50 mt-2 w-72 overflow-hidden rounded-xl border border-border bg-popover shadow-2xl">
                <div className="border-b border-border/60 px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {t('terminal.chooseProject', 'Choose sub-project')}
                </div>
                <div className="p-1.5">
                  {projects.map((project) => {
                    const isPreferred = project.id === preferredProjectId;
                    const isFocused = project.id === focusedProjectId;
                    return (
                      <button
                        key={project.id}
                        type="button"
                        onClick={() => handleSelect(project.id)}
                        className={cn(
                          'flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left transition-colors',
                          isPreferred
                            ? 'bg-primary/10 text-foreground'
                            : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                        )}
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <ProjectIcon project={project} size={14} className="text-muted-foreground" />
                          <span className="truncate text-sm font-medium">{project.name}</span>
                        </span>
                        <span className="flex shrink-0 items-center gap-2">
                          {isFocused && (
                            <span className="rounded-full border border-border bg-card/60 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                              {t('terminal.currentProject', 'Current')}
                            </span>
                          )}
                          {isPreferred && <Icon name="check" size={12} className="text-primary" />}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    );
  }

  const iconButtonBaseClassName =
    variant === 'empty'
      ? cn(
          'inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-sm',
          disabled
            ? 'cursor-not-allowed border-border bg-card/40 text-muted-foreground/60'
            : 'border-border bg-card text-foreground hover:bg-accent/60'
        )
      : cn(
          'inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs',
          disabled
            ? 'cursor-not-allowed text-muted-foreground/60'
            : 'text-foreground hover:bg-accent'
        );

  return (
    <div ref={containerRef} className="relative inline-flex">
      <button
        type="button"
        disabled={disabled}
        onClick={onPrimaryClick}
        title={title}
        className={cn(iconButtonBaseClassName, showMenuTrigger ? 'rounded-r-none pr-1.5' : undefined)}
      >
        <Icon name={icon} size={variant === 'empty' ? 14 : 12} />
        {label}
      </button>

      {showMenuTrigger && (
        <>
          <button
            type="button"
            disabled={disabled}
            onClick={() => setMenuOpen((current) => !current)}
            title={t('terminal.chooseProject', 'Choose sub-project')}
            aria-expanded={menuOpen}
            className={cn(
              iconButtonBaseClassName,
              'rounded-l-none border-l border-border px-2',
              variant === 'empty' ? 'bg-card' : undefined
            )}
          >
            <Icon name="chevron-down" size={12} />
          </button>

          {menuOpen && (
            <div className="absolute right-0 top-full z-50 mt-2 w-72 overflow-hidden rounded-xl border border-border bg-popover shadow-2xl">
              <div className="border-b border-border/60 px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {t('terminal.chooseProject', 'Choose sub-project')}
              </div>
              <div className="p-1.5">
                {projects.map((project) => {
                  const isPreferred = project.id === preferredProjectId;
                  const isFocused = project.id === focusedProjectId;
                  return (
                    <button
                      key={project.id}
                      type="button"
                      onClick={() => handleSelect(project.id)}
                      className={cn(
                        'flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left transition-colors',
                        isPreferred
                          ? 'bg-primary/10 text-foreground'
                          : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                      )}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <ProjectIcon project={project} size={14} className="text-muted-foreground" />
                        <span className="truncate text-sm font-medium">{project.name}</span>
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        {isFocused && (
                          <span className="rounded-full border border-border bg-card/60 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                            {t('terminal.currentProject', 'Current')}
                          </span>
                        )}
                        {isPreferred && <Icon name="check" size={12} className="text-primary" />}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default TerminalTargetSplitButton;
