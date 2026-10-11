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
const testLanguage = 'en';
let runtimeStatus = 'running';
let runtimeListener: (() => void) | undefined;
let indeterminate = [{
  key: '["session:phone","reply:01"]',
  commandId: 'command:reply:01',
  target: { type: 'task', task_id: 'task:01' },
}];

const pilotState = {
  status: 'connected',
  vaultStatus: 'ready' as PilotVaultStatus,
  sessionVerification: null as PilotPublicState['sessionVerification'],
  sessionEndReason: null as PilotPublicState['sessionEndReason'],
  configurationId: 'config:desktop',
  relayOrigin: 'https://macro.andrologic.ai' as string | null,
  account: null as PilotPublicState['account'],
  deviceSession: null as PilotPublicState['deviceSession'],
  instance: {
    contract_version: '1.0',
    type: 'instance',
    ref: { type: 'instance', instance_id: 'instance:studio' },
    label: 'Studio Mac',
    connection_state: 'reachable',
    last_seen_at: undefined as string | undefined,
    supported_contract_versions: ['1.0'],
    revision: 1,
  },
  instanceAccess: null as PilotPublicState['instanceAccess'],
  attempt: null as PilotPublicState['attempt'],
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
  ensureDesktopInstance: mock(async () => undefined),
  createOrAttachInstance: mock(async () => undefined),
  refreshAccessRequests: mock(async () => undefined),
  resolveAccess: mock(async () => undefined),
  logout: mock(async () => true),
  clearError: mock(() => undefined),
};

const usePilotStoreMock = Object.assign(() => pilotState, { getState: () => pilotState });

mock.module('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: testLanguage },
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
const openExternalUrlMock = mock(async (_url: string) => undefined);
mock.module('../../../services/externalUrlOpener', () => ({ openExternalUrl: openExternalUrlMock }));
mock.module('../../../composition/macroPilotDesktop', () => ({
  macroPilotRuntime: {
    getStatus: () => runtimeStatus,
    subscribe: (listener: () => void) => { runtimeListener = listener; return () => { runtimeListener = undefined; }; },
    retry: async () => undefined,
    getIndeterminate: () => indeterminate,
    reconcileNotExecuted: reconcileNotExecutedMock,
  },
}));
mock.module('../../ui/toastService', () => ({
  notify: { success: notifySuccessMock, error: mock(() => undefined), warning: notifyWarningMock },
}));

const { PilotView } = await import('./PilotView');
const { Dialog } = await import('../../ui/Dialog');

describe('PilotView', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    initializeMock.mockReset(); initializeMock.mockImplementation(async () => undefined);
    pilotState.busy = false; pilotState.reading = false;
    pilotState.status = 'connected'; pilotState.vaultStatus = 'ready'; pilotState.lastError = null;
    pilotState.sessionVerification = null; pilotState.sessionEndReason = null;
    pilotState.instance.connection_state = 'reachable';
    pilotState.instance.last_seen_at = undefined;
    pilotState.accessRequestsLoaded = true;
    pilotState.refreshAccessRequests.mockReset();
    pilotState.refreshAccessRequests.mockImplementation(async () => undefined);
    pilotState.relayOrigin = 'https://macro.andrologic.ai';
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
    pilotState.connect.mockClear(); pilotState.attempt = null; openExternalUrlMock.mockClear();
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

  it('shows the code without opening GitHub and copies it before opening the browser', async () => {
    const attempt = { attemptKey: 'key', attemptId: 'attempt', userCode: 'TEST-CODE', verificationUri: 'https://github.com/login/device', expiresAt: '2099-01-01T00:00:00Z', interval: 5 };
    pilotState.connect.mockImplementationOnce(async () => { pilotState.attempt = attempt; });
    const signIn = [...container.querySelectorAll('button')].find(button => button.textContent === 'Connect with GitHub')!;
    await act(async () => { signIn.click(); await Promise.resolve(); root.render(<PilotView />); });
    expect(openExternalUrlMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain('TEST-CODE');
    const previous = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const writeText = mock(async (_code: string) => { expect(openExternalUrlMock).not.toHaveBeenCalled(); });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    try {
      const copy = [...container.querySelectorAll('button')].find(button => button.textContent === 'Copy code and open GitHub')!;
      await act(async () => { copy.click(); await Promise.resolve(); });
      expect(writeText).toHaveBeenCalledWith('TEST-CODE');
      expect(openExternalUrlMock).toHaveBeenCalledWith(attempt.verificationUri);
      expect(container.textContent).not.toContain('Confirm this account');
    } finally {
      if (previous) Object.defineProperty(navigator, 'clipboard', previous);
      else Reflect.deleteProperty(navigator, 'clipboard');
    }
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
  it('shows unavailable remote access with one retry when troubleshooting is closed or open', async () => {
    await showAccount();
    runtimeStatus = 'unavailable';
    indeterminate = [];
    await act(async () => { runtimeListener?.(); await Promise.resolve(); });
    const explanation = 'This computer is currently unavailable in Macro Pilot. Retry the connection. Your local projects and conversations remain available.';
    const retries = () => [...container.querySelectorAll('button')].filter(item => item.textContent === 'Retry');
    const details = [...container.querySelectorAll('details')].find(item => item.textContent?.includes('Resolve a connection problem'))!;
    expect(details.open).toBe(false);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(explanation);
    expect(retries()).toHaveLength(1);
    expect(details.contains(retries()[0])).toBe(false);
    await act(async () => { details.open = true; });
    expect(retries()).toHaveLength(1);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(explanation);
    expect(container.textContent).not.toContain('Its journal');
    expect(container.textContent).not.toContain('Local commands are not replayed.');
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
    pilotState.instanceAccess = { contract_version: '1.0', type: 'instance_access',
      ref: { type: 'instance_access', account_id: 'account:one', session_id: 'session:one', instance_id: 'instance:studio' },
      state: 'granted', permissions: ['supervise', 'respond', 'approve_tools', 'review'],
      granted_at: '2026-09-01T00:00:00Z', revision: 1 };
    await act(async () => root.render(<PilotView />));
  };
  const button = (label: string) => [...document.body.querySelectorAll('button')].find(item => item.textContent === label)!;

  it('places this computer in a separate first block even when its session is last', async () => {
    await showAccount();
    const current = pilotState.accountCatalog!.sessions[0];
    pilotState.accountCatalog!.sessions = [{ ...current, session_id: 'session:phone', device_id: 'device:phone', client_kind: 'mobile', label: 'Test phone' }, current];
    pilotState.instance.connection_state = 'unreachable';
    await act(async () => root.render(<PilotView />));
    const devices = container.querySelector('section[aria-label="Devices"]')!;
    const local = devices.querySelector('[aria-label="This computer"]')!;
    expect(local.textContent).toContain('Studio Mac');
    expect(local.textContent).toContain('Online');
    expect(local.textContent).not.toContain('Test phone');
    expect(devices.textContent!.indexOf('Studio Mac')).toBeLessThan(devices.textContent!.indexOf('Test phone'));
    expect(devices.textContent).toContain('Other devices');
    expect(devices.textContent!.match(/Studio Mac/g)).toHaveLength(1);
  });

  it('shows last activity separately from presence and keeps it when this computer goes offline', async () => {
    await showAccount();
    const current = pilotState.accountCatalog!.sessions[0];
    const activity = '2026-09-08T10:00:30.000Z';
    current.last_seen_at = activity;
    pilotState.accountCatalog!.sessions.push({ ...current, session_id: 'session:phone',
      device_id: 'device:phone', client_kind: 'mobile', label: 'Test phone' });
    await act(async () => root.render(<PilotView />));
    const devices = container.querySelector('section[aria-label="Devices"]')!;
    const local = devices.querySelector('[aria-label="This computer"]')!;
    const expected = `Last activity ${new Date(activity).toLocaleString(testLanguage)}`;
    expect(local.textContent).toContain('Online');
    expect(local.textContent).toContain(expected);
    expect(devices.textContent!.split(expected)).toHaveLength(3);
    expect(devices.textContent).toContain('It does not indicate whether a device is online.');
    expect(devices.querySelectorAll('[role="status"]')).toHaveLength(1);
    pilotState.status = 'offline';
    runtimeStatus = 'inactive';
    await act(async () => root.render(<PilotView />));
    expect(local.textContent).toContain('Offline');
    expect(local.textContent).toContain(expected);
  });

  it('uses instance activity only for this computer and keeps its date independent of reachability', async () => {
    await showAccount();
    const current = pilotState.accountCatalog!.sessions[0];
    const activity = '2026-09-08T10:00:30.000Z';
    pilotState.instance.last_seen_at = activity;
    pilotState.accountCatalog!.sessions.push({ ...current, session_id: 'session:phone',
      device_id: 'device:phone', client_kind: 'mobile', label: 'Test phone' });
    await act(async () => root.render(<PilotView />));
    const devices = container.querySelector('section[aria-label="Devices"]')!;
    const local = devices.querySelector('[aria-label="This computer"]')!;
    const expected = `Last activity ${new Date(activity).toLocaleString(testLanguage)}`;
    expect(local.textContent).toContain(expected);
    expect(local.textContent).toContain('Online');
    expect(devices.textContent!.split(expected)).toHaveLength(2);
    expect(devices.textContent!.match(/Last activity unknown/g)).toHaveLength(1);
    pilotState.instance.connection_state = 'unreachable';
    pilotState.status = 'offline';
    runtimeStatus = 'inactive';
    await act(async () => root.render(<PilotView />));
    expect(local.textContent).toContain('Offline');
    expect(local.textContent).toContain(expected);
    // The persisted date also remains available while the account catalog is absent.
    pilotState.accountCatalog = null;
    await act(async () => root.render(<PilotView />));
    expect(local.textContent).toContain('Offline');
    expect(local.textContent).toContain(expected);
    pilotState.instance.connection_state = 'reachable';
    await act(async () => root.render(<PilotView />));
    expect(local.textContent).toContain('Offline');
    expect(local.textContent).toContain(expected);
  });

  it('prefers observed session activity to instance activity even when the instance date is newer', async () => {
    await showAccount();
    const sessionActivity = '2026-09-08T10:00:30.000Z';
    const instanceActivity = '2026-09-09T10:00:30.000Z';
    pilotState.accountCatalog!.sessions[0].last_seen_at = sessionActivity;
    pilotState.instance.last_seen_at = instanceActivity;
    await act(async () => root.render(<PilotView />));
    const local = container.querySelector('[aria-label="This computer"]')!;
    expect(local.textContent).toContain(`Last activity ${new Date(sessionActivity).toLocaleString(testLanguage)}`);
    expect(local.textContent).not.toContain(new Date(instanceActivity).toLocaleString(testLanguage));
  });

  it('shows unknown activity for unobserved devices without substituting created_at', async () => {
    await showAccount();
    const current = pilotState.accountCatalog!.sessions[0];
    pilotState.accountCatalog!.sessions.push({ ...current, session_id: 'session:phone',
      device_id: 'device:phone', client_kind: 'mobile', label: 'Test phone' });
    await act(async () => root.render(<PilotView />));
    const devices = container.querySelector('section[aria-label="Devices"]')!;
    expect(devices.textContent!.match(/Last activity unknown/g)).toHaveLength(2);
    expect(devices.textContent).not.toContain(new Date(current.created_at).toLocaleString(testLanguage));
    // A catalog still loading must also keep activity unknown for this computer.
    pilotState.accountCatalog = null;
    await act(async () => root.render(<PilotView />));
    expect(devices.querySelector('[aria-label="This computer"]')?.textContent).toContain('Last activity unknown');
  });

  it('uses the product relay without exposing a relay address field or an early offline error', async () => {
    pilotState.status = 'unconfigured';
    pilotState.relayOrigin = null;
    pilotState.lastError = 'offline';
    await act(async () => root.render(<PilotView />));

    expect(container.textContent).not.toContain('Relay HTTPS origin');
    expect(container.textContent).not.toContain('Device label');
    expect(container.textContent).not.toContain('Create instance');
    expect(container.querySelector('input[placeholder^="https://"]')).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent ?? null).toBeNull();
    await act(async () => button('Connect with GitHub').click());
    expect(pilotState.connect).toHaveBeenCalledWith('https://macro.andrologic.ai');
  });

  it('shows the connected computer without name fields or pairing setup', async () => {
    pilotState.instanceAccess = {
      contract_version: '1.0', type: 'instance_access',
      ref: { type: 'instance_access', account_id: 'account:one', session_id: 'session:one', instance_id: 'instance:studio' },
      state: 'granted', permissions: ['supervise', 'respond', 'approve_tools', 'review'],
      granted_at: '2026-09-01T00:00:00Z', revision: 1,
    };
    await showAccount();
    expect(container.textContent).toContain('Studio Mac');
    expect(container.textContent).toContain('connected automatically');
    expect(button('Create instance')).toBeUndefined();
    expect(button('Reattach')).toBeUndefined();
    expect(container.querySelector('input')).toBeNull();
    const recovery = [...container.querySelectorAll('details')].find(item => item.textContent?.includes('Resolve a connection problem'));
    expect(recovery?.open).toBe(false);
    expect(container.textContent).toContain('Account session');
    expect(container.textContent).toContain('Saved credentials');
    expect(container.textContent).not.toContain('No pending access requests');
    expect(container.textContent).not.toContain('Refresh to load pending access requests');
  });

  it.each(['inactive', 'unavailable'] as const)('keeps the account connected but never marks an %s runtime online', async status => {
    runtimeStatus = status;
    pilotState.instanceAccess = { contract_version: '1.0', type: 'instance_access', ref: { type: 'instance_access', account_id: 'account:one', session_id: 'session:one', instance_id: 'instance:studio' }, state: 'granted', permissions: ['supervise', 'respond', 'approve_tools', 'review'], granted_at: '2026-09-01T00:00:00Z', revision: 1 };
    await showAccount();
    await act(async () => { runtimeListener?.(); await Promise.resolve(); });
    expect(container.textContent).not.toContain('Online');
    expect(container.textContent).toContain(status === 'inactive' ? 'Connecting…' : 'Unavailable');
    expect(container.textContent).toContain('@example');
  });

  it('updates availability as the runtime changes', async () => {
    pilotState.instanceAccess = {
      contract_version: '1.0', type: 'instance_access',
      ref: { type: 'instance_access', account_id: 'account:one', session_id: 'session:one', instance_id: 'instance:studio' },
      state: 'granted', permissions: ['supervise', 'respond', 'approve_tools', 'review'],
      granted_at: '2026-09-01T00:00:00Z', revision: 1,
    };
    await showAccount();
    expect(container.textContent).toContain('Online');
    runtimeStatus = 'unavailable';
    await act(async () => { runtimeListener?.(); await Promise.resolve(); });
    expect(container.textContent).not.toContain('Online');
    expect(container.textContent).toContain('Unavailable');
    runtimeStatus = 'running';
    await act(async () => { runtimeListener?.(); await Promise.resolve(); });
    expect(container.textContent).toContain('Online');
    pilotState.status = 'offline';
    await act(async () => root.render(<PilotView />));
    expect(container.textContent).not.toContain('Online');
    expect(container.textContent).toContain('Offline');
  });

  it('offers local recovery without GitHub sign-in when saved credentials are inaccessible', async () => {
    await showVaultStatus('intervention_required');
    expect(button('Restore connection')).toBeDefined();
    expect(button('Connect with GitHub')).toBeUndefined();
    expect(pilotState.connect).not.toHaveBeenCalled();
  });

  it('offers sign out before reconnecting when an expired account session is still retained', async () => {
    await showAccount();
    pilotState.lastError = 'unauthorized';
    await act(async () => root.render(<PilotView />));
    expect(button('Connect with GitHub')).toBeUndefined();
    expect(button('Sign out before reconnecting')).toBeDefined();
    expect(pilotState.connect).not.toHaveBeenCalled();
    await act(async () => button('Sign out before reconnecting').click());
    expect(pilotState.logout).toHaveBeenCalledTimes(1);
  });

  it('shows the saved computer availability when the account catalog cannot load', async () => {
    await showAccount();
    pilotState.accountCatalog = null;
    await showVaultStatus('cancelled');
    expect(container.textContent).toContain('Studio Mac');
    expect(container.textContent).toContain('This computer');
    expect(container.textContent).toContain('Permission cancelled');
    expect(container.textContent).not.toContain('Online');
  });

  it('shows a fresh session check in progress while saved credentials are ready', async () => {
    await showAccount();
    pilotState.status = 'vault_unavailable'; pilotState.vaultStatus = 'ready'; pilotState.lastError = null; pilotState.sessionVerification = 'pending';
    runtimeStatus = 'inactive';
    await act(async () => { root.render(<PilotView />); runtimeListener?.(); await Promise.resolve(); });
    expect(container.textContent).toContain('Checking your Macro Connect session before reconnecting this computer.');
    expect(container.textContent).toContain('Connecting…');
    expect(container.textContent).not.toContain('Offline');
    expect(container.textContent).not.toContain('Online');
    expect(button('Restore connection')).toBeUndefined();
    expect(button('Connect with GitHub')).toBeUndefined();
    expect(resumeVaultAccessMock).not.toHaveBeenCalled();
  });

  it('retries a failed fresh session check through initialize without requesting credential permission', async () => {
    await showAccount();
    pilotState.status = 'vault_unavailable'; pilotState.vaultStatus = 'ready'; pilotState.lastError = 'offline'; pilotState.sessionVerification = 'failed';
    runtimeStatus = 'inactive';
    await act(async () => { root.render(<PilotView />); runtimeListener?.(); await Promise.resolve(); });
    initializeMock.mockClear();
    expect(container.textContent).toContain('Your saved credentials are available, but Macro Connect could not check your session.');
    expect(button('Retry connection')).toBeDefined();
    expect(button('Restore connection')).toBeUndefined();
    expect(button('Connect with GitHub')).toBeUndefined();
    let finish!: () => void;
    initializeMock.mockImplementationOnce(async () => {
      pilotState.busy = true; pilotState.reading = true; pilotState.lastError = null; pilotState.sessionVerification = 'pending';
      await new Promise<void>(resolve => { finish = resolve; });
      pilotState.busy = false; pilotState.reading = false; pilotState.status = 'connected'; pilotState.sessionVerification = null;
    });
    await act(async () => { button('Retry connection').click(); await Promise.resolve(); root.render(<PilotView />); });
    expect(initializeMock).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Checking your Macro Connect session before reconnecting this computer.');
    expect(container.textContent).toContain('Connecting…');
    expect(container.textContent).not.toContain('Offline');
    expect(container.textContent).not.toContain('Online');
    expect(button('Retry connection')).toBeUndefined();
    expect(resumeVaultAccessMock).not.toHaveBeenCalled();
    await act(async () => { finish(); await Promise.resolve(); root.render(<PilotView />); });
    runtimeStatus = 'running';
    await act(async () => { runtimeListener?.(); await Promise.resolve(); });
    expect(container.textContent).toContain('Online');
    expect(container.textContent).not.toContain('Checking your Macro Connect session');
    expect(resumeVaultAccessMock).not.toHaveBeenCalled();
  });

  it('keeps session retry after secondary reads clear the shared error', async () => {
    await showAccount();
    pilotState.status = 'vault_unavailable'; pilotState.vaultStatus = 'ready'; pilotState.lastError = 'offline'; pilotState.sessionVerification = 'failed';
    await act(async () => root.render(<PilotView />));
    initializeMock.mockClear();
    const refresh = container.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')!;
    pilotState.refreshAccount.mockImplementationOnce(async () => {
      pilotState.busy = true; pilotState.reading = true; pilotState.lastError = null;
    });
    await act(async () => { refresh.click(); root.render(<PilotView />); });
    expect(button('Retry connection')).toBeDefined();
    expect(button('Retry connection').disabled).toBe(true);
    expect(container.textContent).not.toContain('Checking your Macro Connect session');
    pilotState.busy = false; pilotState.reading = false;
    await act(async () => root.render(<PilotView />));
    expect(button('Retry connection').disabled).toBe(false);
    expect(container.textContent).toContain('Your saved credentials are available');
    expect(initializeMock).not.toHaveBeenCalled();
    expect(resumeVaultAccessMock).not.toHaveBeenCalled();
  });

  it.each(['unauthorized', 'session_revoked'] as const)('explains %s after session references and the shared error are cleared', async reason => {
    pilotState.status = 'signed_out'; pilotState.sessionEndReason = reason; pilotState.lastError = null;
    await act(async () => root.render(<PilotView />));
    expect(container.textContent).toContain(reason === 'unauthorized' ? 'Your Macro Connect session has expired.' : 'Access for this device was revoked.');
    expect(button('Connect with GitHub')).toBeDefined();
    expect(button('Restore connection')).toBeUndefined();
  });

  it('loads legacy requests only after opening troubleshooting and hides an empty result', async () => {
    pilotState.accessRequestsLoaded = false;
    await showAccount();
    expect(pilotState.refreshAccessRequests).not.toHaveBeenCalled();
    const details = [...container.querySelectorAll('details')].find(item => item.textContent?.includes('Resolve a connection problem'))!;
    await act(async () => { details.open = true; });
    expect(pilotState.refreshAccessRequests).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain('Access requests from older devices');
    expect(container.textContent).not.toContain('No pending access requests');
  });

  it('loads legacy requests after an account read finishes while troubleshooting stays open', async () => {
    pilotState.accessRequestsLoaded = false;
    pilotState.busy = true; pilotState.reading = true;
    await showAccount();
    const details = [...container.querySelectorAll('details')].find(item => item.textContent?.includes('Resolve a connection problem'))!;
    await act(async () => { details.open = true; });
    expect(pilotState.refreshAccessRequests).not.toHaveBeenCalled();
    pilotState.busy = false; pilotState.reading = false;
    await act(async () => root.render(<PilotView />));
    expect(details.open).toBe(true);
    expect(pilotState.refreshAccessRequests).toHaveBeenCalledTimes(1);
    await act(async () => root.render(<PilotView />));
    expect(pilotState.refreshAccessRequests).toHaveBeenCalledTimes(1);
  });

  it('loads requests for a new session and instance while troubleshooting stays open', async () => {
    await showAccount();
    const details = [...container.querySelectorAll('details')].find(item => item.textContent?.includes('Resolve a connection problem'))!;
    await act(async () => { details.open = true; });
    expect(pilotState.refreshAccessRequests).not.toHaveBeenCalled();
    pilotState.deviceSession = { ...pilotState.deviceSession!, ref: { ...pilotState.deviceSession!.ref, session_id: 'session:new' } };
    pilotState.accessRequestsLoaded = false;
    pilotState.busy = true;
    await act(async () => root.render(<PilotView />));
    expect(pilotState.refreshAccessRequests).not.toHaveBeenCalled();
    pilotState.busy = false;
    await act(async () => root.render(<PilotView />));
    expect(details.open).toBe(true);
    expect(pilotState.refreshAccessRequests).toHaveBeenCalledTimes(1);
    const previousInstance = pilotState.instance;
    try {
      pilotState.instance = { ...previousInstance, ref: { ...previousInstance.ref, instance_id: 'instance:new' } };
      await act(async () => root.render(<PilotView />));
      expect(details.open).toBe(true);
      expect(pilotState.refreshAccessRequests).toHaveBeenCalledTimes(2);
    } finally { pilotState.instance = previousInstance; }
  });

  it('ignores a late loading failure from an obsolete context', async () => {
    await showAccount();
    pilotState.accessRequestsLoaded = false;
    let rejectPrevious!: (error: Error) => void;
    pilotState.refreshAccessRequests.mockImplementationOnce(() => new Promise<undefined>((_resolve, reject) => { rejectPrevious = reject; }));
    const details = [...container.querySelectorAll('details')].find(item => item.textContent?.includes('Resolve a connection problem'))!;
    await act(async () => { details.open = true; });
    expect(pilotState.refreshAccessRequests).toHaveBeenCalledTimes(1);
    pilotState.deviceSession = { ...pilotState.deviceSession!, ref: { ...pilotState.deviceSession!.ref, session_id: 'session:replacement' } };
    pilotState.refreshAccessRequests.mockImplementationOnce(async () => { pilotState.accessRequestsLoaded = true; });
    await act(async () => root.render(<PilotView />));
    expect(pilotState.refreshAccessRequests).toHaveBeenCalledTimes(2);
    await act(async () => { rejectPrevious(new Error('context_changed')); await Promise.resolve(); });
    expect(details.textContent).not.toContain('Access requests from older devices could not be loaded.');
    expect(details.querySelector('button')).toBeNull();
  });

  it('offers one explicit retry after loading fails without retrying on renders or reopening', async () => {
    await showAccount();
    pilotState.accessRequestsLoaded = false;
    pilotState.refreshAccessRequests.mockImplementationOnce(async () => { throw new Error('offline'); });
    const details = [...container.querySelectorAll('details')].find(item => item.textContent?.includes('Resolve a connection problem'))!;
    await act(async () => { details.open = true; });
    expect(pilotState.refreshAccessRequests).toHaveBeenCalledTimes(1);
    expect(details.textContent).toContain('Access requests from older devices could not be loaded.');
    expect([...details.querySelectorAll('button')].filter(item => item.textContent === 'Retry')).toHaveLength(1);
    await act(async () => root.render(<PilotView />));
    await act(async () => { details.open = false; });
    await act(async () => { details.open = true; });
    expect(pilotState.refreshAccessRequests).toHaveBeenCalledTimes(1);
    pilotState.refreshAccessRequests.mockImplementationOnce(async () => { pilotState.accessRequestsLoaded = true; });
    await act(async () => button('Retry').click());
    expect(pilotState.refreshAccessRequests).toHaveBeenCalledTimes(2);
    expect(details.textContent).not.toContain('Access requests from older devices could not be loaded.');
    expect(details.querySelector('button')).toBeNull();
  });

  it('identifies a persisted session on a previous relay without moving it automatically', async () => {
    pilotState.relayOrigin = 'https://pilot.example.com';
    await showAccount();

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('https://pilot.example.com');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Sign out, then connect with GitHub again');
    expect(container.querySelector('input[placeholder^="https://"]')).toBeNull();
    expect(button('Sign out')).toBeDefined();
    expect(pilotState.connect).not.toHaveBeenCalled();
    expect(pilotState.logout).not.toHaveBeenCalled();

    pilotState.relayOrigin = 'https://macro.andrologic.ai';
    await act(async () => root.render(<PilotView />));
    expect(container.textContent).not.toContain('previously configured relay');
  });

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
      const recovery = container.querySelector(status === 'suspended' ? '[aria-live="polite"]' : '[role="alert"]');
      expect(recovery?.textContent).toContain('Macro Connect connection paused');
      const explanations: Record<Exclude<PilotVaultStatus, 'ready'>, string> = {
        intervention_required: 'Macro needs your permission to read the saved credentials.',
        cancelled: 'Permission was cancelled.',
        suspended: 'If it does not resume after you unlock your session, restore it here.',
        vault_unavailable: 'Saved credentials are inaccessible.',
      };
      expect(recovery?.textContent).toContain(explanations[status]);
      expect([...container.querySelectorAll('button')].filter(item => item.textContent === 'Restore connection')).toHaveLength(1);
      expect(resumeVaultAccessMock).not.toHaveBeenCalled();
      await act(async () => {
        button('Restore connection').click();
        await Promise.resolve();
      });
      expect(resumeVaultAccessMock).toHaveBeenCalledTimes(1);
    },
  );

  it('does not resume on mount, refresh, or reopening settings', async () => {
    await showAccount();
    await showVaultStatus('cancelled');
    expect(resumeVaultAccessMock).not.toHaveBeenCalled();
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')!.click());
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
      button('Restore connection').click();
      await Promise.resolve();
    });
    await act(async () => root.render(<PilotView />));
    expect(container.textContent).toContain('Permission was cancelled. Restore the connection when you are ready.');
    expect(button('Restore connection')).toBeDefined();

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
      button('Restore connection').click();
      await Promise.resolve();
    });
    await act(async () => root.render(<PilotView />));
    expect(container.textContent).toContain('@example');
    expect(container.querySelector('[role="alert"]')?.textContent ?? null).toBeNull();
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
      button('Restore connection').click();
      button('Restore connection').click();
      await Promise.resolve();
    });
    await act(async () => root.render(<PilotView />));
    expect(resumeVaultAccessMock).toHaveBeenCalledTimes(1);
    expect(pilotState.busy).toBe(true);
    expect(pilotState.reading).toBe(true);
    expect(container.textContent).toContain('Waiting for permission to read the saved credentials.');
    expect(button('Restoring connection…').disabled).toBe(true);
    expect(button('Sign out').disabled).toBe(false);
    await act(async () => button('Restoring connection…').click());
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
      pilotState.relayOrigin = 'https://pilot.example.com';
      await showAccount();
      expect(container.textContent).toContain('@example');
      expect(container.textContent).toContain('Example desktop');
      expect(container.querySelector('section[aria-label="Devices"]')?.textContent).toContain('Example desktop');
      await act(async () => button('Manage account').click());
      expect(button('Disconnect all devices')).toBeDefined();
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
    await act(async () => button('Manage account').click());
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
    expect(container.textContent).toContain('Access to this computer needs to be restored.');
    await act(async () => button('Allow access').click());
    expect(pilotState.resolveAccess).toHaveBeenCalledWith('request:phone', 'grant');
  });

  it('hides revoked and expired sessions and counts only active devices', async () => {
    await showAccount();
    const active = pilotState.accountCatalog!.sessions[0];
    pilotState.accountCatalog!.sessions.push(
      { ...active, session_id: 'session:revoked', label: 'Revoked phone', state: 'revoked', last_seen_at: '2026-09-09T10:00:00.000Z' },
      { ...active, session_id: 'session:expired', label: 'Expired phone', state: 'expired', last_seen_at: '2026-09-09T10:00:00.000Z' },
    );
    await act(async () => root.render(<PilotView />));
    expect(container.textContent).not.toContain('Revoked phone');
    expect(container.textContent).not.toContain('Expired phone');
    expect(container.textContent).not.toContain(new Date('2026-09-09T10:00:00.000Z').toLocaleString(testLanguage));
    expect([...container.querySelectorAll('button')].filter(item => item.textContent === 'Disconnect this device')).toHaveLength(1);
    expect(container.querySelector('section[aria-label="Devices"] h4')?.textContent).toEndWith('1');
  });

  it('routes individual and global revocation and explains an unconfirmed self response', async () => {
    await showAccount();
    await act(async () => button('Disconnect this device').click());
    expect(pilotState.revokeSession).toHaveBeenCalledWith('session:one');
    pilotState.revokeAllSessions.mockImplementationOnce(async () => false);
    await act(async () => button('Manage account').click());
    await act(async () => button('Disconnect all devices').click());
    expect(pilotState.revokeAllSessions).not.toHaveBeenCalled();
    await act(async () => button('Disconnect all devices').click());
    expect(pilotState.revokeAllSessions).toHaveBeenCalledTimes(1);
    expect(notifyWarningMock).toHaveBeenCalledWith('Signed out locally. Server revocation could not be confirmed. Sign in again to check your account.');
  });

  it('hides empty diagnostics and requires opening the account menu for secondary actions', async () => {
    indeterminate = [];
    await showAccount();
    expect(container.textContent).not.toContain('Commands requiring reconciliation');
    expect(container.textContent).not.toContain('No command requires');
    expect(container.querySelector('section[aria-label="Devices"]')).not.toBeNull();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    const trigger = container.querySelector<HTMLElement>('summary[aria-label="Account options"]')!;
    await act(async () => trigger.click());
    expect(trigger.closest('details')!.open).toBe(true);
    await act(async () => trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(trigger.closest('details')!.open).toBe(false);
  });

  it('keeps the global disconnect confirmation open when the request fails', async () => {
    await showAccount();
    pilotState.revokeAllSessions.mockImplementationOnce(async () => { throw new Error('offline'); });
    await act(async () => button('Manage account').click());
    await act(async () => button('Disconnect all devices').click());
    await act(async () => button('Disconnect all devices').click());
    expect(pilotState.revokeAllSessions).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain('Every device, including this computer');
    expect(notifySuccessMock).not.toHaveBeenCalled();
  });

  it('keeps the menu open when WebKit moves focus to the settings panel before the click', async () => {
    await showAccount();
    const trigger = container.querySelector<HTMLElement>('summary[aria-label="Account options"]')!;
    await act(async () => trigger.click());
    await act(async () => trigger.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: container })));
    expect(trigger.closest('details')!.open).toBe(true);
    await act(async () => button('Manage account').click());
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain('Manage account');
    expect(trigger.closest('details')!.open).toBe(false);
  });

  it('closes the actions menu with Escape without closing settings', async () => {
    await showAccount();
    const close = mock(() => undefined);
    await act(async () => root.render(<Dialog title="Settings" onClose={close}><PilotView /></Dialog>));
    const trigger = document.querySelector<HTMLElement>('summary[aria-label="Account options"]')!;
    await act(async () => trigger.click());
    expect(trigger.closest('details')!.open).toBe(true);
    await act(async () => trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(trigger.closest('details')!.open).toBe(false);
    expect(close).not.toHaveBeenCalled();
    expect(document.activeElement === trigger).toBe(true);
    await act(async () => trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('prevents disconnecting all devices after the identity changes', async () => {
    await showAccount();
    await act(async () => button('Manage account').click());
    await act(async () => button('Disconnect all devices').click());
    pilotState.accountCatalog = { ...pilotState.accountCatalog!, identity: { ...pilotState.accountCatalog!.identity, session_id: 'session:new' } };
    await act(async () => root.render(<PilotView />));
    expect(button('Disconnect all devices')).toBeUndefined();
    expect(pilotState.revokeAllSessions).not.toHaveBeenCalled();
  });

  it('keeps sign out available during reads but disables it during mutations', async () => {
    await showAccount();
    pilotState.busy = true; pilotState.reading = true;
    await act(async () => root.render(<PilotView />));
    expect(button('Sign out').disabled).toBe(false);
    expect(button('Manage account').disabled).toBe(true);
    pilotState.reading = false;
    await act(async () => root.render(<PilotView />));
    expect(button('Sign out').disabled).toBe(true);
  });

});
