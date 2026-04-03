import React, { useEffect, useRef, Suspense, lazy, useState } from 'react';
import { Header } from './components/layout/Header';
import { Toaster } from './components/ui/Toaster';
import { useWindowRestoration } from './hooks/useWindowRestoration';
import { useUiZoom } from './hooks/useUiZoom';
import { PanelResizer } from './components/layout/PanelResizer';
import { ModeRouter } from './components/layout/ModeRouter';
import { useAppStore } from './stores/useAppStore';
import { Skeleton } from './components/shared/Skeleton';
import { useGlobalShortcuts } from './hooks/useGlobalShortcuts';
import { getPlatformChromeState } from './utils/desktopPlatform';
import { getTitleBarLayout } from './components/layout/titleBarLayout';
import { useShallow } from 'zustand/react/shallow';

// =============================================================================
// LAZY LOADED MODALS - Code Splitting for Non-Critical UI
// =============================================================================
// These modals are not needed immediately on startup and can be loaded on-demand

const DiffModal = lazy(() => import('./components/modals/DiffModal'));
const SettingsModal = lazy(() => import('./components/settings/SettingsModal'));
const AccountModal = lazy(() => import('./components/modals/AccountModal'));
const ProjectModal = lazy(() => import('./components/modals/ProjectModal'));
const ProjectGitFlowModal = lazy(() => import('./components/modals/ProjectGitFlowModal'));
const CodeFileViewerModal = lazy(() => import('./components/modals/CodeFileViewerModal'));
const Footer = lazy(() =>
  import('./components/layout/Footer').then((module) => ({ default: module.Footer }))
);

interface AppBootstrapSnapshot {
  critical: boolean;
  high: boolean;
  normal: boolean;
  low: boolean;
  ready: boolean;
  errors: Record<string, string>;
}

const INITIAL_BOOTSTRAP_SNAPSHOT: AppBootstrapSnapshot = {
  critical: false,
  high: false,
  normal: false,
  low: false,
  ready: false,
  errors: {},
};

const FooterSkeleton: React.FC = () => (
  <div className="h-8 shrink-0 border-t border-border bg-background/70" aria-hidden="true" />
);

// =============================================================================
// INITIALIZATION PRIORITY CONFIGURATION
// =============================================================================

/**
 * Priority levels for store initialization:
 * - CRITICAL: Must complete before UI renders (blocking)
 * - HIGH: Should start immediately, UI can render without it
 * - NORMAL: Can be deferred slightly, non-blocking
 * - LOW: Load after app is interactive
 */

// =============================================================================
// APP COMPONENT
// =============================================================================

const App: React.FC = () => {
  const platformChrome = getPlatformChromeState();
  const titleBarLayout = getTitleBarLayout(platformChrome);

  // Restore window size/position from preferences
  useWindowRestoration();
  useUiZoom();

  useGlobalShortcuts();

  const [initStatus, setInitStatus] = useState<AppBootstrapSnapshot>(INITIAL_BOOTSTRAP_SNAPSHOT);

  const [
    isLeftOpen,
    isRightOpen,
    setLeftOpen,
    setRightOpen,
    leftPanelWidth,
    rightPanelWidth,
    setLeftPanelWidth,
    setRightPanelWidth,
  ] = useAppStore(
    useShallow((state) => [
      state.isLeftPanelOpen,
      state.isRightPanelOpen,
      state.setLeftPanelOpen,
      state.setRightPanelOpen,
      state.leftPanelWidth,
      state.rightPanelWidth,
      state.setLeftPanelWidth,
      state.setRightPanelWidth,
    ])
  );
  
  // Ref to track panels that were auto-collapsed during resize
  const autoCollapseRef = useRef<{ left: boolean; right: boolean }>({ left: false, right: false });
  const lastWidthRef = useRef(window.innerWidth);

  // ==========================================================================
  // RESPONSIVE PANEL MANAGEMENT
  // ==========================================================================

  useEffect(() => {
    const handleResize = () => {
      const width = window.innerWidth;
      const lastWidth = lastWidthRef.current;
      lastWidthRef.current = width;

      // 1. COLLAPSE LOGIC (Window shrinking)
      if (width < 640 && lastWidth >= 640) {
        // Entering mobile (< 640px): collapse whatever is open and remember it
        if (isLeftOpen) {
          autoCollapseRef.current.left = true;
          setLeftOpen(false);
        }
        if (isRightOpen) {
          autoCollapseRef.current.right = true;
          setRightOpen(false);
        }
      } else if (width < 1024 && lastWidth >= 1024) {
        // Entering tablet (640px - 1024px): if both open, collapse left and remember it
        if (isLeftOpen && isRightOpen) {
          autoCollapseRef.current.left = true;
          setLeftOpen(false);
        }
      }

      // 2. RESTORE LOGIC (Window growing)
      if (width >= 1024 && lastWidth < 1024) {
        // Returning to desktop (>= 1024px): restore left if it was auto-collapsed
        if (autoCollapseRef.current.left && !isLeftOpen) {
          setLeftOpen(true);
        }
        if (autoCollapseRef.current.right && !isRightOpen) {
          setRightOpen(true);
        }
        // Reset memory once we are in a state that supports both
        autoCollapseRef.current = { left: false, right: false };
      } else if (width >= 640 && lastWidth < 640) {
        // Returning to tablet (640px - 1024px): restore ONE panel
        // Prioritize right panel restoration in tablet mode
        if (autoCollapseRef.current.right && !isRightOpen) {
          setRightOpen(true);
          autoCollapseRef.current.right = false;
        } else if (autoCollapseRef.current.left && !isLeftOpen) {
          setLeftOpen(true);
          autoCollapseRef.current.left = false;
        }
      }
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [isLeftOpen, isRightOpen, setLeftOpen, setRightOpen]);

  // Handle manual toggles: clear/update auto-collapse memory
  const handleToggleLeft = () => {
    const nextState = !isLeftOpen;
    setLeftOpen(nextState);
    autoCollapseRef.current.left = false; // Manually toggled, clear memory

    // If opening left in tablet mode, toggle right to auto-collapse
    if (nextState && window.innerWidth < 1024 && isRightOpen) {
      autoCollapseRef.current.right = true;
      setRightOpen(false);
    }
  };

  const handleToggleRight = () => {
    const nextState = !isRightOpen;
    setRightOpen(nextState);
    autoCollapseRef.current.right = false; // Manually toggled, clear memory

    // If opening right in tablet mode, toggle left to auto-collapse
    if (nextState && window.innerWidth < 1024 && isLeftOpen) {
      autoCollapseRef.current.left = true;
      setLeftOpen(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;

    void (async () => {
      try {
        const { appBootstrap } = await import('./services/appBootstrap');

        if (cancelled) {
          return;
        }

        setInitStatus(appBootstrap.getSnapshot());
        unsubscribe = appBootstrap.subscribe(() => {
          if (!cancelled) {
            setInitStatus(appBootstrap.getSnapshot());
          }
        });

        await appBootstrap.ensureStarted();
      } catch (error) {
        if (!cancelled) {
          console.error('Failed to initialize app bootstrap:', error);
        }
      }
    })();

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  // ==========================================================================
  // RENDER
  // ==========================================================================

  // Show minimal loading state while critical initialization is pending
  if (!initStatus.critical) {
    return (
      <div className="h-screen w-screen bg-background flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <Skeleton className="h-12 w-12 rounded-full" />
          <Skeleton className="h-4 w-32" />
        </div>
      </div>
    );
  }

  return (
    <div
      className="macro-app-shell h-screen w-screen bg-background overflow-hidden"
      style={{ display: 'grid', gridTemplateRows: `${titleBarLayout.titleBarHeightPx}px 1fr 32px` }}
    >
      <Header
        isLeftOpen={isLeftOpen}
        isRightOpen={isRightOpen}
        onToggleLeft={handleToggleLeft}
        onToggleRight={handleToggleRight}
      />

      {/* Main Content Area */}
      <div className="flex overflow-hidden h-full">
        {/* Left Panel - Mode-specific content */}
        {isLeftOpen && (
          <>
            <div 
              className="hidden sm:flex flex-col shrink-0 h-full" 
              style={{ width: leftPanelWidth }}
            >
              <ModeRouter panel="left" />
            </div>
            <PanelResizer
              onResize={(delta) => setLeftPanelWidth(leftPanelWidth + delta)}
              className="hidden sm:flex"
            />
          </>
        )}

        {/* Center - Chat Zone (all modes use chat in center) */}
        <div className="flex-1 min-w-0 overflow-hidden h-full">
          <ModeRouter panel="center" />
        </div>

        {/* Right Panel - Mode-specific content */}
        {isRightOpen && (
          <>
            <PanelResizer
              onResize={(delta) => setRightPanelWidth(rightPanelWidth - delta)}
              className="hidden sm:flex"
            />
            <div 
              className="hidden sm:flex flex-col shrink-0 h-full" 
              style={{ width: rightPanelWidth }}
            >
              <ModeRouter panel="right" />
            </div>
          </>
        )}
      </div>

      <Suspense fallback={<FooterSkeleton />}>
        <Footer />
      </Suspense>

      {/* Modals - Lazy Loaded with Suspense */}
      <Suspense fallback={null}>
        <DiffModal />
        <SettingsModal />
        <AccountModal />
        <ProjectModal />
        <ProjectGitFlowModal />
        <CodeFileViewerModal />
      </Suspense>

      {/* Toast Notifications */}
      <Toaster />
    </div>
  );
};

export default App;
