import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Monitor, Smartphone, RefreshCw, ChevronRight } from 'lucide-react';
import { PilotActions } from './PilotActions';
import { SettingsSectionHeader } from '../SettingsSectionHeader';
import { useTranslation } from 'react-i18next';
import { openExternalUrl } from '../../../services/externalUrlOpener';
import type { PilotRuntimeStatus } from '../../../services/macroPilot/runtime';
import type { PilotAccountConfirmation, PilotPermission, PilotPublicState } from '../../../services/macroPilot/nativeClient';
import { usePilotStore } from '../../../stores/usePilotStore';
import { Button } from '../../ui/Button';
import { ConfirmPromptModal } from '../../ui/ConfirmPromptModal';
import { notify } from '../../ui/toastService';
import { accountConnectionStatus, computerAvailability, computerAvailabilityMessages, getVaultRecoveryStatus, sessionVerificationStatus, vaultRecoveryMessages } from '../../../services/macroPilot/connectionPresentation';

const PERMISSIONS: PilotPermission[] = ['supervise', 'respond', 'approve_tools', 'review'];
const PILOT_RELAY_ORIGIN = 'https://macro.andrologic.ai';
const accessScopeOf = (state: PilotPublicState) => state.deviceSession && state.instance
  ? JSON.stringify([state.configurationId, state.relayOrigin, state.account?.account_id, state.deviceSession.ref.session_id, state.instance.ref.instance_id])
  : null;

interface IndeterminateCommand {
  key: string;
  commandId: string;
  target: Record<string, string>;
}

const errorFallbacks: Record<string, string> = {
  invalid_configuration: 'Check the device name and try again.',
  invalid_response: 'The relay returned an invalid response.',
  validation_failed: 'The relay rejected this request. Refresh and try again.',
  response_too_large: 'The relay response exceeded the 1 MB limit.',
  redirect_refused: 'The relay tried to redirect the request.',
  unauthorized: 'Your Macro Connect session has expired. Connect with GitHub again. Your local projects and conversations remain available.',
  session_revoked: 'Access for this device was revoked. Connect with GitHub again to restore it. Your local projects and conversations remain available.',
  forbidden: 'This account cannot perform that action.',
  not_found: 'The requested Macro Connect item no longer exists.',
  conflict: 'The connection changed. Refresh and try again.',
  stale_revision: 'The request changed before it could be applied.',
  unavailable: 'Macro Connect is temporarily unavailable.',
  vault_unavailable: 'Saved credentials are inaccessible. Restore the connection.',
  extension_unavailable: 'This relay does not support account management yet.',
  snapshot_expired: 'This list expired. Refresh it before continuing.',
  resource_limit: 'The relay cannot return this list within its resource limits.',
  context_changed: 'The connected account changed. Refresh and try again.',
  offline: 'The relay cannot be reached. Local Macro features remain available.',
};

export const PilotView: React.FC = () => {
  const { t, i18n } = useTranslation();
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
  const [troubleshootOpen, setTroubleshootOpen] = useState(false);
  const accessScope = accessScopeOf(store);
  const accessAttempt = useRef({ scope: accessScope, attempted: false, generation: 0 });
  const [accessFailure, setAccessFailure] = useState<string | null>(null);
  const [accessLoading, setAccessLoading] = useState<string | null>(null);
  const refreshAccessRequests = store.refreshAccessRequests;

  const loadAccessRequests = useCallback(async () => {
    if (!accessScope || usePilotStore.getState().busy || accessScopeOf(usePilotStore.getState()) !== accessScope) return;
    const attempt = accessAttempt.current;
    if (attempt.scope !== accessScope) return;
    attempt.attempted = true;
    const generation = ++attempt.generation;
    setAccessFailure(null);
    setAccessLoading(accessScope);
    try {
      await refreshAccessRequests();
    } catch {
      if (accessAttempt.current.generation === generation && accessScopeOf(usePilotStore.getState()) === accessScope) setAccessFailure(accessScope);
    } finally {
      if (accessAttempt.current.generation === generation) setAccessLoading(null);
    }
  }, [accessScope, refreshAccessRequests]);

  useEffect(() => {
    if (accessAttempt.current.scope !== accessScope) {
      accessAttempt.current = { scope: accessScope, attempted: false, generation: accessAttempt.current.generation + 1 };
      setAccessFailure(null);
      setAccessLoading(null);
    }
    if (troubleshootOpen && accessScope && !busy && !store.accessRequestsLoaded && !accessAttempt.current.attempted) void loadAccessRequests();
  }, [accessScope, busy, troubleshootOpen, store.accessRequestsLoaded, loadAccessRequests]);

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
    if (!['authorizing', 'confirming_account'].includes(authStatus) || !authAttempt || busy || store.lastError) return;
    const timer = window.setTimeout(() => {
      void pollAuth().catch(() => undefined);
    }, authAttempt.interval * 1_000);
    return () => window.clearTimeout(timer);
  }, [authStatus, authAttempt, busy, pollAuth, store.lastError]);

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
  const currentSession = activeSessions.find(session => session.session_id === store.deviceSession?.ref.session_id);
  const otherSessions = activeSessions.filter(session => session.session_id !== store.deviceSession?.ref.session_id);
  const activityLabel = (lastSeenAt?: string) => lastSeenAt
    ? t('settings.pilot.lastActivity', 'Last activity {{date}}', { date: new Date(lastSeenAt).toLocaleString(i18n.language) })
    : t('settings.pilot.lastActivityUnknown', 'Last activity unknown');
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

  const accountStatus = accountConnectionStatus(store);
  const statusLabel = t(`settings.pilot.status.${accountStatus}`, accountStatus.replaceAll('_', ' '));

  const run = async (work: () => Promise<void>, success?: string) => {
    try {
      await work();
      if (success) notify.success(success);
    } catch {
      // The store exposes a redacted error code below.
    }
  };

  const startConnection = () => run(() => store.connect(PILOT_RELAY_ORIGIN));

  const copyAndOpenGitHub = async () => {
    const attempt = usePilotStore.getState().attempt;
    if (!attempt) return;
    try {
      await navigator.clipboard.writeText(attempt.userCode);
    } catch {
      notify.error(t('settings.pilot.copyCodeFailed', 'Could not copy the code. Copy it manually before opening GitHub.'));
      return;
    }
    try {
      await openExternalUrl(attempt.verificationUri);
    } catch {
      notify.error(t('settings.pilot.openGitHubFailed', 'The code was copied. Open github.com/login/device in your browser.'));
    }
  };

  const connectInstance = () => run(
    () => store.createOrAttachInstance(),
    t('settings.pilot.instanceConnected', 'This computer is connected to Macro Connect.'),
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

  const vaultRecoveryStatus = getVaultRecoveryStatus(store);
  const availability = computerAvailability(store, runtimeStatus);
  const verificationStatus = sessionVerificationStatus(store);
  const connectionError = store.sessionEndReason ?? store.lastError;
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
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-300">
      <section className="space-y-4">
        <SettingsSectionHeader title={t('settings.pilot.connection', 'Connection')} />
        <div className="space-y-4 rounded-xl border border-border/50 bg-card/40 p-4">
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

          {connectionError && !vaultRecoveryStatus && !verificationStatus && (connectionError !== 'offline' || Boolean(store.relayOrigin)) && (
            <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {t(`settings.pilot.errors.${connectionError}`, errorFallbacks[connectionError] || connectionError)}
            </div>
          )}

          {verificationStatus && <div role="status" aria-live="polite" className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs space-y-2">
            <p className="text-muted-foreground">{verificationStatus === 'verifying'
              ? t('settings.pilot.sessionVerification.pending', 'Checking your Macro Connect session before reconnecting this computer. Your local projects and conversations remain available.')
              : t('settings.pilot.sessionVerification.failed', 'Your saved credentials are available, but Macro Connect could not check your session. Check your internet connection and try again. Your local projects and conversations remain available.')}</p>
            {verificationStatus === 'retry' && <Button size="sm" variant="secondary" disabled={store.busy} onClick={() => void initialize()}>
              {t('settings.pilot.sessionVerification.retry', 'Retry connection')}
            </Button>}
          </div>}

          {vaultRecoveryStatus && (
            <div
              role={vaultRecoveryActive || vaultRecoveryStatus === 'suspended' ? 'status' : 'alert'}
              aria-live="polite"
              className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs space-y-2"
            >
              <p className="font-medium">{t('settings.pilot.vaultRecovery.title', 'Macro Connect connection paused')}</p>
              <p className="text-muted-foreground">
                {vaultRecoveryActive
                  ? t('settings.pilot.vaultRecovery.waiting', 'Waiting for permission to read the saved credentials. You can keep using Macro or sign out.')
                  : t(
                    `settings.pilot.vaultRecovery.${vaultRecoveryStatus}`,
                    vaultRecoveryMessages[vaultRecoveryStatus],
                  )}
              </p>
              <Button
                size="sm"
                variant="secondary"
                disabled={vaultRecoveryBusy || store.busy}
                onClick={() => { void resumeVaultAccess(); }}
              >
                {vaultRecoveryActive
                  ? t('settings.pilot.vaultRecovery.resuming', 'Restoring connection…')
                  : t('settings.pilot.vaultRecovery.resume', 'Restore connection')}
              </Button>
            </div>
          )}

          {!store.deviceSession && !store.attempt && !vaultRecoveryStatus && (
            <Button disabled={store.busy} onClick={startConnection}>
              {t('settings.pilot.signIn', 'Connect with GitHub')}
            </Button>
          )}

          {store.deviceSession && (accountStatus === 'expired' || accountStatus === 'revoked') && !vaultRecoveryStatus && (
            <Button size="sm" variant="secondary" disabled={store.busy && !store.reading} onClick={logout}>
              {t('settings.pilot.clearExpiredSession', 'Sign out before reconnecting')}
            </Button>
          )}

          {store.attempt && !store.attempt.identifiedAccount && (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">
                {t('settings.pilot.deviceCodeHelp', 'Copy this code, then enter it on GitHub to connect.')}
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <code className="select-all rounded-md border border-border bg-background px-3 py-2 text-lg tracking-[0.18em]">
                  {store.attempt.userCode}
                </code>
                <Button variant="secondary" onClick={() => void copyAndOpenGitHub()}>
                  {t('settings.pilot.copyAndOpenGitHub', 'Copy code and open GitHub')}
                </Button>
                <Button variant="ghost" disabled={store.busy} onClick={() => run(async () => { await store.pollAuth(); })}>
                  {t('settings.pilot.check', 'Check now')}
                </Button>
              </div>
            </div>
          )}

          {store.attempt?.identifiedAccount && (
            <div role="status" className="space-y-3 text-xs text-muted-foreground">
              <p>{t('settings.pilot.finishingConnection', 'Finishing connection…')}</p>
              {store.lastError && <Button variant="secondary" disabled={store.busy} onClick={() => run(async () => { await store.pollAuth(); })}>
                {t('common.retry', 'Retry')}
              </Button>}
            </div>
          )}
        </div>
      </section>

      {store.deviceSession && (
        <section aria-label={t('settings.pilot.devicesTitle', 'Devices')} className="space-y-4">
          <SettingsSectionHeader
            title={<>{t('settings.pilot.devicesTitle', 'Devices')} {accountCatalog && <span className="ml-1 text-xs text-muted-foreground">{activeSessions.length}</span>}</>}
            description={t('settings.pilot.automaticDevices', 'Devices signed in to the same Macro Connect account are connected automatically.')}
            action={<Button size="sm" variant="ghost" aria-label={t('common.refresh', 'Refresh')} title={t('common.refresh', 'Refresh')} disabled={store.busy} onClick={() => run(store.refreshAccount)}>
              <RefreshCw aria-hidden="true" className="h-3.5 w-3.5" />
            </Button>}
          />
          <div className="space-y-4 rounded-xl border border-border/50 bg-card/40 p-4">
            <div aria-label={t('settings.pilot.currentComputer', 'This computer')} className="flex items-center gap-3 rounded-lg border border-border bg-background/50 p-3">
              <Monitor aria-hidden="true" className="h-5 w-5 shrink-0 text-primary" />
              <div className="min-w-0 flex-1">
                <p className="break-words text-sm font-medium">{store.instance?.label ?? currentSession?.label ?? t('settings.pilot.currentComputer', 'This computer')}</p>
                <p className="text-xs text-muted-foreground">{t('settings.pilot.currentComputer', 'This computer')} · <span role="status">{t(`settings.pilot.availability.${availability}`, computerAvailabilityMessages[availability])}</span></p>
                <p className="text-xs text-muted-foreground">{activityLabel(currentSession?.last_seen_at ?? store.instance?.last_seen_at)}</p>
              </div>
              {currentSession && <PilotActions label={t('settings.pilot.deviceMenu', 'Options for {{device}}', { device: store.instance?.label ?? currentSession.label })}>
                <p className="px-3 py-2 text-xs text-muted-foreground">{t('settings.pilot.expiresAt', 'Expires {{date}}', { date: new Date(currentSession.expires_at).toLocaleString() })}</p>
                <button type="button" disabled={store.busy} onClick={() => accountMutation(() => store.revokeSession(currentSession.session_id))}>{t('settings.pilot.disconnectDevice', 'Disconnect this device')}</button>
              </PilotActions>}
            </div>
            {otherSessions.length > 0 && <div className="border-t border-border/50 pt-4">
              <p className="mb-3 text-xs font-medium text-muted-foreground">{t('settings.pilot.otherDevices', 'Other devices')}</p>
              <div className="divide-y divide-border/50">
                {otherSessions.map(session => {
                  const DeviceIcon = session.client_kind === 'mobile' ? Smartphone : Monitor;
                  return <div key={session.session_id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
                    <DeviceIcon aria-hidden="true" className="h-5 w-5 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <p className="break-words text-sm font-medium">{session.label}</p>
                      <p className="text-xs text-muted-foreground">{t(`settings.pilot.clientKind.${session.client_kind}`, session.client_kind)}</p>
                      <p className="text-xs text-muted-foreground">{activityLabel(session.last_seen_at)}</p>
                    </div>
                    <PilotActions label={t('settings.pilot.deviceMenu', 'Options for {{device}}', { device: session.label })}>
                      <p className="px-3 py-2 text-xs text-muted-foreground">{t('settings.pilot.expiresAt', 'Expires {{date}}', { date: new Date(session.expires_at).toLocaleString() })}</p>
                      <button type="button" disabled={store.busy} onClick={() => accountMutation(() => store.revokeSession(session.session_id))}>{t('settings.pilot.disconnectDevice', 'Disconnect this device')}</button>
                    </PilotActions>
                  </div>;
                })}
              </div>
            </div>}
            <p className="text-xs text-muted-foreground">{t('settings.pilot.activityHelp', 'Last activity records a successful request. It does not indicate whether a device is online.')}</p>
            {!accountCatalog && <p role="status" className="text-xs text-muted-foreground">{store.busy ? t('common.loading', 'Loading…') : t('settings.pilot.accountNotLoaded', 'Account details have not been loaded. Refresh to try again.')}</p>}
            {!store.instance && <div role="status" className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
              <span>{t('settings.pilot.preparingDevice', 'Setting up this device…')}</span>
              {!store.busy && <Button size="sm" variant="ghost" onClick={() => run(store.ensureDesktopInstance)}>{t('common.retry', 'Retry')}</Button>}
            </div>}
            {store.instance && (store.instanceAccess?.state !== 'granted' || !PERMISSIONS.every(permission => store.instanceAccess?.permissions.includes(permission))) && <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-500/30 p-3 text-xs">
              <span>{t('settings.pilot.limitedAccess', 'Access to this computer needs to be restored.')}</span>
              <Button size="sm" variant="secondary" disabled={store.busy} onClick={connectInstance}>{t('settings.pilot.reattach', 'Restore access')}</Button>
            </div>}
            {store.instance && (
              <details open={troubleshootOpen} className="group/troubleshoot border-t border-border/50 pt-3 text-xs" onToggle={event => setTroubleshootOpen(event.currentTarget.open)}>
                <summary className="flex min-h-8 cursor-pointer list-none items-center gap-2 rounded-md text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary [&::-webkit-details-marker]:hidden">
                  <ChevronRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0 transition-transform group-open/troubleshoot:rotate-90 motion-reduce:transition-none" />
                  {t('settings.pilot.troubleshoot', 'Resolve a connection problem')}
                </summary>
                <div className="mt-3 space-y-3 pl-5">
                  <p className="text-muted-foreground">{t('settings.pilot.connectionHelp', 'Keep Macro open and check your internet connection so Macro Pilot can reach this computer.')}</p>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
                    <dt className="text-muted-foreground">{t('settings.pilot.accountSession', 'Account session')}</dt>
                    <dd>{statusLabel}</dd>
                    <dt className="text-muted-foreground">{t('settings.pilot.savedCredentials', 'Saved credentials')}</dt>
                    <dd>{vaultRecoveryStatus
                      ? t(`settings.pilot.availability.${vaultRecoveryStatus === 'suspended' ? 'paused' : vaultRecoveryStatus}`, computerAvailabilityMessages[vaultRecoveryStatus === 'suspended' ? 'paused' : vaultRecoveryStatus])
                      : t('settings.pilot.credentialsReady', 'Available')}</dd>
                    <dt className="text-muted-foreground">{t('settings.pilot.currentComputer', 'This computer')}</dt>
                    <dd>{t(`settings.pilot.availability.${availability}`, computerAvailabilityMessages[availability])}</dd>
                  </dl>
                  {accessFailure === accessScope && accessScope && <div role="status" className="flex items-center justify-between gap-3 text-muted-foreground">
                    <span>{t('settings.pilot.accessRequestsFailed', 'Access requests from older devices could not be loaded.')}</span>
                    <Button size="sm" variant="ghost" disabled={store.busy || accessLoading === accessScope} onClick={() => void loadAccessRequests()}>{t('common.retry', 'Retry')}</Button>
                  </div>}
                  {store.accessRequests.length > 0 && <div className="space-y-3 border-t border-border/50 pt-3">
                    <div className="flex items-center justify-between gap-3">
                      <span>{t('settings.pilot.legacyAccessTitle', 'Access requests from older devices')}</span>
                      <Button size="sm" variant="ghost" disabled={store.busy || accessLoading === accessScope} onClick={() => void loadAccessRequests()}>{t('common.refresh', 'Refresh')}</Button>
                    </div>
                    {store.accessRequests.map(request => <div key={request.access_request_id} className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
                      <span className="break-words">{request.device_label}</span>
                      <div className="flex gap-2">
                        <Button size="sm" disabled={store.busy} onClick={() => run(() => store.resolveAccess(request.access_request_id, 'grant'))}>{t('settings.pilot.grant', 'Allow access')}</Button>
                        <Button size="sm" variant="ghost" disabled={store.busy} onClick={() => run(() => store.resolveAccess(request.access_request_id, 'deny'))}>{t('settings.pilot.deny', 'Deny')}</Button>
                      </div>
                    </div>)}
                  </div>}
                </div>
              </details>
            )}
          </div>
        </section>
      )}

      {store.instance && runtimeStatus === 'unavailable' && (
        <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs space-y-2">
          <p>{t('settings.pilot.runtimeUnavailable', 'This computer is currently unavailable in Macro Pilot. Retry the connection. Your local projects and conversations remain available.')}</p>
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
