import React, { useEffect, useState } from 'react';
import { useAppStore } from '../../stores/useAppStore';
import type { AppMode } from '../../types';
import { Skeleton } from '../shared/Skeleton';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import {
  modePanelLoaders,
  preloadModePanels,
  resetModePanelLoader,
  type ModePanelComponent,
  type ModePanelLoader,
  type ModePanelSlot,
} from './modePanelLoaders';

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

const formatPanelLoadError = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }

  return typeof error === 'string' ? error : 'Unknown module loading error';
};

interface AsyncPanelProps {
  loader: ModePanelLoader;
  fallback: React.ReactNode;
}

export const AsyncPanel: React.FC<AsyncPanelProps> = ({ loader, fallback }) => {
  const [retryKey, setRetryKey] = useState(0);
  const [state, setState] = useState<{
    status: 'loading' | 'ready' | 'error';
    component: ModePanelComponent | null;
    error: unknown;
  }>(() => {
    const cachedComponent = loader.getCachedComponent();
    return cachedComponent
      ? { status: 'ready', component: cachedComponent, error: null }
      : { status: 'loading', component: null, error: null };
  });

  useEffect(() => {
    let cancelled = false;
    const cachedComponent = loader.getCachedComponent();

    if (cachedComponent) {
      setState({ status: 'ready', component: cachedComponent, error: null });
      return () => {
        cancelled = true;
      };
    }

    setState({ status: 'loading', component: null, error: null });

    void loader
      .load()
      .then((component) => {
        if (!cancelled) {
          setState({ status: 'ready', component, error: null });
        }
      })
      .catch((error) => {
        if (!cancelled) {
          console.error(`[ModeRouter] Failed to load ${loader.label}`, error);
          setState({ status: 'error', component: null, error });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [loader, retryKey]);

  if (state.status === 'ready' && state.component) {
    const Component = state.component;
    return <Component />;
  }

  if (state.status === 'error') {
    return (
      <div className="flex h-full min-h-0 flex-col items-center justify-center gap-4 border border-dashed border-border bg-background/70 p-6 text-center">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-amber-500/20 bg-amber-500/10 text-amber-500">
          <Icon name="alert-circle" size={18} />
        </div>
        <div className="max-w-sm space-y-1">
          <h2 className="text-sm font-semibold text-foreground">
            {loader.label} could not load.
          </h2>
          <p className="text-xs leading-5 text-muted-foreground">
            {formatPanelLoadError(state.error)}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            leftIcon={<Icon name="refresh-cw" size={13} />}
            onClick={() => {
              resetModePanelLoader(loader);
              setRetryKey((current) => current + 1);
            }}
          >
            Retry
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => window.location.reload()}
          >
            Reload app
          </Button>
        </div>
      </div>
    );
  }

  return <>{fallback}</>;
};

interface ModeRouterProps {
  panel: ModePanelSlot;
}

/**
 * ModeRouter - Routes to the appropriate panel component based on current mode
 * 
 * PERFORMANCE OPTIMIZATIONS:
 * - Loads mode panels through a cached controlled async loader
 * - Keeps skeleton loading states without letting chunk failures crash the shell
 * - Prevents unnecessary re-renders with stable references
 */
export const ModeRouter: React.FC<ModeRouterProps> = ({ panel }) => {
  const mode = useAppStore((state) => state.mode);
  const loader = modePanelLoaders[mode][panel];
  const fallback = panelSkeletons[panel];

  if (!loader) {
    return null;
  }

  return <AsyncPanel loader={loader} fallback={fallback} />;
};

// =============================================================================
// PRELOADING UTILITIES
// =============================================================================

/**
 * Preloads components for a specific mode
 * Call this when hovering over mode switcher or anticipating mode change
 */
export const preloadModeComponents = (mode: AppMode): void => {
  void preloadModePanels(mode);
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
