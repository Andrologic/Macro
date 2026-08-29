import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { RestartSafetySnapshot } from '../../services/restartSafety';

const closeDetailsMock = mock(() => undefined);
const installAndRestartMock = mock(async () => true);
const resetMock = mock(async () => undefined);
const checkForUpdatesMock = mock(async () => 'ready' as const);
const prepareForPotentialShutdownMock = mock(async () => undefined);
const savePreferenceMock = mock(async () => undefined);
const notifyErrorMock = mock(() => undefined);

let restartSafetySnapshot: RestartSafetySnapshot;
let updateState: Record<string, unknown>;
let shutdownGateActive = false;

const useAppUpdateStoreMock = Object.assign(
  (selector: (state: Record<string, unknown>) => unknown) => selector(updateState),
  { getState: () => updateState },
);

mock.module('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallbackOrOptions?: string | Record<string, unknown>, options?: Record<string, unknown>) => {
      const fallback = typeof fallbackOrOptions === 'string'
        ? fallbackOrOptions
        : String(fallbackOrOptions?.defaultValue ?? _key);
      const values = typeof fallbackOrOptions === 'object' ? fallbackOrOptions : options;
      return fallback.replace('{{count}}', String(values?.count ?? ''));
    },
  }),
}));

mock.module('../../stores/useAppUpdateStore', () => ({
  useAppUpdateStore: useAppUpdateStoreMock,
}));

mock.module('../../stores/useAppStore', () => ({
  useAppStore: {
    getState: () => ({ projectGroups: [], selectedGroupId: null }),
  },
}));

mock.module('../../stores/useChatStore', () => ({
  useChatStore: { getState: () => ({}) },
}));

mock.module('../../stores/useTaskStore', () => ({
  useTaskStore: { getState: () => ({}) },
}));

mock.module('../../services/restartSafety', () => ({
  selectRestartSafetySnapshot: () => restartSafetySnapshot,
  hasUnapprovedRestartSafetyActivity: (
    approved: RestartSafetySnapshot,
    current: RestartSafetySnapshot,
  ) => {
    const approvedKeys = new Set([
      ...approved.activeAgents,
      ...approved.activeImplementations,
    ].map((activity) => `${activity.kind}:${activity.id}`));
    return [...current.activeAgents, ...current.activeImplementations]
      .some((activity) => !approvedKeys.has(`${activity.kind}:${activity.id}`));
  },
}));

mock.module('../../services/windowShutdown', () => ({
  prepareForPotentialShutdown: prepareForPotentialShutdownMock,
}));

mock.module('../../services/appShutdownGate', () => ({
  beginAppShutdownGate: () => {
    shutdownGateActive = true;
    return () => { shutdownGateActive = false; };
  },
  isAppShutdownGateActive: () => shutdownGateActive,
}));

mock.module('../../services/preferences', () => ({
  PREF_KEYS: { RELEASE_NOTES_PENDING_UPDATE: 'releaseNotesPendingUpdate' },
  savePreference: savePreferenceMock,
}));

mock.module('../chat/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div>,
}));

mock.module('../ui/toastService', () => ({
  notify: { error: notifyErrorMock },
}));

const { default: UpdateModal } = await import('./UpdateModal');

const emptySafetySnapshot = (): RestartSafetySnapshot => ({
  activeAgents: [],
  activeImplementations: [],
  activeAgentCount: 0,
  activeImplementationCount: 0,
  activeWorkCount: 0,
  hasActiveWork: false,
});

describe('UpdateModal', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    restartSafetySnapshot = emptySafetySnapshot();
    shutdownGateActive = false;
    updateState = {
      phase: 'ready',
      availableUpdate: {
        currentVersion: '0.1.0',
        version: '0.1.1',
        date: '2026-08-19T10:00:00Z',
        notes: '## Changes',
      },
      error: null,
      errorOperation: null,
      detailsOpen: true,
      closeDetails: closeDetailsMock,
      installAndRestart: installAndRestartMock,
      reset: resetMock,
      checkForUpdates: checkForUpdatesMock,
    };
    closeDetailsMock.mockClear();
    installAndRestartMock.mockClear();
    resetMock.mockClear();
    checkForUpdatesMock.mockClear();
    prepareForPotentialShutdownMock.mockClear();
    prepareForPotentialShutdownMock.mockImplementation(async () => undefined);
    savePreferenceMock.mockClear();
    notifyErrorMock.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.querySelectorAll('[data-macro-dialog-root]').forEach((element) => element.remove());
    container.remove();
  });

  const renderModal = async () => {
    await act(async () => root.render(<UpdateModal />));
  };

  const buttonByText = (text: string): HTMLButtonElement | undefined =>
    Array.from(document.querySelectorAll('button')).find((button) => button.textContent === text);

  it('prepares the application and installs when no work is active', async () => {
    await renderModal();

    await act(async () => buttonByText('Install now')?.click());

    expect(prepareForPotentialShutdownMock).toHaveBeenCalledTimes(1);
    expect(savePreferenceMock).toHaveBeenCalledWith('releaseNotesPendingUpdate', {
      version: '0.1.1',
      content: '## Changes',
    });
    expect(installAndRestartMock).toHaveBeenCalledTimes(1);
  });

  it('blocks new work before preparing the restart', async () => {
    prepareForPotentialShutdownMock.mockImplementationOnce(async () => {
      expect(shutdownGateActive).toBe(true);
    });
    await renderModal();

    await act(async () => buttonByText('Install now')?.click());

    expect(prepareForPotentialShutdownMock).toHaveBeenCalledTimes(1);
    expect(installAndRestartMock).toHaveBeenCalledTimes(1);
  });

  it('warns about active agents and keeps waiting as the safe action', async () => {
    restartSafetySnapshot = {
      ...emptySafetySnapshot(),
      activeAgents: [{
        id: 'conversation-1',
        kind: 'agent',
        phase: 'streaming',
        title: 'Release agent',
      }],
      activeAgentCount: 1,
      activeWorkCount: 1,
      hasActiveWork: true,
    };
    await renderModal();

    await act(async () => buttonByText('Install now')?.click());

    expect(document.body.textContent).toContain('Agents are still running');
    expect(document.body.textContent).toContain('Release agent');
    expect(installAndRestartMock).not.toHaveBeenCalled();

    await act(async () => buttonByText('Wait')?.click());
    expect(closeDetailsMock).toHaveBeenCalledTimes(1);
  });

  it('allows an explicit forced restart after the warning', async () => {
    restartSafetySnapshot = {
      ...emptySafetySnapshot(),
      activeImplementations: [{
        id: 'task-1',
        kind: 'implement',
        phase: 'running',
        title: 'Native checks',
      }],
      activeImplementationCount: 1,
      activeWorkCount: 1,
      hasActiveWork: true,
    };
    await renderModal();
    await act(async () => buttonByText('Install now')?.click());
    await act(async () => buttonByText('Install anyway')?.click());

    expect(prepareForPotentialShutdownMock).toHaveBeenCalledTimes(1);
    expect(installAndRestartMock).toHaveBeenCalledTimes(1);
  });

  it('discards a failed staged package before downloading it again', async () => {
    updateState.phase = 'error';
    updateState.error = 'The update could not be installed';
    updateState.errorOperation = 'install';
    await renderModal();

    await act(async () => buttonByText('Download again')?.click());

    expect(resetMock).toHaveBeenCalledTimes(1);
    expect(checkForUpdatesMock).toHaveBeenCalledWith({ explicit: true });
    expect(installAndRestartMock).toHaveBeenCalledTimes(0);
  });
});
