import React, { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../stores/useAppStore';
import { Icon } from '../ui/Icon';
import { settingsRegistry } from '../../composition/settings/registry';
import { SettingsContent } from './SettingsContent';
import { cn } from '../../utils/cn';
import { useAppVersion } from '../../hooks/useAppVersion';
import { Dialog } from '../ui/Dialog';
import { SettingsSearchProvider } from './search/SettingsSearch';

export const SettingsModal: React.FC = () => {
  const { t } = useTranslation();
  const appVersion = useAppVersion();
  const { settingsOpen, closeSettings, activeSettingsTab, setSettingsTab } = useAppStore();

  useSyncExternalStore(settingsRegistry.subscribe, settingsRegistry.getRevision, settingsRegistry.getRevision);
  const context = { settingsOpen };
  const tabs = settingsRegistry.list(context);
  const activeTab = settingsRegistry.get(activeSettingsTab, context) ?? tabs[0];
  const activeTabDescription = activeTab
    ? t(activeTab.descriptionKey, activeTab.description ?? 'Configure your application settings')
    : '';

  if (!settingsOpen) return null;

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
            <h2 className="text-2xl font-bold tracking-tight text-foreground">
              {t('settings.title') || 'Settings'}
            </h2>
          </div>

          <nav className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 pb-3 md:pb-0">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={(event) => {
                  setSettingsTab(tab.id)
                  if (event.detail > 0) {
                    event.currentTarget.blur()
                  }
                }}
                className={cn(
                  "w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200",
                  activeTab?.id === tab.id
                    ? "bg-primary/10 text-primary shadow-sm"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
              >
                <Icon name={tab.icon} size={18} />
                {t(tab.labelKey, tab.label)}
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
        <SettingsSearchProvider key={activeTab?.id}>
          <div className="flex-1 flex flex-col bg-background/50 min-h-0">
            <header className="min-h-16 border-b border-border flex items-center justify-between px-4 md:px-8 py-3 md:py-0 bg-card/30">
              <div>
                <h3 className="text-lg font-semibold text-foreground">
                  {activeTab && t(activeTab.labelKey, activeTab.label)}
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

            <div className="flex-1 overflow-y-auto p-4 md:p-6">
              <div className="max-w-3xl mx-auto animate-fade-in">
                {activeTab && <SettingsContent contribution={activeTab} />}
              </div>
            </div>
          </div>
        </SettingsSearchProvider>
      </div>
    </Dialog>
  );
};

// Export both named and default for lazy loading compatibility
export default SettingsModal;
