import { describe, expect, it } from 'bun:test';
import {
  resolveServiceRuntime,
  resolveServiceRuntimeCapabilities,
} from './serviceRuntime';

describe('serviceRuntime', () => {
  it('resolves browser desktop to the mock provider', () => {
    const runtime = resolveServiceRuntime({
      env: {
        VITE_BACKEND_TRANSPORT: 'desktop',
      },
      tauriAvailable: false,
    });

    expect(runtime).toMatchObject({
      effectiveTransport: 'desktop',
      effectiveProvider: 'mock',
      requestedProvider: null,
    });
    expect(resolveServiceRuntimeCapabilities(runtime).projectMutation).toBe(true);
  });

  it('resolves Tauri desktop to the ipc provider', () => {
    const runtime = resolveServiceRuntime({
      env: {
        VITE_BACKEND_TRANSPORT: 'desktop',
      },
      tauriAvailable: true,
    });

    expect(runtime).toMatchObject({
      effectiveTransport: 'desktop',
      effectiveProvider: 'ipc',
      requestedProvider: null,
    });
  });

  it('forces the remote provider when transport is remote and no provider is set', () => {
    const runtime = resolveServiceRuntime({
      env: {
        VITE_BACKEND_TRANSPORT: 'remote',
      },
      tauriAvailable: false,
    });

    expect(runtime).toMatchObject({
      effectiveTransport: 'remote',
      effectiveProvider: 'remote',
      requestedProvider: null,
    });
    expect(resolveServiceRuntimeCapabilities(runtime)).toMatchObject({
      bootstrap: true,
      taskCatalog: true,
      gitTree: true,
      gitHistory: true,
      toolSettings: true,
      mcpServerSettings: true,
      projectMutation: false,
      gitWorktrees: false,
      gitFilePreview: false,
      taskMutation: false,
      implementExecution: false,
      taskProjectCommands: false,
    });
  });

  it('forces the remote provider and records a warning when VITE_DATA_PROVIDER=mock', () => {
    const runtime = resolveServiceRuntime({
      env: {
        VITE_BACKEND_TRANSPORT: 'remote',
        VITE_DATA_PROVIDER: 'mock',
      },
      tauriAvailable: false,
    });

    expect(runtime).toMatchObject({
      effectiveTransport: 'remote',
      effectiveProvider: 'remote',
      requestedProvider: 'mock',
    });
    expect(runtime.warnings).toEqual([
      expect.objectContaining({
        code: 'REMOTE_PROVIDER_IGNORED',
      }),
    ]);
  });
});
