import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Monitor, Smartphone, RefreshCw } from 'lucide-react';
import { PilotActions } from './PilotActions';
import { useTranslation } from 'react-i18next';
import { openExternalUrl } from '../../../services/externalUrlOpener';
import type { PilotRuntimeStatus } from '../../../services/macroPilot/runtime';
import type { PilotAccountConfirmation, PilotPermission } from '../../../services/macroPilot/nativeClient';
import { usePilotStore } from '../../../stores/usePilotStore';
import { Button } from '../../ui/Button';
import { ConfirmPromptModal } from '../../ui/ConfirmPromptModal';
import { notify } from '../../ui/toastService';

const PERMISSIONS: PilotPermission[] = ['supervise', 'respond', 'approve_tools', 'review'];
const PILOT_RELAY_ORIGIN = 'https://macro.andrologic.ai';

interface IndeterminateCommand {
  key: string;
  commandId: string;
  target: Record<string, string>;
}

const errorFallbacks: Record<string, string> = {
  invalid_configuration: 'Check the device name and try again.',
  invalid_response: 'The relay returned an invalid response.',
  response_too_large: 'The relay response exceeded the 1 MB limit.',
  redirect_refused: 'The relay tried to redirect the request.',
  unauthorized: 'The connection has expired. Sign in again.',
  session_revoked: 'This device session was revoked.',
  forbidden: 'This account cannot perform that action.',
  not_found: 'The requested Pilot resource no longer exists.',
  conflict: 'The request conflicts with the current Pilot state.',
  stale_revision: 'The request changed before it could be applied.',
  unavailable: 'Pilot is temporarily unavailable.',
  vault_unavailable: 'The operating system credential vault is unavailable.',
  extension_unavailable: 'This relay does not support account management yet.',
  snapshot_expired: 'This list expired. Refresh it before continuing.',
  resource_limit: 'The relay cannot return this list within its resource limits.',
  context_changed: 'The connected account changed. Refresh and try again.',
  offline: 'The relay cannot be reached. Local Macro features remain available.',
};

const vaultErrorStatus: Record<string, 'intervention_required' | 'cancelled' | 'suspended' | 'vault_unavailable'> = {
  vault_intervention_required: 'intervention_required',
  vault_cancelled: 'cancelled',
  vault_suspended: 'suspended',
  vault_unavailable: 'vault_unavailable',
};

const vaultRecoveryFallbacks: Record<'intervention_required' | 'cancelled' | 'suspended' | 'vault_unavailable', string> = {
  intervention_required: 'Macro needs attention to access the system credential vault and restore Pilot data.',
  cancelled: 'Credential vault access was cancelled. You can try again when you are ready.',
  suspended: 'Access to Pilot credentials is suspended. Resume access to restore Pilot data.',
  vault_unavailable: 'Macro could not access the system credential vault. You can try to resume access.',
};

export const PilotView: React.FC = () => {
  const { t } = useTranslation();
  const store = usePilotStore();
  const initialize = store.initialize;
  const pollAuth = store.pollAuth;
  const authStatus = store.status;
  const authAttempt = store.attempt;
  const busy = store.busy;
  const { deviceSession, accountCatalog, lastError, refreshAccount } = store;
  const [deleteTarget, setDeleteTarget] = useState<{ identity: PilotAccountConfirmation; origin: string } | null>(null);
  const [manageAccountOpen, setManageAccountOpen] = useState(false);
  const [allTarget, setAllTarget] = useState<typeof deleteTarget>(null);
  const refreshedScope = useRef<string | null>(null);
  const [runtimeStatus, setRuntimeStatus] = useState<PilotRuntimeStatus>('inactive');
  const [indeterminateCommands, setIndeterminateCommands] = useState<IndeterminateCommand[]>([]);
  const [reconciliationTarget, setReconciliationTarget] = useState<IndeterminateCommand | null>(null);
  const [reconciliationBusy, setReconciliationBusy] = useState(false);
  const [vaultRecoveryBusy, setVaultRecoveryBusy] = useState(false);
  const vaultRecoveryLock = useRef(false);

  const refreshIndeterminate = useCallback(async () => {
    const { macroPilotRuntime } = await import('../../../composition/macroPilotDesktop');
    setRuntimeStatus(macroPilotRuntime.getStatus());
    setIndeterminateCommands(macroPilotRuntime.getIndeterminate());
  }, []);

  useEffect(() => {
    void initialize();
  }, [initialize]);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    void import('../../../composition/macroPilotDesktop').then(({ macroPilotRuntime }) => {
      if (cancelled) return;
      unsubscribe = macroPilotRuntime.subscribe(() => { void refreshIndeterminate(); });
      void refreshIndeterminate();
    });
    return () => { cancelled = true; unsubscribe?.(); };
  }, [refreshIndeterminate, store.instance?.ref.instance_id]);

  useEffect(() => {
    if (authStatus !== 'authorizing' || !authAttempt || busy) return;
    const timer = window.setTimeout(() => {
      void pollAuth().catch(() => undefined);
    }, authAttempt.interval * 1_000);
    return () => window.clearTimeout(timer);
  }, [authStatus, authAttempt, busy, pollAuth]);

  useEffect(() => {
    const scope = deviceSession ? `${store.relayOrigin}:${deviceSession.ref.session_id}` : null;
    if (!scope) { refreshedScope.current = null; return; }
    if (authStatus === 'connected' && !busy && !lastError && (refreshedScope.current !== scope || !accountCatalog)) {
      refreshedScope.current = scope;
      void refreshAccount().catch(() => undefined);
    }
  }, [deviceSession, store.relayOrigin, authStatus, busy, accountCatalog, lastError, refreshAccount]);

  const currentIdentity = store.accountCatalog?.identity;
  const activeSessions = store.accountCatalog?.sessions.filter(session => session.state === 'active') ?? [];
  const targetCurrent = (target: typeof deleteTarget) => Boolean(target && currentIdentity
    && target.origin === store.relayOrigin
    && target.identity.account_id === store.account?.account_id
    && target.identity.session_id === store.deviceSession?.ref.session_id
    && target.identity.account_id === currentIdentity.account_id
    && target.identity.session_id === currentIdentity.session_id
    && target.identity.subject === currentIdentity.subject
    && target.identity.login === currentIdentity.login);

  const deleteTargetCurrent = targetCurrent(deleteTarget);
  const allTargetCurrent = targetCurrent(allTarget);

  const statusLabel = useMemo(
    () => t(`settings.pilot.status.${store.status}`, store.status.replaceAll('_', ' ')),
    [store.status, t],
  );

  const run = async (work: () => Promise<void>, success?: string) => {
    try {
      await work();
      if (success) notify.success(success);
    } catch {
      // The store exposes a redacted error code below.
    }
  };

  const startConnection = () => run(async () => {
    await store.connect(PILOT_RELAY_ORIGIN);
    const verificationUri = usePilotStore.getState().attempt?.verificationUri;
    if (verificationUri) await openExternalUrl(verificationUri);
  });

  const confirmAccount = () => run(
    () => store.confirmAccount(),
    t('settings.pilot.connected', 'Pilot account connected.'),
  );

  const connectInstance = () => run(
    () => store.createOrAttachInstance(),
    t('settings.pilot.instanceConnected', 'This Macro instance is connected.'),
  );

  const logout = () => run(async () => {
    const confirmed = await store.logout();
    notify[confirmed ? 'success' : 'warning'](
      confirmed
        ? t('settings.pilot.logoutConfirmed', 'Signed out and revoked the server session.')
        : t('settings.pilot.logoutOffline', 'Signed out locally. Server revocation could not be confirmed. Sign in again to check your account.'),
    );
  });

  const resumeVaultAccess = async () => {
    if (vaultRecoveryLock.current) return;
    vaultRecoveryLock.current = true;
    setVaultRecoveryBusy(true);
    try {
      await store.resumeVaultAccess();
    } catch {
      // The store exposes a redacted vault status and error code below.
    } finally {
      vaultRecoveryLock.current = false;
      setVaultRecoveryBusy(false);
    }
  };

  const vaultRecoveryStatus = store.vaultStatus && store.vaultStatus !== 'ready'
    ? store.vaultStatus
    : vaultErrorStatus[store.lastError ?? ''];
  const vaultRecoveryActive = vaultRecoveryBusy;
  const legacyRelayOrigin = store.deviceSession && store.relayOrigin !== PILOT_RELAY_ORIGIN
    ? store.relayOrigin
    : null;

  const accountMutation = (work: () => Promise<boolean>) => run(async () => {
    const confirmed = await work();
    setDeleteTarget(null);
    setAllTarget(null);
    notify[confirmed ? 'success' : 'warning'](confirmed
      ? t('settings.pilot.accountUpdated', 'Account access updated.')
      : t('settings.pilot.logoutOffline', 'Signed out locally. Server revocation could not be confirmed. Sign in again to check your account.'));
  });

  const confirmReconciliation = async () => {
    if (!reconciliationTarget) return;
    setReconciliationBusy(true);
    try {
      const { macroPilotRuntime } = await import('../../../composition/macroPilotDesktop');
      await macroPilotRuntime.reconcileNotExecuted(reconciliationTarget.key);
      await refreshIndeterminate();
      setReconciliationTarget(null);
      notify.success(t('settings.pilot.reconciliationDone', 'The command was marked as not executed. A new explicit command is required.'));
    } catch {
      notify.error(t('settings.pilot.reconciliationFailed', 'The local reconciliation could not be saved.'));
    } finally {
      setReconciliationBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <section className="space-y-3 border-b border-border pb-5">
        <div className="flex items-center justify-between gap-3">
          <span className="min-w-0 truncate text-sm font-medium">{store.account && store.deviceSession ? `@${store.account.identity.login}` : t('settings.pilot.connection', 'Connection')}</span>
          <div className="flex shrink-0 items-center gap-2">
          <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
            {statusLabel}
          </span>
          {store.deviceSession && <PilotActions label={t('settings.pilot.accountMenu', 'Account options')}>
            <button type="button" disabled={store.busy && !store.reading} onClick={logout}>{t('settings.pilot.signOut', 'Sign out')}</button>
            <button type="button" disabled={!currentIdentity || store.busy} onClick={() => setManageAccountOpen(true)}>{t('settings.pilot.manageAccount', 'Manage account')}</button>
          </PilotActions>}
          </div>
        </div>

        {legacyRelayOrigin && (
          <p role="alert" className="break-words rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-muted-foreground">
            {t(
              'settings.pilot.legacyRelay',
              'This session still uses the previously configured relay: {{origin}}. Sign out, then connect with GitHub again to use the Macro relay.',
              { origin: legacyRelayOrigin },
            )}
          </p>
        )}

        {store.lastError && !vaultRecoveryStatus && (store.lastError !== 'offline' || Boolean(store.relayOrigin)) && (
          <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {t(`settings.pilot.errors.${store.lastError}`, errorFallbacks[store.lastError] || store.lastError)}
          </div>
        )}

        {store.status === 'vault_unavailable' && vaultRecoveryStatus && (
          <div
            role={vaultRecoveryActive ? 'status' : 'alert'}
            aria-live="polite"
            className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs space-y-2"
          >
            <p className="font-medium">{t('settings.pilot.vaultRecovery.title', 'Pilot data is paused')}</p>
            <p className="text-muted-foreground">
              {vaultRecoveryActive
                ? t('settings.pilot.vaultRecovery.waiting', 'Waiting for access to the system credential vault. You can keep using Macro or sign out.')
                : t(
                  `settings.pilot.vaultRecovery.${vaultRecoveryStatus}`,
                  vaultRecoveryFallbacks[vaultRecoveryStatus],
                )}
            </p>
            <Button
              size="sm"
              variant="secondary"
              disabled={vaultRecoveryBusy || store.busy}
              onClick={() => { void resumeVaultAccess(); }}
            >
              {vaultRecoveryActive
                ? t('settings.pilot.vaultRecovery.resuming', 'Resuming access…')
                : t('settings.pilot.vaultRecovery.resume', 'Resume vault access')}
            </Button>
          </div>
        )}

        {!store.deviceSession && !store.attempt && (
          <Button disabled={store.busy} onClick={startConnection}>
            {t('settings.pilot.signIn', 'Connect with GitHub')}
          </Button>
        )}

        {store.attempt && !store.attempt.identifiedAccount && (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              {t('settings.pilot.deviceCodeHelp', 'Enter this code only in the GitHub page opened by this Macro window.')}
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <code className="rounded-md border border-border bg-background px-3 py-2 text-lg tracking-[0.18em]">
                {store.attempt.userCode}
              </code>
              <Button variant="secondary" onClick={() => openExternalUrl(store.attempt!.verificationUri)}>
                {t('settings.pilot.openGitHub', 'Open GitHub')}
              </Button>
              <Button variant="ghost" disabled={store.busy} onClick={() => run(async () => { await store.pollAuth(); })}>
                {t('settings.pilot.check', 'Check now')}
              </Button>
            </div>
          </div>
        )}

        {store.attempt?.identifiedAccount && (
          <div className="space-y-3 rounded-md border border-primary/30 bg-primary/5 p-3">
            <div>
              <p className="text-sm font-medium">
                {store.attempt.identifiedAccount.identity.display_name || store.attempt.identifiedAccount.identity.login}
              </p>
              <p className="text-xs text-muted-foreground">@{store.attempt.identifiedAccount.identity.login}</p>
            </div>
            <p className="text-xs text-muted-foreground">
              {t('settings.pilot.confirmIdentity', 'Confirm that this is the GitHub account you intended to connect.')}
            </p>
            <Button disabled={store.busy} onClick={confirmAccount}>
              {t('settings.pilot.confirmAccount', 'Confirm this account')}
            </Button>
          </div>
        )}

      </section>

      {store.deviceSession && (
        <section aria-label={t('settings.pilot.devicesTitle', 'Devices')} className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <h4 className="text-sm font-medium">{t('settings.pilot.devicesTitle', 'Devices')} {accountCatalog && <span className="ml-1 text-xs text-muted-foreground">{activeSessions.length}</span>}</h4>
            <Button size="sm" variant="ghost" aria-label={t('common.refresh', 'Refresh')} title={t('common.refresh', 'Refresh')} disabled={store.busy} onClick={() => run(store.refreshAccount)}>
              <RefreshCw aria-hidden="true" className="h-3.5 w-3.5" />
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{t('settings.pilot.automaticDevices', 'Devices signed in to the same Macro Connect account are connected automatically.')}</p>
          <div className="divide-y divide-border">
            {activeSessions.map(session => {
              const current = session.session_id === store.deviceSession?.ref.session_id;
              const label = current && store.instance ? store.instance.label : session.label;
              const DeviceIcon = session.client_kind === 'mobile' ? Smartphone : Monitor;
              return <div key={session.session_id} className="flex items-center gap-3 py-3">
                <DeviceIcon aria-hidden="true" className="h-5 w-5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="break-words text-sm font-medium">{label}</p>
                  <p className="text-xs text-muted-foreground">{current ? t('settings.pilot.currentComputer', 'This computer') : t(`settings.pilot.clientKind.${session.client_kind}`, session.client_kind)}
                    {current && store.status === 'connected' && store.instance?.connection_state === 'reachable' && <> · {t('settings.pilot.online', 'Online')}</>}
                  </p>
                </div>
                <PilotActions label={t('settings.pilot.deviceMenu', 'Options for {{device}}', { device: label })}>
                  <p className="px-3 py-2 text-xs text-muted-foreground">{t('settings.pilot.expiresAt', 'Expires {{date}}', { date: new Date(session.expires_at).toLocaleString() })}</p>
                  <button type="button" disabled={store.busy} onClick={() => accountMutation(() => store.revokeSession(session.session_id))}>{t('settings.pilot.disconnectDevice', 'Disconnect this device')}</button>
                </PilotActions>
              </div>;
            })}
          </div>
          {!accountCatalog && <p role="status" className="text-xs text-muted-foreground">{store.busy ? t('common.loading', 'Loading…') : t('settings.pilot.accountNotLoaded', 'Account details have not been loaded. Refresh to try again.')}</p>}
          {!store.instance && <div role="status" className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
            <span>{t('settings.pilot.preparingDevice', 'Setting up this device…')}</span>
            {!store.busy && <Button size="sm" variant="ghost" onClick={() => run(store.ensureDesktopInstance)}>{t('common.retry', 'Retry')}</Button>}
          </div>}
          {store.instance && (store.instanceAccess?.state !== 'granted' || !PERMISSIONS.every(permission => store.instanceAccess?.permissions.includes(permission))) && <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-500/30 p-3 text-xs">
            <span>{t('settings.pilot.limitedAccess', 'Access to this computer needs to be restored.')}</span>
            <Button size="sm" variant="secondary" disabled={store.busy} onClick={connectInstance}>{t('settings.pilot.reattach', 'Restore access')}</Button>
          </div>}
        </section>
      )}

      {store.instance && store.deviceSession && (
        <details className="group text-xs">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground focus-visible:outline-primary">{t('settings.pilot.troubleshoot', 'Resolve a connection problem')}</summary>
          <div className="mt-3 space-y-3 border-l border-border pl-3">
            <div className="flex items-center justify-between gap-3">
              <span>{t('settings.pilot.accessTitle', 'Device access')}</span>
              <Button size="sm" variant="ghost" disabled={store.busy} onClick={() => run(store.refreshAccessRequests)}>{t('common.refresh', 'Refresh')}</Button>
            </div>
            {!store.accessRequestsLoaded ? <p className="text-muted-foreground">{t('settings.pilot.accessNotLoaded', 'Refresh to load pending access requests.')}</p>
              : store.accessRequests.length === 0 ? <p className="text-muted-foreground">{t('settings.pilot.noAccessRequests', 'No pending access requests.')}</p>
              : store.accessRequests.map(request => <div key={request.access_request_id} className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
                <span className="break-words">{request.device_label}</span>
                <div className="flex gap-2">
                  <Button size="sm" disabled={store.busy} onClick={() => run(() => store.resolveAccess(request.access_request_id, 'grant'))}>{t('settings.pilot.grant', 'Allow access')}</Button>
                  <Button size="sm" variant="ghost" disabled={store.busy} onClick={() => run(() => store.resolveAccess(request.access_request_id, 'deny'))}>{t('settings.pilot.deny', 'Deny')}</Button>
                </div>
              </div>)}
          </div>
        </details>
      )}

      {store.instance && runtimeStatus === 'unavailable' && (
        <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs space-y-2">
          <p>{t('settings.pilot.runtimeUnavailable', 'Desktop supervision is unavailable. Its journal could not be loaded or the relay could not be reached. Local commands are not replayed.')}</p>
          <Button size="sm" variant="secondary" onClick={() => void import('../../../composition/macroPilotDesktop').then(({ macroPilotRuntime }) => macroPilotRuntime.retry())}>
            {t('common.retry', 'Retry')}
          </Button>
        </div>
      )}

      {store.instance && runtimeStatus !== 'unavailable' && indeterminateCommands.length > 0 && (
        <details className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs">
          <summary className="cursor-pointer font-medium">{t('settings.pilot.actionsNeedReview', 'Actions to verify')} · {indeterminateCommands.length}</summary>
          <p className="my-3 text-muted-foreground">{t('settings.pilot.indeterminateDescription', 'Check whether these actions took effect before continuing.')}</p>
          <div className="space-y-2">
            {indeterminateCommands.map((command) => (
              <div key={command.key} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{command.commandId}</p>
                  <p className="text-xs text-muted-foreground">
                    {t('settings.pilot.commandTarget', 'Target: {{target}}', {
                      target: command.target.type || command.target.task_id || command.target.run_id || 'resource',
                    })}
                  </p>
                </div>
                <Button size="sm" variant="secondary" onClick={() => setReconciliationTarget(command)}>
                  {t('settings.pilot.reconcile', 'Reconcile locally')}
                </Button>
              </div>
            ))}
          </div>
        </details>
      )}

      <ConfirmPromptModal
        isOpen={manageAccountOpen && Boolean(currentIdentity)}
        title={t('settings.pilot.manageAccount', 'Manage account')}
        showConfirmButton={false}
        cancelLabel={t('common.close', 'Close')}
        onCancel={() => setManageAccountOpen(false)} onConfirm={() => undefined}
      >
        <div className="flex flex-col items-start gap-3">
          <p className="text-xs text-muted-foreground">@{currentIdentity?.login}</p>
          <Button size="sm" variant="secondary" disabled={store.busy} onClick={() => {
            if (!currentIdentity || !store.relayOrigin) return;
            setManageAccountOpen(false); setAllTarget({ identity: { ...currentIdentity }, origin: store.relayOrigin });
          }}>{t('settings.pilot.revokeAll', 'Disconnect all devices')}</Button>
          <Button size="sm" variant="ghost" className="text-destructive" disabled={store.busy} onClick={() => {
            if (!currentIdentity || !store.relayOrigin) return;
            setManageAccountOpen(false); setDeleteTarget({ identity: { account_id: currentIdentity.account_id, session_id: currentIdentity.session_id, subject: currentIdentity.subject, login: currentIdentity.login }, origin: store.relayOrigin });
          }}>{t('settings.pilot.deleteAccount', 'Delete relay account')}</Button>
        </div>
      </ConfirmPromptModal>

      <ConfirmPromptModal
        isOpen={Boolean(allTarget)} title={t('settings.pilot.revokeAll', 'Disconnect all devices')}
        description={t('settings.pilot.disconnectAllDescription', 'Every device, including this computer, will need to sign in again. Local projects and conversations are preserved.')}
        confirmLabel={t('settings.pilot.revokeAll', 'Disconnect all devices')} cancelLabel={t('common.cancel', 'Cancel')}
        confirmVariant="error" isSubmitting={store.busy} showConfirmButton={allTargetCurrent}
        onCancel={() => setAllTarget(null)} onConfirm={() => {
          if (allTargetCurrent) void accountMutation(store.revokeAllSessions);
        }}
      >
        <p className="text-sm">@{allTarget?.identity.login}</p>
        {!allTargetCurrent && <p role="alert" className="text-xs text-destructive">{t('settings.pilot.errors.context_changed', errorFallbacks.context_changed)}</p>}
      </ConfirmPromptModal>

      <ConfirmPromptModal
        isOpen={Boolean(deleteTarget)}
        title={t('settings.pilot.deleteAccount', 'Delete relay account')}
        description={t('settings.pilot.deleteDescription', 'Delete this relay account and revoke every session and association. Local projects and conversations are preserved. Signing in again creates an account with no restored associations.')}
        confirmLabel={t('settings.pilot.deleteConfirm', 'Delete this account permanently')}
        cancelLabel={t('common.cancel', 'Cancel')}
        confirmVariant="error"
        isSubmitting={store.busy}
        showConfirmButton={deleteTargetCurrent}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => { if (deleteTarget && deleteTargetCurrent) void accountMutation(() => store.deleteAccount(deleteTarget.identity, deleteTarget.origin)); }}
      >
        <p className="break-all text-sm font-medium">GitHub @{deleteTarget?.identity.login}</p>
        <p className="break-all text-xs">{t('settings.pilot.githubSubject', 'GitHub ID: {{subject}}', { subject: deleteTarget?.identity.subject })}</p>
        {!deleteTargetCurrent && <p role="alert" className="mt-2 text-xs text-destructive">{t('settings.pilot.errors.context_changed', errorFallbacks.context_changed)}</p>}
      </ConfirmPromptModal>

      <ConfirmPromptModal
        isOpen={Boolean(reconciliationTarget)}
        title={t('settings.pilot.reconciliationTitle', 'Confirm that the effect did not occur')}
        description={t(
          'settings.pilot.reconciliationDescription',
          'Use this only after checking the local task, conversation, tool or Git state and confirming that the command had no effect. Macro will close this attempt and require a new explicit command.',
        )}
        confirmLabel={t('settings.pilot.reconciliationConfirm', 'I confirm it was not executed')}
        cancelLabel={t('common.cancel', 'Cancel')}
        confirmVariant="error"
        isSubmitting={reconciliationBusy}
        onCancel={() => setReconciliationTarget(null)}
        onConfirm={() => void confirmReconciliation()}
      />
    </div>
  );
};

export default PilotView;
