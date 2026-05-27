import { afterEach, describe, expect, it } from 'bun:test';
import { installTauriRuntimeMock, removeTauriRuntimeMock } from '../test-utils/tauriRuntime';
import {
  clearRemoteRuntimeCapabilityOverrides,
  DESKTOP_IPC_UNAVAILABLE_MESSAGE,
  resolveServiceRuntime,
  resolveServiceRuntimeCapabilities,
  setRemoteRuntimeCapabilityOverrides,
} from './serviceRuntime';

describe('serviceRuntime', () => {
  afterEach(() => {
    removeTauriRuntimeMock();
    clearRemoteRuntimeCapabilityOverrides();
  });

  it('rejects browser desktop without falling back to mock data', () => {
    expect(() => resolveServiceRuntime({
      env: {
        VITE_BACKEND_TRANSPORT: 'desktop',
      },
      tauriAvailable: false,
    })).toThrow(DESKTOP_IPC_UNAVAILABLE_MESSAGE);
  });

  it('resolves Tauri desktop to the ipc provider', () => {
    installTauriRuntimeMock();

    const runtime = resolveServiceRuntime({
      env: {
        VITE_BACKEND_TRANSPORT: 'desktop',
      },
    });

    expect(runtime).toMatchObject({
      effectiveTransport: 'desktop',
      effectiveProvider: 'ipc',
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
      skills: true,
      skillScripts: false,
    });
  });

  it('forces the remote provider without requiring Tauri IPC', () => {
    const runtime = resolveServiceRuntime({
      env: {
        VITE_BACKEND_TRANSPORT: 'remote',
      },
      tauriAvailable: false,
    });

    expect(runtime).toMatchObject({
      effectiveTransport: 'remote',
      effectiveProvider: 'remote',
    });
  });

  it('applies remote-declared skill capabilities over the conservative default', () => {
    const runtime = resolveServiceRuntime({
      env: {
        VITE_BACKEND_TRANSPORT: 'remote',
      },
      tauriAvailable: false,
    });

    setRemoteRuntimeCapabilityOverrides({
      skills: false,
      skillScripts: true,
    });

    expect(resolveServiceRuntimeCapabilities(runtime)).toMatchObject({
      skills: false,
      skillScripts: true,
    });
  });
});
