import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { notify } from '../ui/toastService';
import { ProjectCapabilitiesNotice } from '../project/ProjectCapabilitiesNotice';
import { getProjectCapabilities } from '../../services/projectCapabilities';
import { inspectWorktree, repairWorktree, type WorktreeDiagnosticTarget } from '../../services/worktreeDiagnostics';
import type { GitWorktreeInspectionDto } from '../../services/tauriIpc';

function Diagnostic({ entry, repairDisabled }: { entry: WorktreeDiagnosticTarget; repairDisabled: boolean }) {
  const { t } = useTranslation();
  const [inspection, setInspection] = useState<GitWorktreeInspectionDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const supported = getProjectCapabilities(entry.project).worktrees;
  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    setBusy(true);
    setError(null);
    inspectWorktree(entry).then((value) => {
      if (!cancelled) setInspection(value);
    }).catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [entry, revision, supported]);

  const repair = async () => {
    setBusy(true);
    setError(null);
    try {
      setInspection(await repairWorktree(entry));
      notify.success(t('implement.worktreeDiagnostic.repaired'));
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(message);
      notify.error(t('implement.worktreeDiagnostic.refused'), { description: message });
    } finally { setBusy(false); }
  };
  return <section className="space-y-3 rounded-md border border-border p-3">
    <h3 className="text-sm font-medium">{entry.project.name}</h3>
    <ProjectCapabilitiesNotice project={entry.project} />
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-xs">
      <dt>{t('implement.worktreeDiagnostic.repository')}</dt><dd className="break-all select-text">{entry.project.path}</dd>
      <dt>{t('implement.worktreeDiagnostic.path')}</dt><dd className="break-all select-text">{inspection?.worktreePath || '—'}</dd>
      <dt>{t('implement.worktreeDiagnostic.expectedBranch')}</dt><dd className="break-all">{entry.target.branchName}</dd>
      <dt>{t('implement.worktreeDiagnostic.branch')}</dt><dd className="break-all">{inspection?.branchName || t('implement.worktreeDiagnostic.unknown')}</dd>
      <dt>{t('implement.worktreeDiagnostic.state')}</dt><dd>{inspection ? t(`implement.worktreeDiagnostic.states.${inspection.status}`) : t('implement.worktreeDiagnostic.unknown')}</dd>
      <dt>{t('implement.worktreeDiagnostic.changes')}</dt><dd>{t(`implement.worktreeDiagnostic.${inspection?.isDirty == null ? 'unknown' : inspection.isDirty ? 'dirty' : 'clean'}`)}</dd>
    </dl>
    {inspection?.status === 'ready' && inspection.branchName !== entry.target.branchName && <p role="alert" className="text-xs text-amber-500">{t('implement.worktreeDiagnostic.branchMismatch')}</p>}
    <p className="text-xs text-muted-foreground">{t('implement.worktreeDiagnostic.protection')}</p>
    {error && <p role="alert" className="break-words text-xs text-red-500">{error}</p>}
    <div className="flex gap-2">
      <Button size="sm" variant="secondary" disabled={busy || !supported} onClick={() => setRevision((value) => value + 1)}>{t('implement.worktreeDiagnostic.refresh')}</Button>
      <Button size="sm" disabled={busy || !supported || repairDisabled || !inspection || inspection.status === 'ready'} onClick={() => void repair()}>{t('implement.worktreeDiagnostic.repair')}</Button>
    </div>
    {repairDisabled && <p className="text-xs text-muted-foreground">{t('implement.worktreeDiagnostic.stopBeforeRepair')}</p>}
  </section>;
}

export function WorktreeDiagnosticsDialog({ entries, repairDisabled, onClose }: {
  entries: WorktreeDiagnosticTarget[];
  repairDisabled: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return <Dialog title={t('implement.worktreeDiagnostic.title')} onClose={onClose} backdropClassName="fixed inset-0 z-[12020] flex items-center justify-center bg-black/60 p-4" panelClassName="w-full max-w-xl rounded-lg border border-border bg-card p-4 shadow-xl">
    <div className="mb-3 flex items-center justify-between gap-3"><h2 className="text-sm font-semibold">{t('implement.worktreeDiagnostic.title')}</h2><Button size="sm" variant="ghost" onClick={onClose}>{t('common.close')}</Button></div>
    <div className="max-h-[70vh] space-y-3 overflow-auto">{entries.map((entry) => <Diagnostic key={`${entry.target.projectId}:${entry.target.worktreeKey}`} entry={entry} repairDisabled={repairDisabled} />)}</div>
  </Dialog>;
}
