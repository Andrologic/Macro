import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../../stores/useAppStore';
import { ThemeManifest, ThemeManifestItem, Theme } from '../../../types/theme'; // Adjust import based on usage
import { Icon } from '../../ui/Icon';
import { cn } from '../../../utils/cn';
import { ThemePreview } from './ThemePreview';

interface LoadedTheme extends ThemeManifestItem {
    colors?: Theme['colors'];
}

export const AppearanceView: React.FC = () => {
  const { t } = useTranslation();
  const {
    activeThemeId,
    setTheme,
    uiZoomMode,
    uiZoomLevel,
    setUiZoomMode,
    setUiZoomLevel,
  } = useAppStore();
  const [themes, setThemes] = useState<LoadedTheme[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const zoomPercent = Math.round(uiZoomLevel * 100);

  useEffect(() => {
    const loadThemes = async () => {
        try {
            const manifestRes = await fetch('/themes/manifest.json');
            const manifest: ThemeManifest = await manifestRes.json();
            
            // Fetch colors for each theme in parallel
            const loadedThemes = await Promise.all(
                manifest.themes.map(async (item) => {
                    try {
                        const themeRes = await fetch(item.path);
                        const themeData: Theme = await themeRes.json();
                        return { ...item, colors: themeData.colors };
                    } catch (e) {
                         console.warn(`Failed to load theme ${item.id}`, e);
                         return item;
                    }
                })
            );
            
            setThemes(loadedThemes);
        } catch (error) {
            console.error('Failed to load theme manifest', error);
        } finally {
            setIsLoading(false);
        }
    };

    loadThemes();
  }, []);

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-300">
      <section className="space-y-4">
        <h4 className="text-sm font-medium text-primary uppercase tracking-wider">
          {t('settings.zoom') || 'Zoom'}
        </h4>

        <div className="space-y-4 bg-card/40 p-4 rounded-xl border border-border/50">
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => setUiZoomMode('auto')}
              className={cn(
                'px-3 py-1.5 rounded-lg text-sm font-medium transition-colors',
                uiZoomMode === 'auto'
                  ? 'bg-primary/15 text-primary border border-primary/30'
                  : 'bg-muted/50 text-muted-foreground border border-border/60 hover:text-foreground'
              )}
            >
              {t('settings.zoom_auto') || 'Auto'}
            </button>
            <button
              onClick={() => setUiZoomMode('override')}
              className={cn(
                'px-3 py-1.5 rounded-lg text-sm font-medium transition-colors',
                uiZoomMode === 'override'
                  ? 'bg-primary/15 text-primary border border-primary/30'
                  : 'bg-muted/50 text-muted-foreground border border-border/60 hover:text-foreground'
              )}
            >
              {t('settings.zoom_override') || 'Override'}
            </button>
          </div>

          <div className="flex items-center justify-between gap-4">
            <label className="text-sm text-foreground">
              {t('settings.zoom_level') || 'Interface zoom'}
            </label>
            <span className="text-xs font-medium px-2 py-1 rounded-md bg-muted text-muted-foreground min-w-[56px] text-center">
              {zoomPercent}%
            </span>
          </div>

          <input
            type="range"
            min={75}
            max={200}
            step={5}
            value={zoomPercent}
            onChange={(event) => setUiZoomLevel(Number(event.target.value) / 100)}
            disabled={uiZoomMode === 'auto'}
            className="w-full accent-primary disabled:opacity-50 disabled:cursor-not-allowed"
          />

          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              {uiZoomMode === 'auto'
                ? t('settings.zoom_auto_desc') || 'Uses your system display scaling (Wayland/X11/macOS/Windows).'
                : t('settings.zoom_override_desc') || 'Manually set interface zoom from 75% to 200%.'}
            </p>
            <button
              onClick={() => setUiZoomLevel(1)}
              className="text-xs px-2 py-1 rounded-md border border-border/60 text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
            >
              {t('settings.zoom_reset') || 'Reset'}
            </button>
          </div>
        </div>
      </section>

      <section>
        <h4 className="text-sm font-medium text-primary uppercase tracking-wider mb-4">
          {t('settings.theme') || 'Theme'}
        </h4>
        
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
          {themes.map((theme) => ( 
            <button
              key={theme.id}
              onClick={() => setTheme(theme.id)}
              className={cn(
                "group relative flex flex-col gap-2 p-3 rounded-xl border-2 transition-all duration-200 text-left",
                activeThemeId === theme.id
                  ? "border-primary bg-primary/5 ring-1 ring-primary/20 shadow-sm"
                  : "border-border/50 hover:border-border hover:bg-muted/50"
              )}
            >
              {activeThemeId === theme.id && (
                  <div className="absolute top-2 right-2 p-1 bg-primary text-primary-foreground rounded-full z-10 shadow-sm">
                      <Icon name="check" size={10} />
                  </div>
              )}

              {/* Theme Preview Component */}
              {theme.colors ? (
                  <ThemePreview colors={theme.colors} isActive={activeThemeId === theme.id} />
              ) : (
                  // Fallback for failed load
                  <div className={cn(
                      "w-full aspect-[4/3] rounded-lg mb-2 border border-border/10 shadow-inner flex overflow-hidden",
                      theme.type === 'dark' ? "bg-slate-900" : "bg-slate-100"
                  )} />
              )}
              
              <div>
                 <span className="text-sm font-semibold text-foreground block truncate">{theme.name}</span>
                 <span className="text-xs text-muted-foreground capitalize flex items-center gap-1">
                    {theme.type === 'dark' ? <Icon name="moon" size={10} /> : <Icon name="sun" size={10} />}
                    {theme.type}
                 </span>
              </div>
            </button>
          ))}
          
          {isLoading && (
              // Loading Skeletons
              Array.from({ length: 9 }).map((_, i) => (
                  <div key={i} className="h-40 rounded-xl bg-muted/20 animate-pulse" />
              ))
          )}
        </div>
      </section>
    </div>
  );
};
