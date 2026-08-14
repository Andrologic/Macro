import {
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  Suspense,
  lazy,
  useEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useTauriWindow } from '../../hooks/useTauriWindow';
import { getGlobalProjectById } from '../../services/globalProjects';
import { windowSetTrafficLightPosition } from '../../services/tauriWindow';
import { useAppStore } from '../../stores/useAppStore';
import { type AppMode, type Project } from '../../types';
import { cn } from '../../utils/cn';
import { getPlatformChromeState } from '../../utils/desktopPlatform';
import { getEffectiveUiZoomScale } from '../../utils/uiZoom';
import { Logo } from '../ui/Logo';
import { Icon, type IconName } from '../ui/Icon';
import { WindowControls } from './WindowControls';
import { hasModePanel } from './modePanelLoaders';
import {
  getMacosTrafficLightPosition,
  getTitleBarLayout,
} from './titleBarLayout';

const ProjectNavigator = lazy(() =>
  import('../modals/ProjectNavigator').then((module) => ({
    default: module.ProjectNavigator,
  }))
);

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

const projectHasGitIntegration = (
  project: Pick<Project, 'gitSetupState' | 'readOnlyReason'>
): boolean => {
  if (project.gitSetupState === 'not_git') return false;
  return project.readOnlyReason !== 'missing_git' && project.readOnlyReason !== 'manual_and_missing_git';
};

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
  const projectNavigatorOpen = useAppStore((state) => state.projectNavigatorOpen);
  const openProjectNavigator = useAppStore((state) => state.openProjectNavigator);
  const closeProjectNavigator = useAppStore((state) => state.closeProjectNavigator);
  const selectedGroupId = useAppStore((state) => state.selectedGroupId);
  const selectedProjectId = useAppStore((state) => state.selectedProjectId);
  const projectGroups = useAppStore((state) => state.projectGroups);
  const getProjectById = useAppStore((state) => state.getProjectById);
  const uiZoomMode = useAppStore((state) => state.uiZoomMode);
  const uiZoomLevel = useAppStore((state) => state.uiZoomLevel);

  const platformChrome = getPlatformChromeState();
  const titleBarLayout = getTitleBarLayout(platformChrome);
  const {
    isAvailable: isTauriAvailable,
    startDragging,
    toggleMaximize,
  } = useTauriWindow();
  const { t } = useTranslation();

  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [portalPosition, setPortalPosition] = useState<{ top: number; left: number } | null>(null);

  const headerRef = useRef<HTMLElement>(null);
  const modeMenuRef = useRef<HTMLDivElement>(null);
  const modeMenuPortalRef = useRef<HTMLDivElement>(null);
  const lastTrafficLightPositionRef = useRef<string | null>(null);

  const modeOptions: ModeOption[] = [
    { value: 'Architect', label: t('header.architect'), icon: 'compass' },
    { value: 'Implement', label: t('header.implement'), icon: 'code' },
    { value: 'Chat', label: t('header.chat'), icon: 'message-circle' },
  ];

  const currentMode = modeOptions.find((candidate) => candidate.value === mode) || modeOptions[0];
  const isNativeMacosTitlebar = platformChrome.usesNativeMacosTitlebar;
  const effectiveUiZoomScale = getEffectiveUiZoomScale(uiZoomMode, uiZoomLevel);
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

  useEffect(() => {
    if (!isNativeMacosTitlebar || !isTauriAvailable) {
      lastTrafficLightPositionRef.current = null;
      return;
    }

    let cancelled = false;
    const position = getMacosTrafficLightPosition(effectiveUiZoomScale);
    const positionKey = `${position.x}:${position.y}`;

    if (lastTrafficLightPositionRef.current === positionKey) {
      return;
    }

    lastTrafficLightPositionRef.current = positionKey;

    void windowSetTrafficLightPosition(position.x, position.y).catch((error) => {
      if (!cancelled) {
        lastTrafficLightPositionRef.current = null;
        console.error('Failed to sync macOS traffic light position:', error);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [effectiveUiZoomScale, isNativeMacosTitlebar, isTauriAvailable]);

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

  const selectedGroup = getGlobalProjectById(projectGroups, selectedGroupId);
  const selectedProject = selectedProjectId ? getProjectById(selectedProjectId) ?? null : null;
  const projectName = selectedGroup?.name ?? selectedProject?.name ?? null;
  const projectPickerIcon: IconName = selectedGroup
    ? 'layers'
    : selectedProject
      ? projectHasGitIntegration(selectedProject)
        ? 'folder-git-2'
        : 'folder'
      : 'layers';

  const renderModeButton = (modeOption: ModeOption) => (
    <button
      key={modeOption.value}
      onClick={() => setMode(modeOption.value)}
      data-tauri-drag-region="false"
      data-tour-id={`mode-${modeOption.value.toLowerCase()}`}
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
    ariaLabel?: string,
    tourId?: string
  ) => (
    <button
      onClick={onClick}
      className="macro-titlebar-action rounded-md p-1.5 transition-colors hover:bg-accent"
      title={title}
      aria-label={ariaLabel || title}
      data-tauri-drag-region="false"
      data-tour-id={tourId}
    >
      <Icon name={iconName} size={16} className="text-muted-foreground" />
    </button>
  );

  return (
    <>
      <header
        ref={headerRef}
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
            <div className="macro-topbar-brand flex items-center gap-2 shrink-0" data-tour-id="app-brand">
              <Logo size={24} />
              <span
                className={cn(
                  'macro-topbar-brand-label',
                  isNativeMacosTitlebar ? 'inline-flex' : 'hidden lg:inline-flex',
                  'items-center self-center text-sm font-semibold leading-none text-foreground'
                )}
              >
                Macro
              </span>
            </div>

            {mode === 'Architect' ? (
              <>
                <div className="ml-2 hidden h-5 w-px shrink-0 bg-border sm:block" />
                <button
                  onClick={openProjectNavigator}
                  className={cn(
                    'macro-titlebar-action flex h-8 items-center gap-2 rounded-md px-2.5',
                    'hover:bg-accent transition-colors text-sm',
                    'min-w-[80px] max-w-[140px] sm:max-w-[180px] md:max-w-[220px] lg:max-w-[280px] xl:max-w-[320px]'
                  )}
                  data-tauri-drag-region="false"
                  data-tour-id="project-picker"
                >
                  <Icon name={projectPickerIcon} size={15} className="text-muted-foreground shrink-0" />
                  <span className="inline-flex min-w-0 items-center truncate leading-none text-foreground">
                    {projectName || t('header.selectProject')}
                  </span>
                  <Icon name="chevron-down" size={12} className="text-muted-foreground shrink-0" />
                </button>
              </>
            ) : null}
          </div>

          <div className="macro-topbar-center justify-self-center" data-tauri-drag-region="false">
            <div
              className="hidden lg:inline-flex bg-secondary rounded-lg p-1 shrink-0 pointer-events-auto"
              data-tour-id="mode-switcher"
            >
              {modeOptions.map(renderModeButton)}
            </div>

            <div className="lg:hidden relative pointer-events-auto" ref={modeMenuRef}>
              <button
                onClick={() => setModeMenuOpen((current) => !current)}
                className="macro-titlebar-action flex items-center gap-2 rounded-md bg-secondary px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-accent"
                data-tauri-drag-region="false"
                data-tour-id="mode-switcher"
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
            {hasModePanel(mode, 'left') && (
              <button
                onClick={onToggleLeft}
                className="macro-titlebar-action hidden rounded-md p-1.5 transition-colors hover:bg-accent sm:block"
                title={t('header.toggleLeftPanel')}
                data-tauri-drag-region="false"
                data-tour-id="toggle-left-panel"
              >
                <Icon
                  name={isLeftOpen ? 'panel-left-close' : 'panel-left-open'}
                  size={16}
                  className="text-muted-foreground"
                />
              </button>
            )}
            <button
              onClick={onToggleRight}
              className="macro-titlebar-action hidden rounded-md p-1.5 transition-colors hover:bg-accent sm:block"
              title={t('header.toggleRightPanel')}
              data-tauri-drag-region="false"
              data-tour-id="toggle-right-panel"
            >
              <Icon
                name={isRightOpen ? 'panel-right-close' : 'panel-right-open'}
                size={16}
                className="text-muted-foreground"
              />
            </button>

            <div className="hidden sm:block w-px h-5 bg-border mx-1" />

            {renderHeaderIconButton(
              () => window.dispatchEvent(new Event('macro:start-onboarding')),
              'book-open',
              t('onboarding.open', 'Open onboarding'),
              t('onboarding.open', 'Open onboarding'),
              'onboarding-help'
            )}

            {renderHeaderIconButton(
              () => openSettings(),
              'settings',
              t('header.settings'),
              t('header.settings'),
              'settings-button'
            )}

            {isTauriAvailable && platformChrome.showCustomWindowControls ? (
              <div className="w-px h-5 bg-border mx-1" />
            ) : null}

            <WindowControls chromeState={platformChrome} />
          </div>
        </div>
      </header>

      <Suspense fallback={null}>
        <ProjectNavigator
          isOpen={projectNavigatorOpen}
          onClose={closeProjectNavigator}
        />
      </Suspense>
    </>
  );
}
