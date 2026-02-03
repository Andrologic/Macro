import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../stores/useAppStore';
import { useAuthStore } from '../../stores/useAuthStore';
import { Icon } from '../ui/Icon';
import { Button } from '../ui/Button';
import { Select } from '../ui/Select';
import { SUPPORTED_LANGUAGES, changeLanguage, type SupportedLanguage } from '../../i18n';
import { ThemeManifest } from '../../types/theme';

export const SettingsModal: React.FC = () => {
  const { t, i18n } = useTranslation();
  const { settingsOpen, closeSettings, activeThemeId, setTheme, openProvidersSettings, openToolsSettings } = useAppStore();
  const { user, updatePreferences, isLoading } = useAuthStore();
  const [manifest, setManifest] = useState<ThemeManifest | null>(null);

  // Load manifest for global theme selector
  useEffect(() => {
    fetch('/themes/manifest.json')
      .then((res) => res.json())
      .then((data: ThemeManifest) => setManifest(data))
      .catch(console.error);
  }, []);

  const [language, setLanguage] = useState<SupportedLanguage>((i18n.language as SupportedLanguage) || 'en');
  const [notifications, setNotifications] = useState(user?.preferences.notifications ?? true);
  const [emailUpdates, setEmailUpdates] = useState(user?.preferences.emailUpdates ?? false);

  if (!settingsOpen) return null;

  const handleSave = async () => {
    try {
      // Update i18n language
      await changeLanguage(language);

      if (user) {
        // Theme is stored locally; keep preferences update for language + notifications.
        await updatePreferences({
          language,
          notifications,
          emailUpdates,
        });
      }
      closeSettings();
    } catch (error) {
      console.error('Failed to save preferences:', error);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-[480px] max-h-[85vh] bg-card border border-border rounded-2xl shadow-2xl overflow-hidden flex flex-col">
        <header className="h-12 px-4 border-b border-border flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Icon name="settings" size={16} className="text-primary" />
            <span className="text-sm text-foreground">{t('settings.title')}</span>
          </div>
          <button
            onClick={closeSettings}
            className="p-1.5 rounded-lg hover:bg-accent transition-colors"
            aria-label={t('common.close')}
          >
            <Icon name="x" size={14} className="text-muted-foreground" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-4 space-y-6">
          {/* Appearance Section */}
          <section>
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
              {t('settings.appearance')}
            </h3>
            
            {/* Theme */}
            <div className="mb-4">
              <Select
                value={activeThemeId}
                onChange={(e) => setTheme(e.target.value)}
                label={t('settings.theme')}
              >
                 {manifest?.themes.map((thm) => (
                    <option key={thm.id} value={thm.id}>
                      {thm.name}
                    </option>
                 ))}
                 {!manifest && <option value="macro-dark">Macro Dark</option>}
              </Select>
            </div>

            {/* Language */}
            <div>
              <Select
                label={t('settings.language')}
                value={language}
                onChange={(e) => setLanguage(e.target.value as SupportedLanguage)}
              >
                {Object.entries(SUPPORTED_LANGUAGES).map(([code, { nativeName }]) => (
                  <option key={code} value={code}>
                    {nativeName}
                  </option>
                ))}
              </Select>
            </div>
          </section>

          {/* Notifications Section */}
          <section>
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
              {t('settings.notifications')}
            </h3>
            
            {/* In-app Notifications */}
            <div className="flex items-center justify-between py-2">
              <div>
                <label className="block text-sm text-foreground">{t('settings.inAppNotifications')}</label>
                <p className="text-xs text-muted-foreground mt-0.5">{t('settings.inAppNotificationsDesc')}</p>
              </div>
              <button
                onClick={() => setNotifications(!notifications)}
                className={`
                  relative w-11 h-6 rounded-full transition-colors duration-200
                  ${notifications ? 'bg-primary' : 'bg-muted'}
                `}
                aria-pressed={notifications}
                role="switch"
              >
                <span
                  className={`
                    absolute top-1 w-4 h-4 bg-white rounded-full transition-transform duration-200
                    ${notifications ? 'left-6' : 'left-1'}
                  `}
                />
              </button>
            </div>

            {/* Email Updates */}
            <div className="flex items-center justify-between py-2">
              <div>
                <label className="block text-sm text-foreground">{t('settings.emailUpdates')}</label>
                <p className="text-xs text-muted-foreground mt-0.5">{t('settings.emailUpdatesDesc')}</p>
              </div>
              <button
                onClick={() => setEmailUpdates(!emailUpdates)}
                className={`
                  relative w-11 h-6 rounded-full transition-colors duration-200
                  ${emailUpdates ? 'bg-primary' : 'bg-muted'}
                `}
                aria-pressed={emailUpdates}
                role="switch"
              >
                <span
                  className={`
                    absolute top-1 w-4 h-4 bg-white rounded-full transition-transform duration-200
                    ${emailUpdates ? 'left-6' : 'left-1'}
                  `}
                />
              </button>
            </div>
          </section>

          {/* AI & Models Section */}
          <section>
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
              {t('settings.aiModels')}
            </h3>
            
            <button
              onClick={() => {
                closeSettings();
                openProvidersSettings();
              }}
              className="w-full flex items-center justify-between p-3 bg-muted/50 hover:bg-muted rounded-lg transition-colors group"
            >
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
                  <Icon name="cpu" size={16} />
                </div>
                <div className="text-left">
                  <span className="block text-sm text-foreground">{t('settings.aiProviders')}</span>
                  <span className="block text-xs text-muted-foreground">{t('settings.aiProvidersDesc')}</span>
                </div>
              </div>
              <Icon name="chevron-right" size={16} className="text-muted-foreground group-hover:text-foreground transition-colors" />
            </button>

            <button
              onClick={() => {
                closeSettings();
                openToolsSettings();
              }}
              className="w-full flex items-center justify-between p-3 bg-muted/50 hover:bg-muted rounded-lg transition-colors group mt-2"
            >
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
                  <Icon name="tool" size={16} />
                </div>
                <div className="text-left">
                  <span className="block text-sm text-foreground">{t('settings.toolsMcp')}</span>
                  <span className="block text-xs text-muted-foreground">{t('settings.toolsMcpDesc')}</span>
                </div>
              </div>
              <Icon name="chevron-right" size={16} className="text-muted-foreground group-hover:text-foreground transition-colors" />
            </button>
          </section>

          {/* About Section */}
          <section>
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
              {t('settings.about')}
            </h3>
            <div className="bg-card/50 rounded-lg p-3 space-y-1">
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">{t('common.version')}</span>
                <span className="text-foreground">1.0.0</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">{t('common.build')}</span>
                <span className="text-foreground">2026.01.20</span>
              </div>
            </div>
          </section>
        </div>

        <footer className="h-12 border-t border-border px-4 flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={closeSettings}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" size="sm" onClick={handleSave} isLoading={isLoading}>
            {t('settings.saveChanges')}
          </Button>
        </footer>
      </div>
    </div>
  );
};
