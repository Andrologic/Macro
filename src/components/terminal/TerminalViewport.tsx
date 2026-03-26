import React, { useEffect, useRef } from 'react';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import type { TerminalTab } from '../../stores/useTerminalStore';

interface TerminalViewportProps {
  tab: TerminalTab;
  onInput: (input: string) => void;
  onResize: (cols: number, rows: number) => void;
}

const canFitTerminal = (terminal: Terminal, container: HTMLDivElement): boolean => {
  if (!container.isConnected || container.clientWidth <= 0 || container.clientHeight <= 0) {
    return false;
  }

  const core = (terminal as Terminal & {
    _core?: {
      _renderService?: {
        hasRenderer?: () => boolean;
        _renderer?: { value?: unknown };
      };
    };
  })._core;
  const renderService = core?._renderService;

  if (!renderService) {
    return false;
  }

  if (typeof renderService.hasRenderer === 'function') {
    return renderService.hasRenderer();
  }

  return Boolean(renderService._renderer?.value);
};

export const TerminalViewport: React.FC<TerminalViewportProps> = ({
  tab,
  onInput,
  onResize,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const lastSnapshotRef = useRef('');
  const liveSessionRef = useRef(tab.hasLiveSession);
  const inputHandlerRef = useRef(onInput);
  const resizeHandlerRef = useRef(onResize);

  useEffect(() => {
    liveSessionRef.current = tab.hasLiveSession;
    if (terminalRef.current) {
      terminalRef.current.options.disableStdin = !tab.hasLiveSession;
    }
  }, [tab.hasLiveSession]);

  useEffect(() => {
    inputHandlerRef.current = onInput;
  }, [onInput]);

  useEffect(() => {
    resizeHandlerRef.current = onResize;
  }, [onResize]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    let disposed = false;
    let initTimeoutId: number | null = null;
    let fitFrameId: number | null = null;
    let fitRetryTimeoutId: number | null = null;
    let terminal: Terminal | null = null;
    let fitAddon: FitAddon | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let dataDisposable: { dispose: () => void } | null = null;

    const clearFitTimers = () => {
      if (fitFrameId !== null) {
        window.cancelAnimationFrame(fitFrameId);
        fitFrameId = null;
      }
      if (fitRetryTimeoutId !== null) {
        window.clearTimeout(fitRetryTimeoutId);
        fitRetryTimeoutId = null;
      }
    };

    const scheduleFit = (attempt = 0) => {
      clearFitTimers();
      fitFrameId = window.requestAnimationFrame(() => {
        fitFrameId = null;

        if (
          disposed ||
          !terminal ||
          !fitAddon ||
          !containerRef.current ||
          !canFitTerminal(terminal, containerRef.current)
        ) {
          if (!disposed && attempt < 10) {
            fitRetryTimeoutId = window.setTimeout(() => scheduleFit(attempt + 1), 16);
          }
          return;
        }

        try {
          fitAddon.fit();
          if (terminal.cols > 0 && terminal.rows > 0) {
            resizeHandlerRef.current(terminal.cols, terminal.rows);
          }
        } catch {
          if (!disposed && attempt < 10) {
            fitRetryTimeoutId = window.setTimeout(() => scheduleFit(attempt + 1), 16);
          }
        }
      });
    };

    initTimeoutId = window.setTimeout(() => {
      if (disposed) {
        return;
      }

      terminal = new Terminal({
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 13,
        lineHeight: 1.2,
        cursorBlink: true,
        disableStdin: !tab.hasLiveSession,
        allowTransparency: true,
        theme: {
          background: '#09090b',
          foreground: '#fafafa',
          cursor: '#a1a1aa',
          selectionBackground: 'rgba(99, 102, 241, 0.24)',
        },
      });
      fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.open(container);
      terminalRef.current = terminal;

      if (tab.snapshot) {
        terminal.write(tab.snapshot);
      }
      lastSnapshotRef.current = tab.snapshot;

      dataDisposable = terminal.onData((data) => {
        if (liveSessionRef.current) {
          inputHandlerRef.current(data);
        }
      });

      resizeObserver = new ResizeObserver(() => {
        scheduleFit();
      });
      resizeObserver.observe(container);
      scheduleFit();
    }, 0);

    return () => {
      disposed = true;
      if (initTimeoutId !== null) {
        window.clearTimeout(initTimeoutId);
      }
      clearFitTimers();
      dataDisposable?.dispose();
      resizeObserver?.disconnect();
      terminalRef.current = null;
      terminal?.dispose();
    };
  }, [tab.id]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }

    if (tab.snapshot.startsWith(lastSnapshotRef.current)) {
      const delta = tab.snapshot.slice(lastSnapshotRef.current.length);
      if (delta) {
        terminal.write(delta);
      }
    } else if (tab.snapshot !== lastSnapshotRef.current) {
      terminal.clear();
      if (tab.snapshot) {
        terminal.write(tab.snapshot);
      }
    }

    lastSnapshotRef.current = tab.snapshot;
  }, [tab.snapshot]);

  return <div ref={containerRef} className="h-full w-full px-3 py-2" />;
};

export default TerminalViewport;
