import { useState, useEffect, useCallback } from 'react';
import {
  isTauriEnvironment,
  windowClose,
  windowIsMaximized,
  windowMaximize,
  windowMinimize,
  windowToggleMaximize,
  windowUnmaximize,
} from '../services/tauriWindow';

export function useTauriWindow() {
  const isAvailable = isTauriEnvironment();
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    if (!isAvailable) {
      setIsMaximized(false);
      return;
    }

    let mounted = true;

    const loadInitialWindowState = async () => {
      try {
        const max = await windowIsMaximized();
        if (mounted) {
          setIsMaximized(max);
        }
      } catch (error) {
        console.error('Error reading initial Tauri window state:', error);
        if (mounted) {
          setIsMaximized(false);
        }
      }
    };

    void loadInitialWindowState();

    return () => {
      mounted = false;
    };
  }, [isAvailable]);

  const syncMaximizedState = useCallback(async () => {
    if (!isAvailable) {
      return;
    }

    try {
      setIsMaximized(await windowIsMaximized());
    } catch (error) {
      console.error('Error syncing Tauri window state:', error);
    }
  }, [isAvailable]);

  const minimize = useCallback(async () => {
    if (!isAvailable) {
      return;
    }

    try {
      await windowMinimize();
    } catch (error) {
      console.error('Failed to minimize window:', error);
    }
  }, [isAvailable]);

  const maximize = useCallback(async () => {
    if (!isAvailable) {
      return;
    }

    try {
      await windowMaximize();
      setIsMaximized(true);
    } catch (error) {
      console.error('Failed to maximize window:', error);
      await syncMaximizedState();
    }
  }, [isAvailable, syncMaximizedState]);

  const unmaximize = useCallback(async () => {
    if (!isAvailable) {
      return;
    }

    try {
      await windowUnmaximize();
      setIsMaximized(false);
    } catch (error) {
      console.error('Failed to restore window:', error);
      await syncMaximizedState();
    }
  }, [isAvailable, syncMaximizedState]);

  const toggleMaximize = useCallback(async () => {
    if (!isAvailable) {
      return;
    }

    try {
      await windowToggleMaximize();
      await syncMaximizedState();
    } catch (error) {
      console.error('Failed to toggle maximize state:', error);
    }
  }, [isAvailable, syncMaximizedState]);

  const close = useCallback(async () => {
    if (!isAvailable) {
      return;
    }

    try {
      await windowClose();
    } catch (error) {
      console.error('Failed to close window:', error);
    }
  }, [isAvailable]);

  return {
    isAvailable,
    isMaximized,
    minimize,
    maximize,
    unmaximize,
    toggleMaximize,
    close,
  };
}
