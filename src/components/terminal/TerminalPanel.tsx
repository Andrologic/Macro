import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '../ui/Toaster';
import { Icon } from '../ui/Icon';
import { cn } from '../../utils/cn';
import { useTerminalStore } from '../../stores/useTerminalStore';
import { TerminalViewport } from './TerminalViewport';

interface TerminalPanelProps {
  className?: string;
}

const STATUS_LABELS: Record<string, string> = {
  idle: 'Idle',
  running: 'Running',
  disconnected: 'Disconnected',
  'restored-disconnected': 'Disconnected',
};

export const TerminalPanel: React.FC<TerminalPanelProps> = ({ className }) => {
  const { t } = useTranslation();
  const tabs = useTerminalStore((state) => state.tabs);
  const tabOrder = useTerminalStore((state) => state.tabOrder);
  const activeTabId = useTerminalStore((state) => state.activeTabId);
  const activateTab = useTerminalStore((state) => state.activateTab);
  const createManualTab = useTerminalStore((state) => state.createManualTab);
  const reconnectTab = useTerminalStore((state) => state.reconnectTab);
  const writeInput = useTerminalStore((state) => state.writeInput);
  const resizeTab = useTerminalStore((state) => state.resizeTab);
  const closeTab = useTerminalStore((state) => state.closeTab);

  const orderedTabs = useMemo(
    () => tabOrder.map((tabId) => tabs[tabId]).filter(Boolean),
    [tabOrder, tabs]
  );
  const activeTab = activeTabId ? tabs[activeTabId] : null;

  const runAction = (action: () => Promise<unknown>) => {
    void action().catch((error) => {
      const message =
        error instanceof Error ? error.message : t('common.error', 'An error occurred');
      toast.error(message);
    });
  };

  if (!activeTab) {
    return (
      <div className={cn('h-full border-t border-border/60 bg-card/40', className)}>
        <div className="flex h-full items-center justify-center">
          <button
            type="button"
            onClick={() => runAction(() => createManualTab())}
            className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-2 text-sm text-foreground hover:bg-accent/60"
          >
            <Icon name="plus" size={14} />
            {t('terminal.newTerminal', 'New terminal')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <section className={cn('flex h-full min-h-0 flex-col border-t border-border/60 bg-card/40', className)}>
      <header className="flex h-11 items-center justify-between gap-3 border-b border-border/60 px-3">
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto">
          {orderedTabs.map((tab) => {
            const isActive = tab.id === activeTab.id;
            return (
              <div
                key={tab.id}
                className={cn(
                  'group inline-flex h-8 min-w-0 max-w-[240px] items-center gap-1 rounded-md border pr-1 text-xs transition-colors',
                  isActive
                    ? 'border-primary/30 bg-primary/10 text-foreground'
                    : 'border-transparent bg-transparent text-muted-foreground hover:border-border hover:bg-accent/50 hover:text-foreground'
                )}
              >
                <button
                  type="button"
                  onClick={() => activateTab(tab.id)}
                  className="inline-flex min-w-0 flex-1 items-center gap-2 px-3"
                >
                  <span
                    className={cn(
                      'h-2 w-2 shrink-0 rounded-full',
                      tab.status === 'running'
                        ? 'bg-amber-400'
                        : tab.hasLiveSession
                          ? 'bg-emerald-400'
                          : 'bg-muted-foreground/60'
                    )}
                  />
                  <span className="truncate">{tab.title}</span>
                  {tab.hasUnreadOutput && !isActive && (
                    <span className="h-2 w-2 shrink-0 rounded-full bg-primary" />
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => runAction(() => closeTab(tab.id))}
                  className="hidden rounded-sm p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground group-hover:inline-flex"
                  title={t('common.close', 'Close')}
                >
                  <Icon name="x" size={12} />
                </button>
              </div>
            );
          })}
        </div>

        <div className="flex items-center gap-1">
          {!activeTab.hasLiveSession && (
            <button
              type="button"
              onClick={() => runAction(() => reconnectTab(activeTab.id))}
              className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs text-foreground hover:bg-accent"
            >
              <Icon name="refresh-cw" size={12} />
              {t('terminal.reconnect', 'Reconnect')}
            </button>
          )}
          <button
            type="button"
            onClick={() => runAction(() => createManualTab())}
            className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs text-foreground hover:bg-accent"
            title={t('terminal.newTerminal', 'New terminal')}
          >
            <Icon name="plus" size={12} />
          </button>
        </div>
      </header>

      <div className="flex items-center justify-between border-b border-border/40 px-3 py-1.5 text-[11px] text-muted-foreground">
        <span className="truncate">{activeTab.cwd}</span>
        <span>{STATUS_LABELS[activeTab.status] || activeTab.status}</span>
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden bg-background">
        <TerminalViewport
          tab={activeTab}
          onInput={(input) => {
            void writeInput(activeTab.id, input).catch((error) => {
              const message =
                error instanceof Error ? error.message : t('common.error', 'An error occurred');
              toast.error(message);
            });
          }}
          onResize={(cols, rows) => {
            if (!activeTab.hasLiveSession) {
              return;
            }
            void resizeTab(activeTab.id, cols, rows).catch(() => undefined);
          }}
        />

        {!activeTab.hasLiveSession && (
          <div className="absolute inset-x-4 top-4 flex justify-end">
            <div className="max-w-sm rounded-lg border border-border bg-card/95 px-3 py-2 text-xs text-muted-foreground shadow-lg">
              <div className="mb-2 flex items-center gap-2 text-foreground">
                <Icon name="alert-circle" size={12} />
                {t('terminal.disconnected', 'Disconnected session')}
              </div>
              <p>
                {t(
                  'terminal.disconnectedDescription',
                  'This tab was restored from history. Start a new live shell to continue interacting.'
                )}
              </p>
              <button
                type="button"
                onClick={() => runAction(() => reconnectTab(activeTab.id))}
                className="mt-3 inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
              >
                <Icon name="refresh-cw" size={12} />
                {t('terminal.reconnect', 'Reconnect')}
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
};

export default TerminalPanel;
