import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { RestartSafetySnapshot } from '../../services/restartSafety';

const closeDetailsMock = mock(() => undefined);
const installAndRestartMock = mock(async () => true);
const prepareForPotentialShutdownMock = mock(async () => undefined);
const notifyErrorMock = mock(() => undefined);

let restartSafetySnapshot: RestartSafetySnapshot;
let updateState: Record<string, unknown>;

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
}));

mock.module('../../services/windowShutdown', () => ({
  prepareForPotentialShutdown: prepareForPotentialShutdownMock,
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
    };
    closeDetailsMock.mockClear();
    installAndRestartMock.mockClear();
    prepareForPotentialShutdownMock.mockClear();
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

    await act(async () => buttonByText('Restart and update')?.click());

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

    await act(async () => buttonByText('Restart and update')?.click());

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
    await act(async () => buttonByText('Restart and update')?.click());
    await act(async () => buttonByText('Restart anyway')?.click());

    expect(prepareForPotentialShutdownMock).toHaveBeenCalledTimes(1);
    expect(installAndRestartMock).toHaveBeenCalledTimes(1);
  });
});
