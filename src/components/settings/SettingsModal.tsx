import React from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore, SettingsTab } from '../../stores/useAppStore';
import { Icon, IconName } from '../ui/Icon';
import { cn } from '../../utils/cn';
import { GeneralView } from './views/GeneralView';
import { NotificationsView } from './views/NotificationsView';
import { AppearanceView } from './views/AppearanceView';
import { ProvidersSettings } from './views/ai/ProvidersSettings';
import { ModelsSettings } from './views/ai/ModelsSettings';
import { SpeechSettings } from './views/ai/SpeechSettings';
import { ToolsView } from './views/ToolsView';
import { SkillsView } from './views/SkillsView';
import { ShortcutsView } from './views/ShortcutsView';
import { PromptsView } from './views/PromptsView';
import { ArchitectGitFlowView } from './views/ArchitectGitFlowView';
import { useAppVersion } from '../../hooks/useAppVersion';
import { Dialog } from '../ui/Dialog';

export const SettingsModal: React.FC = () => {
  const { t } = useTranslation();
  const appVersion = useAppVersion();
  const { settingsOpen, closeSettings, activeSettingsTab, setSettingsTab } = useAppStore();

  if (!settingsOpen) return null;

  const activeTabDescription =
    activeSettingsTab === 'speech'
      ? t('settings.desc.speech', 'Configure microphone dictation and speech-to-text providers')
      : activeSettingsTab === 'notifications'
      ? t(
          'settings.desc.notifications',
          'Configure in-app and desktop notification delivery'
        )
      : t(`settings.desc.${activeSettingsTab}`) || 'Configure your application settings';

  const tabs: { id: SettingsTab; icon: IconName; label: string }[] = [
    { id: 'general', icon: 'settings', label: t('settings.general') || 'General' },
    {
      id: 'notifications',
      icon: 'bell',
      label: t('settings.notifications', 'Notifications'),
    },
    { id: 'appearance', icon: 'palette', label: t('settings.appearance') || 'Appearance' },
    { id: 'providers', icon: 'server', label: t('settings.providers') || 'AI Providers' },
    { id: 'models', icon: 'cpu', label: t('settings.models') || 'AI Models' },
    { id: 'speech', icon: 'mic', label: t('settings.speech', 'Dictation') },
    { id: 'tools', icon: 'tool', label: t('settings.tools') || 'Tools & MCP' },
    { id: 'skills', icon: 'sparkles', label: t('settings.skills', 'Skills') },
    { id: 'prompts', icon: 'message-square', label: t('settings.prompts') || 'System Prompts' },
    { id: 'architect', icon: 'git-branch', label: t('settings.architect') || 'Git workflow' },
    { id: 'shortcuts', icon: 'zap', label: t('settings.shortcuts') || 'Shortcuts' },
  ];

  return (
    <Dialog
      title={t('settings.title') || 'Settings'}
      onClose={closeSettings}
      backdropClassName="fixed inset-0 z-50 flex items-center justify-center bg-black/60 animate-fade-in p-3 md:p-6"
    >
      {/* Modal Container */}
      <div className="flex h-[min(90vh,calc(100vh-1.5rem))] w-full max-w-[1200px] flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl ring-1 ring-white/5 md:h-[min(85vh,calc(100vh-3rem))] md:flex-row">

        {/* Sidebar */}
        <div className="flex max-h-56 w-full shrink-0 flex-col border-b border-border bg-card/50 md:max-h-none md:w-64 md:border-b-0 md:border-r">
          <div className="p-4 md:p-6">
            <h2 className="text-lg font-bold text-foreground flex items-center gap-2">
              <div className="p-1.5 rounded-md bg-primary/20 text-primary">
                <Icon name="settings" size={18} />
              </div>
              {t('settings.title') || 'Settings'}
            </h2>
          </div>

          <nav className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 pb-3 md:pb-0">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setSettingsTab(tab.id)}
                className={cn(
                  "w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200",
                  activeSettingsTab === tab.id
                    ? "bg-primary/10 text-primary shadow-sm"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
              >
                <Icon name={tab.icon} size={18} />
                {tab.label}
              </button>
            ))}
          </nav>

          <div className="p-4 border-t border-border bg-card/30 hidden md:block">
            <div className="text-xs text-muted-foreground text-center">
              Macro
              <br />
              <span className="opacity-50">{appVersion}</span>
            </div>
          </div>
        </div>

        {/* Content Area */}
        <div className="flex-1 flex flex-col bg-background/50 min-h-0">
          <header className="min-h-16 border-b border-border flex items-center justify-between px-4 md:px-8 py-3 md:py-0 bg-card/30">
            <div>
              <h3 className="text-lg font-semibold text-foreground">
                {tabs.find(t => t.id === activeSettingsTab)?.label}
              </h3>
              <p className="text-sm text-muted-foreground">
                {activeTabDescription}
              </p>
            </div>
            <button
              type="button"
              aria-label={t('common.close', 'Close')}
              onClick={closeSettings}
              className="p-2 rounded-lg hover:bg-destructive/10 hover:text-destructive transition-colors"
            >
              <Icon name="x" size={20} />
            </button>
          </header>

          <div className="flex-1 overflow-y-auto p-4 md:p-8">
            <div className="max-w-3xl mx-auto animate-fade-in">
              {activeSettingsTab === 'general' && <GeneralView />}
              {activeSettingsTab === 'notifications' && <NotificationsView />}
              {activeSettingsTab === 'appearance' && <AppearanceView />}
              {activeSettingsTab === 'providers' && <ProvidersSettings />}
              {activeSettingsTab === 'models' && <ModelsSettings />}
              {activeSettingsTab === 'speech' && <SpeechSettings />}
              {activeSettingsTab === 'tools' && <ToolsView />}
              {activeSettingsTab === 'skills' && <SkillsView />}
              {activeSettingsTab === 'prompts' && <PromptsView />}
              {activeSettingsTab === 'architect' && <ArchitectGitFlowView />}
              {activeSettingsTab === 'shortcuts' && <ShortcutsView />}
            </div>
          </div>
        </div>
      </div>
    </Dialog>
  );
};

// Export both named and default for lazy loading compatibility
export default SettingsModal;
