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

interface WindowState {
  width: number;
  height: number;
  x: number | null;
  y: number | null;
  isMaximized: boolean;
}

// Debounce timer ref
let saveTimeout: ReturnType<typeof setTimeout> | null = null;

/**
 * Check if running in Tauri environment
 */
function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Hook to save and restore window state on app start/close
 */
export function useWindowRestoration() {
  const isInitialized = useRef(false);
  const windowApiRef = useRef<{
    setSize: (width: number, height: number) => Promise<void>;
    setPosition: (x: number, y: number) => Promise<void>;
    getOuterSize: () => Promise<{ width: number; height: number }>;
    getOuterPosition: () => Promise<{ x: number; y: number }>;
    maximize: () => Promise<void>;
    isMaximized: () => Promise<boolean>;
  } | null>(null);

  // Initialize window API
  const initWindowApi = useCallback(async () => {
    if (!isTauri()) return null;

    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const { LogicalSize, LogicalPosition } = await import(
        "@tauri-apps/api/dpi"
      );
      const win = getCurrentWindow();

      return {
        setSize: async (width: number, height: number) => {
          await win.setSize(new LogicalSize(width, height));
        },
        setPosition: async (x: number, y: number) => {
          await win.setPosition(new LogicalPosition(x, y));
        },
        getOuterSize: async () => {
          const size = await win.outerSize();
          return { width: size.width, height: size.height };
        },
        getOuterPosition: async () => {
          const pos = await win.outerPosition();
          return { x: pos.x, y: pos.y };
        },
        maximize: () => win.maximize(),
        isMaximized: () => win.isMaximized(),
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

      // Only save size/position if not maximized
      if (!isMax) {
        const size = await api.getOuterSize();
        const pos = await api.getOuterPosition();

        await Promise.all([
          savePreference(PREF_KEYS.WINDOW_WIDTH, size.width),
          savePreference(PREF_KEYS.WINDOW_HEIGHT, size.height),
          savePreference(PREF_KEYS.WINDOW_X, pos.x),
          savePreference(PREF_KEYS.WINDOW_Y, pos.y),
        ]);
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
        const prefs = await loadPreferences<WindowState>([
          PREF_KEYS.WINDOW_WIDTH,
          PREF_KEYS.WINDOW_HEIGHT,
          PREF_KEYS.WINDOW_X,
          PREF_KEYS.WINDOW_Y,
          PREF_KEYS.IS_MAXIMIZED,
        ]);

        const width = prefs[PREF_KEYS.WINDOW_WIDTH as keyof WindowState] as number;
        const height = prefs[PREF_KEYS.WINDOW_HEIGHT as keyof WindowState] as number;
        const x = prefs[PREF_KEYS.WINDOW_X as keyof WindowState] as number | null;
        const y = prefs[PREF_KEYS.WINDOW_Y as keyof WindowState] as number | null;
        const isMaximized = prefs[PREF_KEYS.IS_MAXIMIZED as keyof WindowState] as boolean;

        if (isMaximized) {
          await api.maximize();
        } else if (width && height) {
          await api.setSize(width, height);
          if (x !== null && y !== null) {
            await api.setPosition(x, y);
          }
        }

        console.log("Window state restored:", { width, height, x, y, isMaximized });
      } catch (error) {
        console.error("Failed to restore window state:", error);
      }
    };

    restore();
  }, [initWindowApi]);

  // Listen to window resize/move events
  useEffect(() => {
    if (!isTauri()) return;

    let unlistenResize: (() => void) | null = null;
    let unlistenMove: (() => void) | null = null;

    const setupListeners = async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const win = getCurrentWindow();

        unlistenResize = await win.onResized(() => {
          debouncedSave();
        });

        unlistenMove = await win.onMoved(() => {
          debouncedSave();
        });
      } catch (error) {
        console.error("Failed to setup window listeners:", error);
      }
    };

    setupListeners();

    return () => {
      if (saveTimeout) {
        clearTimeout(saveTimeout);
      }
      unlistenResize?.();
      unlistenMove?.();
    };
  }, [debouncedSave]);
}
