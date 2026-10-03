import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauriAvailable, localBackupSchedule, localBackupStatus } from '../../../services/tauriIpc';
import { captureBackupBrowserState } from '../../../services/localBackup';
import { open, save } from '../../../services/tauriDialog';
import type { LocalBackupStatus } from '../../../services/tauriIpc';
import { BackupRecoveryStatus } from './BackupRecoveryStatus';
import { usePersistenceHealth } from '../../../services/persistenceHealth';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Input } from '../../ui/Input';
import { notify } from '../../ui/toastService';

type Operation = 'export' | 'restore';
export function BackupSettingsSection() {
  const { t } = useTranslation();
  const issues = usePersistenceHealth((state) => state.issues);
  const [path, setPath] = useState('');
  const [action, setAction] = useState<Operation | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<LocalBackupStatus | null>(null);
  const [scheduled, setScheduled] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const descriptionId = useId();
  const pathId = useId();
  const showError = (error: unknown) => setStatus({ code: 'failed', message: String(error), browser: null });
  useEffect(() => {
    if (isTauriAvailable()) void localBackupStatus().then(setStatus).catch(showError);
  }, []);
  const chooseFile = async (operation: Operation) => {
    setBusy(true);
    try {
      const options = { title: t(operation === 'export' ? 'backup.export' : 'backup.restore'), filters: [{ name: 'JSON', extensions: ['json'] }] };
      const selected = operation === 'export'
        ? await save({ ...options, defaultPath: `macro-profile-${new Date().toISOString().slice(0, 10)}.json` })
        : await open({ ...options, multiple: false, directory: false });
      if (selected) {
        setPath(selected);
        setStatus(null);
        setAction(operation);
      }
    } catch (error) { showError(error); }
    finally { setBusy(false); }
  };
  const schedule = async () => {
    if (!action || busy || !path.trim()) return;
    setBusy(true);
    setStatus(null);
    try {
      await localBackupSchedule(action, path.trim(), captureBackupBrowserState(), true);
      setScheduled(true);
      setAction(null);
      notify.success(t('backup.scheduledTitle'), { description: t('backup.scheduled') });
    } catch (error) { showError(error); }
    finally { setBusy(false); }
  };
  const unavailable = !isTauriAvailable();
  return <section className="min-w-0 space-y-3 rounded-lg border border-border bg-card/40 p-4">
    <div className="space-y-1">
      <h3 className="text-sm font-semibold">{t('backup.title')}</h3>
      <p className="text-xs text-muted-foreground">{t('backup.scope')}</p>
    </div>
    <p className="text-xs text-muted-foreground">{t('backup.exclusions')}</p>
    <details className="text-xs text-muted-foreground">
      <summary className="cursor-pointer">{t('backup.limitsTitle')}</summary>
      <div className="mt-2 space-y-2"><p>{t('backup.limits')}</p><p>{t('backup.secrets')}</p></div>
    </details>
    {Object.entries(issues).map(([key, message]) => <div role="alert" key={key} className="text-xs text-destructive"><span className="font-medium">{t('backup.recovery')}</span><details><summary>{t('backup.diagnostics')}</summary><pre className="whitespace-pre-wrap break-all">{message}</pre></details></div>)}
    <div className="divide-y divide-border">
      {(['export', 'restore'] as const).map(operation => <div key={operation} className="flex flex-wrap items-center justify-between gap-3 py-3">
        <p className="min-w-0 flex-1 basis-48 text-xs text-muted-foreground">{t(operation === 'export' ? 'backup.exportHelp' : 'backup.restoreHelp')}</p>
        <Button size="sm" variant="secondary" disabled={busy || scheduled || unavailable} onClick={() => void chooseFile(operation)}>{t(`backup.${operation}`)}</Button>
      </div>)}
    </div>
    {unavailable && <p className="text-xs text-muted-foreground">{t('backup.desktopRequired')}</p>}
    {scheduled && <div role="status" className="space-y-1 rounded border border-border bg-background p-3 text-xs"><p className="font-medium">{t('backup.scheduledTitle')}</p><p>{t('backup.scheduled')}</p><p className="break-all">{path}</p></div>}
    {status && !action && <BackupRecoveryStatus status={status} />}
    {action && <Dialog title={t(action === 'restore' ? 'backup.restore' : 'backup.export')} onClose={() => { if (!busy) setAction(null); }} initialFocusRef={cancelRef} ariaDescribedBy={descriptionId} panelClassName="w-full max-w-lg max-h-[85vh] overflow-y-auto rounded-xl border border-border bg-background p-5 shadow-xl">
      <div className="space-y-4" aria-busy={busy}>
        <h3 className="text-sm font-semibold">{t(action === 'restore' ? 'backup.restore' : 'backup.export')}</h3>
        <p id={descriptionId} className="text-xs text-muted-foreground">{t(action === 'restore' ? 'backup.confirmRestore' : 'backup.confirmExport')}</p>
        <div className="space-y-1">
          <label htmlFor={pathId} className="text-xs font-medium">{t(action === 'restore' ? 'backup.source' : 'backup.destination')}</label>
          <Input id={pathId} value={path} onChange={event => setPath(event.target.value)} disabled={busy} />
          <p className="break-all text-xs text-muted-foreground">{path}</p>
        </div>
        {status && <BackupRecoveryStatus status={status} />}
        <div className="flex flex-wrap justify-end gap-2">
          <Button ref={cancelRef} size="sm" variant="secondary" disabled={busy} onClick={() => setAction(null)}>{t('common.cancel')}</Button>
          <Button size="sm" variant={action === 'restore' ? 'error' : 'primary'} isLoading={busy} disabled={!path.trim()} onClick={() => void schedule()}>{t(action === 'restore' ? 'backup.confirmReplace' : 'backup.confirm')}</Button>
        </div>
      </div>
    </Dialog>}
  </section>;
}
