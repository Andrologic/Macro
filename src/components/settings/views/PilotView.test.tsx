import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const initializeMock = mock(async () => undefined);
const reconcileNotExecutedMock = mock(async (_key: string) => undefined);
const notifySuccessMock = mock(() => undefined);
let runtimeStatus = 'running';
let indeterminate = [{
  key: '["session:phone","reply:01"]',
  commandId: 'command:reply:01',
  target: { type: 'task', task_id: 'task:01' },
}];

const pilotState = {
  status: 'connected',
  configurationId: 'config:desktop',
  relayOrigin: 'https://pilot.example.com',
  account: null,
  deviceSession: null,
  instance: {
    contract_version: '1.0',
    type: 'instance',
    ref: { type: 'instance', instance_id: 'instance:studio' },
    label: 'Studio Mac',
    connection_state: 'reachable',
    supported_contract_versions: ['1.0'],
    revision: 1,
  },
  instanceAccess: null,
  attempt: null,
  lastError: null,
  logoutRevocationConfirmed: null,
  busy: false,
  accessRequests: [],
  initialize: initializeMock,
  connect: mock(async () => undefined),
  pollAuth: mock(async () => false),
  confirmAccount: mock(async () => undefined),
  createOrAttachInstance: mock(async () => undefined),
  refreshAccessRequests: mock(async () => undefined),
  resolveAccess: mock(async () => undefined),
  logout: mock(async () => true),
  clearError: mock(() => undefined),
};

const usePilotStoreMock = Object.assign(() => pilotState, { getState: () => pilotState });

mock.module('react-i18next', () => ({
  useTranslation: () => ({
    t: (
      key: string,
      fallbackOrOptions?: string | Record<string, unknown>,
      maybeOptions?: Record<string, unknown>,
    ) => {
      const fallback = typeof fallbackOrOptions === 'string'
        ? fallbackOrOptions
        : String(fallbackOrOptions?.defaultValue ?? key);
      const values = typeof fallbackOrOptions === 'object' ? fallbackOrOptions : maybeOptions;
      return Object.entries(values ?? {}).reduce(
        (text, [name, value]) => text.replace(`{{${name}}}`, String(value)),
        fallback,
      );
    },
  }),
}));

mock.module('../../../stores/usePilotStore', () => ({ usePilotStore: usePilotStoreMock }));
mock.module('../../../services/externalUrlOpener', () => ({ openExternalUrl: async () => undefined }));
mock.module('../../../services/macroPilot/runtime', () => ({
  macroPilotRuntime: {
    getStatus: () => runtimeStatus,
    subscribe: () => () => undefined,
    retry: async () => undefined,
    getIndeterminate: () => indeterminate,
    reconcileNotExecuted: reconcileNotExecutedMock,
  },
}));
mock.module('../../ui/toastService', () => ({
  notify: { success: notifySuccessMock, error: mock(() => undefined), warning: mock(() => undefined) },
}));

const { PilotView } = await import('./PilotView');

describe('PilotView', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    runtimeStatus = 'running';
    indeterminate = [{
      key: '["session:phone","reply:01"]',
      commandId: 'command:reply:01',
      target: { type: 'task', task_id: 'task:01' },
    }];
    reconcileNotExecutedMock.mockClear();
    notifySuccessMock.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<PilotView />);
      await Promise.resolve();
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('exige la confirmation explicite avant le rapprochement local', async () => {
    const reconcileButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Reconcile locally');
    expect(reconcileButton).toBeDefined();

    await act(async () => reconcileButton!.click());
    expect(reconcileNotExecutedMock).not.toHaveBeenCalled();
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain(
      'Confirm that the effect did not occur',
    );

    const confirmButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'I confirm it was not executed');
    indeterminate = [];
    await act(async () => {
      confirmButton!.click();
      await Promise.resolve();
    });

    expect(reconcileNotExecutedMock).toHaveBeenCalledWith('["session:phone","reply:01"]');
    expect(notifySuccessMock).toHaveBeenCalledTimes(1);
  });
  it('shows unavailable supervision instead of an empty reconciliation result', async () => {
    runtimeStatus = 'unavailable';
    indeterminate = [];
    const refresh = [...container.querySelectorAll('button')].filter(button => button.textContent === 'Refresh').at(-1);
    await act(async () => { refresh!.click(); await Promise.resolve(); });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Desktop supervision is unavailable');
    expect(container.textContent).not.toContain('No command requires local reconciliation.');
  });

});
