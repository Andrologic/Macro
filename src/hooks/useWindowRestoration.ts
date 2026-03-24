/**
 * Window Restoration Hook
 *
 * Saves and restores window size, position, and maximized state.
 * Works only in Tauri environment with persistence via preferences service.
 */

import { useEffect, useCallback } from "react";
import {
  savePreference,
  loadPreferences,
  PREF_KEYS,
} from "../services/preferences";
import {
  isTauriEnvironment,
  showMainWindow,
  windowIsMaximized,
  windowMaximize,
  windowOuterPosition,
  windowOuterSize,
  windowScaleFactor,
  windowSetPosition,
  windowSetSize,
} from "../services/tauriWindow";
import { isPageShuttingDown } from "../utils/pageLifecycle";
import { devLogger } from "../utils/devLogger";

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
    if (isPageShuttingDown()) return;

    const api = await getWindowApi();
    if (!api || isPageShuttingDown()) return;

    try {
      const prefs = await loadPreferences<Record<string, unknown>>([
        PREF_KEYS.WINDOW_WIDTH,
        PREF_KEYS.WINDOW_HEIGHT,
        PREF_KEYS.WINDOW_X,
        PREF_KEYS.WINDOW_Y,
        PREF_KEYS.IS_MAXIMIZED,
      ]);

      const width = prefs[PREF_KEYS.WINDOW_WIDTH] as number | undefined;
      const height = prefs[PREF_KEYS.WINDOW_HEIGHT] as number | undefined;
      const x = prefs[PREF_KEYS.WINDOW_X] as number | null;
      const y = prefs[PREF_KEYS.WINDOW_Y] as number | null;
      const isMaximized = prefs[PREF_KEYS.IS_MAXIMIZED] as boolean;

      await new Promise((resolve) => setTimeout(resolve, 50));

      if (isPageShuttingDown()) return;

      if (isMaximized) {
        await api.maximize();
      } else if (width && height && width > 100 && height > 100) {
        await api.setSize(width, height);
        if (x !== null && y !== null && x >= 0 && y >= 0) {
          await api.setPosition(x, y);
        }
      }

      if (isPageShuttingDown()) return;
      devLogger.log("Window state restored:", { width, height, x, y, isMaximized });
    } catch (error) {
      if (isPageShuttingDown()) return;
      console.error("Failed to restore window state:", error);
    }

    if (isPageShuttingDown()) return;

    try {
      await showMainWindow();
      if (isPageShuttingDown()) return;
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

        const serializedState = JSON.stringify(nextState);
        if (lastSavedState === serializedState) {
          return;
        }
        lastSavedState = serializedState;

        await Promise.all([
          savePreference(PREF_KEYS.WINDOW_WIDTH, logicalWidth),
          savePreference(PREF_KEYS.WINDOW_HEIGHT, logicalHeight),
          savePreference(PREF_KEYS.WINDOW_X, logicalX),
          savePreference(PREF_KEYS.WINDOW_Y, logicalY),
        ]);
      } else {
        const serializedState = JSON.stringify(nextState);
        if (lastSavedState === serializedState) {
          return;
        }
        lastSavedState = serializedState;
      }

      await savePreference(PREF_KEYS.IS_MAXIMIZED, isMax);
    } catch (error) {
      console.error("Failed to save window state:", error);
    }
  }, []);

  // Debounced save
  const debouncedSave = useCallback(() => {
    if (isPageShuttingDown()) {
      return;
    }
    if (saveTimeout) {
      clearTimeout(saveTimeout);
    }
    saveTimeout = setTimeout(() => {
      void saveWindowState();
    }, 500);
  }, [saveWindowState]);

  // Restore window state on mount
  useEffect(() => {
    void ensureWindowRestoredOnce();
  }, []);

  // Listen to window resize/move events
  useEffect(() => {
    if (!isTauri()) return;

    let intervalId: ReturnType<typeof setInterval> | null = null;

    intervalId = setInterval(() => {
      debouncedSave();
    }, 1000);

    return () => {
      if (saveTimeout) {
        clearTimeout(saveTimeout);
      }
      if (intervalId) {
        clearInterval(intervalId);
      }
    };
  }, [debouncedSave]);
}
