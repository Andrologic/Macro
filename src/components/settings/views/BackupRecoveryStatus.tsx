import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ProfileStartupRecoveryError, revealProfileRecovery, retryProfileRecovery } from '../../../services/ipc/backup';
import { windowClose } from '../../../services/tauriWindow';
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

function ProfileRecoveryScreen({ error }: { error: ProfileStartupRecoveryError }) {
  const { t } = useTranslation();
  const [feedback, setFeedback] = useState('');
  const [restarting, setRestarting] = useState(false);
  const { kind, diagnostics, preservedArchive } = error.recovery;
  const restore = kind === 'restore';
  const button = 'rounded-lg border border-border px-3 py-2 hover:bg-accent disabled:opacity-50';
  const retry = async () => {
    setRestarting(true);
    try { await retryProfileRecovery(); }
    catch { setRestarting(false); setFeedback(t('backup.recoveryActionFailed')); }
  };
  const reveal = async () => {
    try { await revealProfileRecovery(); }
    catch { setFeedback(t('backup.recoveryActionFailed')); }
  };
  const quit = async () => {
    try { await windowClose(); }
    catch { setFeedback(t('backup.recoveryActionFailed')); }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText([diagnostics, preservedArchive].filter(Boolean).join('\n'));
      setFeedback(t('backup.diagnosticsCopied'));
    } catch { setFeedback(t('backup.recoveryActionFailed')); }
  };
  return <main className="flex h-full min-h-0 flex-col bg-background text-foreground">
    <div data-tauri-drag-region className="h-10 shrink-0" />
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto px-6">
      <section role="alert" className="w-full max-w-lg space-y-3 rounded-xl border border-border bg-card p-6 text-sm">
        <h1 className="text-lg font-semibold">{t(restore ? 'backup.restoreRecoveryTitle' : 'backup.profileOpenFailedTitle')}</h1>
        <p className="text-muted-foreground">{t(restore ? 'backup.nativeRecoveryHint' : 'backup.profileOpenFailedHint')}</p>
        <details>
          <summary>{t('backup.diagnostics')}</summary>
          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all">{diagnostics}</pre>
        </details>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={button} disabled={restarting} onClick={() => void retry()}>{t('common.retry')}</button>
          {restore && <button type="button" className={button} onClick={() => void reveal()}>
            {t(preservedArchive ? 'backup.revealPreservedArchive' : 'backup.revealRecoveryFolder')}
          </button>}
          <button type="button" className={button} onClick={() => void copy()}>{t('backup.copyDiagnostics')}</button>
          <button type="button" className={button} onClick={() => void quit()}>{t('backup.recoveryQuit')}</button>
        </div>
        <p role="status" className="text-muted-foreground">{feedback}</p>
      </section>
    </div>
  </main>;
}

export function BackupStartupRecovery({ error }: { error: unknown }) {
  const { t } = useTranslation();
  if (error instanceof ProfileStartupRecoveryError) return <ProfileRecoveryScreen error={error} />;
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  const sessionReplaced = code === 'BROWSER_RUNTIME_SESSION_REPLACED';
  const connectionUnavailable = typeof code === 'string' && [
    'BROWSER_RUNTIME_UNAVAILABLE', 'BROWSER_RUNTIME_CONNECTION_ERROR', 'BROWSER_RUNTIME_CONNECTION_CLOSED',
  ].includes(code);
  if (connectionUnavailable) return <section role="alert" className="space-y-3 p-4 text-sm">
    <h1>{t('backup.runtimeUnavailableTitle')}</h1>
    <p>{t('backup.runtimeUnavailableHint')}</p>
    <button type="button" className="rounded-lg border border-border px-3 py-2 hover:bg-accent"
      onClick={() => window.location.reload()}>{t('common.retry')}</button>
  </section>;
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
