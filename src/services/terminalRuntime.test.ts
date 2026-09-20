import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { Theme } from '../types/theme';
import type { terminalRuntime as TerminalRuntime } from './terminalRuntime';
import { terminalRenderingLifecycle } from './terminalRenderingLifecycle';

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
  static instances: ResizeObserverMock[] = [];
  observe = mock(() => undefined);
  disconnect = mock(() => undefined);

  constructor(readonly callback: ResizeObserverCallback) { ResizeObserverMock.instances.push(this); }
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
  static failOnData = false;
  static failOpen = false;
  static deferWrites = false;

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
  writeCallbacks: Array<() => void> = [];
  linkDispose = mock(() => undefined);
  inputDispose = mock(() => undefined);

  constructor(readonly options: Record<string, unknown>) {
    FakeTerminal.instances.push(this);
  }

  loadAddon(addon: { activate?: (terminal: FakeTerminal) => void }) {
    addon.activate?.(this);
  }

  registerLinkProvider() {
    return { dispose: this.linkDispose };
  }

  open(mount: HTMLElement) {
    if (FakeTerminal.failOpen) throw new Error('open failed');
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
    if (FakeTerminal.failOnData) throw new Error('input subscription failed');
    this.dataHandler = handler;
    return { dispose: this.inputDispose };
  }

  write(data: string | Uint8Array, callback?: () => void) {
    this.writes.push(typeof data === 'string' ? data : new TextDecoder().decode(data));
    if (callback && FakeTerminal.deferWrites) this.writeCallbacks.push(callback);
    else callback?.();
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
const runtimes: Array<typeof TerminalRuntime> = [];
let originalFonts: PropertyDescriptor | undefined;
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

  terminalRenderingLifecycle.install();
  const module = await import(`./terminalRuntime.ts?terminal-runtime-test=${importCounter}`);
  runtimes.push(module.terminalRuntime);
  return module.terminalRuntime;
};

describe('terminalRuntime', () => {
  beforeEach(() => {
    mock.restore();
    FakeTerminal.failOnData = false;
    FakeTerminal.failOpen = false;
    FakeTerminal.deferWrites = false;
    ResizeObserverMock.instances = [];
    originalFonts = Object.getOwnPropertyDescriptor(document, 'fonts');
    originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver;
  });

  afterEach(() => {
    for (const runtime of runtimes.splice(0)) runtime.disposeAll();
    if (originalFonts) Object.defineProperty(document, 'fonts', originalFonts);
    else Reflect.deleteProperty(document, 'fonts');
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

  it('keeps six detached sessions in addition to every attached session', async () => {
    const runtime = await loadTerminalRuntime();
    const attach = (tabId: string) => {
      const hostElement = buildHost();
      runtime.attachTab({ tabId, hostElement, snapshot: '', hasLiveSession: true,
        onInput: () => undefined, onResize: () => undefined });
      return hostElement;
    };
    for (let index = 0; index < 8; index++) attach(`attached-${index}`);
    for (let index = 0; index < 7; index++) {
      const host = attach(`detached-${index}`);
      runtime.detachTab(`detached-${index}`, host);
    }
    expect(FakeTerminal.instances.slice(0, 8).every((terminal) => terminal.disposeCount === 0)).toBe(true);
    expect(FakeTerminal.instances[8].disposeCount).toBe(1);
    expect(FakeTerminal.instances.slice(9).every((terminal) => terminal.disposeCount === 0)).toBe(true);
    attach('detached-1');
    expect(FakeTerminal.instances).toHaveLength(15);
    runtime.disposeAll();
    runtime.disposeAll();
    expect(FakeTerminal.instances.every((terminal) => terminal.disposeCount === 1)).toBe(true);
    expect(ResizeObserverMock.instances.every((observer) => observer.disconnect.mock.calls.length === 1)).toBe(true);
  });

  it('ignores fonts, write callbacks, input, observer and RAF callbacks after disposal', async () => {
    const runtime = await loadTerminalRuntime();
    let fontsReady!: () => void;
    Object.defineProperty(document, 'fonts', { configurable: true,
      value: { ready: new Promise<void>((resolve) => { fontsReady = resolve; }) } });
    const frames = new Map<number, FrameRequestCallback>();
    const cancelled: number[] = [];
    let nextFrame = 0;
    spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => { cancelled.push(id); });
    const addWindow = spyOn(window, 'addEventListener');
    const removeWindow = spyOn(window, 'removeEventListener');
    const addDocument = spyOn(document, 'addEventListener');
    const removeDocument = spyOn(document, 'removeEventListener');
    FakeTerminal.deferWrites = true;
    const onInput = mock(() => undefined);
    const onResize = mock(() => undefined);
    runtime.attachTab({ tabId: 'late', hostElement: buildHost(), snapshot: 'ready',
      hasLiveSession: true, onInput, onResize });
    const terminal = FakeTerminal.instances[0];
    for (const callback of [...frames.values()]) callback(0);
    expect(terminal.writeCallbacks).toHaveLength(1);
    runtime.syncTab({ tabId: 'late', snapshot: 'ready again', hasLiveSession: true, onInput, onResize });
    runtime.resizeTab('late');
    runtime.disposeTab('late');
    runtime.disposeTab('late');
    const refreshCount = terminal.refreshes.length;
    const fitCount = FakeFitAddon.instances[0].fitCount;
    const resizeCount = onResize.mock.calls.length;
    const writeCount = terminal.writes.length;
    const frameCount = frames.size;
    terminal.dataHandler?.('input');
    terminal.writeCallbacks.forEach((callback) => callback());
    ResizeObserverMock.instances[0].callback([], {} as ResizeObserver);
    for (const callback of frames.values()) callback(0);
    fontsReady();
    await Promise.resolve();
    expect(terminal.disposeCount).toBe(1);
    expect(terminal.linkDispose).toHaveBeenCalledTimes(1);
    expect(terminal.inputDispose).toHaveBeenCalledTimes(1);
    expect(ResizeObserverMock.instances[0].disconnect).toHaveBeenCalledTimes(1);
    expect(terminal.refreshes).toHaveLength(refreshCount);
    expect(terminal.writes).toHaveLength(writeCount);
    expect(FakeFitAddon.instances[0].fitCount).toBe(fitCount);
    expect(onResize).toHaveBeenCalledTimes(resizeCount);
    expect(onInput).not.toHaveBeenCalled();
    expect(frames.size).toBe(frameCount);
    expect(cancelled).toHaveLength(2);
    const resizeListener = addWindow.mock.calls.find(([name]) => name === 'resize')![1];
    const visibilityListener = addDocument.mock.calls.find(([name]) => name === 'visibilitychange')![1];
    expect(removeWindow).toHaveBeenCalledWith('resize', resizeListener);
    expect(removeDocument).toHaveBeenCalledWith('visibilitychange', visibilityListener);
  });

  it('releases partial acquisition and a failed mount before retrying', async () => {
    const runtime = await loadTerminalRuntime();
    const params = { tabId: 'partial', hostElement: buildHost(), snapshot: '',
      hasLiveSession: true, onInput: () => undefined, onResize: () => undefined };
    FakeTerminal.failOnData = true;
    expect(() => runtime.attachTab(params)).toThrow('input subscription failed');
    expect(FakeTerminal.instances[0].disposeCount).toBe(1);
    expect(FakeTerminal.instances[0].linkDispose).toHaveBeenCalledTimes(1);
    FakeTerminal.failOnData = false;
    FakeTerminal.failOpen = true;
    expect(() => runtime.attachTab(params)).toThrow('open failed');
    expect(FakeTerminal.instances[1].disposeCount).toBe(1);
    expect(ResizeObserverMock.instances[0].disconnect).toHaveBeenCalledTimes(1);
    expect(params.hostElement.children).toHaveLength(0);
    FakeTerminal.failOpen = false;
    runtime.attachTab(params);
    expect(FakeTerminal.instances[2].disposeCount).toBe(0);
    runtime.disposeTab('partial');
    expect(FakeTerminal.instances[2].disposeCount).toBe(1);
  });

  it('rejects a late renderer attachment after application stop and permits the next owner', async () => {
    const runtime = await loadTerminalRuntime();
    const owner = terminalRenderingLifecycle.install();
    const params = { tabId: 'owned', snapshot: '', hasLiveSession: true,
      hostElement: buildHost(), onInput: () => undefined, onResize: () => undefined };
    runtime.attachTab(params);
    let release!: () => void;
    const lateAttachment = new Promise<void>((resolve) => { release = resolve; })
      .then(() => runtime.attachTab({ ...params, tabId: 'late' }));
    owner.stop();
    release();
    await lateAttachment;
    expect(FakeTerminal.instances).toHaveLength(1);
    expect(FakeTerminal.instances[0].disposeCount).toBe(1);
    expect(params.hostElement.children).toHaveLength(0);

    const next = terminalRenderingLifecycle.install();
    runtime.attachTab({ ...params, tabId: 'next' });
    owner.stop();
    expect(FakeTerminal.instances).toHaveLength(2);
    expect(FakeTerminal.instances[1].disposeCount).toBe(0);
    next.stop();
    next.stop();
    expect(FakeTerminal.instances[1].disposeCount).toBe(1);
  });

  it('keeps runtimes independent and ignores a detach from a previous host', async () => {
    const first = await loadTerminalRuntime();
    const { createTerminalRuntime } = await import(`./terminalRuntime.ts?terminal-runtime-test=${importCounter}`);
    const second = createTerminalRuntime();
    runtimes.push(second);
    const oldHost = buildHost();
    const newHost = buildHost();
    const onInput = mock(() => undefined);
    const params = { tabId: 'same-id', snapshot: '', hasLiveSession: true,
      onInput, onResize: () => undefined };
    first.attachTab({ ...params, hostElement: oldHost });
    first.attachTab({ ...params, hostElement: newHost });
    first.detachTab('same-id', oldHost);
    expect(newHost.children).toHaveLength(1);
    second.attachTab({ ...params, hostElement: buildHost() });
    first.disposeAll();
    expect(FakeTerminal.instances[0].disposeCount).toBe(1);
    expect(FakeTerminal.instances[1].disposeCount).toBe(0);
    second.detachTab('same-id');
    FakeTerminal.instances[1].dataHandler?.('detached input');
    expect(onInput).not.toHaveBeenCalled();
    expect(FakeTerminal.instances[1].disposeCount).toBe(0);
  });

});
