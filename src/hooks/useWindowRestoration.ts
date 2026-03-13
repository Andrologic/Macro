/**
 * Window Restoration Hook
 *
 * Saves and restores window size, position, and maximized state.
 * Works only in Tauri environment with persistence via preferences service.
 */

import { useEffect, useRef, useCallback } from "react";
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

// Debounce timer ref
let saveTimeout: ReturnType<typeof setTimeout> | null = null;

/**
 * Check if running in Tauri environment
 */
function isTauri(): boolean {
  return isTauriEnvironment();
}

/**
 * Hook to save and restore window state on app start/close
 */
export function useWindowRestoration() {
  const isInitialized = useRef(false);
  const lastSavedState = useRef<string | null>(null);
  const windowApiRef = useRef<{
    setSize: (width: number, height: number) => Promise<void>;
    setPosition: (x: number, y: number) => Promise<void>;
    getOuterSize: () => Promise<{ width: number; height: number }>;
    getOuterPosition: () => Promise<{ x: number; y: number }>;
    getScaleFactor: () => Promise<number>;
    maximize: () => Promise<void>;
    isMaximized: () => Promise<boolean>;
  } | null>(null);

  // Initialize window API
  const initWindowApi = useCallback(async () => {
    if (!isTauri()) return null;

    try {
      return {
        setSize: (width: number, height: number) => windowSetSize(width, height),
        setPosition: (x: number, y: number) => windowSetPosition(x, y),
        getOuterSize: () => windowOuterSize(),
        getOuterPosition: () => windowOuterPosition(),
        getScaleFactor: () => windowScaleFactor(),
        maximize: () => windowMaximize(),
        isMaximized: () => windowIsMaximized(),
      };
    } catch (error) {
      console.error("Failed to init window API for restoration:", error);
      return null;
    }
  }, []);

  // Save current window state with debounce
  const saveWindowState = useCallback(async () => {
    const api = windowApiRef.current;
    if (!api) return;

    try {
      const isMax = await api.isMaximized();
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
        nextState.width = logicalWidth;
        nextState.height = logicalHeight;
        nextState.x = logicalX;
        nextState.y = logicalY;

        const serializedState = JSON.stringify(nextState);
        if (lastSavedState.current === serializedState) {
          return;
        }
        lastSavedState.current = serializedState;

        await Promise.all([
          savePreference(PREF_KEYS.WINDOW_WIDTH, logicalWidth),
          savePreference(PREF_KEYS.WINDOW_HEIGHT, logicalHeight),
          savePreference(PREF_KEYS.WINDOW_X, logicalX),
          savePreference(PREF_KEYS.WINDOW_Y, logicalY),
        ]);
      } else {
        const serializedState = JSON.stringify(nextState);
        if (lastSavedState.current === serializedState) {
          return;
        }
        lastSavedState.current = serializedState;
      }

      await savePreference(PREF_KEYS.IS_MAXIMIZED, isMax);
    } catch (error) {
      console.error("Failed to save window state:", error);
    }
  }, []);

  // Debounced save
  const debouncedSave = useCallback(() => {
    if (saveTimeout) {
      clearTimeout(saveTimeout);
    }
    saveTimeout = setTimeout(() => {
      saveWindowState();
    }, 500);
  }, [saveWindowState]);

  // Restore window state on mount
  useEffect(() => {
    if (isInitialized.current) return;

    const restore = async () => {
      const api = await initWindowApi();
      if (!api) return;

      windowApiRef.current = api;
      isInitialized.current = true;

      try {
        // Load preferences with correct key access
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

        // Small delay to ensure window is ready before resizing
        await new Promise((resolve) => setTimeout(resolve, 50));

        if (isMaximized) {
          await api.maximize();
        } else if (width && height && width > 100 && height > 100) {
          await api.setSize(width, height);
          if (x !== null && y !== null && x >= 0 && y >= 0) {
            await api.setPosition(x, y);
          }
        }

        console.log("Window state restored:", { width, height, x, y, isMaximized });
      } catch (error) {
        console.error("Failed to restore window state:", error);
      } finally {
        try {
          await showMainWindow();
          console.log("Window shown via command");
        } catch (err) {
          console.error("Failed to invoke show_main_window:", err);
        }
      }
    };

    restore();
  }, [initWindowApi]);

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
