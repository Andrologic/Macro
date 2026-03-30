import {
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  useEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useTauriWindow } from '../../hooks/useTauriWindow';
import { getGlobalProjectById } from '../../services/globalProjects';
import { useAppStore } from '../../stores/useAppStore';
import { type AppMode } from '../../types';
import { cn } from '../../utils/cn';
import { getPlatformChromeState } from '../../utils/desktopPlatform';
import { Logo } from '../ui/Logo';
import { Icon, type IconName } from '../ui/Icon';
import { ProjectNavigator } from '../modals/ProjectNavigator';
import { WindowControls } from './WindowControls';
import { getTitleBarLayout } from './titleBarLayout';

const MODES_DROPDOWN_WIDTH = 192;
const MODES_DROPDOWN_GAP = 6;
const MODES_DROPDOWN_MARGIN = 8;
const INTERACTIVE_TITLEBAR_SELECTOR =
  "button, a, input, textarea, select, summary, [role='button'], [role='link'], [contenteditable='true']";

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

export type MacosTitlebarMouseAction = 'none' | 'toggle-maximize' | 'start-dragging';

export function resolveMacosTitlebarMouseAction({
  button,
  clickCount,
  isNoDragZone,
  isInteractiveElement,
}: {
  button: number;
  clickCount: number;
  isNoDragZone: boolean;
  isInteractiveElement: boolean;
}): MacosTitlebarMouseAction {
  if (button !== 0 || isNoDragZone || isInteractiveElement) {
    return 'none';
  }

  if (clickCount === 2) {
    return 'toggle-maximize';
  }

  return 'start-dragging';
}

export function Header({
  isLeftOpen,
  isRightOpen,
  onToggleLeft,
  onToggleRight,
}: HeaderProps) {
  const mode = useAppStore((state) => state.mode);
  const setMode = useAppStore((state) => state.setMode);
  const openSettings = useAppStore((state) => state.openSettings);
  const openAccount = useAppStore((state) => state.openAccount);
  const selectedGroupId = useAppStore((state) => state.selectedGroupId);
  const projectGroups = useAppStore((state) => state.projectGroups);

  const platformChrome = getPlatformChromeState();
  const titleBarLayout = getTitleBarLayout(platformChrome);
  const {
    isAvailable: isTauriAvailable,
    startDragging,
    toggleMaximize,
  } = useTauriWindow();
  const { t } = useTranslation();

  const [projectNavigatorOpen, setProjectNavigatorOpen] = useState(false);
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [portalPosition, setPortalPosition] = useState<{ top: number; left: number } | null>(null);

  const modeMenuRef = useRef<HTMLDivElement>(null);
  const modeMenuPortalRef = useRef<HTMLDivElement>(null);

  const modeOptions: ModeOption[] = [
    { value: 'Architect', label: t('header.architect'), icon: 'compass' },
    { value: 'Implement', label: t('header.implement'), icon: 'code' },
    { value: 'Chat', label: t('header.chat'), icon: 'message-circle' },
    { value: 'Debug', label: t('header.debug'), icon: 'terminal' },
  ];

  const currentMode = modeOptions.find((candidate) => candidate.value === mode) || modeOptions[0];
  const isNativeMacosTitlebar = platformChrome.usesNativeMacosTitlebar;
  const headerStyle = {
    '--macro-titlebar-height': `${titleBarLayout.titleBarHeightPx}px`,
  } as CSSProperties;

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
      if (!trigger) {
        return;
      }

      const viewportWidth = window.innerWidth;
      let left = trigger.left + trigger.width / 2 - MODES_DROPDOWN_WIDTH / 2;

      if (left < MODES_DROPDOWN_MARGIN) {
        left = MODES_DROPDOWN_MARGIN;
      } else if (left + MODES_DROPDOWN_WIDTH > viewportWidth - MODES_DROPDOWN_MARGIN) {
        left = viewportWidth - MODES_DROPDOWN_WIDTH - MODES_DROPDOWN_MARGIN;
      }

      setPortalPosition({
        top: Math.round(trigger.bottom + MODES_DROPDOWN_GAP),
        left: Math.round(left),
      });
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    return () => window.removeEventListener('resize', updatePosition);
  }, [modeMenuOpen]);

  const handleHeaderDoubleClick = () => {
    if (isNativeMacosTitlebar || platformChrome.disableCustomDoubleClickZoom) {
      return;
    }

    if (isTauriAvailable) {
      void toggleMaximize();
    }
  };

  const handleHeaderMouseDown = (event: ReactMouseEvent<HTMLElement>) => {
    if (!isNativeMacosTitlebar || !isTauriAvailable) {
      return;
    }

    const target = event.target instanceof HTMLElement ? event.target : null;
    const isNoDragZone = Boolean(target?.closest('[data-tauri-drag-region="false"]'));
    const isInteractiveElement = Boolean(target?.closest(INTERACTIVE_TITLEBAR_SELECTOR));
    const action = resolveMacosTitlebarMouseAction({
      button: event.button,
      clickCount: event.detail,
      isNoDragZone,
      isInteractiveElement,
    });

    if (action === 'toggle-maximize') {
      void toggleMaximize();
      return;
    }

    if (action === 'start-dragging') {
      void startDragging();
    }
  };

  const projectName = getGlobalProjectById(projectGroups, selectedGroupId)?.name ?? null;

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
      className="macro-titlebar-action p-1.5 rounded-lg hover:bg-accent transition-colors"
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
        className={cn(
          'macro-topbar select-none shrink-0 overflow-visible',
          isNativeMacosTitlebar && 'macro-topbar--native-macos'
        )}
        style={headerStyle}
        data-tauri-drag-region
        onMouseDown={handleHeaderMouseDown}
        onDoubleClick={handleHeaderDoubleClick}
      >
        <div className="macro-topbar-inner grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] gap-3">
          <div className="macro-topbar-leading flex min-w-0 items-center gap-2">
            <div className="macro-topbar-brand flex items-center gap-2 shrink-0">
              <Logo size={24} strokeWidth={3} />
              <span
                className={cn(
                  'macro-topbar-brand-label',
                  isNativeMacosTitlebar ? 'block' : 'hidden lg:block',
                  'text-sm font-semibold text-foreground'
                )}
              >
                Macro
              </span>
            </div>

            {mode !== 'Chat' ? (
              <>
                <div className="hidden sm:block w-px h-5 bg-border shrink-0" />
                <button
                  onClick={() => setProjectNavigatorOpen(true)}
                  className={cn(
                    'macro-titlebar-action flex items-center gap-2 px-3 py-1.5 rounded-lg',
                    'hover:bg-accent transition-colors text-sm',
                    'min-w-[80px] max-w-[140px] sm:max-w-[180px] md:max-w-[220px] lg:max-w-[280px] xl:max-w-[320px]'
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
            ) : null}
          </div>

          <div className="macro-topbar-center justify-self-center" data-tauri-drag-region="false">
            <div className="hidden lg:inline-flex bg-secondary rounded-lg p-1 shrink-0 pointer-events-auto">
              {modeOptions.map(renderModeButton)}
            </div>

            <div className="lg:hidden relative pointer-events-auto" ref={modeMenuRef}>
              <button
                onClick={() => setModeMenuOpen((current) => !current)}
                className="macro-titlebar-action flex items-center gap-2 px-3 py-1.5 rounded-lg bg-secondary hover:bg-accent transition-colors text-xs font-medium"
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

          <div className="macro-topbar-trailing flex min-w-[100px] sm:min-w-[160px] md:min-w-[200px] items-center justify-end gap-2 justify-self-end">
            <button
              onClick={onToggleLeft}
              className="macro-titlebar-action hidden sm:block p-1.5 rounded-lg hover:bg-accent transition-colors"
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
              className="macro-titlebar-action hidden sm:block p-1.5 rounded-lg hover:bg-accent transition-colors"
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

            {renderHeaderIconButton(() => openSettings(), 'settings', t('header.settings'), t('header.settings'))}
            {renderHeaderIconButton(openAccount, 'user', t('header.account'), t('header.account'))}

            {isTauriAvailable && platformChrome.showCustomWindowControls ? (
              <div className="w-px h-5 bg-border mx-1" />
            ) : null}

            <WindowControls chromeState={platformChrome} />
          </div>
        </div>
      </header>

      <ProjectNavigator isOpen={projectNavigatorOpen} onClose={() => setProjectNavigatorOpen(false)} />
    </>
  );
}
