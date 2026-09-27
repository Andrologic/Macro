import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PilotAccountCatalog, PilotPublicState, PilotAccessRequest } from '../../../services/macroPilot/nativeClient';
import type { PilotVaultStatus } from '../../../services/tauriIpc';

const initializeMock = mock(async () => undefined);
const resumeVaultAccessMock = mock(async () => undefined);
const reconcileNotExecutedMock = mock(async (_key: string) => undefined);
const notifySuccessMock = mock(() => undefined);
const notifyWarningMock = mock((_message: string) => undefined);
let runtimeStatus = 'running';
let indeterminate = [{
  key: '["session:phone","reply:01"]',
  commandId: 'command:reply:01',
  target: { type: 'task', task_id: 'task:01' },
}];

const pilotState = {
  status: 'connected',
  vaultStatus: 'ready' as PilotVaultStatus,
  configurationId: 'config:desktop',
  relayOrigin: 'https://pilot.example.com',
  account: null as PilotPublicState['account'],
  deviceSession: null as PilotPublicState['deviceSession'],
  instance: {
    contract_version: '1.0',
    type: 'instance',
    ref: { type: 'instance', instance_id: 'instance:studio' },
    label: 'Studio Mac',
    connection_state: 'reachable',
    supported_contract_versions: ['1.0'],
    revision: 1,
  },
  instanceAccess: null as PilotPublicState['instanceAccess'],
  attempt: null,
  lastError: null as PilotPublicState['lastError'],
  logoutRevocationConfirmed: null,
  busy: false,
  reading: false,
  accountCatalog: null as PilotAccountCatalog | null,
  accessRequests: [] as PilotAccessRequest[],
  accessRequestsLoaded: true,
  refreshAccount: mock(async () => undefined),
  revokeSession: mock(async (_id: string) => true),
  revokeAllSessions: mock(async () => true),
  deleteAccount: mock(async (_identity: unknown, _origin: string) => true),
  initialize: initializeMock,
  resumeVaultAccess: resumeVaultAccessMock,
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
  notify: { success: notifySuccessMock, error: mock(() => undefined), warning: notifyWarningMock },
}));

const { PilotView } = await import('./PilotView');

describe('PilotView', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    pilotState.busy = false; pilotState.reading = false;
    pilotState.status = 'connected'; pilotState.vaultStatus = 'ready'; pilotState.lastError = null;
    pilotState.account = null; pilotState.deviceSession = null; pilotState.accountCatalog = null;
    pilotState.instanceAccess = null; pilotState.accessRequests = [];
    pilotState.deleteAccount.mockClear(); pilotState.resolveAccess.mockClear();
    pilotState.logout.mockClear();
    runtimeStatus = 'running';
    indeterminate = [{
      key: '["session:phone","reply:01"]',
      commandId: 'command:reply:01',
      target: { type: 'task', task_id: 'task:01' },
    }];
    reconcileNotExecutedMock.mockClear();
    resumeVaultAccessMock.mockReset(); resumeVaultAccessMock.mockImplementation(async () => undefined);
    notifySuccessMock.mockClear(); notifyWarningMock.mockClear();
    pilotState.revokeSession.mockClear(); pilotState.revokeAllSessions.mockClear();
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
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain(
      'Confirm that the effect did not occur',
    );

    const confirmButton = [...document.body.querySelectorAll('button')]
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

  const showAccount = async () => {
    pilotState.account = { contract_version: '1.0', type: 'account', account_id: 'account:one', revision: 1,
      identity: { provider: 'github', login: 'example', subject: '1234' } };
    pilotState.deviceSession = { contract_version: '1.0', type: 'device_session',
      ref: { type: 'session', account_id: 'account:one', session_id: 'session:one' },
      device_id: 'device:one', state: 'active', issued_at: '2026-09-01T00:00:00Z', revision: 1 };
    pilotState.accountCatalog = { identity: { account_id: 'account:one', session_id: 'session:one',
      provider: 'github', login: 'example', subject: '1234', revision: 1 }, revision: 1,
      sessions: [{ session_id: 'session:one', device_id: 'device:one', label: 'Example desktop',
        client_kind: 'desktop', state: 'active', created_at: '2026-09-01T00:00:00Z', expires_at: '2026-10-01T00:00:00Z' }] };
    await act(async () => root.render(<PilotView />));
  };
  const button = (label: string) => [...document.body.querySelectorAll('button')].find(item => item.textContent === label)!;

  const showVaultStatus = async (status: Exclude<PilotVaultStatus, 'ready'>) => {
    pilotState.status = 'vault_unavailable';
    pilotState.vaultStatus = status;
    pilotState.lastError = status === 'intervention_required' ? 'vault_intervention_required'
      : status === 'cancelled' ? 'vault_cancelled'
        : status === 'suspended' ? 'vault_suspended' : 'vault_unavailable';
    await act(async () => root.render(<PilotView />));
  };

  it.each(['intervention_required', 'cancelled', 'suspended', 'vault_unavailable'] as const)(
    'explains the %s vault state and offers one explicit recovery action', async (status) => {
      await showVaultStatus(status);
      const recovery = container.querySelector('[role="alert"]');
      expect(recovery?.textContent).toContain('Pilot data is paused');
      const explanations: Record<Exclude<PilotVaultStatus, 'ready'>, string> = {
        intervention_required: 'Macro needs attention to access the system credential vault and restore Pilot data.',
        cancelled: 'Credential vault access was cancelled. You can try again when you are ready.',
        suspended: 'Access to Pilot credentials is suspended. Resume access to restore Pilot data.',
        vault_unavailable: 'Macro could not access the system credential vault. You can try to resume access.',
      };
      expect(recovery?.textContent).toContain(explanations[status]);
      expect([...container.querySelectorAll('button')].filter(item => item.textContent === 'Resume vault access')).toHaveLength(1);
      expect(resumeVaultAccessMock).not.toHaveBeenCalled();
      await act(async () => {
        button('Resume vault access').click();
        await Promise.resolve();
      });
      expect(resumeVaultAccessMock).toHaveBeenCalledTimes(1);
    },
  );

  it('does not resume on mount, refresh, or reopening settings', async () => {
    await showVaultStatus('cancelled');
    expect(resumeVaultAccessMock).not.toHaveBeenCalled();
    await act(async () => button('Refresh').click());
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => {
      root.render(<PilotView />);
      await Promise.resolve();
    });
    expect(resumeVaultAccessMock).not.toHaveBeenCalled();
  });

  it('shows a cancelled attempt and restores Pilot data after successful explicit recovery', async () => {
    await showVaultStatus('intervention_required');
    resumeVaultAccessMock.mockImplementationOnce(async () => {
      pilotState.vaultStatus = 'cancelled';
      pilotState.lastError = 'vault_cancelled';
      throw new Error('cancelled');
    });
    await act(async () => {
      button('Resume vault access').click();
      await Promise.resolve();
    });
    await act(async () => root.render(<PilotView />));
    expect(container.textContent).toContain('Credential vault access was cancelled. You can try again when you are ready.');
    expect(button('Resume vault access')).toBeDefined();

    await showAccount();
    pilotState.status = 'vault_unavailable';
    pilotState.vaultStatus = 'suspended';
    await act(async () => root.render(<PilotView />));
    resumeVaultAccessMock.mockImplementationOnce(async () => {
      pilotState.status = 'connected';
      pilotState.vaultStatus = 'ready';
      pilotState.lastError = null;
    });
    await act(async () => {
      button('Resume vault access').click();
      await Promise.resolve();
    });
    await act(async () => root.render(<PilotView />));
    expect(container.textContent).toContain('GitHub @example');
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('locks out double clicks while keeping sign out available during recovery', async () => {
    await showAccount();
    await showVaultStatus('intervention_required');
    let finishRecovery!: () => void;
    const recoveryPending = new Promise<void>(resolve => { finishRecovery = resolve; });
    resumeVaultAccessMock.mockImplementation(async () => {
      pilotState.busy = true;
      pilotState.reading = true;
      await recoveryPending;
    });
    await act(async () => {
      button('Resume vault access').click();
      button('Resume vault access').click();
      await Promise.resolve();
    });
    await act(async () => root.render(<PilotView />));
    expect(resumeVaultAccessMock).toHaveBeenCalledTimes(1);
    expect(pilotState.busy).toBe(true);
    expect(pilotState.reading).toBe(true);
    expect(container.textContent).toContain('Waiting for access to the system credential vault.');
    expect(button('Resuming access…').disabled).toBe(true);
    expect(button('Sign out').disabled).toBe(false);
    await act(async () => button('Resuming access…').click());
    expect(resumeVaultAccessMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      button('Sign out').click();
      await Promise.resolve();
    });
    expect(pilotState.logout).toHaveBeenCalledTimes(1);
    await act(async () => { finishRecovery(); await recoveryPending; });
  });

  it('shows identity and sessions without an instance and requires explicit deletion confirmation', async () => {
    const instance = pilotState.instance;
    Object.assign(pilotState, { instance: null });
    try {
      await showAccount();
      expect(container.textContent).toContain('GitHub @example');
      expect(container.textContent).toContain('Example desktop');
      expect(button('Revoke all sessions')).toBeDefined();
      await act(async () => button('Delete relay account').click());
      expect(pilotState.deleteAccount).not.toHaveBeenCalled();
      const dialog = document.body.querySelector('[role="dialog"]');
      expect(dialog?.textContent).toContain('GitHub @example');
      expect(dialog?.textContent).toContain('GitHub ID: 1234');
      expect(dialog?.textContent).toContain('Local projects and conversations are preserved.');
      await act(async () => button('Delete this account permanently').click());
      expect(pilotState.deleteAccount).toHaveBeenCalledWith({ account_id: 'account:one', session_id: 'session:one', login: 'example', subject: '1234' }, 'https://pilot.example.com');
    } finally { pilotState.instance = instance; }
  });

  it('removes deletion confirmation if the identity changes while the dialog is open', async () => {
    await showAccount();
    await act(async () => button('Delete relay account').click());
    pilotState.accountCatalog = { ...pilotState.accountCatalog!, identity: { ...pilotState.accountCatalog!.identity, login: 'renamed' } };
    await act(async () => root.render(<PilotView />));
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain('The connected account changed.');
    expect(button('Delete this account permanently')).toBeUndefined();
    expect(pilotState.deleteAccount).not.toHaveBeenCalled();
  });

  it('offers association without permission checkboxes and warns about legacy limited access', async () => {
    await showAccount();
    pilotState.instanceAccess = { contract_version: '1.0', type: 'instance_access',
      ref: { type: 'instance_access', account_id: 'account:one', session_id: 'session:one', instance_id: 'instance:studio' },
      state: 'granted', permissions: ['supervise'], granted_at: '2026-09-01T00:00:00Z', revision: 1 };
    pilotState.accessRequests = [{ access_request_id: 'request:phone', device_session: pilotState.deviceSession!,
      device_label: 'Example phone', expires_at: '2026-10-01T00:00:00Z' }];
    await act(async () => root.render(<PilotView />));
    expect(container.querySelectorAll('input[type="checkbox"]').length).toBe(0);
    expect(container.textContent).toContain('This existing association has limited permissions.');
    await act(async () => button('Associate device').click());
    expect(pilotState.resolveAccess).toHaveBeenCalledWith('request:phone', 'grant');
  });

  it('routes individual and global revocation and explains an unconfirmed self response', async () => {
    await showAccount();
    await act(async () => button('Revoke session').click());
    expect(pilotState.revokeSession).toHaveBeenCalledWith('session:one');
    pilotState.revokeAllSessions.mockImplementationOnce(async () => false);
    await act(async () => button('Revoke all sessions').click());
    expect(pilotState.revokeAllSessions).toHaveBeenCalledTimes(1);
    expect(notifyWarningMock).toHaveBeenCalledWith('Signed out locally. Server revocation could not be confirmed. Sign in again to check your account.');
  });

  it('keeps sign out available during reads but disables it during mutations', async () => {
    await showAccount();
    pilotState.busy = true; pilotState.reading = true;
    await act(async () => root.render(<PilotView />));
    expect(button('Sign out').disabled).toBe(false);
    expect(button('Revoke all sessions').disabled).toBe(true);
    pilotState.reading = false;
    await act(async () => root.render(<PilotView />));
    expect(button('Sign out').disabled).toBe(true);
  });

});
