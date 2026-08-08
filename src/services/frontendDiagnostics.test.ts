import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import {
  createFrontendDiagnosticMessage,
  installFrontendDiagnostics,
  type FrontendLogParams,
} from './frontendDiagnostics';

describe('frontendDiagnostics', () => {
  let forwardedLogs: FrontendLogParams[];
  let uninstall: (() => void) | null;

  beforeEach(() => {
    forwardedLogs = [];
    uninstall = null;
  });

  afterEach(() => {
    uninstall?.();
  });

  it('formats module import failures with useful context', () => {
    const message = createFrontendDiagnosticMessage('error', {
      message: 'Importing a module script failed.',
      filename: 'http://localhost:1422/src/components/layout/ModeRouter.tsx',
      lineno: 12,
      colno: 4,
    });

    expect(message).toContain('[Frontend:error]');
    expect(message).toContain('Importing a module script failed.');
    expect(message).toContain('ModeRouter.tsx');
  });

  it('relays window errors to the configured frontend logger', async () => {
    const consoleError = mock(() => undefined);
    uninstall = installFrontendDiagnostics({
      forwardLog: (params) => {
        forwardedLogs.push(params);
      },
      consoleLike: {
        error: consoleError,
        warn: () => undefined,
      },
    });

    const error = new Event('error') as ErrorEvent;
    Object.defineProperty(error, 'message', {
      configurable: true,
      value: 'Importing a module script failed.',
    });
    Object.defineProperty(error, 'filename', {
      configurable: true,
      value: 'http://localhost:1422/assets/ImplementCenter.js',
    });
    Object.defineProperty(error, 'error', {
      configurable: true,
      value: new TypeError('Importing a module script failed.'),
    });

    window.dispatchEvent(error);
    await Promise.resolve();

    expect(forwardedLogs).toHaveLength(1);
    expect(forwardedLogs[0]).toMatchObject({
      level: 'error',
      scope: 'frontend',
    });
    expect(forwardedLogs[0].message).toContain('Importing a module script failed.');
    expect(forwardedLogs[0].message).toContain('ImplementCenter.js');
    expect(consoleError.mock.calls.length).toBe(1);
  });

  it('reloads once in dev when Vite optimized deps are stale', async () => {
    const reloadPage = mock(() => undefined);
    const scheduledReloads: Array<() => void> = [];
    const storage = new Map<string, string>();
    uninstall = installFrontendDiagnostics({
      isDev: true,
      reloadPage,
      scheduleReload: (run) => {
        scheduledReloads.push(run);
      },
      storage: {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => {
          storage.set(key, value);
        },
      },
      forwardLog: (params) => {
        forwardedLogs.push(params);
      },
      consoleLike: {
        error: () => undefined,
        warn: () => undefined,
      },
    });

    const dispatchOptimizedDepFailure = () => {
      const error = new Event('error') as ErrorEvent;
      Object.defineProperty(error, 'message', {
        configurable: true,
        value: 'TypeError: Importing a module script failed.',
      });
      Object.defineProperty(error, 'filename', {
        configurable: true,
        value: 'http://localhost:1422/node_modules/.vite/deps/react-dom_client.js?v=abc',
      });
      window.dispatchEvent(error);
    };

    dispatchOptimizedDepFailure();
    dispatchOptimizedDepFailure();

    expect(scheduledReloads).toHaveLength(1);
    scheduledReloads[0]();
    expect(reloadPage.mock.calls).toHaveLength(1);
  });
});
