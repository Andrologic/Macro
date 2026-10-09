import { useTranslation } from 'react-i18next';
import type { LocalBackupStatus } from '../../../services/tauriIpc';

const statusKeys = {
  exported: 'backup.resultExported',
  restored: 'backup.resultRestored',
  rolledBack: 'backup.resultRolledBack',
  failed: 'backup.resultFailed',
  invalidRequest: 'backup.resultInvalidRequest',
} as const;

export function BackupRecoveryStatus({ status }: { status: LocalBackupStatus }) {
  const { t } = useTranslation();
  if (!status.code && !status.message) return null;
  const key = status.code && statusKeys[status.code];
  return <div className="space-y-2 break-words text-xs">
    <p role="status">{t(key || 'backup.resultLegacy')}</p>
    {status.path && <p className="break-all">{status.path}</p>}
    {status.message && <details><summary>{t('backup.diagnostics')}</summary><pre className="whitespace-pre-wrap break-all">{status.message}</pre></details>}
  </div>;
}

export function BackupStartupRecovery({ error }: { error: unknown }) {
  const { t } = useTranslation();
  const sessionReplaced = typeof error === 'object' && error !== null &&
    'code' in error && error.code === 'BROWSER_RUNTIME_SESSION_REPLACED';
  if (sessionReplaced) return <section role="alert" className="space-y-3 p-4 text-sm">
    <h1>{t('backup.sessionReplacedTitle')}</h1>
    <p>{t('backup.sessionReplacedHint')}</p>
    <button type="button" className="rounded-lg border border-border px-3 py-2 hover:bg-accent"
      onClick={() => window.location.reload()}>{t('backup.sessionReplacedReload')}</button>
  </section>;
  return <section role="alert" className="space-y-3 p-4 text-sm">
    <h1>{t('backup.startupTitle')}</h1>
    <p>{t('backup.startupRecovery')}</p>
    <details><summary>{t('backup.diagnostics')}</summary><pre className="whitespace-pre-wrap break-all">{String(error)}</pre></details>
  </section>;
}
