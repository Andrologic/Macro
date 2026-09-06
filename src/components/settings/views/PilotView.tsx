import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { openExternalUrl } from '../../../services/externalUrlOpener';
import type { PilotPermission } from '../../../services/macroPilot/nativeClient';
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
  offline: 'The relay cannot be reached. Local Macro features remain available.',
};

export const PilotView: React.FC = () => {
  const { t } = useTranslation();
  const store = usePilotStore();
  const initialize = store.initialize;
  const pollAuth = store.pollAuth;
  const authStatus = store.status;
  const authAttempt = store.attempt;
  const busy = store.busy;
  const [origin, setOrigin] = useState('');
  const [deviceLabel, setDeviceLabel] = useState('Macro desktop');
  const [instanceLabel, setInstanceLabel] = useState('Macro desktop');
  const [selectedPermissions, setSelectedPermissions] = useState<Record<string, PilotPermission[]>>({});
  const [indeterminateCommands, setIndeterminateCommands] = useState<IndeterminateCommand[]>([]);
  const [reconciliationTarget, setReconciliationTarget] = useState<IndeterminateCommand | null>(null);
  const [reconciliationBusy, setReconciliationBusy] = useState(false);

  const refreshIndeterminate = useCallback(async () => {
    const { macroPilotRuntime } = await import('../../../services/macroPilot/runtime');
    setIndeterminateCommands(macroPilotRuntime.getIndeterminate());
  }, []);

  useEffect(() => {
    void initialize();
  }, [initialize]);

  useEffect(() => {
    void refreshIndeterminate().catch(() => undefined);
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
        : t('settings.pilot.logoutOffline', 'Signed out locally. Server revocation could not be confirmed.'),
    );
  });

  const confirmReconciliation = async () => {
    if (!reconciliationTarget) return;
    setReconciliationBusy(true);
    try {
      const { macroPilotRuntime } = await import('../../../services/macroPilot/runtime');
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

        {store.lastError && (
          <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {t(`settings.pilot.errors.${store.lastError}`, errorFallbacks[store.lastError] || store.lastError)}
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
            <Button variant="secondary" disabled={store.busy} onClick={logout}>
              {t('settings.pilot.signOut', 'Sign out')}
            </Button>
          </div>
        )}
      </section>

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
            description={t('settings.pilot.accessDescription', 'Review each device and grant only the permissions it needs.')}
            action={<Button size="sm" variant="secondary" disabled={store.busy} onClick={() => run(store.refreshAccessRequests)}>{t('common.refresh', 'Refresh')}</Button>}
          />
          {store.accessRequests.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('settings.pilot.noAccessRequests', 'No pending access requests.')}</p>
          ) : store.accessRequests.map((request) => {
            const selected = selectedPermissions[request.access_request_id] || [];
            return (
              <div key={request.access_request_id} className="space-y-3 rounded-md border border-border bg-background/50 p-3">
                <div>
                  <p className="text-sm font-medium">{request.device_label}</p>
                  <p className="text-xs text-muted-foreground">{t('settings.pilot.expiresAt', 'Expires {{date}}', { date: new Date(request.expires_at).toLocaleString() })}</p>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {PERMISSIONS.map((permission) => (
                    <label key={permission} className="flex items-center gap-2 text-xs">
                      <input
                        type="checkbox"
                        checked={selected.includes(permission)}
                        onChange={(event) => setSelectedPermissions((current) => ({
                          ...current,
                          [request.access_request_id]: event.target.checked
                            ? [...selected, permission]
                            : selected.filter((value) => value !== permission),
                        }))}
                      />
                      {t(`settings.pilot.permissions.${permission}`, permission)}
                    </label>
                  ))}
                </div>
                <div className="flex gap-2">
                  <Button size="sm" disabled={store.busy || selected.length === 0} onClick={() => run(() => store.resolveAccess(request.access_request_id, 'grant', selected))}>
                    {t('settings.pilot.grant', 'Grant selected')}
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
          {indeterminateCommands.length === 0 ? (
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
