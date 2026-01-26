import { useEffect, useState } from 'react';
import { useAppStore } from '../../stores/useAppStore';
import { applyTheme } from '../../utils/themeUtils';
import { Theme, ThemeManifest } from '../../types/theme';

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const activeThemeId = useAppStore((state) => state.activeThemeId);
  const [manifest, setManifest] = useState<ThemeManifest | null>(null);

  // 1. Load Manifest
  useEffect(() => {
    fetch('/themes/manifest.json')
      .then((res) => res.json())
      .then((data: ThemeManifest) => setManifest(data))
      .catch((err) => console.error('Failed to load theme manifest:', err));
  }, []);

  // 2. Load and Apply Theme
  useEffect(() => {
    if (!manifest) return;

    const themeEntry = manifest.themes.find((t) => t.id === activeThemeId) || manifest.themes[0];
    
    if (themeEntry) {
      fetch(themeEntry.path)
        .then((res) => res.json())
        .then((theme: Theme) => {
          applyTheme(theme);
        })
        .catch((err) => console.error(`Failed to load theme ${activeThemeId}:`, err));
    }
  }, [activeThemeId, manifest]);

  return <>{children}</>;
}
