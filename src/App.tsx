import React, { useEffect, useRef, Suspense, lazy, useState } from "react";
import { useTranslation } from "react-i18next";
import { Header } from "./components/layout/Header";
import { useWindowRestoration } from "./hooks/useWindowRestoration";
import { useUiZoom } from "./hooks/useUiZoom";
import { PanelResizer } from "./components/layout/PanelResizer";
import { ModeRouter } from "./components/layout/ModeRouter";
import { hasModePanel } from "./components/layout/modePanelLoaders";
import { Footer } from "./components/layout/Footer";
import { Toaster } from "./components/ui/Toaster";
import { notify } from "./components/ui/toastService";
import { WorkflowAttentionNotifications } from "./components/notifications/WorkflowAttentionNotifications";
import { useAppStore } from "./stores/useAppStore";
import { useConversationArchiveStore } from "./stores/useConversationArchiveStore";
import { useViewFilterStore } from "./stores/useViewFilterStore";
import { Skeleton } from "./components/shared/Skeleton";
import { useGlobalShortcuts } from "./hooks/useGlobalShortcuts";
import { getPlatformChromeState } from "./utils/desktopPlatform";
import { getTitleBarLayout } from "./components/layout/titleBarLayout";
import { useShallow } from "zustand/react/shallow";
import type {
  AppBootstrapController,
  AppBootstrapSnapshot,
} from "./services/appBootstrap";
import {
  getDatabaseInitializationStatus,
  isTauriAvailable,
  retryDatabaseInitialization,
} from "./services/tauriIpc";

// =============================================================================
// LAZY LOADED MODALS - Code Splitting for Non-Critical UI
// =============================================================================
// These modals are not needed immediately on startup and can be loaded on-demand

const DiffModal = lazy(() => import("./components/modals/DiffModal"));
const SettingsModal = lazy(() => import("./components/settings/SettingsModal"));
const ProjectModal = lazy(() => import("./components/modals/ProjectModal"));
const ProjectNavigator = lazy(() =>
  import("./components/modals/ProjectNavigator").then((module) => ({
    default: module.ProjectNavigator,
  })),
);
const ProjectGitFlowModal = lazy(
  () => import("./components/modals/ProjectGitFlowModal"),
);
const CodeFileViewerModal = lazy(
  () => import("./components/modals/CodeFileViewerModal"),
);
const ReleaseNotesModal = lazy(
  () => import("./components/modals/ReleaseNotesModal"),
);
const AppUpdateController = lazy(
  () => import("./components/updates/AppUpdateController"),
);
const OnboardingGuide = lazy(() =>
  import("./components/onboarding/OnboardingGuide").then((module) => ({
    default: module.OnboardingGuide,
  })),
);

const INITIAL_BOOTSTRAP_SNAPSHOT: AppBootstrapSnapshot = {
  phase: "idle",
  critical: false,
  high: false,
  normal: false,
  low: false,
  ready: false,
  errors: {},
  warnings: {},
  startupError: null,
};

const StartupScreen: React.FC = () => (
  <div className="flex h-full w-full min-h-0 min-w-0 items-center justify-center bg-background">
    <div className="flex flex-col items-center gap-4">
      <Skeleton className="h-12 w-12 rounded-full" />
      <Skeleton className="h-4 w-32" />
    </div>
  </div>
);

const StartupErrorScreen: React.FC<{
  message: string;
  failedSteps: string[];
  details?: string;
  onRetry: () => void;
}> = ({ message, failedSteps, details, onRetry }) => {
  const { t } = useTranslation();
  return (
  <div className="flex h-full w-full min-h-0 min-w-0 items-center justify-center bg-background px-6 text-foreground">
    <div className="w-full max-w-lg rounded-2xl border border-border bg-card/80 p-6 shadow-2xl">
      <p className="text-xs font-semibold uppercase tracking-[0.22em] text-muted-foreground">
        {t("startup.interrupted", "Startup interrupted")}
      </p>
      <h1 className="mt-3 text-2xl font-semibold">
        {t("startup.failedTitle", "Macro could not finish booting.")}
      </h1>
      <p className="mt-3 text-sm leading-6 text-muted-foreground">
        {import.meta.env.DEV
          ? message
          : t(
              "startup.failedDescription",
              "Macro could not initialize its local data. You can retry safely."
            )}
      </p>
      {import.meta.env.DEV && failedSteps.length > 0 && (
        <div className="mt-4 rounded-xl border border-border bg-background/60 p-3">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t("startup.failedSteps", "Failed steps")}
          </p>
          <p className="mt-1 text-sm">{failedSteps.join(", ")}</p>
        </div>
      )}
      {import.meta.env.DEV && details && (
        <pre className="mt-4 max-h-40 overflow-auto rounded-xl bg-black/40 p-3 text-xs text-muted-foreground">
          {details}
        </pre>
      )}
      <button
        type="button"
        onClick={onRetry}
        className="mt-5 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"
      >
        {t("common.retry", "Retry")}
      </button>
    </div>
  </div>
  );
};

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

  const [initStatus, setInitStatus] = useState<AppBootstrapSnapshot>(
    INITIAL_BOOTSTRAP_SNAPSHOT,
  );
  const [bootstrapImportError, setBootstrapImportError] = useState<{
    message: string;
    details?: string;
  } | null>(null);
  const [bootstrapRetryKey, setBootstrapRetryKey] = useState(0);
  const appBootstrapRef = useRef<AppBootstrapController | null>(null);

  const [
    isLeftOpen,
    isRightOpen,
    setLeftOpen,
    setRightOpen,
    leftPanelWidth,
    architectLeftPanelWidth,
    rightPanelWidth,
    setLeftPanelWidth,
    setArchitectLeftPanelWidth,
    setRightPanelWidth,
    metadataRecoveryReport,
    mode,
    projectNavigatorOpen,
    closeProjectNavigator,
  ] = useAppStore(
    useShallow((state) => [
      state.isLeftPanelOpen,
      state.isRightPanelOpen,
      state.setLeftPanelOpen,
      state.setRightPanelOpen,
      state.leftPanelWidth,
      state.architectLeftPanelWidth,
      state.rightPanelWidth,
      state.setLeftPanelWidth,
      state.setArchitectLeftPanelWidth,
      state.setRightPanelWidth,
      state.metadataRecoveryReport,
      state.mode,
      state.projectNavigatorOpen,
      state.closeProjectNavigator,
    ]),
  );
  const hasLeftPanel = hasModePanel(mode, "left");
  const hasRightPanel = hasModePanel(mode, "right");
  const activeLeftPanelWidth = mode === "Architect" ? architectLeftPanelWidth : leftPanelWidth;
  const resizeActiveLeftPanel = mode === "Architect" ? setArchitectLeftPanelWidth : setLeftPanelWidth;

  useEffect(() => {
    void useConversationArchiveStore.getState().hydrateArchivedConversationIds();
    void useViewFilterStore.getState().hydrate();
  }, [bootstrapRetryKey]);

  // Ref to track panels that were auto-collapsed during resize
  const autoCollapseRef = useRef<{ left: boolean; right: boolean }>({
    left: false,
    right: false,
  });
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

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
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
        setBootstrapImportError(null);
        const { appBootstrap } = await import("./services/appBootstrap");

        if (cancelled) {
          return;
        }

        appBootstrapRef.current = appBootstrap;
        setInitStatus(appBootstrap.getSnapshot());
        unsubscribe = appBootstrap.subscribe(() => {
          if (!cancelled) {
            setInitStatus(appBootstrap.getSnapshot());
          }
        });

        await appBootstrap.ensureStarted();
      } catch (error) {
        if (!cancelled) {
          console.error("Failed to initialize app bootstrap:", error);
          setBootstrapImportError({
            message:
              error instanceof Error
                ? error.message
                : "Macro could not load its startup module.",
            details:
              error instanceof Error
                ? error.stack || error.message
                : String(error),
          });
        }
      }
    })();

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [bootstrapRetryKey]);

  const handleStartupRetry = () => {
    setBootstrapImportError(null);
    setInitStatus(INITIAL_BOOTSTRAP_SNAPSHOT);
    const controller = appBootstrapRef.current;
    if (!controller) {
      setBootstrapRetryKey((current) => current + 1);
      return;
    }

    void (async () => {
      if (isTauriAvailable()) {
        const databaseStatus = await getDatabaseInitializationStatus();
        if (databaseStatus.status === "failed") {
          await retryDatabaseInitialization();
        }
      }
      await controller.restart();
    })().catch((error) => {
      console.error("Failed to restart app bootstrap:", error);
      setBootstrapImportError({
        message:
          error instanceof Error
            ? error.message
            : "Macro could not restart its startup sequence.",
        details:
          error instanceof Error ? error.stack || error.message : String(error),
      });
    });
  };

  const lastRecoveryToastKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (
      !initStatus.critical ||
      !metadataRecoveryReport ||
      metadataRecoveryReport.status === "none"
    ) {
      return;
    }

    const toastKey = [
      metadataRecoveryReport.status,
      metadataRecoveryReport.restoredCommit || "",
      metadataRecoveryReport.message || "",
    ].join(":");
    if (lastRecoveryToastKeyRef.current === toastKey) {
      return;
    }
    lastRecoveryToastKeyRef.current = toastKey;

    if (metadataRecoveryReport.status === "restored_from_history") {
      notify.success(
        metadataRecoveryReport.restoredCommit
          ? `Metadata @macro restored from history (${metadataRecoveryReport.restoredCommit})`
          : "Metadata @macro restored from history",
        {
          description:
            metadataRecoveryReport.message ||
            "Macro restored the latest valid metadata snapshot before loading the workspace.",
        },
      );
      return;
    }

    if (metadataRecoveryReport.status === "reconstructed_from_hints") {
      notify.info("Metadata @macro reconfigured from local projects", {
        description:
          metadataRecoveryReport.message ||
          "Macro rebuilt a minimal metadata state from locally known projects.",
      });
      return;
    }

    if (
      metadataRecoveryReport.status === "blocked_dirty" ||
      metadataRecoveryReport.status === "blocked_conflict"
    ) {
      notify.warning("Automatic @macro recovery skipped", {
        description:
          metadataRecoveryReport.message ||
          "Macro detected local metadata blockers and did not apply recovery automatically.",
      });
    }
  }, [initStatus.critical, metadataRecoveryReport]);

  // ==========================================================================
  // RENDER
  // ==========================================================================

  // Show minimal loading state while critical initialization is pending
  if (!initStatus.critical) {
    const startupError = bootstrapImportError || initStatus.startupError;
    if (startupError) {
      const failedSteps = initStatus.startupError
        ? initStatus.startupError.failedSteps
        : ["Bootstrap import"];
      return (
        <StartupErrorScreen
          message={startupError.message}
          failedSteps={failedSteps}
          details={startupError.details}
          onRetry={handleStartupRetry}
        />
      );
    }

    return <StartupScreen />;
  }

  return (
    <div
      className="macro-app-shell grid h-full w-full min-h-0 min-w-0 overflow-hidden bg-background"
      data-tour-id="app-shell"
      style={{
        gridTemplateRows: `${titleBarLayout.titleBarHeightPx}px 1fr 32px`,
      }}
    >
      <Header
        isLeftOpen={isLeftOpen}
        isRightOpen={isRightOpen}
        onToggleLeft={handleToggleLeft}
        onToggleRight={handleToggleRight}
      />

      {/* Main Content Area */}
      <div className="flex h-full min-h-0 min-w-0 overflow-hidden">
        {/* Left Panel - Mode-specific content */}
        {hasLeftPanel && isLeftOpen && (
          <>
            <div
              className="hidden h-full min-h-0 min-w-0 shrink-0 overflow-hidden sm:flex sm:flex-col"
              data-tour-id="left-panel"
              style={{ width: activeLeftPanelWidth }}
            >
              <ModeRouter panel="left" />
            </div>
            <PanelResizer
              onResize={(delta) => resizeActiveLeftPanel(activeLeftPanelWidth + delta)}
              className="hidden sm:flex"
              ariaLabel="Resize left panel"
            />
          </>
        )}

        {/* Center - Chat Zone (all modes use chat in center) */}
        <div className="flex-1 h-full min-h-0 min-w-0 overflow-hidden" data-tour-id="center-panel">
          <ModeRouter panel="center" />
        </div>

        {/* Right Panel - Mode-specific content */}
        {hasRightPanel && isRightOpen && (
          <>
            <PanelResizer
              onResize={(delta) => setRightPanelWidth(rightPanelWidth - delta)}
              className="hidden sm:flex"
              ariaLabel="Resize right panel"
            />
            <div
              className="hidden h-full min-h-0 min-w-0 shrink-0 overflow-hidden sm:flex sm:flex-col"
              data-tour-id="right-panel"
              style={{ width: rightPanelWidth }}
            >
              <ModeRouter panel="right" />
            </div>
          </>
        )}
      </div>

      <Footer />

      {/* Modals - Lazy Loaded with Suspense */}
      <Suspense fallback={null}>
        <DiffModal />
        <SettingsModal />
        <ProjectModal />
        {projectNavigatorOpen ? (
          <ProjectNavigator isOpen onClose={closeProjectNavigator} />
        ) : null}
        <ProjectGitFlowModal />
        <CodeFileViewerModal />
        <AppUpdateController enabled={initStatus.ready} />
        <ReleaseNotesModal enabled={initStatus.ready} />
      </Suspense>

      <Toaster />
      <WorkflowAttentionNotifications />

      <Suspense fallback={null}>
        <OnboardingGuide />
      </Suspense>
    </div>
  );
};

export default App;
