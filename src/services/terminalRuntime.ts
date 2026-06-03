import { Terminal, type ITerminalOptions } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import type { Theme } from '../types/theme';
import { openExternalUrl } from './externalUrlOpener';
import {
  findTerminalSearchMatches,
  getNextTerminalSearchIndex,
  selectTerminalSearchMatch,
  type TerminalSearchDirection,
  type TerminalSearchResult,
} from './terminalSearch';
import { createTerminalUrlLinkProvider } from './terminalLinks';
import { buildTerminalTheme, getTerminalThemeSignature } from './terminalTheme';

const FIT_RETRY_LIMIT = 8;
const FIT_RETRY_DELAY_MS = 24;
const MAX_DETACHED_RUNTIME_SESSIONS = 6;

type WriteOperation =
  | { type: 'write'; data: string }
  | { type: 'reset'; snapshot: string };
type SnapshotSyncResult = 'none' | 'write' | 'reset';

type RuntimeHandlers = {
  onInput: (input: string) => void;
  onResize: (cols: number, rows: number) => void;
  onClear?: () => void;
};

type RuntimeSession = {
  tabId: string;
  terminal: Terminal;
  fitAddon: FitAddon;
  mount: HTMLDivElement;
  host: HTMLDivElement | null;
  isOpened: boolean;
  resizeObserver: ResizeObserver | null;
  lastSnapshot: string;
  lastReportedSize: { cols: number; rows: number } | null;
  hasLiveSession: boolean;
  handlers: RuntimeHandlers;
  writeQueue: WriteOperation[];
  writeFrameId: number | null;
  fitFrameId: number | null;
  fitRetryTimeoutId: number | null;
  linkProviderDisposable: { dispose: () => void } | null;
  lastTouchedAt: number;
  themeSignature: string;
  lastFitFailureKey: string | null;
  windowResizeListener: () => void;
  visibilityChangeListener: () => void;
};

export interface TerminalRuntimeAttachParams extends RuntimeHandlers {
  tabId: string;
  hostElement: HTMLDivElement;
  snapshot: string;
  hasLiveSession: boolean;
  theme?: Theme | null;
}

export interface TerminalRuntimeSyncParams extends RuntimeHandlers {
  tabId: string;
  snapshot: string;
  hasLiveSession: boolean;
  theme?: Theme | null;
}

const runtimeSessions = new Map<string, RuntimeSession>();

const getTerminalFitBlocker = (terminal: Terminal, container: HTMLDivElement): string | null => {
  if (!container.isConnected) {
    return 'host_disconnected';
  }

  if (container.clientWidth <= 0 || container.clientHeight <= 0) {
    return 'host_zero_size';
  }

  const core = terminal as Terminal & {
    _core?: {
      _renderService?: {
        hasRenderer?: () => boolean;
        _renderer?: { value?: unknown };
      };
    };
  };
  const renderService = core._core?._renderService;

  if (!renderService) {
    return 'renderer_unavailable';
  }

  if (typeof renderService.hasRenderer === 'function') {
    return renderService.hasRenderer() ? null : 'renderer_not_ready';
  }

  return renderService._renderer?.value ? null : 'renderer_not_ready';
};

const getWindowsPtyOptions = (): { backend: 'conpty' } | undefined => {
  if (typeof navigator === 'undefined') {
    return undefined;
  }

  const platformHint = (
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ||
    navigator.platform ||
    navigator.userAgent
  ).toLowerCase();

  return platformHint.includes('win') ? { backend: 'conpty' } : undefined;
};

const buildTerminalOptions = (
  hasLiveSession: boolean,
  theme?: Theme | null
): ITerminalOptions => {
  const terminalOptions: ITerminalOptions & { rescaleOverlappingGlyphs?: boolean } = {
    fontFamily: 'JetBrains Mono, monospace',
    fontSize: 12,
    lineHeight: 1.2,
    cursorBlink: true,
    cursorInactiveStyle: 'outline',
    disableStdin: !hasLiveSession,
    allowTransparency: false,
    customGlyphs: true,
    rescaleOverlappingGlyphs: true,
    minimumContrastRatio: 4.5,
    smoothScrollDuration: 0,
    windowsPty: getWindowsPtyOptions(),
    linkHandler: {
      allowNonHttpProtocols: false,
      activate: (event, text) => {
        if (event.button !== 0) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        void openExternalUrl(text).catch((error) => {
          console.warn('Failed to open terminal hyperlink:', error);
        });
      },
    },
    theme: buildTerminalTheme(theme),
  };

  return terminalOptions as ITerminalOptions;
};

const applyTerminalTheme = (session: RuntimeSession, theme?: Theme | null): boolean => {
  const signature = getTerminalThemeSignature(theme);
  if (session.themeSignature === signature) {
    return false;
  }

  session.terminal.options.theme = buildTerminalTheme(theme);
  session.themeSignature = signature;
  return true;
};

const clearFitTimers = (session: RuntimeSession) => {
  if (session.fitFrameId !== null) {
    window.cancelAnimationFrame(session.fitFrameId);
    session.fitFrameId = null;
  }
  if (session.fitRetryTimeoutId !== null) {
    window.clearTimeout(session.fitRetryTimeoutId);
    session.fitRetryTimeoutId = null;
  }
};

const clearWriteTimers = (session: RuntimeSession) => {
  if (session.writeFrameId !== null) {
    window.cancelAnimationFrame(session.writeFrameId);
    session.writeFrameId = null;
  }
};

const refreshTerminal = (session: RuntimeSession) => {
  if (!session.isOpened || session.terminal.rows <= 0) {
    return;
  }

  try {
    session.terminal.refresh(0, session.terminal.rows - 1);
  } catch {
    // xterm can briefly reject refreshes while its renderer is being recreated.
  }
};

const writeAndRefresh = (session: RuntimeSession, data: string) => {
  if (!data) {
    refreshTerminal(session);
    return;
  }

  session.terminal.write(data, () => {
    refreshTerminal(session);
  });
};

const flushWriteQueue = (session: RuntimeSession) => {
  session.writeFrameId = null;
  if (!session.isOpened || session.writeQueue.length === 0) {
    return;
  }

  const operations = session.writeQueue.splice(0, session.writeQueue.length);
  let resetSnapshot: string | null = null;
  let bufferedWrite = '';
  for (const operation of operations) {
    if (operation.type === 'reset') {
      resetSnapshot = operation.snapshot;
      bufferedWrite = '';
      continue;
    }

    bufferedWrite += operation.data;
  }

  if (resetSnapshot !== null) {
    session.terminal.reset();
    session.terminal.clear();
    writeAndRefresh(session, resetSnapshot + bufferedWrite);
    return;
  }

  if (bufferedWrite) {
    writeAndRefresh(session, bufferedWrite);
  }
};

const scheduleWriteFlush = (session: RuntimeSession) => {
  if (!session.isOpened || session.writeFrameId !== null) {
    return;
  }

  session.writeFrameId = window.requestAnimationFrame(() => {
    flushWriteQueue(session);
  });
};

const queueWriteOperation = (session: RuntimeSession, operation: WriteOperation) => {
  session.writeQueue.push(operation);
  session.lastTouchedAt = Date.now();
  scheduleWriteFlush(session);
};

const logFitFailure = (session: RuntimeSession, reason: string) => {
  if (!import.meta.env?.DEV) {
    return;
  }

  const host = session.host;
  const key = `${reason}:${host?.clientWidth ?? 0}x${host?.clientHeight ?? 0}`;
  if (session.lastFitFailureKey === key) {
    return;
  }

  session.lastFitFailureKey = key;
  console.debug('[terminal_runtime_fit_skipped]', {
    tabId: session.tabId,
    reason,
    hostWidth: host?.clientWidth ?? 0,
    hostHeight: host?.clientHeight ?? 0,
  });
};

const scheduleFit = (session: RuntimeSession, attempt = 0) => {
  if (!session.host) {
    return;
  }

  clearFitTimers(session);
  session.fitFrameId = window.requestAnimationFrame(() => {
    session.fitFrameId = null;

    if (!session.host) {
      return;
    }

    const fitBlocker = getTerminalFitBlocker(session.terminal, session.host);
    if (fitBlocker) {
      if (attempt < FIT_RETRY_LIMIT) {
        session.fitRetryTimeoutId = window.setTimeout(
          () => scheduleFit(session, attempt + 1),
          FIT_RETRY_DELAY_MS
        );
      } else {
        logFitFailure(session, fitBlocker);
      }
      return;
    }

    try {
      session.fitAddon.fit();
      if (session.terminal.cols > 0 && session.terminal.rows > 0) {
        const nextSize = {
          cols: session.terminal.cols,
          rows: session.terminal.rows,
        };
        const sizeChanged =
          !session.lastReportedSize ||
          session.lastReportedSize.cols !== nextSize.cols ||
          session.lastReportedSize.rows !== nextSize.rows;
        session.lastReportedSize = nextSize;
        if (sizeChanged) {
          session.handlers.onResize(nextSize.cols, nextSize.rows);
        }
      }
      session.lastFitFailureKey = null;
      refreshTerminal(session);
    } catch {
      if (attempt < FIT_RETRY_LIMIT) {
        session.fitRetryTimeoutId = window.setTimeout(
          () => scheduleFit(session, attempt + 1),
          FIT_RETRY_DELAY_MS
        );
      } else {
        logFitFailure(session, 'fit_failed');
      }
    }
  });
};

const disconnectResizeObserver = (session: RuntimeSession) => {
  session.resizeObserver?.disconnect();
  session.resizeObserver = null;
};

const connectResizeObserver = (session: RuntimeSession, hostElement: HTMLDivElement) => {
  disconnectResizeObserver(session);
  const resizeObserver = new ResizeObserver(() => {
    scheduleFit(session);
  });
  resizeObserver.observe(hostElement);
  session.resizeObserver = resizeObserver;
};

const syncSnapshot = (session: RuntimeSession, snapshot: string): SnapshotSyncResult => {
  if (snapshot === session.lastSnapshot) {
    return 'none';
  }

  let result: SnapshotSyncResult = 'none';
  if (snapshot.startsWith(session.lastSnapshot)) {
    const delta = snapshot.slice(session.lastSnapshot.length);
    if (delta) {
      queueWriteOperation(session, { type: 'write', data: delta });
      result = 'write';
    }
  } else {
    queueWriteOperation(session, { type: 'reset', snapshot });
    result = 'reset';
  }

  session.lastSnapshot = snapshot;
  return result;
};

const updateSessionState = (
  session: RuntimeSession,
  params: TerminalRuntimeSyncParams,
  options: { syncSnapshot?: boolean } = {}
): { themeChanged: boolean; snapshotResult: SnapshotSyncResult } => {
  session.handlers = {
    onInput: params.onInput,
    onResize: params.onResize,
    onClear: params.onClear,
  };
  session.hasLiveSession = params.hasLiveSession;
  session.terminal.options.disableStdin = !params.hasLiveSession;
  const themeChanged = applyTerminalTheme(session, params.theme);
  const snapshotResult =
    options.syncSnapshot === false ? 'none' : syncSnapshot(session, params.snapshot);
  session.lastTouchedAt = Date.now();
  return { themeChanged, snapshotResult };
};

const ensureTerminalOpened = (session: RuntimeSession) => {
  if (session.isOpened) {
    return;
  }

  session.terminal.open(session.mount);
  session.isOpened = true;
  scheduleWriteFlush(session);
};

const createRuntimeSession = (tabId: string): RuntimeSession => {
  const mount = document.createElement('div');
  mount.className = 'macro-terminal-runtime';
  mount.style.height = '100%';
  mount.style.width = '100%';

  const terminal = new Terminal(buildTerminalOptions(false));
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  const linkProviderDisposable = terminal.registerLinkProvider(
    createTerminalUrlLinkProvider(terminal, (url) => {
      void openExternalUrl(url).catch((error) => {
        console.warn('Failed to open terminal URL:', error);
      });
    })
  );

  let session: RuntimeSession;
  session = {
    tabId,
    terminal,
    fitAddon,
    mount,
    host: null,
    isOpened: false,
    resizeObserver: null,
    lastSnapshot: '',
    lastReportedSize: null,
    hasLiveSession: false,
    handlers: {
      onInput: () => undefined,
      onResize: () => undefined,
    },
    writeQueue: [],
    writeFrameId: null,
    fitFrameId: null,
    fitRetryTimeoutId: null,
    linkProviderDisposable,
    lastTouchedAt: Date.now(),
    themeSignature: getTerminalThemeSignature(),
    lastFitFailureKey: null,
    windowResizeListener: () => {
      scheduleFit(session);
    },
    visibilityChangeListener: () => {
      scheduleFit(session);
    },
  };

  terminal.onData((data) => {
    if (session.hasLiveSession) {
      if (data === '\x0c' && session.handlers.onClear) {
        session.handlers.onClear();
        return;
      }
      session.handlers.onInput(data);
    }
  });
  window.addEventListener('resize', session.windowResizeListener);
  document.addEventListener('visibilitychange', session.visibilityChangeListener);
  void document.fonts?.ready
    .then(() => {
      scheduleFit(session);
      refreshTerminal(session);
    })
    .catch(() => undefined);

  return session;
};

const destroyRuntimeSession = (session: RuntimeSession) => {
  clearFitTimers(session);
  clearWriteTimers(session);
  disconnectResizeObserver(session);
  window.removeEventListener('resize', session.windowResizeListener);
  document.removeEventListener('visibilitychange', session.visibilityChangeListener);
  if (session.host && session.mount.parentElement === session.host) {
    session.host.replaceChildren();
  }
  session.host = null;
  session.linkProviderDisposable?.dispose();
  session.linkProviderDisposable = null;
  session.terminal.dispose();
};

const pruneDetachedSessions = () => {
  if (runtimeSessions.size <= MAX_DETACHED_RUNTIME_SESSIONS) {
    return;
  }

  const detachedSessions = [...runtimeSessions.values()]
    .filter((session) => session.host === null)
    .sort((left, right) => left.lastTouchedAt - right.lastTouchedAt);

  while (
    runtimeSessions.size > MAX_DETACHED_RUNTIME_SESSIONS &&
    detachedSessions.length > 0
  ) {
    const session = detachedSessions.shift();
    if (!session) {
      break;
    }
    runtimeSessions.delete(session.tabId);
    destroyRuntimeSession(session);
  }
};

const getOrCreateRuntimeSession = (tabId: string): RuntimeSession => {
  const existing = runtimeSessions.get(tabId);
  if (existing) {
    existing.lastTouchedAt = Date.now();
    return existing;
  }

  const session = createRuntimeSession(tabId);
  runtimeSessions.set(tabId, session);
  pruneDetachedSessions();
  return session;
};

export const terminalRuntime = {
  attachTab(params: TerminalRuntimeAttachParams) {
    const session = getOrCreateRuntimeSession(params.tabId);
    updateSessionState(session, params, { syncSnapshot: false });

    if (session.host !== params.hostElement) {
      if (session.host && session.mount.parentElement === session.host) {
        session.host.replaceChildren();
      }
      params.hostElement.replaceChildren(session.mount);
      session.host = params.hostElement;
      connectResizeObserver(session, params.hostElement);
    }

    ensureTerminalOpened(session);
    scheduleFit(session);
    syncSnapshot(session, params.snapshot);
    session.terminal.focus();
  },

  detachTab(tabId: string, hostElement?: HTMLDivElement | null) {
    const session = runtimeSessions.get(tabId);
    if (!session) {
      return;
    }

    if (hostElement && session.host !== hostElement) {
      return;
    }

    if (session.host && session.mount.parentElement === session.host) {
      session.host.replaceChildren();
    }
    session.host = null;
    disconnectResizeObserver(session);
    clearFitTimers(session);
    session.lastTouchedAt = Date.now();
    pruneDetachedSessions();
  },

  syncTab(params: TerminalRuntimeSyncParams) {
    const session = runtimeSessions.get(params.tabId);
    if (!session) {
      return;
    }

    const previousSnapshot = session.lastSnapshot;
    const { themeChanged } = updateSessionState(session, params, { syncSnapshot: false });
    const willResetSnapshot =
      params.snapshot !== previousSnapshot && !params.snapshot.startsWith(previousSnapshot);
    if (themeChanged || willResetSnapshot) {
      scheduleFit(session);
    }
    syncSnapshot(session, params.snapshot);
  },

  setTheme(theme?: Theme | null) {
    for (const session of runtimeSessions.values()) {
      if (applyTerminalTheme(session, theme)) {
        scheduleFit(session);
      }
    }
  },

  focusTab(tabId: string) {
    const session = runtimeSessions.get(tabId);
    if (!session) {
      return;
    }

    session.lastTouchedAt = Date.now();
    if (session.isOpened) {
      session.terminal.focus();
    }
  },

  resizeTab(tabId: string) {
    const session = runtimeSessions.get(tabId);
    if (!session) {
      return;
    }

    scheduleFit(session);
  },

  searchTab(
    tabId: string,
    query: string,
    direction: TerminalSearchDirection = 'next',
    currentIndex?: number | null,
    options?: { focusTerminal?: boolean }
  ): TerminalSearchResult {
    const session = runtimeSessions.get(tabId);
    if (!session || !query.trim()) {
      session?.terminal.clearSelection();
      return { matchIndex: -1, matchCount: 0 };
    }

    const matches = findTerminalSearchMatches(session.terminal, query);
    const nextIndex = getNextTerminalSearchIndex(matches.length, currentIndex, direction);
    if (nextIndex === null) {
      session.terminal.clearSelection();
      return { matchIndex: -1, matchCount: 0 };
    }

    selectTerminalSearchMatch(session.terminal, matches[nextIndex], options?.focusTerminal ?? true);
    session.lastTouchedAt = Date.now();
    return {
      matchIndex: nextIndex,
      matchCount: matches.length,
    };
  },

  clearSearch(tabId: string) {
    const session = runtimeSessions.get(tabId);
    if (!session) {
      return;
    }

    session.terminal.clearSelection();
    session.terminal.focus();
  },

  disposeTab(tabId: string) {
    const session = runtimeSessions.get(tabId);
    if (!session) {
      return;
    }

    runtimeSessions.delete(tabId);
    destroyRuntimeSession(session);
  },
};

export default terminalRuntime;
