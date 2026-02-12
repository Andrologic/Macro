import { useEffect, useState, useCallback, createContext, useContext } from 'react';
import { useAppStore } from '../../stores/useAppStore';
import { applyTheme } from '../../utils/themeUtils';
import { useDynamicAppIcon } from '../../hooks/useDynamicAppIcon';
import { Theme, ThemeManifest } from '../../types/theme';

// =============================================================================
// THEME CONTEXT
// =============================================================================

interface ThemeContextType {
  theme: Theme;
  isDark: boolean;
  isLoading: boolean;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export function useTheme() {
  const context = useContext(ThemeContext);
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

interface CachedTheme {
  version: string;
  themeId: string;
  theme: Theme;
  timestamp: number;
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
    const cached = localStorage.getItem(`${THEME_CACHE_KEY}-${themeId}`);
    if (!cached) return null;

    const parsed: CachedTheme = JSON.parse(cached);
    
    // Check version
    if (parsed.version !== THEME_CACHE_VERSION) {
      return null;
    }

    // Check cache expiry (7 days)
    const CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
    if (Date.now() - parsed.timestamp > CACHE_TTL) {
      return null;
    }

    return parsed.theme;
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
    localStorage.setItem(`${THEME_CACHE_KEY}-${themeId}`, JSON.stringify(cache));
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

// =============================================================================
// THEME PROVIDER COMPONENT
// =============================================================================

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [manifest, setManifest] = useState<ThemeManifest | null>(null);
  const [currentTheme, setCurrentTheme] = useState<Theme>(defaultTheme);
  const [isLoading, setIsLoading] = useState(true);
  
  useDynamicAppIcon(currentTheme?.colors?.primary);

  const activeThemeId = useAppStore((state) => state.activeThemeId);

  // ==========================================================================
  // INITIAL THEME SETUP - Critical path optimization
  // ==========================================================================

  useEffect(() => {
    /**
     * CRITICAL PATH OPTIMIZATION:
     * 1. Apply default theme immediately (no flash of unstyled content)
     * 2. Check for cached theme
     * 3. Load manifest in background
     * 4. Fetch actual theme if needed
     */
    
    const setupTheme = async (): Promise<void> => {
      const startTime = performance.now();
      
      // Step 1: Apply default theme immediately
      applyDefaultTheme();
      
      // Step 2: Try to load from cache
      const cachedTheme = loadThemeFromCache(activeThemeId);
      if (cachedTheme) {
        applyTheme(cachedTheme);
        setCurrentTheme(cachedTheme);
        setIsLoading(false);
        console.log(`[ThemeProvider] Loaded from cache in ${(performance.now() - startTime).toFixed(2)}ms`);
      }

      // Step 3: Load manifest (non-blocking if cache hit)
      try {
        const manifestResponse = await fetch('/themes/manifest.json');
        const manifestData: ThemeManifest = await manifestResponse.json();
        setManifest(manifestData);

        // Step 4: Load actual theme if not cached
        const themeEntry = manifestData.themes.find((t) => t.id === activeThemeId) 
          || manifestData.themes[0];
        
        if (themeEntry && !cachedTheme) {
          const themeResponse = await fetch(themeEntry.path);
          const theme: Theme = await themeResponse.json();
          
          applyTheme(theme);
          setCurrentTheme(theme);
          saveThemeToCache(activeThemeId, theme);
          
          console.log(`[ThemeProvider] Loaded from network in ${(performance.now() - startTime).toFixed(2)}ms`);
        }
      } catch (error) {
        console.error('[ThemeProvider] Failed to load theme:', error);
        // Keep default theme on error
      } finally {
        setIsLoading(false);
      }
    };

    void setupTheme();
  }, []); // Run once on mount

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
        saveThemeToCache(themeId, theme);
      } catch (error) {
        console.error(`[ThemeProvider] Failed to load theme ${themeId}:`, error);
      }
    }
  }, [manifest]);

  // React to theme ID changes
  useEffect(() => {
    // Only handle changes after initial load
    if (!isLoading && activeThemeId !== currentTheme?.name?.toLowerCase().replace(' ', '-')) {
      void handleThemeChange(activeThemeId);
    }
  }, [activeThemeId, isLoading, handleThemeChange]);

  // ==========================================================================
  // PRELOAD OTHER THEMES
  // ==========================================================================

  useEffect(() => {
    /**
     * Preload other themes in background after initial render
     */
    if (!manifest || isLoading) return;

    const preloadThemes = (): void => {
      manifest.themes.forEach((themeEntry) => {
        if (themeEntry.id !== activeThemeId && !loadThemeFromCache(themeEntry.id)) {
          // Preload theme file
          fetch(themeEntry.path)
            .then((res) => res.json())
            .then((theme: Theme) => {
              saveThemeToCache(themeEntry.id, theme);
              console.log(`[ThemeProvider] Preloaded theme: ${themeEntry.id}`);
            })
            .catch((err) => {
              console.warn(`[ThemeProvider] Failed to preload theme ${themeEntry.id}:`, err);
            });
        }
      });
    };

    if ('requestIdleCallback' in window) {
      window.requestIdleCallback(() => preloadThemes(), { timeout: 5000 });
    } else {
      setTimeout(() => preloadThemes(), 2000);
    }
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
