import React, { useEffect, useState, useRef, Suspense, lazy } from 'react';
import { Header } from './components/layout/Header';
import { Toaster } from './components/ui/Toaster';
import { useWindowRestoration } from './hooks/useWindowRestoration';
import { PanelResizer } from './components/layout/PanelResizer';
import { ModeRouter, preloadAllModes } from './components/layout/ModeRouter';
import { useAppStore } from './stores/useAppStore';
import { useChatStore } from './stores/useChatStore';
import { useTaskStore } from './stores/useTaskStore';
import { useAIStore } from './stores/useAIStore';
import { useAuthStore } from './stores/useAuthStore';
import { useToolsStore } from './stores/useToolsStore';
import { useProviderStore } from './stores/useProviderStore';
import { Skeleton } from './components/shared/Skeleton';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
type InitPriority = 'critical' | 'high' | 'normal' | 'low';

// =============================================================================
// LAZY LOADED MODALS - Code Splitting for Non-Critical UI
// =============================================================================
// These modals are not needed immediately on startup and can be loaded on-demand

const DiffModal = lazy(() => import('./components/modals/DiffModal'));
const SettingsModal = lazy(() => import('./components/settings/SettingsModal'));
const AccountModal = lazy(() => import('./components/modals/AccountModal'));
const ProjectModal = lazy(() => import('./components/modals/ProjectModal'));
const CodeFileViewerModal = lazy(() => import('./components/modals/CodeFileViewerModal'));

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
  // Restore window size/position from preferences
  useWindowRestoration();

  // ==========================================================================
  // STORE INITIALIZATION FUNCTIONS
  // ==========================================================================
  
  const initializeApp = useAppStore((state) => state.initialize);
  const initializeChat = useChatStore((state) => state.initialize);
  const initializeTasks = useTaskStore((state) => state.initialize);
  const initializeAI = useAIStore((state) => state.initialize);
  const initializeTools = useToolsStore((state) => state.loadSettings);
  const initializeProviders = useProviderStore((state) => state.initialize);
  const checkSession = useAuthStore((state) => state.checkSession);

  // ==========================================================================
  // INITIALIZATION STATE
  // ==========================================================================
  
  const [initStatus, setInitStatus] = useState<{
    critical: boolean;
    high: boolean;
    normal: boolean;
    low: boolean;
  }>({
    critical: false,
    high: false,
    normal: false,
    low: false,
  });

  const [, setInitErrors] = useState<Record<string, string>>({});

  // ==========================================================================
  // PANEL STATE FROM STORE (persisted)
  // ==========================================================================
  
  const isLeftOpen = useAppStore((state) => state.isLeftPanelOpen);
  const isRightOpen = useAppStore((state) => state.isRightPanelOpen);
  const setLeftOpen = useAppStore((state) => state.setLeftPanelOpen);
  const setRightOpen = useAppStore((state) => state.setRightPanelOpen);
  const leftPanelWidth = useAppStore((state) => state.leftPanelWidth);
  const rightPanelWidth = useAppStore((state) => state.rightPanelWidth);
  const setLeftPanelWidth = useAppStore((state) => state.setLeftPanelWidth);
  const setRightPanelWidth = useAppStore((state) => state.setRightPanelWidth);
  
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

  // ==========================================================================
  // OPTIMIZED INITIALIZATION - Parallel with Priority
  // ==========================================================================

  useEffect(() => {
    /**
     * Initialize stores with priority-based loading strategy
     * 
     * PERFORMANCE OPTIMIZATION:
     * - Critical: App bootstrap (UI cannot render without it)
     * - High: Auth session (needed for permissions but UI can show skeleton)
     * - Normal: Chat, Tasks (can load in background)
     * - Low: AI Providers, Tools (can be deferred)
     */
    
    const initWithTracking = async (
      name: string,
      initFn: () => Promise<void>,
      priority: InitPriority
    ): Promise<void> => {
      const startTime = performance.now();
      try {
        await initFn();
        const duration = performance.now() - startTime;
        console.log(`[Init] ${name} (${priority}) completed in ${duration.toFixed(2)}ms`);
      } catch (error) {
        const duration = performance.now() - startTime;
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.error(`[Init] ${name} (${priority}) failed after ${duration.toFixed(2)}ms:`, errorMessage);
        setInitErrors((prev) => ({ ...prev, [name]: errorMessage }));
      }
    };

    const runInitialization = async (): Promise<void> => {
      const startTime = performance.now();
      console.log('[Init] Starting prioritized initialization...');

      // CRITICAL: App bootstrap - blocks UI rendering
      await initWithTracking('App Bootstrap', initializeApp, 'critical');
      setInitStatus((prev) => ({ ...prev, critical: true }));

      // HIGH: Auth session - parallel with UI rendering
      const highPriorityInit = Promise.all([
        initWithTracking('Auth Session', checkSession, 'high'),
      ]).then(() => {
        setInitStatus((prev) => ({ ...prev, high: true }));
      });

      // NORMAL: Core data - can load in background
      const normalPriorityInit = Promise.all([
        initWithTracking('Chat Store', initializeChat, 'normal'),
        initWithTracking('Task Store', initializeTasks, 'normal'),
      ]).then(() => {
        setInitStatus((prev) => ({ ...prev, normal: true }));
      });

      // LOW: Configuration and providers - defer until idle
      const lowPriorityInit = new Promise<void>((resolve) => {
        const runLowPriority = async (): Promise<void> => {
          await Promise.all([
            initWithTracking('AI Store', initializeAI, 'low'),
            initWithTracking('Tools Store', initializeTools, 'low'),
            initWithTracking('Provider Store', initializeProviders, 'low'),
          ]);
          setInitStatus((prev) => ({ ...prev, low: true }));
          resolve();
        };

        // Use requestIdleCallback if available, otherwise setTimeout
        if ('requestIdleCallback' in window) {
          window.requestIdleCallback(() => void runLowPriority(), { timeout: 2000 });
        } else {
          setTimeout(() => void runLowPriority(), 100);
        }
      });

      // Wait for critical + high before considering app "ready"
      await Promise.all([highPriorityInit, normalPriorityInit]);
      
      const totalDuration = performance.now() - startTime;
      console.log(`[Init] App ready in ${totalDuration.toFixed(2)}ms`);

      // Preload all mode components after app is ready
      preloadAllModes();

      // Low priority can continue in background
      void lowPriorityInit;
    };

    void runInitialization();
  }, [
    initializeApp,
    initializeChat,
    initializeTasks,
    initializeAI,
    initializeTools,
    initializeProviders,
    checkSession,
  ]);

  // ==========================================================================
  // GLOBAL KEYBOARD SHORTCUTS
  // ==========================================================================

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      // New Chat: Ctrl+N or Cmd+N
      if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
        e.preventDefault();
        void useChatStore.getState().createConversation('New Conversation', null, null);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
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
    <div className="h-screen w-screen bg-background grid grid-rows-[48px_1fr] overflow-hidden">
      {/* Header */}
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

      {/* Modals - Lazy Loaded with Suspense */}
      <Suspense fallback={null}>
        <DiffModal />
        <SettingsModal />
        <AccountModal />
        <ProjectModal />
        <CodeFileViewerModal />
      </Suspense>

      {/* Toast Notifications */}
      <Toaster />
    </div>
  );
};

export default App;
