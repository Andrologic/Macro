import { afterEach, describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { PilotPublicState } from '../../services/macroPilot/nativeClient';

let state = { status: 'vault_unavailable', vaultStatus: 'intervention_required', configurationId: 'config:one', relayOrigin: 'https://relay.example.com', account: null, deviceSession: null, instance: null, instanceAccess: null, attempt: null, lastError: null, logoutRevocationConfirmed: null } as PilotPublicState;
let listener: (() => void) | undefined;
const openSettings = mock(() => undefined);
const actionRequired = mock((_title: string, _options: { actions: { onClick: () => void }[]; notificationKey: string }) => undefined);
const dismiss = mock(() => undefined);
mock.module('../../stores/usePilotStore', () => ({ usePilotStore: { getState: () => state, subscribe: (fn: () => void) => { listener = fn; return () => { listener = undefined; }; } } }));
mock.module('../../stores/useAppStore', () => ({ useAppStore: { getState: () => ({ openSettings }) } }));
mock.module('../ui/toastService', () => ({ notify: { actionRequired, dismiss } }));
mock.module('react-i18next', () => ({ useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }) }));
const { ConnectAttentionNotifications } = await import('./ConnectAttentionNotifications');
let unmount = async () => {};
afterEach(async () => { await unmount(); });

describe('ConnectAttentionNotifications', () => {
  it('opens Macro Connect from one notification, ignores stale actions and cleans the subscription', async () => {
    const element = document.createElement('div'); const root = createRoot(element);
    unmount = async () => { await act(async () => root.unmount()); element.remove(); };
    await act(async () => root.render(<ConnectAttentionNotifications />));
    expect(actionRequired).toHaveBeenCalledTimes(1);
    const options = actionRequired.mock.calls[0][1];
    expect(options.notificationKey).toBe('macro-connect-intervention');
    expect(options.actions).toHaveLength(1);
    options.actions[0].onClick(); expect(openSettings).toHaveBeenCalledWith('pilot');
    listener?.(); expect(actionRequired).toHaveBeenCalledTimes(1);
    state = { ...state, vaultStatus: 'ready', status: 'connected' }; listener?.();
    expect(dismiss).toHaveBeenCalledWith('macro-connect-intervention');
    openSettings.mockClear(); options.actions[0].onClick(); expect(openSettings).not.toHaveBeenCalled();
    await unmount(); expect(listener).toBeUndefined(); unmount = async () => {};
  });
});
