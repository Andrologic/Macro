import { useEffect, useState, useCallback, createContext, useContext } from 'react';
import { useAppStore } from '../../stores/useAppStore';
import { applyTheme } from '../../utils/themeUtils';
import { useNativeMacWindowTheme } from '../../hooks/useNativeMacWindowTheme';
import { Theme, ThemeManifest } from '../../types/theme';
import { devLogger } from '../../utils/devLogger';

// =============================================================================
// THEME CONTEXT
// =============================================================================

interface ThemeContextType {
  theme: Theme;
  isDark: boolean;
  isLoading: boolean;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export function useOptionalTheme() {
  return useContext(ThemeContext);
}

export function useTheme() {
  const context = useOptionalTheme();
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}

// =============================================================================
// THEME CACHE CONSTANTS
// =============================================================================

const THEME_CACHE_KEY = 'macro-theme-cache';
const THEME_CACHE_VERSION = '2';
const themeCache = new Map<string, CachedTheme>();
let initialThemeSetupKey: string | null = null;
let initialThemeSetupPromise: Promise<InitialThemeSetupResult> | null = null;
let initialThemeSetupResult: InitialThemeSetupResult | null = null;
const preloadingThemeIds = new Set<string>();

interface CachedTheme {
  version: string;
  themeId: string;
  theme: Theme;
  timestamp: number;
}

interface InitialThemeSetupResult {
  manifest: ThemeManifest | null;
  theme: Theme;
  themeId: string;
}

// =============================================================================
// DEFAULT THEME - Inlined for instant first render
// =============================================================================

const defaultTheme: Theme = {
  name: 'Macro Dark',
  type: 'dark',
  colors: {
    background: '#09090b',
    foreground: '#fafafa',
    card: '#09090b',
    cardForeground: '#fafafa',
    popover: '#09090b',
    popoverForeground: '#fafafa',
    primary: '#6366f1',
    primaryForeground: '#fafafa',
    secondary: '#27272a',
    secondaryForeground: '#fafafa',
    muted: '#27272a',
    mutedForeground: '#a1a1aa',
    accent: '#27272a',
    accentForeground: '#fafafa',
    destructive: '#ef4444',
    destructiveForeground: '#fafafa',
    border: '#27272a',
    input: '#27272a',
    ring: '#6366f1',
  },
};

// =============================================================================
// THEME LOADING UTILITIES
// =============================================================================

/**
 * Load theme from cache
 */
const loadThemeFromCache = (themeId: string): Theme | null => {
  try {
    const cached = themeCache.get(`${THEME_CACHE_KEY}-${themeId}`);
    if (!cached) return null;

    // Check version
    if (cached.version !== THEME_CACHE_VERSION) {
      return null;
    }

    // Check cache expiry (7 days)
    const CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
    if (Date.now() - cached.timestamp > CACHE_TTL) {
      return null;
    }

    return cached.theme;
  } catch {
    return null;
  }
};

/**
 * Save theme to cache
 */
const saveThemeToCache = (themeId: string, theme: Theme): void => {
  try {
    const cache: CachedTheme = {
      version: THEME_CACHE_VERSION,
      themeId,
      theme,
      timestamp: Date.now(),
    };
    themeCache.set(`${THEME_CACHE_KEY}-${themeId}`, cache);
  } catch (error) {
    console.warn('[ThemeProvider] Failed to cache theme:', error);
  }
};

/**
 * Apply default theme immediately (synchronous)
 */
const applyDefaultTheme = (): void => {
  applyTheme(defaultTheme);
};

const ensureInitialThemeSetup = async (activeThemeId: string): Promise<InitialThemeSetupResult> => {
  if (initialThemeSetupResult && initialThemeSetupKey === activeThemeId) {
    return initialThemeSetupResult;
  }

  if (initialThemeSetupPromise && initialThemeSetupKey === activeThemeId) {
    return initialThemeSetupPromise;
  }

  initialThemeSetupKey = activeThemeId;
  initialThemeSetupPromise = (async () => {
    const startTime = performance.now();
    applyDefaultTheme();

    let manifest: ThemeManifest | null = null;
    let resolvedTheme = defaultTheme;
    let resolvedThemeId = activeThemeId;

    const cachedTheme = loadThemeFromCache(activeThemeId);
    if (cachedTheme) {
      resolvedTheme = cachedTheme;
      applyTheme(cachedTheme);
      devLogger.log(`[ThemeProvider] Loaded from cache in ${(performance.now() - startTime).toFixed(2)}ms`);
    }

    try {
      const manifestResponse = await fetch('/themes/manifest.json');
      const manifestData: ThemeManifest = await manifestResponse.json();
      manifest = manifestData;

      const themeEntry = manifestData.themes.find((theme) => theme.id === activeThemeId)
        || manifestData.themes[0];

      if (themeEntry) {
        resolvedThemeId = themeEntry.id;
      }

      if (themeEntry && !cachedTheme) {
        const themeResponse = await fetch(themeEntry.path);
        resolvedTheme = await themeResponse.json();
        applyTheme(resolvedTheme);
        saveThemeToCache(themeEntry.id, resolvedTheme);
        devLogger.log(`[ThemeProvider] Loaded from network in ${(performance.now() - startTime).toFixed(2)}ms`);
      }
    } catch (error) {
      console.error('[ThemeProvider] Failed to load theme:', error);
    }

    const result = {
      manifest,
      theme: resolvedTheme,
      themeId: resolvedThemeId,
    };
    initialThemeSetupResult = result;
    return result;
  })();

  return initialThemeSetupPromise;
};

// =============================================================================
// THEME PROVIDER COMPONENT
// =============================================================================

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [manifest, setManifest] = useState<ThemeManifest | null>(null);
  const [currentTheme, setCurrentTheme] = useState<Theme>(defaultTheme);
  const [currentThemeId, setCurrentThemeId] = useState<string>('macro-dark');
  const [isLoading, setIsLoading] = useState(true);

  useNativeMacWindowTheme(currentTheme, !isLoading);

  const activeThemeId = useAppStore((state) => state.activeThemeId);
  const [initialThemeId] = useState(() => activeThemeId);

  // ==========================================================================
  // INITIAL THEME SETUP - Critical path optimization
  // ==========================================================================

  useEffect(() => {
    let cancelled = false;

    const setupTheme = async (): Promise<void> => {
      const result = await ensureInitialThemeSetup(initialThemeId);
      if (cancelled) {
        return;
      }

      setManifest(result.manifest);
      setCurrentTheme(result.theme);
      setCurrentThemeId(result.themeId);
      setIsLoading(false);
    };

    void setupTheme();

    return () => {
      cancelled = true;
    };
  }, [initialThemeId]);

  // ==========================================================================
  // THEME CHANGE HANDLER
  // ==========================================================================

  const handleThemeChange = useCallback(async (themeId: string): Promise<void> => {
    if (!manifest) return;

    // Check cache first
    const cachedTheme = loadThemeFromCache(themeId);
    if (cachedTheme) {
      applyTheme(cachedTheme);
      setCurrentTheme(cachedTheme);
      setCurrentThemeId(themeId);
      return;
    }

    // Fetch from network
    const themeEntry = manifest.themes.find((t) => t.id === themeId);
    if (themeEntry) {
      try {
        const response = await fetch(themeEntry.path);
        const theme: Theme = await response.json();
        applyTheme(theme);
        setCurrentTheme(theme);
        setCurrentThemeId(themeEntry.id);
        saveThemeToCache(themeEntry.id, theme);
      } catch (error) {
        console.error(`[ThemeProvider] Failed to load theme ${themeId}:`, error);
      }
    }
  }, [manifest]);

  // React to theme ID changes
  useEffect(() => {
    // Only handle changes after initial load
    if (!isLoading && activeThemeId !== currentThemeId) {
      void handleThemeChange(activeThemeId);
    }
  }, [activeThemeId, currentThemeId, isLoading, handleThemeChange]);

  // ==========================================================================
  // PRELOAD OTHER THEMES
  // ==========================================================================

  useEffect(() => {
    /**
     * Preload other themes in background after initial render
     */
    if (!manifest || isLoading) return;

    let idleCallbackId: number | null = null;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const preloadThemes = (): void => {
      manifest.themes.forEach((themeEntry) => {
        if (
          themeEntry.id !== activeThemeId &&
          !loadThemeFromCache(themeEntry.id) &&
          !preloadingThemeIds.has(themeEntry.id)
        ) {
          preloadingThemeIds.add(themeEntry.id);
          fetch(themeEntry.path)
            .then((res) => res.json())
            .then((theme: Theme) => {
              if (cancelled) {
                return;
              }
              saveThemeToCache(themeEntry.id, theme);
              devLogger.log(`[ThemeProvider] Preloaded theme: ${themeEntry.id}`);
            })
            .catch((err) => {
              console.warn(`[ThemeProvider] Failed to preload theme ${themeEntry.id}:`, err);
            })
            .finally(() => {
              preloadingThemeIds.delete(themeEntry.id);
            });
        }
      });
    };

    if ('requestIdleCallback' in window) {
      idleCallbackId = window.requestIdleCallback(() => preloadThemes(), { timeout: 5000 });
    } else {
      timeoutId = setTimeout(() => preloadThemes(), 2000);
    }

    return () => {
      cancelled = true;
      if (idleCallbackId !== null && 'cancelIdleCallback' in window) {
        window.cancelIdleCallback(idleCallbackId);
      }
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
  }, [manifest, isLoading, activeThemeId]);

  const contextValue: ThemeContextType = {
    theme: currentTheme,
    isDark: currentTheme.type === 'dark',
    isLoading,
  };

  return (
    <ThemeContext.Provider value={contextValue}>
      {children}
    </ThemeContext.Provider>
  );
}

// =============================================================================
// EXPORTS
// =============================================================================

export { defaultTheme };
export type { CachedTheme };
