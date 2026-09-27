import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauriAvailable, localBackupSchedule, localBackupStatus } from '../../../services/tauriIpc';
import { captureBackupBrowserState } from '../../../services/localBackup';
import type { LocalBackupStatus } from '../../../services/tauriIpc';
import { BackupRecoveryStatus } from './BackupRecoveryStatus';
import { usePersistenceHealth } from '../../../services/persistenceHealth';

export function BackupSettingsSection() {
  const { t } = useTranslation();
  const issues = usePersistenceHealth((state) => state.issues);
  const [path, setPath] = useState('');
  const [action, setAction] = useState<'export' | 'restore' | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<LocalBackupStatus | null>(null);
  const [scheduled, setScheduled] = useState(false);
  const showError = (error: unknown) => setStatus({ code: 'failed', message: String(error), browser: null });
  useEffect(() => {
    if (isTauriAvailable()) void localBackupStatus().then(setStatus).catch(showError);
  }, []);
  const schedule = async () => {
    if (!action) return;
    setBusy(true);
    setScheduled(false);
    setStatus(null);
    try {
      await localBackupSchedule(action, path.trim(), captureBackupBrowserState(), true);
      setScheduled(true);
      setAction(null);
    } catch (error) { showError(error); }
    finally { setBusy(false); }
  };
  return <section className="space-y-3 rounded-lg border border-border p-4">
    <h3 className="text-sm font-semibold">{t('backup.title', 'Backup and restore')}</h3>
    <p className="text-xs text-muted-foreground">{t('backup.scope', 'Local profile: conversations, stored attachments, code checkpoints, drafts and global preferences. Project folders and their Git metadata are excluded. Keep a separate copy of your projects. Maximum archive size: 256 MiB; restore with the same Macro version.')}</p>
    <p className="text-xs text-muted-foreground">{t('backup.secrets', 'Provider credentials, MCP environment variables and headers are excluded from portable exports. Reconnect providers after restoring. Conversation and file contents remain private data; store the archive securely.')}</p>
    {Object.entries(issues).map(([key, message]) => <div role="alert" key={key} className="text-xs text-destructive"><span className="font-medium">{t('backup.recovery', 'Recovery required. Original data preserved.')}</span><details><summary>{t('backup.diagnostics')}</summary><pre className="whitespace-pre-wrap">{message}</pre></details></div>)}
    <label className="block space-y-1 text-xs">
      <span>{t('backup.path', 'Absolute path to the local backup file')}</span>
      <input className="w-full rounded border border-border bg-background px-3 py-2 text-sm" value={path} onChange={(event) => setPath(event.target.value)} placeholder="/…/macro-profile.json" disabled={busy} />
    </label>
    <div className="flex gap-2">
      <button className="rounded border border-border px-3 py-1.5 text-xs" disabled={busy || !path.trim() || !isTauriAvailable()} onClick={() => setAction('export')}>{t('backup.export', 'Prepare backup')}</button>
      <button className="rounded border border-border px-3 py-1.5 text-xs" disabled={busy || !path.trim() || !isTauriAvailable()} onClick={() => setAction('restore')}>{t('backup.restore', 'Restore backup')}</button>
    </div>
    {action && <div role="alertdialog" aria-label={t('backup.confirmTitle', 'Confirm profile operation')} className="space-y-2 rounded border border-border p-3 text-xs">
      <p>{action === 'restore' ? t('backup.confirmRestore', 'At the next startup, this archive will replace your local profile. Macro validates it first and keeps the previous profile for recovery. Stop current tasks and quit immediately after confirming. Restore this file?') : t('backup.confirmExport', 'Stop current tasks before continuing. Macro will create the archive at the next startup, while the database and configuration are closed. Prepare this backup?')}</p>
      <p className="break-all">{path}</p>
      <div className="flex gap-2"><button disabled={busy} className="rounded bg-primary px-3 py-1.5 text-primary-foreground" onClick={() => void schedule()}>{t('backup.confirm', 'Confirm')}</button><button disabled={busy} onClick={() => setAction(null)}>{t('common.cancel', 'Cancel')}</button></div>
    </div>}
    {scheduled && <p role="status" className="text-xs">{t('backup.scheduled')}</p>}
    {status && <BackupRecoveryStatus status={status} />}
  </section>;
}
