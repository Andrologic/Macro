import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { Theme } from '../types/theme';
import type { terminalRuntime as TerminalRuntime } from './terminalRuntime';

const macroDarkTheme: Theme = {
  name: 'Macro Dark',
  type: 'dark',
  colors: {
    background: '#09090b',
    foreground: '#fafafa',
    card: '#09090b',
    cardForeground: '#fafafa',
    popover: '#09090b',
    popoverForeground: '#fafafa',
    primary: '#6366f1',
    primaryForeground: '#fafafa',
    secondary: '#27272a',
    secondaryForeground: '#fafafa',
    muted: '#27272a',
    mutedForeground: '#a1a1aa',
    accent: '#27272a',
    accentForeground: '#fafafa',
    destructive: '#ef4444',
    destructiveForeground: '#fafafa',
    border: '#27272a',
    input: '#27272a',
    ring: '#6366f1',
  },
};

const macroLightTheme: Theme = {
  ...macroDarkTheme,
  name: 'Macro Light',
  type: 'light',
  colors: {
    ...macroDarkTheme.colors,
    background: '#ffffff',
    foreground: '#09090b',
    primary: '#4f46e5',
    ring: '#4f46e5',
  },
};

class ResizeObserverMock {
  observe = mock(() => undefined);
  disconnect = mock(() => undefined);

  constructor(readonly callback: ResizeObserverCallback) {}
}

class FakeFitAddon {
  static instances: FakeFitAddon[] = [];
  static nextCols = 96;
  static nextRows = 24;

  fitCount = 0;
  terminal: FakeTerminal | null = null;

  constructor() {
    FakeFitAddon.instances.push(this);
  }

  activate(terminal: FakeTerminal) {
    this.terminal = terminal;
  }

  dispose() {}

  fit() {
    this.fitCount += 1;
    if (!this.terminal) {
      return;
    }
    this.terminal.cols = FakeFitAddon.nextCols;
    this.terminal.rows = FakeFitAddon.nextRows;
  }
}

class FakeTerminal {
  static instances: FakeTerminal[] = [];

  _core = {
    _renderService: {
      hasRenderer: () => this.opened,
      _renderer: { value: {} },
    },
  };
  buffer = { active: { length: 0, getLine: () => undefined } };
  clearCount = 0;
  cols = 0;
  dataHandler: ((data: string) => void) | null = null;
  disposeCount = 0;
  element: HTMLElement | null = null;
  focusCount = 0;
  opened = false;
  refreshes: Array<[number, number]> = [];
  resetCount = 0;
  rows = 0;
  writes: string[] = [];

  constructor(readonly options: Record<string, unknown>) {
    FakeTerminal.instances.push(this);
  }

  loadAddon(addon: { activate?: (terminal: FakeTerminal) => void }) {
    addon.activate?.(this);
  }

  registerLinkProvider() {
    return { dispose: mock(() => undefined) };
  }

  open(mount: HTMLElement) {
    this.opened = true;
    this.element = document.createElement('div');
    this.element.className = 'xterm';
    const viewport = document.createElement('div');
    viewport.className = 'xterm-viewport';
    const screen = document.createElement('div');
    screen.className = 'xterm-screen';
    this.element.append(viewport, screen);
    mount.appendChild(this.element);
  }

  onData(handler: (data: string) => void) {
    this.dataHandler = handler;
    return { dispose: mock(() => undefined) };
  }

  write(data: string | Uint8Array, callback?: () => void) {
    this.writes.push(typeof data === 'string' ? data : new TextDecoder().decode(data));
    callback?.();
  }

  reset() {
    this.resetCount += 1;
  }

  clear() {
    this.clearCount += 1;
  }

  refresh(start: number, end: number) {
    this.refreshes.push([start, end]);
  }

  focus() {
    this.focusCount += 1;
  }

  dispose() {
    this.disposeCount += 1;
  }

  clearSelection() {}
  scrollToLine() {}
  select() {}
}

const buildHost = () => {
  const host = document.createElement('div');
  Object.defineProperty(host, 'clientWidth', { configurable: true, value: 640 });
  Object.defineProperty(host, 'clientHeight', { configurable: true, value: 280 });
  document.body.appendChild(host);
  return host;
};

const flushFrames = async (count = 3) => {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve();
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  }
};

let importCounter = 0;
let originalResizeObserver: typeof ResizeObserver | undefined;

const loadTerminalRuntime = async (): Promise<typeof TerminalRuntime> => {
  importCounter += 1;
  FakeTerminal.instances = [];
  FakeFitAddon.instances = [];
  FakeFitAddon.nextCols = 96;
  FakeFitAddon.nextRows = 24;

  mock.module('xterm', () => ({
    Terminal: FakeTerminal,
  }));
  mock.module('xterm-addon-fit', () => ({
    FitAddon: FakeFitAddon,
  }));
  mock.module('./externalUrlOpener', () => ({
    openExternalUrl: mock(async () => undefined),
  }));

  const module = await import(`./terminalRuntime.ts?terminal-runtime-test=${importCounter}`);
  return module.terminalRuntime;
};

describe('terminalRuntime', () => {
  beforeEach(() => {
    mock.restore();
    originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver;
  });

  afterEach(() => {
    document.body.replaceChildren();
    if (originalResizeObserver) {
      globalThis.ResizeObserver = originalResizeObserver;
    }
    mock.restore();
  });

  it('opens xterm after mounting, fits, and reports each size once', async () => {
    const runtime = await loadTerminalRuntime();
    const host = buildHost();
    const onResize = mock(() => undefined);

    runtime.attachTab({
      tabId: 'tab-1',
      hostElement: host,
      snapshot: 'ready\r\n',
      hasLiveSession: true,
      theme: macroDarkTheme,
      onInput: () => undefined,
      onResize,
    });
    await flushFrames();

    const terminal = FakeTerminal.instances[0];
    const fitAddon = FakeFitAddon.instances[0];
    expect(terminal.opened).toBe(true);
    expect(host.querySelector('.macro-terminal-runtime')).not.toBeNull();
    expect(fitAddon.fitCount).toBe(1);
    expect(onResize).toHaveBeenCalledTimes(1);
    expect(onResize).toHaveBeenCalledWith(96, 24);
    expect(terminal.writes).toEqual(['ready\r\n']);

    runtime.resizeTab('tab-1');
    await flushFrames();

    expect(fitAddon.fitCount).toBe(2);
    expect(onResize).toHaveBeenCalledTimes(1);
  });

  it('resets, clears, and refreshes when replaying a non-prefix snapshot', async () => {
    const runtime = await loadTerminalRuntime();
    const host = buildHost();

    runtime.attachTab({
      tabId: 'tab-1',
      hostElement: host,
      snapshot: 'first\r\n',
      hasLiveSession: true,
      theme: macroDarkTheme,
      onInput: () => undefined,
      onResize: () => undefined,
    });
    await flushFrames();

    runtime.syncTab({
      tabId: 'tab-1',
      snapshot: 'replacement\r\n',
      hasLiveSession: true,
      theme: macroDarkTheme,
      onInput: () => undefined,
      onResize: () => undefined,
    });
    await flushFrames();

    const terminal = FakeTerminal.instances[0];
    expect(terminal.resetCount).toBe(1);
    expect(terminal.clearCount).toBe(1);
    expect(terminal.writes).toEqual(['first\r\n', 'replacement\r\n']);
    expect(terminal.refreshes.length).toBeGreaterThan(0);
  });

  it('keeps the latest clear handler after sync updates', async () => {
    const runtime = await loadTerminalRuntime();
    const host = buildHost();
    const onInput = mock(() => undefined);
    const firstClear = mock(() => undefined);
    const nextClear = mock(() => undefined);

    runtime.attachTab({
      tabId: 'tab-1',
      hostElement: host,
      snapshot: '',
      hasLiveSession: true,
      theme: macroDarkTheme,
      onInput,
      onResize: () => undefined,
      onClear: firstClear,
    });
    runtime.syncTab({
      tabId: 'tab-1',
      snapshot: '',
      hasLiveSession: true,
      theme: macroDarkTheme,
      onInput,
      onResize: () => undefined,
      onClear: nextClear,
    });

    FakeTerminal.instances[0].dataHandler?.('\x0c');

    expect(firstClear).not.toHaveBeenCalled();
    expect(nextClear).toHaveBeenCalledTimes(1);
    expect(onInput).not.toHaveBeenCalled();
  });

  it('refits and refreshes after a theme change', async () => {
    const runtime = await loadTerminalRuntime();
    const host = buildHost();

    runtime.attachTab({
      tabId: 'tab-1',
      hostElement: host,
      snapshot: 'hello\r\n',
      hasLiveSession: true,
      theme: macroDarkTheme,
      onInput: () => undefined,
      onResize: () => undefined,
    });
    await flushFrames();
    const fitAddon = FakeFitAddon.instances[0];
    const initialFitCount = fitAddon.fitCount;

    runtime.syncTab({
      tabId: 'tab-1',
      snapshot: 'hello\r\n',
      hasLiveSession: true,
      theme: macroLightTheme,
      onInput: () => undefined,
      onResize: () => undefined,
    });
    await flushFrames();

    expect(fitAddon.fitCount).toBe(initialFitCount + 1);
    expect(FakeTerminal.instances[0].refreshes.length).toBeGreaterThan(0);
  });
});
