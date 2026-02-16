import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useAppStore } from '../../stores/useAppStore';
import { Icon, IconName } from '../ui/Icon';
import { Logo } from '../ui/Logo';
import { WindowControls } from './WindowControls';
import { useTauriWindow } from '../../hooks/useTauriWindow';
import { useTranslation } from 'react-i18next';
import { ProjectNavigator } from '../modals/ProjectNavigator';
import { cn } from '../../utils/cn';
import type { AppMode } from '../../types';

// Constants
const MODES_DROPDOWN_WIDTH = 192; // 12rem
const MODES_DROPDOWN_GAP = 6;
const MODES_DROPDOWN_MARGIN = 8;

interface HeaderProps {
  isLeftOpen: boolean;
  isRightOpen: boolean;
  onToggleLeft: () => void;
  onToggleRight: () => void;
}

interface ModeOption {
  value: AppMode;
  label: string;
  icon: IconName;
}

export function Header({
  isLeftOpen,
  isRightOpen,
  onToggleLeft,
  onToggleRight,
}: HeaderProps) {
  // Store hooks
  const mode = useAppStore((state) => state.mode);
  const setMode = useAppStore((state) => state.setMode);
  const openSettings = useAppStore((state) => state.openSettings);
  const openAccount = useAppStore((state) => state.openAccount);
  const selectedProjectId = useAppStore((state) => state.selectedProjectId);
  const selectedGroupId = useAppStore((state) => state.selectedGroupId);
  const projectGroups = useAppStore((state) => state.projectGroups);

  // UI hooks
  const { isAvailable: isTauriAvailable, toggleMaximize } = useTauriWindow();
  const { t } = useTranslation();

  // Local state
  const [projectNavigatorOpen, setProjectNavigatorOpen] = useState(false);
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [portalPosition, setPortalPosition] = useState<{ top: number; left: number } | null>(null);

  // Refs
  const modeMenuRef = useRef<HTMLDivElement>(null);
  const modeMenuPortalRef = useRef<HTMLDivElement>(null);

  // Derived state
  const modeOptions: ModeOption[] = [
    { value: 'Architect', label: t('header.architect'), icon: 'compass' },
    { value: 'Implement', label: t('header.implement'), icon: 'code' },
    { value: 'Chat', label: t('header.chat'), icon: 'message-circle' },
    { value: 'Debug', label: t('header.debug'), icon: 'terminal' },
  ];

  const currentMode = modeOptions.find((m) => m.value === mode) || modeOptions[0];

  // Effects
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      const isClickOutside =
        modeMenuRef.current && !modeMenuRef.current.contains(target) &&
        modeMenuPortalRef.current && !modeMenuPortalRef.current.contains(target);

      if (isClickOutside) {
        setModeMenuOpen(false);
      }
    };

    if (modeMenuOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [modeMenuOpen]);

  useEffect(() => {
    if (!modeMenuOpen) {
      setPortalPosition(null);
      return;
    }

    const updatePosition = () => {
      const trigger = modeMenuRef.current?.getBoundingClientRect();
      if (!trigger) return;

      const viewportWidth = window.innerWidth;
      let left = trigger.left + trigger.width / 2 - MODES_DROPDOWN_WIDTH / 2;
      
      // Clamp to viewport with margins
      if (left < MODES_DROPDOWN_MARGIN) {
        left = MODES_DROPDOWN_MARGIN;
      } else if (left + MODES_DROPDOWN_WIDTH > viewportWidth - MODES_DROPDOWN_MARGIN) {
        left = viewportWidth - MODES_DROPDOWN_WIDTH - MODES_DROPDOWN_MARGIN;
      }

      const top = trigger.bottom + MODES_DROPDOWN_GAP;
      setPortalPosition({ top: Math.round(top), left: Math.round(left) });
    };

    updatePosition();
    const handleResize = () => updatePosition();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [modeMenuOpen]);

  // Handlers
  const handleHeaderDoubleClick = () => {
    if (isTauriAvailable) {
      toggleMaximize();
    }
  };

  const getCurrentProjectName = (): string | null => {
    if (!selectedGroupId) return null;
    const group = projectGroups.find((g) => g.id === selectedGroupId);
    if (!group) return null;
    
    if (selectedProjectId) {
      const project = group.projects.find((p) => p.id === selectedProjectId);
      return project?.name || group.name;
    }
    return group.name;
  };

  const projectName = getCurrentProjectName();

  // Render helpers
  const renderModeButton = (modeOption: ModeOption) => (
    <button
      key={modeOption.value}
      onClick={() => setMode(modeOption.value)}
      data-tauri-drag-region="false"
      className={cn(
        'flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-medium transition-all duration-200',
        mode === modeOption.value
          ? 'bg-primary text-primary-foreground shadow-sm'
          : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
      )}
    >
      <Icon name={modeOption.icon} size={12} />
      {modeOption.label}
    </button>
  );

  const renderHeaderIconButton = (
    onClick: () => void,
    iconName: IconName,
    title: string,
    ariaLabel?: string
  ) => (
    <button
      onClick={onClick}
      className="p-1.5 rounded-lg hover:bg-accent transition-colors"
      title={title}
      aria-label={ariaLabel || title}
      data-tauri-drag-region="false"
    >
      <Icon name={iconName} size={16} className="text-muted-foreground" />
    </button>
  );

  return (
    <>
      <header 
        className="h-12 bg-card border-b border-border flex items-center justify-between px-4 shrink-0 select-none relative z-50 overflow-hidden"
        data-tauri-drag-region
        onDoubleClick={handleHeaderDoubleClick}
      >
        {/* Left Section: Logo, App Name, Project Button */}
        <div className="flex-1 flex items-center gap-2 min-w-0 overflow-hidden" data-tauri-drag-region>
          <div className="flex items-center gap-2 shrink-0">
            <Logo size={20} strokeWidth={3} />
            <span className="hidden lg:block text-sm font-semibold text-foreground">
              Macro
            </span>
          </div>
          
          {mode !== 'Chat' && (
            <>
              <div className="hidden sm:block w-px h-5 bg-border shrink-0" />
              <button
                onClick={() => setProjectNavigatorOpen(true)}
                className={cn(
                  'flex items-center gap-2 px-3 py-1.5 rounded-lg',
                  'hover:bg-accent transition-colors',
                  'text-sm min-w-[80px] max-w-[140px] sm:max-w-[180px] md:max-w-[220px] lg:max-w-[280px] xl:max-w-[320px]'
                )}
                data-tauri-drag-region="false"
              >
                <Icon name="folder-git-2" size={14} className="text-muted-foreground shrink-0" />
                <span className="truncate text-foreground min-w-0">
                  {projectName || t('header.selectProject')}
                </span>
                <Icon name="chevron-down" size={12} className="text-muted-foreground shrink-0" />
              </button>
            </>
          )}
        </div>

        {/* Center Section: Mode Selection - Fixed Position */}
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-10 pointer-events-none" data-tauri-drag-region="false">
          {/* Desktop: Segment Control */}
          <div className="hidden lg:inline-flex bg-secondary rounded-lg p-1 shrink-0 pointer-events-auto">
            {modeOptions.map(renderModeButton)}
          </div>

          {/* Mobile: Dropdown Menu */}
          <div className="lg:hidden relative pointer-events-auto" ref={modeMenuRef}>
            <button
              onClick={() => setModeMenuOpen(!modeMenuOpen)}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-secondary hover:bg-accent transition-colors text-xs font-medium"
              data-tauri-drag-region="false"
            >
              <Icon name={currentMode.icon} size={14} />
              <span className="truncate max-w-[80px]">{currentMode.label}</span>
              <Icon name="chevron-down" size={12} className="text-muted-foreground shrink-0" />
            </button>

            {modeMenuOpen && portalPosition && createPortal(
              <div
                ref={modeMenuPortalRef}
                style={{
                  position: 'absolute',
                  top: `${portalPosition.top}px`,
                  left: `${portalPosition.left}px`,
                  width: `${MODES_DROPDOWN_WIDTH}px`,
                }}
                className="bg-card border border-border rounded-lg shadow-xl z-[9999] py-1 animate-in fade-in zoom-in-95 duration-100"
              >
                {modeOptions.map((modeOption) => (
                  <button
                    key={modeOption.value}
                    onClick={() => {
                      setMode(modeOption.value);
                      setModeMenuOpen(false);
                    }}
                    className={cn(
                      'w-full flex items-center gap-2 px-3 py-2 text-xs font-medium transition-colors',
                      mode === modeOption.value
                        ? 'bg-primary/10 text-primary'
                        : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                    )}
                  >
                    <Icon name={modeOption.icon} size={14} />
                    {modeOption.label}
                  </button>
                ))}
              </div>,
              document.body
            )}
          </div>
        </div>

        {/* Right Section: Controls */}
        <div className="flex-1 flex items-center justify-end gap-2 min-w-[100px] sm:min-w-[160px] md:min-w-[200px]" data-tauri-drag-region>
          {/* Panel Toggle Buttons - Synced with App.tsx small screen breakpoints */}
          <button
            onClick={onToggleLeft}
            className="hidden sm:block p-1.5 rounded-lg hover:bg-accent transition-colors"
            title={t('header.toggleLeftPanel')}
            data-tauri-drag-region="false"
          >
            <Icon
              name={isLeftOpen ? 'panel-left-close' : 'panel-left-open'}
              size={16}
              className="text-muted-foreground"
            />
          </button>
          <button
            onClick={onToggleRight}
            className="hidden sm:block p-1.5 rounded-lg hover:bg-accent transition-colors"
            title={t('header.toggleRightPanel')}
            data-tauri-drag-region="false"
          >
            <Icon
              name={isRightOpen ? 'panel-right-close' : 'panel-right-open'}
              size={16}
              className="text-muted-foreground"
            />
          </button>

          <div className="hidden sm:block w-px h-5 bg-border mx-1" />

          {/* Settings Button */}
          {renderHeaderIconButton(
            () => openSettings(),
            'settings',
            t('header.settings'),
            t('header.settings')
          )}

          {/* Account Button */}
          {renderHeaderIconButton(
            openAccount,
            'user',
            t('header.account'),
            t('header.account')
          )}

          {/* Divider before Window Controls */}
          {isTauriAvailable && <div className="w-px h-5 bg-border mx-1" />}

          {/* Window Controls */}
          <WindowControls />
        </div>
      </header>

      {/* Modals */}
      <ProjectNavigator 
        isOpen={projectNavigatorOpen} 
        onClose={() => setProjectNavigatorOpen(false)} 
      />
    </>
  );
}
