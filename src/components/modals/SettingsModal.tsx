import React, { useState } from 'react';
import { useAppStore } from '../../stores/useAppStore';
import { useAuthStore } from '../../stores/useAuthStore';
import { Icon } from '../ui/Icon';
import { Button } from '../ui/Button';
import type { ThemeMode, Language } from '../../types';

export const SettingsModal: React.FC = () => {
  const { settingsOpen, closeSettings } = useAppStore();
  const { user, updatePreferences, isLoading } = useAuthStore();
  const [theme, setTheme] = useState<ThemeMode>(user?.preferences.theme || 'dark');
  const [language, setLanguage] = useState<Language>(user?.preferences.language || 'en');
  const [notifications, setNotifications] = useState(user?.preferences.notifications ?? true);
  const [emailUpdates, setEmailUpdates] = useState(user?.preferences.emailUpdates ?? false);

  if (!settingsOpen) return null;

  const handleSave = async () => {
    try {
      await updatePreferences({
        theme,
        language,
        notifications,
        emailUpdates,
      });
      closeSettings();
    } catch (error) {
      console.error('Failed to save preferences:', error);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-[480px] max-h-[85vh] bg-zinc-950 border border-zinc-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col">
        <header className="h-12 px-4 border-b border-zinc-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Icon name="settings" size={16} className="text-indigo-400" />
            <span className="text-sm text-zinc-200">Settings</span>
          </div>
          <button
            onClick={closeSettings}
            className="p-1.5 rounded-lg hover:bg-zinc-900 transition-colors"
          >
            <Icon name="x" size={14} className="text-zinc-500" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-4 space-y-6">
          {/* Appearance Section */}
          <section>
            <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">
              Appearance
            </h3>
            
            {/* Theme */}
            <div className="mb-4">
              <label className="block text-sm text-zinc-300 mb-2">Theme</label>
              <div className="flex gap-2">
                {(['light', 'dark', 'system'] as ThemeMode[]).map((themeOption) => (
                  <button
                    key={themeOption}
                    onClick={() => setTheme(themeOption)}
                    className={`
                      flex-1 px-3 py-2 rounded-lg text-sm font-medium capitalize transition-all
                      ${
                        theme === themeOption
                          ? 'bg-indigo-500 text-white'
                          : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200'
                      }
                    `}
                  >
                    {themeOption}
                  </button>
                ))}
              </div>
            </div>

            {/* Language */}
            <div>
              <label className="block text-sm text-zinc-300 mb-2">Language</label>
              <select
                value={language}
                onChange={(e) => setLanguage(e.target.value as Language)}
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-indigo-500"
              >
                <option value="en">English</option>
                <option value="fr">Français</option>
              </select>
            </div>
          </section>

          {/* Notifications Section */}
          <section>
            <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">
              Notifications
            </h3>
            
            {/* In-app Notifications */}
            <div className="flex items-center justify-between py-2">
              <div>
                <label className="block text-sm text-zinc-200">In-app notifications</label>
                <p className="text-xs text-zinc-500 mt-0.5">Receive notifications in the app</p>
              </div>
              <button
                onClick={() => setNotifications(!notifications)}
                className={`
                  relative w-11 h-6 rounded-full transition-colors duration-200
                  ${notifications ? 'bg-indigo-500' : 'bg-zinc-700'}
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
                <label className="block text-sm text-zinc-200">Email updates</label>
                <p className="text-xs text-zinc-500 mt-0.5">Receive email notifications</p>
              </div>
              <button
                onClick={() => setEmailUpdates(!emailUpdates)}
                className={`
                  relative w-11 h-6 rounded-full transition-colors duration-200
                  ${emailUpdates ? 'bg-indigo-500' : 'bg-zinc-700'}
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
            <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">
              About
            </h3>
            <div className="bg-zinc-800/50 rounded-lg p-3 space-y-1">
              <div className="flex justify-between text-xs">
                <span className="text-zinc-500">Version</span>
                <span className="text-zinc-300">1.0.0</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-zinc-500">Build</span>
                <span className="text-zinc-300">2026.01.20</span>
              </div>
            </div>
          </section>
        </div>

        <footer className="h-12 border-t border-zinc-800 px-4 flex items-center justify-end gap-2">
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
