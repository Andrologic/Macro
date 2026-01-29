import { useState, useEffect, useCallback } from 'react';

interface TauriWindowAPI {
  minimize: () => Promise<void>;
  maximize: () => Promise<void>;
  unmaximize: () => Promise<void>;
  toggleMaximize: () => Promise<void>;
  startDragging: () => Promise<void>;
  close: () => Promise<void>;
  isMaximized: () => Promise<boolean>;
}

let tauriWindowAPI: TauriWindowAPI | null = null;
let initPromise: Promise<void> | null = null;

async function initTauriWindowAPI(): Promise<void> {
  if (initPromise) {
    return initPromise;
  }

  initPromise = (async () => {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const window = getCurrentWindow();
      
      tauriWindowAPI = {
        minimize: () => window.minimize(),
        maximize: () => window.maximize(),
        unmaximize: () => window.unmaximize(),
        toggleMaximize: () => window.toggleMaximize(),
        startDragging: () => window.startDragging(),
        close: () => window.close(),
        isMaximized: () => window.isMaximized(),
      };
    } catch (error) {
      console.error('Failed to initialize Tauri window API:', error);
      tauriWindowAPI = null;
    }
  })();

  return initPromise;
}

export function useTauriWindow() {
  const [isAvailable, setIsAvailable] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);
  const [isInitialized, setIsInitialized] = useState(false);

  useEffect(() => {
    let mounted = true;

    const checkAndInit = async () => {
      // Check if running in Tauri
      const isTauri = typeof window !== 'undefined' && 
                     (window as any).__TAURI__ !== undefined ||
                     (window as any).__TAURI_INTERNALS__ !== undefined ||
                     window.location.protocol === 'tauri:';

      if (!isTauri || !mounted) {
        setIsInitialized(true);
        return;
      }

      try {
        await initTauriWindowAPI();
        
        if (mounted) {
          setIsAvailable(!!tauriWindowAPI);
          setIsInitialized(true);

          // Get initial maximized state
          if (tauriWindowAPI) {
            const max = await tauriWindowAPI.isMaximized();
            if (mounted) {
              setIsMaximized(max);
            }
          }
        }
      } catch (error) {
        console.error('Error initializing Tauri window:', error);
        if (mounted) {
          setIsAvailable(false);
          setIsInitialized(true);
        }
      }
    };

    checkAndInit();

    return () => {
      mounted = false;
    };
  }, []);

  const minimize = useCallback(async () => {
    if (tauriWindowAPI) {
      await tauriWindowAPI.minimize();
    }
  }, []);

  const maximize = useCallback(async () => {
    if (tauriWindowAPI) {
      await tauriWindowAPI.maximize();
      setIsMaximized(true);
    }
  }, []);

  const unmaximize = useCallback(async () => {
    if (tauriWindowAPI) {
      await tauriWindowAPI.unmaximize();
      setIsMaximized(false);
    }
  }, []);

  const toggleMaximize = useCallback(async () => {
    if (tauriWindowAPI) {
      await tauriWindowAPI.toggleMaximize();
      const max = await tauriWindowAPI.isMaximized();
      setIsMaximized(max);
    }
  }, []);

  const close = useCallback(async () => {
    if (tauriWindowAPI) {
      await tauriWindowAPI.close();
    }
  }, []);

  const startDragging = useCallback(async () => {
    if (tauriWindowAPI) {
      await tauriWindowAPI.startDragging();
    }
  }, []);

  return {
    isAvailable: isAvailable && isInitialized,
    isMaximized,
    minimize,
    maximize,
    unmaximize,
    toggleMaximize,
    startDragging,
    close,
  };
}
