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
  const { activeThemeId, setTheme } = useAppStore();
  const [themes, setThemes] = useState<LoadedTheme[]>([]);
  const [isLoading, setIsLoading] = useState(true);

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
