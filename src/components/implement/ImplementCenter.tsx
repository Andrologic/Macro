import React from 'react';
import { useTranslation } from 'react-i18next';
import ChatZone from '../chat/ChatZone';
import { PanelResizer } from '../layout/PanelResizer';
import { Icon } from '../ui/Icon';
import { toast } from '../ui/Toaster';
import { cn } from '../../utils/cn';
import { useTerminalStore } from '../../stores/useTerminalStore';
import TerminalPanel from '../terminal/TerminalPanel';

export const ImplementCenter: React.FC = () => {
  const { t } = useTranslation();
  const panelOpen = useTerminalStore((state) => state.panelOpen);
  const panelHeight = useTerminalStore((state) => state.panelHeight);
  const hiddenTerminalTabCount = useTerminalStore((state) => state.hiddenTerminalTabCount);
  const togglePanel = useTerminalStore((state) => state.togglePanel);
  const setPanelHeight = useTerminalStore((state) => state.setPanelHeight);

  const handleToggleTerminal = React.useCallback(() => {
    void togglePanel().catch((error) => {
      const message =
        error instanceof Error ? error.message : t('common.error', 'An error occurred');
      toast.error(message);
    });
  }, [t, togglePanel]);

  const terminalButton = (
    <button
      type="button"
      onClick={handleToggleTerminal}
      className={cn(
        'relative inline-flex h-8 items-center gap-2 rounded-md border px-3 text-xs font-medium transition-colors',
        panelOpen
          ? 'border-primary/30 bg-primary/10 text-primary'
          : 'border-border bg-card/40 text-muted-foreground hover:bg-accent hover:text-foreground'
      )}
    >
      <Icon name="terminal" size={12} />
      {t('terminal.title', 'Terminal')}
      {hiddenTerminalTabCount > 0 && (
        <span className="inline-flex min-w-[18px] items-center justify-center rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold text-primary-foreground">
          {hiddenTerminalTabCount}
        </span>
      )}
    </button>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className={cn('min-h-0', panelOpen ? 'flex-1' : 'h-full')}>
        <ChatZone headerActions={terminalButton} />
      </div>

      {panelOpen && (
        <>
          <PanelResizer
            orientation="vertical"
            onResize={(delta) => setPanelHeight(panelHeight - delta)}
            className="w-full"
          />
          <div
            className="shrink-0 min-h-0 overflow-hidden"
            style={{ height: panelHeight }}
          >
            <TerminalPanel />
          </div>
        </>
      )}
    </div>
  );
};

export default ImplementCenter;
