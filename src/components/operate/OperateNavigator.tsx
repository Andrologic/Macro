import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import {
  operateSnoozeDeadlineWarning, selectOperateInbox,
  type OperateRunRow, type OperateThreadRow,
} from '../../services/operateInboxModel';
import {
  openOperateRun, openOperateThread, snoozeOperateThread, subscribeOperateInbox,
  terminateOperateRun, useOperateInboxStore,
} from '../../stores/useOperateInboxStore';
import { useAgsdlTranslation } from '../agsdl/useAgsdlTranslation';
import { Dialog } from '../ui/Dialog';
import { notify } from '../ui/toastService';
import { useArchitectLaunchStore } from '../../stores/useArchitectLaunchStore';
import { architectLaunch } from '../../services/ipc/architectLaunch';
import { workflowRunAccessSnapshot030 } from '../../services/workflowAgentTasks';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';

// The launch window is rarely opened: it loads when it is first needed.
const ArchitectLaunchDialog = lazy(() => import('./ArchitectLaunchDialog'));
const ArchiveRunSecrets = lazy(() => import('./ArchitectLaunchDialog').then(module => ({ default: module.ArchiveRunSecrets })));

const systemRunLabel = (item: { systemLabel: string; runLabel: string }) => `${item.systemLabel} · ${item.runLabel}`;
const elapsedLabel = (ms: number, locale: string | undefined) =>
  new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(-Math.floor(ms / 60_000), 'minute');

function ThreadRow({ thread }: { thread: OperateThreadRow }) {
  const { t, i18n } = useAgsdlTranslation();
  const [editing, setEditing] = useState(false);
  const [date, setDate] = useState('');
  const untilMs = new Date(date).getTime();
  const deadline = operateSnoozeDeadlineWarning(thread, untilMs);
  const showError = () => notify.error(t('agsdl.inbox.actionFailed'));
  const name = systemRunLabel(thread);
  return <div className="border-l border-border pl-2">
    <button type="button" className="block text-left" data-operate-open-thread onClick={() => void openOperateThread(thread).catch(showError)}>
      {thread.agentLabel}{thread.hidden && <> · {t('agsdl.inbox.hidden')}</>}
    </button>
    <button type="button" className="block text-left text-muted-foreground" onClick={() => openOperateRun(thread)}>{name}</button>
    {(thread.reason || thread.elapsedMs !== null) && <p>
      {thread.reason && t(`agsdl.inbox.reason.${thread.reason}`)}
      {thread.elapsedMs !== null && <>{thread.reason && ' · '}{elapsedLabel(thread.elapsedMs, i18n.resolvedLanguage)}</>}</p>}
    {thread.reason === 'snoozed' && thread.facts?.snoozeUntilMs != null &&
      <time>{new Date(thread.facts.snoozeUntilMs).toLocaleString(i18n.resolvedLanguage)}</time>}
    {thread.location.kind === 'remote' && <p>{thread.location.label}</p>}
    {thread.stale && <p>{t('agsdl.run030.staleShort')}</p>}
    {thread.canSnooze && thread.reason !== 'snoozed' &&
      <button type="button" onClick={() => setEditing(!editing)}>{t('agsdl.inbox.snooze')}</button>}
    {editing && <form onSubmit={event => {
      event.preventDefault();
      void snoozeOperateThread(thread, untilMs).then(() => setEditing(false), showError);
    }}>
      <label>{t('agsdl.inbox.snoozeUntil')} <input type="datetime-local" value={date} onChange={event => setDate(event.target.value)} required /></label>
      {deadline !== null && <p role="status">{t('agsdl.inbox.deadlineWarning', { time: new Date(deadline).toLocaleString(i18n.resolvedLanguage) })}</p>}
      <button disabled={!(untilMs > Date.now())}>{t('agsdl.inbox.snooze')}</button>
    </form>}
  </div>;
}

function RunRow({ run }: { run: OperateRunRow }) {
  const { t } = useAgsdlTranslation();
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [editingSecrets, setEditingSecrets] = useState(false);
  const archiveRun = workflowRunAccessSnapshot030().find(entry => entry.scope.owner.planId === run.systemId)
    ?.archiveRuns?.get(run.scope.systemStartId);
  const name = systemRunLabel(run);
  const terminate = () => {
    setConfirming(false);
    setPending(true);
    void terminateOperateRun(run).catch(() => notify.error(t('agsdl.inbox.actionFailed'))).finally(() => setPending(false));
  };
  return <section className="mb-2">
    <button type="button" className="block text-left font-medium" onClick={() => openOperateRun(run)}>{name}</button>
    <p>{t(`agsdl.inbox.status.${run.status}`)} · {run.location.kind === 'local' ? t('agsdl.inbox.local') : run.location.label}</p>
    {archiveRun && <div className="flex gap-2">
      <button type="button" onClick={() => void architectLaunch.openFolder(run.scope.systemStartId)
        .catch(() => notify.error(t('agsdl.inbox.actionFailed')))}>{t('agsdl.launch.openFolder')}</button>
      <button type="button" onClick={() => setEditingSecrets(true)}>{t('agsdl.launch.secrets')}</button>
      {editingSecrets && <Suspense fallback={null}><ArchiveRunSecrets version={archiveRun.version} onClose={() => setEditingSecrets(false)} /></Suspense>}
    </div>}
    {run.canTerminate &&
      <button type="button" disabled={pending || run.status === 'stopping'} onClick={() => setConfirming(true)}>{t('agsdl.inbox.terminate')}</button>}
    {confirming && <Dialog title={t('agsdl.inbox.terminate')} onClose={() => setConfirming(false)}
      panelClassName="max-w-sm space-y-3 rounded border border-border bg-card p-4 text-sm">
      <p>{t('agsdl.inbox.confirmTerminate', { run: name })}</p>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={() => setConfirming(false)}>{t('agsdl.shell030.close')}</button>
        <button type="button" className="text-destructive" onClick={terminate}>{t('agsdl.inbox.terminate')}</button>
      </div>
    </Dialog>}
    {run.threads.length > 0 && <details>
      <summary>{t('agsdl.run030.instances')}</summary>
      {run.threads.map(thread => <ThreadRow key={thread.key} thread={thread} />)}
    </details>}
  </section>;
}

export default function OperateNavigator() {
  const { t, i18n } = useAgsdlTranslation();
  const { runs, filter, hiddenAgents, loading, readFailed, setFilter, nowMs } = useOperateInboxStore();
  const launchWindow = useArchitectLaunchStore(state => state.window);
  const openLaunch = useArchitectLaunchStore(state => state.open);
  useEffect(subscribeOperateInbox, []);
  const sections = useMemo(() => selectOperateInbox(runs, filter, nowMs, hiddenAgents,
    time => new Date(time).toLocaleString(i18n.resolvedLanguage)), [runs, filter, nowMs, hiddenAgents, i18n.resolvedLanguage]);
  return <nav className="flex h-full min-h-0 flex-col" aria-label={t('agsdl.shell030.executions')} data-tour-id="operate-executions">
    <header className="border-b border-border p-2 text-xs">
      <Button size="sm" variant="secondary" className="mb-2 !h-7 w-full !px-3 !py-0 text-xs" leftIcon={<Icon name="play" size={12} />}
        onClick={() => openLaunch()}>{t('agsdl.launch.title')}</Button>
      {launchWindow && <Suspense fallback={null}><ArchitectLaunchDialog
        key={JSON.stringify(launchWindow.version ?? null)} initialVersion={launchWindow.version} /></Suspense>}
      <h2 className="text-sm font-medium">{t('agsdl.shell030.executions')}</h2>
      <input type="search" aria-label={t('agsdl.inbox.search')} placeholder={t('agsdl.inbox.search')}
        value={filter.query ?? ''} onChange={event => setFilter({ ...filter, query: event.target.value })} />
      <select aria-label={t('agsdl.inbox.systemFilter')} value={filter.systemId ?? ''}
        onChange={event => setFilter({ ...filter, systemId: event.target.value || undefined })}>
        <option value="">{t('agsdl.inbox.allSystems')}</option>
        {sections.systems.map(system => <option key={system.id} value={system.id}>{system.label}</option>)}
      </select>
      <label className="block"><input type="checkbox" checked={!!filter.showHidden}
        onChange={event => setFilter({ ...filter, showHidden: event.target.checked })} /> {t('agsdl.inbox.showHidden')}</label>
    </header>
    <div className="min-h-0 flex-1 overflow-auto p-2 text-xs">
      {readFailed && <p role="alert">{t('agsdl.run030.readFailed')}</p>}
      {!runs.length && <p role="status">{t(loading ? 'agsdl.run030.loading' : 'agsdl.run030.noRuns')}</p>}
      <h3>{t('agsdl.inbox.attention')}</h3>
      {sections.attention.map(item => item.kind === 'thread' ? <ThreadRow key={item.key} thread={item} />
        : <button type="button" key={item.key} className="block text-left" onClick={() => openOperateRun(item.run, item.requestId)}>
          {systemRunLabel(item.run)} · {t(`agsdl.inbox.reason.${item.reason}`)}
          {item.elapsedMs !== null && <> · {elapsedLabel(item.elapsedMs, i18n.resolvedLanguage)}</>}
        </button>)}
      <details open><summary>{t('agsdl.inbox.active')}</summary>
        {sections.active.map(run => <RunRow key={run.key} run={run} />)}
      </details>
      <details><summary>{t('agsdl.inbox.snoozed')}</summary>
        {sections.snoozed.map(thread => <ThreadRow key={thread.key} thread={thread} />)}
      </details>
      <details><summary>{t('agsdl.inbox.finished')}</summary>
        {sections.finished.map(run => <RunRow key={run.key} run={run} />)}
      </details>
      <details><summary>{t('agsdl.inbox.scheduled')}</summary></details>
    </div>
  </nav>;
}
