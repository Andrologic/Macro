import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { openExternalUrl } from '../../../services/externalUrlOpener';
import type { PilotRuntimeStatus } from '../../../services/macroPilot/runtime';
import type { PilotAccountConfirmation, PilotPermission } from '../../../services/macroPilot/nativeClient';
import { usePilotStore } from '../../../stores/usePilotStore';
import { Button } from '../../ui/Button';
import { ConfirmPromptModal } from '../../ui/ConfirmPromptModal';
import { Input } from '../../ui/Input';
import { notify } from '../../ui/toastService';
import { SettingsSectionHeader } from '../SettingsSectionHeader';

const PERMISSIONS: PilotPermission[] = ['supervise', 'respond', 'approve_tools', 'review'];

interface IndeterminateCommand {
  key: string;
  commandId: string;
  target: Record<string, string>;
}

const errorFallbacks: Record<string, string> = {
  invalid_configuration: 'Check the relay address and the required fields.',
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
  const [origin, setOrigin] = useState('');
  const [deviceLabel, setDeviceLabel] = useState('Macro desktop');
  const [instanceLabel, setInstanceLabel] = useState('Macro desktop');
  const [deleteTarget, setDeleteTarget] = useState<{ identity: PilotAccountConfirmation; origin: string } | null>(null);
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
    if (store.relayOrigin) setOrigin(store.relayOrigin);
  }, [store.relayOrigin]);

  useEffect(() => {
    if (store.instance?.label) setInstanceLabel(store.instance.label);
  }, [store.instance?.label]);

  useEffect(() => {
    if (authStatus !== 'authorizing' || !authAttempt || busy) return;
    const timer = window.setTimeout(() => {
      void pollAuth().catch(() => undefined);
    }, authAttempt.interval * 1_000);
    return () => window.clearTimeout(timer);
  }, [authStatus, authAttempt, busy, pollAuth]);

  useEffect(() => {
    if (deviceSession && !busy && !accountCatalog && !lastError) {
      void refreshAccount().catch(() => undefined);
    }
  }, [deviceSession, busy, accountCatalog, lastError, refreshAccount]);

  const currentIdentity = store.accountCatalog?.identity;
  const deleteTargetCurrent = Boolean(deleteTarget && currentIdentity
    && deleteTarget.origin === store.relayOrigin
    && deleteTarget.identity.account_id === store.account?.account_id
    && deleteTarget.identity.session_id === store.deviceSession?.ref.session_id
    && deleteTarget.identity.account_id === currentIdentity.account_id
    && deleteTarget.identity.session_id === currentIdentity.session_id
    && deleteTarget.identity.subject === currentIdentity.subject
    && deleteTarget.identity.login === currentIdentity.login);

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
    await store.connect(origin, deviceLabel);
    const verificationUri = usePilotStore.getState().attempt?.verificationUri;
    if (verificationUri) await openExternalUrl(verificationUri);
  });

  const confirmAccount = () => run(
    () => store.confirmAccount(),
    t('settings.pilot.connected', 'Pilot account connected.'),
  );

  const connectInstance = () => run(
    () => store.createOrAttachInstance(instanceLabel),
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

  const accountMutation = (work: () => Promise<boolean>) => run(async () => {
    const confirmed = await work();
    setDeleteTarget(null);
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
    <div className="space-y-5">
      <SettingsSectionHeader
        title={t('settings.pilot.title', 'Macro Pilot')}
        description={t(
          'settings.pilot.description',
          'Connect this desktop to the configured Pilot relay. Macro remains fully usable locally without an account.',
        )}
      />

      <section className="rounded-lg border border-border bg-card/40 p-4 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-medium">{t('settings.pilot.connection', 'Connection')}</span>
          <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
            {statusLabel}
          </span>
        </div>

        {store.lastError && !vaultRecoveryStatus && (
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
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 sm:col-span-2">
              <span className="text-xs text-muted-foreground">{t('settings.pilot.relayOrigin', 'Relay HTTPS origin')}</span>
              <Input
                value={origin}
                onChange={(event) => setOrigin(event.target.value)}
                placeholder="https://pilot.example.com"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">{t('settings.pilot.deviceLabel', 'Device label')}</span>
              <Input value={deviceLabel} maxLength={120} onChange={(event) => setDeviceLabel(event.target.value)} />
            </label>
            <div className="flex items-end">
              <Button className="w-full" disabled={store.busy || !origin.trim() || !deviceLabel.trim()} onClick={startConnection}>
                {t('settings.pilot.signIn', 'Connect with GitHub')}
              </Button>
            </div>
          </div>
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

        {store.account && store.deviceSession && (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium">{store.account.identity.display_name || store.account.identity.login}</p>
              <p className="text-xs text-muted-foreground">@{store.account.identity.login}</p>
            </div>
            <Button variant="secondary" disabled={store.busy && !store.reading} onClick={logout}>
              {t('settings.pilot.signOut', 'Sign out')}
            </Button>
          </div>
        )}
      </section>

      {store.deviceSession && (
        <section className="rounded-lg border border-border bg-card/40 p-4 space-y-3">
          <SettingsSectionHeader
            title={t('settings.pilot.accountTitle', 'GitHub account and devices')}
            description={t('settings.pilot.accountDescription', 'Manage relay sessions even without a connected desktop instance.')}
            action={<Button size="sm" variant="secondary" disabled={store.busy} onClick={() => run(store.refreshAccount)}>{t('common.refresh', 'Refresh')}</Button>}
          />
          {currentIdentity ? <>
            <p className="text-sm font-medium">GitHub @{currentIdentity.login}</p>
            <p className="break-all text-xs text-muted-foreground">{t('settings.pilot.githubSubject', 'GitHub ID: {{subject}}', { subject: currentIdentity.subject })}</p>
            {store.accountCatalog!.sessions.map(session => (
              <div key={session.session_id} className="flex items-center justify-between gap-3 rounded-md border border-border p-3">
                <div className="min-w-0 text-xs">
                  <p className="break-words font-medium">{session.label}</p>
                  <p className="text-muted-foreground">{t(`settings.pilot.clientKind.${session.client_kind}`, session.client_kind)} · {t(`settings.pilot.sessionState.${session.state}`, session.state)}</p>
                  {session.session_id === currentIdentity.session_id && <p>{t('settings.pilot.currentDevice', 'This device')}</p>}
                  <p className="text-muted-foreground">{t('settings.pilot.expiresAt', 'Expires {{date}}', { date: new Date(session.expires_at).toLocaleString() })}</p>
                </div>
                <Button size="sm" variant="secondary" disabled={store.busy || session.state !== 'active'} onClick={() => accountMutation(() => store.revokeSession(session.session_id))}>
                  {t('settings.pilot.revokeSession', 'Revoke session')}
                </Button>
              </div>
            ))}
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" disabled={store.busy} onClick={() => accountMutation(store.revokeAllSessions)}>{t('settings.pilot.revokeAll', 'Revoke all sessions')}</Button>
              <Button variant="error" disabled={store.busy} onClick={() => setDeleteTarget({ identity: { account_id: currentIdentity.account_id, session_id: currentIdentity.session_id, login: currentIdentity.login, subject: currentIdentity.subject }, origin: store.relayOrigin! })}>{t('settings.pilot.deleteAccount', 'Delete relay account')}</Button>
            </div>
          </> : <p className="text-xs text-muted-foreground">{t('settings.pilot.accountNotLoaded', 'Account details have not been loaded. Refresh to try again.')}</p>}
        </section>
      )}

      {store.deviceSession && (
        <section className="rounded-lg border border-border bg-card/40 p-4 space-y-3">
          <SettingsSectionHeader
            title={t('settings.pilot.instanceTitle', 'Desktop instance')}
            description={t('settings.pilot.instanceDescription', 'The instance key stays in the operating system credential vault.')}
          />
          <div className="flex gap-2">
            <Input value={instanceLabel} maxLength={120} disabled={Boolean(store.instance)} onChange={(event) => setInstanceLabel(event.target.value)} />
            <Button disabled={store.busy} onClick={connectInstance}>
              {store.instance
                ? t('settings.pilot.reattach', 'Reattach')
                : t('settings.pilot.createInstance', 'Create instance')}
            </Button>
          </div>
          {store.instanceAccess?.state === 'granted' && !PERMISSIONS.every(permission => store.instanceAccess!.permissions.includes(permission)) && (
            <p role="alert" className="text-xs text-amber-600">{t('settings.pilot.limitedAccess', 'This existing association has limited permissions. Reattach explicitly to enable full access to this instance.')}</p>
          )}
          {store.instance && (
            <div className="flex items-center justify-between rounded-md bg-background/60 px-3 py-2 text-xs">
              <span>{store.instance.label}</span>
              <span className="text-muted-foreground">{store.instance.connection_state}</span>
            </div>
          )}
        </section>
      )}

      {store.instance && (
        <section className="rounded-lg border border-border bg-card/40 p-4 space-y-3">
          <SettingsSectionHeader
            title={t('settings.pilot.accessTitle', 'Device access')}
            description={t('settings.pilot.accessDescription', 'Associate only devices you trust. Associated devices can access all projects and use the available Pilot actions.')}
            action={<Button size="sm" variant="secondary" disabled={store.busy} onClick={() => run(store.refreshAccessRequests)}>{t('common.refresh', 'Refresh')}</Button>}
          />
          {!store.accessRequestsLoaded ? (
            <p className="text-xs text-muted-foreground">{t('settings.pilot.accessNotLoaded', 'Refresh to load pending access requests.')}</p>
          ) : store.accessRequests.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('settings.pilot.noAccessRequests', 'No pending access requests.')}</p>
          ) : store.accessRequests.map((request) => {
            return (
              <div key={request.access_request_id} className="space-y-3 rounded-md border border-border bg-background/50 p-3">
                <div>
                  <p className="text-sm font-medium">{request.device_label}</p>
                  <p className="text-xs text-muted-foreground">{t('settings.pilot.expiresAt', 'Expires {{date}}', { date: new Date(request.expires_at).toLocaleString() })}</p>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" disabled={store.busy} onClick={() => run(() => store.resolveAccess(request.access_request_id, 'grant'))}>
                    {t('settings.pilot.grant', 'Associate device')}
                  </Button>
                  <Button size="sm" variant="secondary" disabled={store.busy} onClick={() => run(() => store.resolveAccess(request.access_request_id, 'deny'))}>
                    {t('settings.pilot.deny', 'Deny')}
                  </Button>
                </div>
              </div>
            );
          })}
        </section>
      )}

      {store.instance && runtimeStatus === 'unavailable' && (
        <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs space-y-2">
          <p>{t('settings.pilot.runtimeUnavailable', 'Desktop supervision is unavailable. Its journal could not be loaded or the relay could not be reached. Local commands are not replayed.')}</p>
          <Button size="sm" variant="secondary" onClick={() => void import('../../../composition/macroPilotDesktop').then(({ macroPilotRuntime }) => macroPilotRuntime.retry())}>
            {t('common.retry', 'Retry')}
          </Button>
        </div>
      )}

      {store.instance && (
        <section className="rounded-lg border border-border bg-card/40 p-4 space-y-3">
          <SettingsSectionHeader
            title={t('settings.pilot.indeterminateTitle', 'Commands requiring reconciliation')}
            description={t(
              'settings.pilot.indeterminateDescription',
              'Macro will never replay a command when it cannot determine whether its local effect occurred.',
            )}
            action={
              <Button size="sm" variant="secondary" onClick={() => void refreshIndeterminate()}>
                {t('common.refresh', 'Refresh')}
              </Button>
            }
          />
          {runtimeStatus === 'unavailable' ? null : indeterminateCommands.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {t('settings.pilot.noIndeterminate', 'No command requires local reconciliation.')}
            </p>
          ) : (
            indeterminateCommands.map((command) => (
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
            ))
          )}
        </section>
      )}

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
