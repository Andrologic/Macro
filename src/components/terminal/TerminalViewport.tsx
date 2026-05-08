import React, { useEffect, useRef } from 'react';
import type { TerminalTab } from '../../stores/useTerminalStore';
import terminalRuntime from '../../services/terminalRuntime';
import { useOptionalTheme } from '../theme/ThemeProvider';

interface TerminalViewportProps {
  tab: TerminalTab;
  onInput: (input: string) => void;
  onResize: (cols: number, rows: number) => void;
}

export const TerminalViewport: React.FC<TerminalViewportProps> = ({
  tab,
  onInput,
  onResize,
}) => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const themeContext = useOptionalTheme();
  const terminalTheme = themeContext?.theme ?? null;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }

    terminalRuntime.attachTab({
      tabId: tab.id,
      hostElement: host,
      snapshot: tab.snapshot,
      hasLiveSession: tab.hasLiveSession,
      theme: terminalTheme,
      onInput,
      onResize,
    });

    return () => {
      terminalRuntime.detachTab(tab.id, host);
    };
    // The attach lifecycle is scoped to the tab identity; live state and handlers are updated separately.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id]);

  useEffect(() => {
    terminalRuntime.syncTab({
      tabId: tab.id,
      snapshot: tab.snapshot,
      hasLiveSession: tab.hasLiveSession,
      theme: terminalTheme,
      onInput,
      onResize,
    });
  }, [tab.id, tab.snapshot, tab.hasLiveSession, terminalTheme, onInput, onResize]);

  useEffect(() => {
    terminalRuntime.focusTab(tab.id);
    terminalRuntime.resizeTab(tab.id);
  }, [tab.id, tab.hasLiveSession]);

  return (
    <div className="macro-terminal-shell h-full w-full">
      <div ref={hostRef} className="macro-terminal-host h-full w-full" />
    </div>
  );
};

export default TerminalViewport;
