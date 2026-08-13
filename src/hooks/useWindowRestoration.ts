/**
 * Window Restoration Hook
 *
 * Saves and restores window size, position, and maximized state.
 * Works only in Tauri environment with persistence via preferences service.
 */

import { useEffect, useCallback, useRef } from "react";
import {
  savePreference,
  loadPersistedPreference,
  loadPreferences,
  PREF_KEYS,
} from "../services/preferences";
import { useAppStore } from "../stores/useAppStore";
import {
  isTauriEnvironment,
  showMainWindow,
  windowAvailableMonitorBounds,
  windowClose,
  windowCurrentMonitorWorkArea,
  windowIsMaximized,
  windowMaximize,
  windowOnMoved,
  windowOnCloseRequested,
  windowOnResized,
  windowOuterPosition,
  windowOuterSize,
  windowPrimaryMonitorWorkArea,
  windowScaleFactor,
  windowSetBackgroundColor,
  windowSetPosition,
  windowSetSize,
  windowSetTheme,
} from "../services/tauriWindow";
import { markWindowCloseShutdown } from "../services/windowShutdown";
import { getPlatformChromeState } from "../utils/desktopPlatform";
import { isPageShuttingDown } from "../utils/pageLifecycle";
import { devLogger } from "../utils/devLogger";
import { sanitizeWindowBounds, type MonitorBounds } from '../services/windowBounds';

type WindowApi = {
  setSize: (width: number, height: number) => Promise<void>;
  setPosition: (x: number, y: number) => Promise<void>;
  getOuterSize: () => Promise<{ width: number; height: number }>;
  getOuterPosition: () => Promise<{ x: number; y: number }>;
  getScaleFactor: () => Promise<number>;
  maximize: () => Promise<void>;
  isMaximized: () => Promise<boolean>;
};

// Debounce timer ref
let saveTimeout: ReturnType<typeof setTimeout> | null = null;
let windowApi: WindowApi | null = null;
let windowApiPromise: Promise<WindowApi | null> | null = null;
let lastSavedState: string | null = null;
let restorePromise: Promise<void> | null = null;

type NativeWindowThemePreference = 'light' | 'dark' | null;

const getSelectedProjectGroupWorkspacePaths = (): string[] => {
  const { projectGroups, selectedGroupId } = useAppStore.getState();
  if (!selectedGroupId) return [];
  return (
    projectGroups
      .find((group) => group.id === selectedGroupId)
      ?.projects.map((project) => project.path)
      .filter((path) => path.trim().length > 0) ?? []
  );
};

const MACOS_WINDOW_BOOTSTRAP_VERSION = 2;
const LEGACY_MACOS_DEFAULT_WINDOW_SIZE = {
  width: 1200,
  height: 800,
} as const;
const WINDOW_CLOSE_FLUSH_TIMEOUT_MS = 1_000;

const monitorBoundsFromWorkArea = (
  workArea: { width: number; height: number; x: number; y: number } | null
): MonitorBounds | null =>
  workArea
    ? {
        position: { x: workArea.x, y: workArea.y },
        size: { width: workArea.width, height: workArea.height },
        workArea: {
          position: { x: workArea.x, y: workArea.y },
          size: { width: workArea.width, height: workArea.height },
        },
      }
    : null;

const retryWindowOperation = async <T>(
  operation: () => Promise<T>,
  description: string
): Promise<T> => {
  try {
    return await operation();
  } catch (error) {
    devLogger.log(`Retrying ${description} after a transient failure: ${String(error)}`);
    return operation();
  }
};

const isLegacyMacosDefaultWindowSize = (
  width: number | undefined,
  height: number | undefined
): boolean =>
  width === LEGACY_MACOS_DEFAULT_WINDOW_SIZE.width &&
  height === LEGACY_MACOS_DEFAULT_WINDOW_SIZE.height;

const clearPendingWindowStateSave = (): void => {
  if (!saveTimeout) {
    return;
  }

  clearTimeout(saveTimeout);
  saveTimeout = null;
};

/**
 * Check if running in Tauri environment
 */
function isTauri(): boolean {
  return isTauriEnvironment();
}

async function getWindowApi(): Promise<WindowApi | null> {
  if (windowApi) {
    return windowApi;
  }

  if (windowApiPromise) {
    return windowApiPromise;
  }

  windowApiPromise = (async () => {
    if (!isTauri()) return null;

    try {
      const api = {
        setSize: (width: number, height: number) => windowSetSize(width, height),
        setPosition: (x: number, y: number) => windowSetPosition(x, y),
        getOuterSize: () => windowOuterSize(),
        getOuterPosition: () => windowOuterPosition(),
        getScaleFactor: () => windowScaleFactor(),
        maximize: () => windowMaximize(),
        isMaximized: () => windowIsMaximized(),
      };
      windowApi = api;
      return api;
    } catch (error) {
      console.error("Failed to init window API for restoration:", error);
      return null;
    }
  })();

  return windowApiPromise;
}

export async function ensureWindowRestoredOnce(): Promise<void> {
  if (restorePromise) {
    return restorePromise;
  }

  restorePromise = (async () => {
    const shouldAbortRestore = (): boolean => {
      if (!isPageShuttingDown()) {
        return false;
      }

      devLogger.log('Aborting window restoration because shutdown is in progress.');
      return true;
    };

    if (shouldAbortRestore()) return;

    const api = await getWindowApi();
    if (!api || shouldAbortRestore()) return;

    try {
      const [
        prefs,
        persistedWidth,
        persistedHeight,
        persistedX,
        persistedY,
        persistedBootstrapVersion,
      ] = await Promise.all([
        loadPreferences<Record<string, unknown>>([
          PREF_KEYS.WINDOW_WIDTH,
          PREF_KEYS.WINDOW_HEIGHT,
          PREF_KEYS.WINDOW_X,
          PREF_KEYS.WINDOW_Y,
          PREF_KEYS.IS_MAXIMIZED,
          PREF_KEYS.NATIVE_MACOS_TITLEBAR_BG,
          PREF_KEYS.NATIVE_MACOS_TITLEBAR_THEME,
        ]),
        loadPersistedPreference<number>(PREF_KEYS.WINDOW_WIDTH),
        loadPersistedPreference<number>(PREF_KEYS.WINDOW_HEIGHT),
        loadPersistedPreference<number | null>(PREF_KEYS.WINDOW_X),
        loadPersistedPreference<number | null>(PREF_KEYS.WINDOW_Y),
        loadPersistedPreference<number>(PREF_KEYS.WINDOW_BOOTSTRAP_VERSION),
      ]);

      if (shouldAbortRestore()) return;

      const width = prefs[PREF_KEYS.WINDOW_WIDTH] as number | undefined;
      const height = prefs[PREF_KEYS.WINDOW_HEIGHT] as number | undefined;
      const x = prefs[PREF_KEYS.WINDOW_X] as number | null;
      const y = prefs[PREF_KEYS.WINDOW_Y] as number | null;
      const isMaximized = prefs[PREF_KEYS.IS_MAXIMIZED] as boolean;
      const nativeMacosTitlebarBg = prefs[PREF_KEYS.NATIVE_MACOS_TITLEBAR_BG] as string | undefined;
      const nativeMacosTitlebarTheme = prefs[PREF_KEYS.NATIVE_MACOS_TITLEBAR_THEME] as NativeWindowThemePreference | undefined;
      const chromeState = getPlatformChromeState();

      if (chromeState.usesNativeMacosTitlebar) {
        await Promise.all([
          nativeMacosTitlebarBg
            ? windowSetBackgroundColor(nativeMacosTitlebarBg)
            : Promise.resolve(),
          nativeMacosTitlebarTheme
            ? windowSetTheme(nativeMacosTitlebarTheme)
            : Promise.resolve(),
        ]);

        if (shouldAbortRestore()) return;
      }

      await new Promise((resolve) => setTimeout(resolve, 50));

      if (shouldAbortRestore()) return;

      const hasPersistedWindowGeometry =
        persistedWidth !== undefined ||
        persistedHeight !== undefined ||
        persistedX !== undefined ||
        persistedY !== undefined;
      const needsMacosBootstrapVersionUpgrade =
        chromeState.platform === "macos" &&
        (persistedBootstrapVersion ?? 0) < MACOS_WINDOW_BOOTSTRAP_VERSION;
      const shouldMigrateLegacyMacosDefault =
        needsMacosBootstrapVersionUpgrade &&
        isLegacyMacosDefaultWindowSize(persistedWidth, persistedHeight);
      const shouldBootstrapMacosMaximized =
        chromeState.platform === "macos" &&
        (!hasPersistedWindowGeometry || shouldMigrateLegacyMacosDefault);

      let bootstrappedMacosMaximized = false;
      let restoredWithMacosWorkArea = false;
      let restoredMacosWorkArea:
        | { width: number; height: number; x: number; y: number }
        | null = null;
      if (shouldBootstrapMacosMaximized) {
        try {
          await api.maximize();
          if (shouldAbortRestore()) return;
          bootstrappedMacosMaximized = true;
        } catch (error) {
          devLogger.log(
            `Failed to maximize default macOS window, falling back to monitor work area: ${String(error)}`
          );
          const monitorWorkArea =
            (await windowCurrentMonitorWorkArea()) ??
            (await windowPrimaryMonitorWorkArea());
          if (monitorWorkArea) {
            restoredMacosWorkArea = monitorWorkArea;
            await api.setSize(monitorWorkArea.width, monitorWorkArea.height);
            if (shouldAbortRestore()) return;
            await api.setPosition(monitorWorkArea.x, monitorWorkArea.y);
            if (shouldAbortRestore()) return;
            restoredWithMacosWorkArea = true;
          }
        }
      }

      if (bootstrappedMacosMaximized) {
        await Promise.all([
          savePreference(PREF_KEYS.IS_MAXIMIZED, true),
          savePreference(
            PREF_KEYS.WINDOW_BOOTSTRAP_VERSION,
            MACOS_WINDOW_BOOTSTRAP_VERSION
          ),
        ]);
      } else if (restoredWithMacosWorkArea && restoredMacosWorkArea) {
        await Promise.all([
          savePreference(PREF_KEYS.WINDOW_WIDTH, restoredMacosWorkArea.width),
          savePreference(PREF_KEYS.WINDOW_HEIGHT, restoredMacosWorkArea.height),
          savePreference(PREF_KEYS.WINDOW_X, restoredMacosWorkArea.x),
          savePreference(PREF_KEYS.WINDOW_Y, restoredMacosWorkArea.y),
          savePreference(PREF_KEYS.IS_MAXIMIZED, false),
          savePreference(
            PREF_KEYS.WINDOW_BOOTSTRAP_VERSION,
            MACOS_WINDOW_BOOTSTRAP_VERSION
          ),
        ]);
      } else if (restoredWithMacosWorkArea) {
        await Promise.all([
          savePreference(PREF_KEYS.IS_MAXIMIZED, false),
          savePreference(
            PREF_KEYS.WINDOW_BOOTSTRAP_VERSION,
            MACOS_WINDOW_BOOTSTRAP_VERSION
          ),
        ]);
      } else if (isMaximized) {
        await api.maximize();
        if (shouldAbortRestore()) return;
      } else if (!restoredWithMacosWorkArea && width && height && width > 100 && height > 100) {
        let monitors: MonitorBounds[] = [];
        try {
          monitors = await windowAvailableMonitorBounds();
        } catch (error) {
          devLogger.log(`Failed to read available monitors: ${String(error)}`);
        }

        let fallbackMonitor: MonitorBounds | null = monitors[0] ?? null;
        if (!fallbackMonitor) {
          const currentWorkArea = await windowCurrentMonitorWorkArea();
          fallbackMonitor = monitorBoundsFromWorkArea(currentWorkArea);
        }
        if (!fallbackMonitor) {
          const primaryWorkArea = await windowPrimaryMonitorWorkArea();
          fallbackMonitor = monitorBoundsFromWorkArea(primaryWorkArea);
        }

        const restoredBounds = sanitizeWindowBounds({
          requestedBounds: { width, height, x: x ?? undefined, y: y ?? undefined },
          monitors,
          fallbackMonitor,
          defaultSize: LEGACY_MACOS_DEFAULT_WINDOW_SIZE,
          platform: chromeState.platform,
          chromeMode: chromeState.usesNativeMacosTitlebar ? 'overlay' : 'frameless',
        });

        await retryWindowOperation(
          () => api.setSize(restoredBounds.width, restoredBounds.height),
          'window size restoration'
        );
        if (shouldAbortRestore()) return;
        await retryWindowOperation(
          () => api.setPosition(restoredBounds.x, restoredBounds.y),
          'window position restoration'
        );
        if (shouldAbortRestore()) return;
      }

      if (
        needsMacosBootstrapVersionUpgrade &&
        !bootstrappedMacosMaximized &&
        !restoredWithMacosWorkArea
      ) {
        await savePreference(
          PREF_KEYS.WINDOW_BOOTSTRAP_VERSION,
          MACOS_WINDOW_BOOTSTRAP_VERSION
        );
      }

      if (shouldAbortRestore()) return;
      devLogger.log("Window state restored:", {
        width,
        height,
        x,
        y,
        isMaximized,
        bootstrappedMacosMaximized,
        restoredWithMacosWorkArea,
      });
    } catch (error) {
      if (isPageShuttingDown()) return;
      console.error("Failed to restore window state:", error);
    }

    if (shouldAbortRestore()) return;

    try {
      await retryWindowOperation(() => showMainWindow(), 'main window display');
      if (shouldAbortRestore()) return;
      devLogger.log("Window shown via command");
    } catch (error) {
      if (isPageShuttingDown()) return;
      console.error("Failed to invoke show_main_window:", error);
    }
  })();

  return restorePromise;
}

/**
 * Hook to save and restore window state on app start/close
 */
export function useWindowRestoration() {
  const closeInProgressRef = useRef(false);
  // Save current window state with debounce
  const saveWindowState = useCallback(async () => {
    const api = await getWindowApi();
    if (!api || isPageShuttingDown()) return;

    try {
      const isMax = await api.isMaximized();
      if (isPageShuttingDown()) return;
      const nextState: Record<string, number | boolean | null> = {
        isMaximized: isMax,
      };
      let serializedState: string;

      // Only save size/position if not maximized
      if (!isMax) {
        const [size, pos, scaleFactor] = await Promise.all([
          api.getOuterSize(),
          api.getOuterPosition(),
          api.getScaleFactor(),
        ]);

        const logicalWidth = Math.round(size.width / scaleFactor);
        const logicalHeight = Math.round(size.height / scaleFactor);
        const logicalX = Math.round(pos.x / scaleFactor);
        const logicalY = Math.round(pos.y / scaleFactor);
        if (isPageShuttingDown()) return;
        nextState.width = logicalWidth;
        nextState.height = logicalHeight;
        nextState.x = logicalX;
        nextState.y = logicalY;

        serializedState = JSON.stringify(nextState);
        if (lastSavedState === serializedState) {
          return;
        }
        await Promise.all([
          savePreference(PREF_KEYS.WINDOW_WIDTH, logicalWidth),
          savePreference(PREF_KEYS.WINDOW_HEIGHT, logicalHeight),
          savePreference(PREF_KEYS.WINDOW_X, logicalX),
          savePreference(PREF_KEYS.WINDOW_Y, logicalY),
        ]);
      } else {
        serializedState = JSON.stringify(nextState);
        if (lastSavedState === serializedState) {
          return;
        }
      }

      await savePreference(PREF_KEYS.IS_MAXIMIZED, isMax);
      lastSavedState = serializedState;
    } catch (error) {
      console.error("Failed to save window state:", error);
    }
  }, []);

  // Debounced save
  const debouncedSave = useCallback(() => {
    if (isPageShuttingDown()) {
      return;
    }
    clearPendingWindowStateSave();
    saveTimeout = setTimeout(() => {
      saveTimeout = null;
      void saveWindowState();
    }, 500);
  }, [saveWindowState]);

  useEffect(() => {
    if (!isTauri()) return;

    let cancelled = false;
    let unlistenCloseRequested: (() => void) | null = null;

    void windowOnCloseRequested(async (event) => {
      if (closeInProgressRef.current) {
        return;
      }

      event.preventDefault();
      closeInProgressRef.current = true;
      clearPendingWindowStateSave();
      let timeout: ReturnType<typeof setTimeout> | null = null;
      try {
        await Promise.race([
          saveWindowState(),
          new Promise<void>((resolve) => {
            timeout = setTimeout(resolve, WINDOW_CLOSE_FLUSH_TIMEOUT_MS);
          }),
        ]);
      } finally {
        if (timeout) {
          clearTimeout(timeout);
        }
      }
      markWindowCloseShutdown(
        'window-close-requested',
        getSelectedProjectGroupWorkspacePaths()
      );
      try {
        await windowClose();
      } catch (error) {
        console.error('Failed to close window after flushing its state:', error);
        closeInProgressRef.current = false;
      }
    })
      .then((unlisten) => {
        if (cancelled) {
          unlisten();
          return;
        }

        unlistenCloseRequested = unlisten;
      })
      .catch((error) => {
        if (!cancelled) {
          console.error('Failed to register window close listener:', error);
        }
      });

    return () => {
      cancelled = true;
      unlistenCloseRequested?.();
    };
  }, [saveWindowState]);

  // Restore window state on mount
  useEffect(() => {
    void ensureWindowRestoredOnce();
  }, []);

  // Listen to window resize/move events
  useEffect(() => {
    if (!isTauri()) return;

    let intervalId: ReturnType<typeof setInterval> | null = null;
    let unlistenResize: (() => void) | null = null;
    let unlistenMove: (() => void) | null = null;
    let cancelled = false;

    const registerWindowListeners = async () => {
      try {
        [unlistenResize, unlistenMove] = await Promise.all([
          windowOnResized(() => debouncedSave()),
          windowOnMoved(() => debouncedSave()),
        ]);
        return;
      } catch (error) {
        if (!cancelled) {
          devLogger.log(`Window listener registration failed, falling back to polling: ${String(error)}`);
        }
      }

      intervalId = setInterval(() => {
        if (document.visibilityState === 'visible') {
          debouncedSave();
        }
      }, 4000);
    };

    void registerWindowListeners();

    return () => {
      cancelled = true;
      clearPendingWindowStateSave();
      unlistenResize?.();
      unlistenMove?.();
      if (intervalId) {
        clearInterval(intervalId);
      }
    };
  }, [debouncedSave]);
}

export function __resetWindowRestorationForTests(): void {
  clearPendingWindowStateSave();
  windowApi = null;
  windowApiPromise = null;
  lastSavedState = null;
  restorePromise = null;
}
