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
  resizeObserver: ResizeObserver | null;
  lastSnapshot: string;
  hasLiveSession: boolean;
  handlers: RuntimeHandlers;
  writeQueue: WriteOperation[];
  writeFrameId: number | null;
  fitFrameId: number | null;
  fitRetryTimeoutId: number | null;
  linkProviderDisposable: { dispose: () => void } | null;
  lastTouchedAt: number;
  themeSignature: string;
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

const canFitTerminal = (terminal: Terminal, container: HTMLDivElement): boolean => {
  if (!container.isConnected || container.clientWidth <= 0 || container.clientHeight <= 0) {
    return false;
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
    return false;
  }

  if (typeof renderService.hasRenderer === 'function') {
    return renderService.hasRenderer();
  }

  return Boolean(renderService._renderer?.value);
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
    lineHeight: 1.1,
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

const applyTerminalTheme = (session: RuntimeSession, theme?: Theme | null) => {
  const signature = getTerminalThemeSignature(theme);
  if (session.themeSignature === signature) {
    return;
  }

  session.terminal.options.theme = buildTerminalTheme(theme);
  session.themeSignature = signature;
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

const flushWriteQueue = (session: RuntimeSession) => {
  session.writeFrameId = null;
  if (session.writeQueue.length === 0) {
    return;
  }

  const operations = session.writeQueue.splice(0, session.writeQueue.length);
  let bufferedWrite = '';
  for (const operation of operations) {
    if (operation.type === 'reset') {
      if (bufferedWrite) {
        session.terminal.write(bufferedWrite);
        bufferedWrite = '';
      }
      session.terminal.reset();
      if (operation.snapshot) {
        session.terminal.write(operation.snapshot);
      }
      continue;
    }

    bufferedWrite += operation.data;
  }

  if (bufferedWrite) {
    session.terminal.write(bufferedWrite);
  }
};

const queueWriteOperation = (session: RuntimeSession, operation: WriteOperation) => {
  session.writeQueue.push(operation);
  session.lastTouchedAt = Date.now();

  if (session.writeFrameId !== null) {
    return;
  }

  session.writeFrameId = window.requestAnimationFrame(() => {
    flushWriteQueue(session);
  });
};

const scheduleFit = (session: RuntimeSession, attempt = 0) => {
  clearFitTimers(session);
  session.fitFrameId = window.requestAnimationFrame(() => {
    session.fitFrameId = null;

    if (!session.host || !canFitTerminal(session.terminal, session.host)) {
      if (attempt < FIT_RETRY_LIMIT) {
        session.fitRetryTimeoutId = window.setTimeout(
          () => scheduleFit(session, attempt + 1),
          FIT_RETRY_DELAY_MS
        );
      }
      return;
    }

    try {
      session.fitAddon.fit();
      if (session.terminal.cols > 0 && session.terminal.rows > 0) {
        session.handlers.onResize(session.terminal.cols, session.terminal.rows);
      }
    } catch {
      if (attempt < FIT_RETRY_LIMIT) {
        session.fitRetryTimeoutId = window.setTimeout(
          () => scheduleFit(session, attempt + 1),
          FIT_RETRY_DELAY_MS
        );
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

const syncSnapshot = (session: RuntimeSession, snapshot: string) => {
  if (snapshot === session.lastSnapshot) {
    return;
  }

  if (snapshot.startsWith(session.lastSnapshot)) {
    const delta = snapshot.slice(session.lastSnapshot.length);
    if (delta) {
      queueWriteOperation(session, { type: 'write', data: delta });
    }
  } else {
    queueWriteOperation(session, { type: 'reset', snapshot });
  }

  session.lastSnapshot = snapshot;
};

const updateSessionState = (session: RuntimeSession, params: TerminalRuntimeSyncParams) => {
  session.handlers = {
    onInput: params.onInput,
    onResize: params.onResize,
  };
  session.hasLiveSession = params.hasLiveSession;
  session.terminal.options.disableStdin = !params.hasLiveSession;
  applyTerminalTheme(session, params.theme);
  syncSnapshot(session, params.snapshot);
  session.lastTouchedAt = Date.now();
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
  terminal.open(mount);

  let session: RuntimeSession;
  session = {
    tabId,
    terminal,
    fitAddon,
    mount,
    host: null,
    resizeObserver: null,
    lastSnapshot: '',
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
    updateSessionState(session, params);

    if (session.host !== params.hostElement) {
      if (session.host && session.mount.parentElement === session.host) {
        session.host.replaceChildren();
      }
      params.hostElement.replaceChildren(session.mount);
      session.host = params.hostElement;
      connectResizeObserver(session, params.hostElement);
    }

    scheduleFit(session);
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

    updateSessionState(session, params);
  },

  setTheme(theme?: Theme | null) {
    for (const session of runtimeSessions.values()) {
      applyTerminalTheme(session, theme);
    }
  },

  focusTab(tabId: string) {
    const session = runtimeSessions.get(tabId);
    if (!session) {
      return;
    }

    session.lastTouchedAt = Date.now();
    session.terminal.focus();
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
