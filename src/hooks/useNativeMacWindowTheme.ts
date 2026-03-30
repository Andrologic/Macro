import { useEffect } from 'react';
import { Theme } from '../types/theme';
import { PREF_KEYS, savePreference } from '../services/preferences';
import { deriveTitlebarTheme } from '../utils/themeUtils';
import { getPlatformChromeState } from '../utils/desktopPlatform';
import {
  isTauriEnvironment,
  windowSetBackgroundColor,
  windowSetTheme,
} from '../services/tauriWindow';
import { devLogger } from '../utils/devLogger';

export function useNativeMacWindowTheme(theme: Theme, enabled = true): void {
  useEffect(() => {
    if (!enabled || !isTauriEnvironment() || !getPlatformChromeState().usesNativeMacosTitlebar) {
      return;
    }

    let cancelled = false;
    const titlebarTheme = deriveTitlebarTheme(theme);

    void (async () => {
      try {
        await Promise.all([
          savePreference(PREF_KEYS.NATIVE_MACOS_TITLEBAR_BG, titlebarTheme.nativeWindowBackground),
          savePreference(PREF_KEYS.NATIVE_MACOS_TITLEBAR_THEME, theme.type),
          windowSetBackgroundColor(titlebarTheme.nativeWindowBackground),
          windowSetTheme(theme.type),
        ]);

        if (!cancelled) {
          devLogger.log('[useNativeMacWindowTheme] Synced native macOS window theme', {
            themeType: theme.type,
            nativeWindowBackground: titlebarTheme.nativeWindowBackground,
          });
        }
      } catch (error) {
        if (!cancelled) {
          console.error('Failed to sync native macOS window theme:', error);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled, theme]);
}
