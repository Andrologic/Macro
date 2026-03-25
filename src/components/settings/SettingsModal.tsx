import React from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore, SettingsTab } from '../../stores/useAppStore';
import { Icon, IconName } from '../ui/Icon';
import { cn } from '../../utils/cn';
import { GeneralView } from './views/GeneralView';
import { AppearanceView } from './views/AppearanceView';
import { ProvidersSettings } from './views/ai/ProvidersSettings';
import { ModelsSettings } from './views/ai/ModelsSettings';
import { ToolsView } from './views/ToolsView';
import { ShortcutsView } from './views/ShortcutsView';
import { PromptsView } from './views/PromptsView';
import { ArchitectGitFlowView } from './views/ArchitectGitFlowView';
import { useAppVersion } from '../../hooks/useAppVersion';

export const SettingsModal: React.FC = () => {
  const { t } = useTranslation();
  const appVersion = useAppVersion();
  // @ts-ignore - store types updated but might not be picked up by lsp immediately
  const { settingsOpen, closeSettings, activeSettingsTab, setSettingsTab } = useAppStore();

  if (!settingsOpen) return null;

  const tabs: { id: SettingsTab; icon: IconName; label: string }[] = [
    { id: 'general', icon: 'settings', label: t('settings.general') || 'General' },
    { id: 'appearance', icon: 'palette', label: t('settings.appearance') || 'Appearance' },
    { id: 'providers', icon: 'server', label: t('settings.providers') || 'AI Providers' },
    { id: 'models', icon: 'cpu', label: t('settings.models') || 'AI Models' },
    { id: 'tools', icon: 'tool', label: t('settings.tools') || 'Tools & MCP' },
    { id: 'prompts', icon: 'message-square', label: t('settings.prompts') || 'System Prompts' },
    { id: 'architect', icon: 'git-branch', label: t('settings.architect') || 'Architect Git Flow' },
    { id: 'shortcuts', icon: 'zap', label: t('settings.shortcuts') || 'Shortcuts' },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-md animate-fade-in p-3 md:p-6">
      {/* Modal Container */}
      <div className="w-full max-w-[1200px] h-[90vh] md:h-[85vh] bg-card border border-border rounded-xl shadow-2xl flex flex-col md:flex-row overflow-hidden ring-1 ring-white/5">

        {/* Sidebar */}
        <div className="w-full md:w-64 bg-card/50 border-b md:border-b-0 md:border-r border-border flex flex-col">
          <div className="p-4 md:p-6">
            <h2 className="text-lg font-bold text-foreground flex items-center gap-2">
              <div className="p-1.5 rounded-md bg-primary/20 text-primary">
                <Icon name="settings" size={18} />
              </div>
              {t('settings.title') || 'Settings'}
            </h2>
          </div>

          <nav className="flex-1 px-3 pb-3 md:pb-0 space-y-1">
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
          <header className="min-h-16 border-b border-border flex items-center justify-between px-4 md:px-8 py-3 md:py-0 bg-card/30 backdrop-blur-sm">
            <div>
              <h3 className="text-lg font-semibold text-foreground">
                {tabs.find(t => t.id === activeSettingsTab)?.label}
              </h3>
              <p className="text-sm text-muted-foreground">
                {t(`settings.desc.${activeSettingsTab}`) || 'Configure your application settings'}
              </p>
            </div>
            <button
              onClick={closeSettings}
              className="p-2 rounded-lg hover:bg-destructive/10 hover:text-destructive transition-colors"
            >
              <Icon name="x" size={20} />
            </button>
          </header>

          <div className="flex-1 overflow-y-auto p-4 md:p-8">
            <div className="max-w-3xl mx-auto animate-fade-in">
              {activeSettingsTab === 'general' && <GeneralView />}
              {activeSettingsTab === 'appearance' && <AppearanceView />}
              {activeSettingsTab === 'providers' && <ProvidersSettings />}
              {activeSettingsTab === 'models' && <ModelsSettings />}
              {activeSettingsTab === 'tools' && <ToolsView />}
              {activeSettingsTab === 'prompts' && <PromptsView />}
              {activeSettingsTab === 'architect' && <ArchitectGitFlowView />}
              {activeSettingsTab === 'shortcuts' && <ShortcutsView />}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

// Export both named and default for lazy loading compatibility
export default SettingsModal;
