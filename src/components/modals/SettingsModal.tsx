import React, { useState, useEffect } from 'react';
import { useAppStore } from '../../stores/useAppStore';
import { useAuthStore } from '../../stores/useAuthStore';
import { Icon } from '../ui/Icon';
import { Button } from '../ui/Button';
import { Select } from '../ui/Select';
import type { Language } from '../../types';
import { ThemeManifest } from '../../types/theme';

export const SettingsModal: React.FC = () => {
  const { settingsOpen, closeSettings, activeThemeId, setTheme } = useAppStore();
  const { user, updatePreferences, isLoading } = useAuthStore();
  const [manifest, setManifest] = useState<ThemeManifest | null>(null);

  // Load manifest for global theme selector
  useEffect(() => {
    fetch('/themes/manifest.json')
      .then((res) => res.json())
      .then((data: ThemeManifest) => setManifest(data))
      .catch(console.error);
  }, []);

  const [language, setLanguage] = useState<Language>(user?.preferences.language || 'en');
  const [notifications, setNotifications] = useState(user?.preferences.notifications ?? true);
  const [emailUpdates, setEmailUpdates] = useState(user?.preferences.emailUpdates ?? false);

  if (!settingsOpen) return null;

  const handleSave = async () => {
    try {
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
            <span className="text-sm text-foreground">Settings</span>
          </div>
          <button
            onClick={closeSettings}
            className="p-1.5 rounded-lg hover:bg-accent transition-colors"
          >
            <Icon name="x" size={14} className="text-muted-foreground" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-4 space-y-6">
          {/* Appearance Section */}
          <section>
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
              Appearance
            </h3>
            
            {/* Theme */}
            <div className="mb-4">
              <Select
                value={activeThemeId}
                onChange={(e) => setTheme(e.target.value)}
              >
                 {manifest?.themes.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                 ))}
                 {!manifest && <option value="macro-dark">Macro Dark</option>}
              </Select>
            </div>

            {/* Language */}
            <div>
              <Select
                label="Language"
                value={language}
                onChange={(e) => setLanguage(e.target.value as Language)}
              >
                <option value="en">English</option>
                <option value="fr">Français</option>
              </Select>
            </div>
          </section>

          {/* Notifications Section */}
          <section>
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
              Notifications
            </h3>
            
            {/* In-app Notifications */}
            <div className="flex items-center justify-between py-2">
              <div>
                <label className="block text-sm text-foreground">In-app notifications</label>
                <p className="text-xs text-muted-foreground mt-0.5">Receive notifications in the app</p>
              </div>
              <button
                onClick={() => setNotifications(!notifications)}
                className={`
                  relative w-11 h-6 rounded-full transition-colors duration-200
                  ${notifications ? 'bg-primary' : 'bg-muted'}
                `}
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
                <label className="block text-sm text-foreground">Email updates</label>
                <p className="text-xs text-muted-foreground mt-0.5">Receive email notifications</p>
              </div>
              <button
                onClick={() => setEmailUpdates(!emailUpdates)}
                className={`
                  relative w-11 h-6 rounded-full transition-colors duration-200
                  ${emailUpdates ? 'bg-primary' : 'bg-muted'}
                `}
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

          {/* About Section */}
          <section>
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
              About
            </h3>
            <div className="bg-card/50 rounded-lg p-3 space-y-1">
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Version</span>
                <span className="text-foreground">1.0.0</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Build</span>
                <span className="text-foreground">2026.01.20</span>
              </div>
            </div>
          </section>
        </div>

        <footer className="h-12 border-t border-border px-4 flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={closeSettings}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={handleSave} isLoading={isLoading}>
            Save Changes
          </Button>
        </footer>
      </div>
    </div>
  );
};
