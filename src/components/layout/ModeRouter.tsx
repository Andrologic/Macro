import React, { Suspense, lazy } from 'react';
import { useAppStore } from '../../stores/useAppStore';
import type { AppMode } from '../../types';
import { Skeleton } from '../shared/Skeleton';

// =============================================================================
// LAZY LOADED COMPONENTS - Code Splitting by Mode
// =============================================================================
// These components are loaded on-demand based on the active mode
// This reduces the initial bundle size significantly

// Architect Mode components - Loaded only when mode === 'Architect'
const NeedsPanel = lazy(() => import('../architect/NeedsPanel'));
const StrategyGraph = lazy(() => import('../plan/StrategyGraph'));

// Implement Mode components - Loaded only when mode === 'Implement'
const TaskQueue = lazy(() => import('../tasks/TaskQueue'));
const FileChangesPanel = lazy(() => import('../implement/FileChangesPanel'));

// Chat Mode components - Loaded only when mode === 'Chat'
const ConversationArchive = lazy(() => import('../chat/ConversationArchive'));
const ContextToolbox = lazy(() => import('../chat/ContextToolbox'));

// Shared - ChatZone is used by all modes, but still lazy loaded
const ChatZone = lazy(() => import('../chat/ChatZone'));

// =============================================================================
// SKELETON COMPONENTS - Loading States
// =============================================================================

const LeftPanelSkeleton: React.FC = () => (
  <div className="flex flex-col gap-3 p-4 h-full">
    <Skeleton className="h-8 w-3/4" />
    <Skeleton className="h-4 w-full" />
    <Skeleton className="h-4 w-5/6" />
    <div className="mt-4 space-y-2">
      <Skeleton className="h-12 w-full" />
      <Skeleton className="h-12 w-full" />
      <Skeleton className="h-12 w-full" />
    </div>
  </div>
);

const CenterPanelSkeleton: React.FC = () => (
  <div className="flex flex-col h-full">
    {/* Header skeleton */}
    <div className="flex items-center gap-3 p-4 border-b border-border">
      <Skeleton className="h-10 w-32" />
      <Skeleton className="h-10 w-32" />
      <div className="flex-1" />
      <Skeleton className="h-10 w-10 rounded-full" />
    </div>
    {/* Messages area skeleton */}
    <div className="flex-1 p-4 space-y-4">
      <Skeleton className="h-20 w-3/4" />
      <Skeleton className="h-20 w-2/3 ml-auto" />
      <Skeleton className="h-20 w-3/4" />
    </div>
    {/* Input area skeleton */}
    <div className="p-4 border-t border-border">
      <Skeleton className="h-24 w-full" />
    </div>
  </div>
);

const RightPanelSkeleton: React.FC = () => (
  <div className="flex flex-col gap-3 p-4 h-full">
    <Skeleton className="h-6 w-1/2" />
    <Skeleton className="h-32 w-full" />
    <Skeleton className="h-32 w-full" />
    <Skeleton className="h-32 w-full" />
  </div>
);

// =============================================================================
// PANEL CONFIGURATION
// =============================================================================

interface PanelConfig {
  left: React.ComponentType<{ className?: string }>;
  center: React.ComponentType;
  right: React.ComponentType<{ className?: string }>;
}

// Map of mode-specific component configurations
const modeConfigs: Record<AppMode, PanelConfig> = {
  Architect: {
    left: NeedsPanel,
    center: ChatZone,
    right: StrategyGraph,
  },
  Implement: {
    left: TaskQueue,
    center: ChatZone,
    right: FileChangesPanel,
  },
  Chat: {
    left: ConversationArchive,
    center: ChatZone,
    right: ContextToolbox,
  },
};

// =============================================================================
// PANEL SKELETON MAP
// =============================================================================

const panelSkeletons = {
  left: <LeftPanelSkeleton />,
  center: <CenterPanelSkeleton />,
  right: <RightPanelSkeleton />,
};

// =============================================================================
// MODE ROUTER COMPONENT
// =============================================================================

interface ModeRouterProps {
  panel: 'left' | 'center' | 'right';
}

/**
 * ModeRouter - Routes to the appropriate panel component based on current mode
 * 
 * PERFORMANCE OPTIMIZATIONS:
 * - Uses React.lazy() for code splitting by mode
 * - Suspense boundaries with skeleton loading states
 * - Only loads components for the active mode
 * - Prevents unnecessary re-renders with stable references
 */
export const ModeRouter: React.FC<ModeRouterProps> = ({ panel }) => {
  const mode = useAppStore((state) => state.mode);

  // Get the appropriate component for the current panel and mode
  const Component = modeConfigs[mode][panel];
  const fallback = panelSkeletons[panel];

  return (
    <Suspense fallback={fallback}>
      <Component />
    </Suspense>
  );
};

// =============================================================================
// PRELOADING UTILITIES
// =============================================================================

/**
 * Preloads components for a specific mode
 * Call this when hovering over mode switcher or anticipating mode change
 */
export const preloadModeComponents = (mode: AppMode): void => {
  // Preload all panels for the specified mode
  switch (mode) {
    case 'Architect':
      import('../architect/NeedsPanel');
      import('../plan/StrategyGraph');
      break;
    case 'Implement':
      import('../tasks/TaskQueue');
      import('../implement/FileChangesPanel');
      break;
    case 'Chat':
      import('../chat/ConversationArchive');
      import('../chat/ContextToolbox');
      break;
  }
  
  // Always preload ChatZone as it's shared
  import('../chat/ChatZone');
};

/**
 * Preloads all mode components
 * Call this after initial render when app is idle
 */
export const preloadAllModes = (): void => {
  // Use requestIdleCallback for non-critical preloading
  if ('requestIdleCallback' in window) {
    window.requestIdleCallback(() => {
      preloadModeComponents('Architect');
      preloadModeComponents('Implement');
      preloadModeComponents('Chat');
    }, { timeout: 2000 });
  } else {
    // Fallback for browsers without requestIdleCallback
    setTimeout(() => {
      preloadModeComponents('Architect');
      preloadModeComponents('Implement');
      preloadModeComponents('Chat');
    }, 2000);
  }
};
