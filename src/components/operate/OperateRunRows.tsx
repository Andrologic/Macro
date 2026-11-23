import { Suspense, lazy, useRef, useState, type KeyboardEvent } from 'react';
import { formatRelativeTimeShort } from '../../i18n/format';
import { isFinishedOperateRun, type OperateRunRow } from '../../services/operateInboxModel';
import { architectLaunch } from '../../services/ipc/architectLaunch';
import { workflowRunAccessSnapshot030 } from '../../services/workflowAgentTasks';
import { operatorErrorKey030 } from '../../services/agsdl/operator030';
import { OperateThreadRowView } from './OperateAttentionRows';
import {
  controlOperateRun, deleteOperateRun, markOperateRunOpened, openOperateRun, terminateOperateRun,
} from '../../stores/useOperateInboxStore';
import { cn } from '../../utils/cn';
import { ConfirmPromptModal } from '../ui/ConfirmPromptModal';
import { Icon, type IconName } from '../ui/Icon';
import { SidebarMenu, sidebarMenuPosition, type SidebarMenuPosition } from '../ui/SidebarMenu';
import { notify } from '../ui/toastService';
import {
  OperateMenuItem, operateRowActionClass, operateRowFocusClass, UnreadDot, useOperateFormat,
} from './OperateColumnParts';
import { OperateMenuSeparator } from './OperateRow';
import {
  formatOperateElapsed, operateRunPresentation, operateToneClass,
} from './operateColumnModel';
import { useAgsdlTranslation } from '../agsdl/useAgsdlTranslation';

const ArchiveRunSecrets = lazy(() => import('./ArchitectLaunchDialog').then(module => ({ default: module.ArchiveRunSecrets })));

const runTitle = (run: OperateRunRow) => `${run.systemLabel} · ${run.runLabel}`;

/** A run of "En cours" or "Terminés": the title opens the graph, the chevron unfolds its threads. */
export function OperateRunRowView({ run, expanded, onToggle, nowMs }: {
  run: OperateRunRow;
  expanded: boolean;
  onToggle: () => void;
  nowMs: number;
}) {
  const { t } = useAgsdlTranslation();
  const { locale, full } = useOperateFormat();
  const openRef = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<SidebarMenuPosition | null>(null);
  const [confirming, setConfirming] = useState<'stop' | 'delete' | null>(null);
  const [editingSecrets, setEditingSecrets] = useState(false);
  const archiveRun = run.location.kind === 'local' && workflowRunAccessSnapshot030()
    .find(entry => entry.archiveRuns?.has(run.scope.systemStartId))?.archiveRuns?.get(run.scope.systemStartId);
  const [pending, setPending] = useState(false);
  const [failedAction, setFailedAction] = useState(false);
  const title = runTitle(run);
  const finished = isFinishedOperateRun(run.status);
  const { icon, tone, spin } = operateRunPresentation[run.status];
  const hasThreads = run.threads.length > 0;
  const waiting = run.threads.some(thread => thread.reason === 'question' || thread.reason === 'approval');
  const stopping = pending || run.status === 'stopping';
  const failed = () => notify.error(t('agsdl.inbox.actionFailed'));
  const statusWord = run.status === 'active' || run.status === 'succeeded' ? null : t(`agsdl.inbox.status.${run.status}`);
  const details: { key: string; icon?: IconName; text: string }[] = [
    ...run.location.kind === 'remote' ? [{ key: 'location', icon: 'server' as const, text: t('agsdl.inbox.onMachine', { machine: run.location.label }) }] : [],
    ...statusWord ? [{ key: 'status', text: statusWord }] : [],
    ...run.stale ? [{ key: 'stale', text: t('agsdl.run030.staleShort') }] : [],
  ];
  const at = finished ? run.finishedAtMs : run.startedAtMs;
  const time = at === null ? null : finished ? formatRelativeTimeShort(at, nowMs, locale) : formatOperateElapsed(nowMs - at, locale) ?? t('agsdl.inbox.justNow');
  // → / ← unfold and fold, as on the section headers.
  const arrows = (event: KeyboardEvent) => {
    if (!hasThreads || (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft')) return;
    if ((event.key === 'ArrowRight') !== expanded) { event.preventDefault(); onToggle(); }
  };
  const submit = async () => {
    setPending(true); setFailedAction(false);
    try {
      if (confirming === 'delete') await deleteOperateRun(run);
      else await terminateOperateRun(run);
      setConfirming(null);
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'DELETE_CLEANUP_PENDING') {
        notify.warning(t('agsdl.inbox.deleteDialog.cleanupPending'));
        setConfirming(null);
      } else setFailedAction(true);
    } finally { setPending(false); }
  };
  const action = run.operatorAction;
  const control = async () => {
    if (!action) return;
    setPending(true);
    try { await controlOperateRun(run, action); }
    catch (error) { notify.error(t(`agsdl.operator.${operatorErrorKey030(error)}`)); }
    finally { setPending(false); }
  };
  const dialog = confirming === 'delete' ? 'deleteDialog' : 'terminateDialog';
  return <div>
    <div data-operate-run className="group/run relative flex min-w-0 items-start rounded-md text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
      onContextMenu={event => { event.preventDefault(); event.stopPropagation(); setMenu(sidebarMenuPosition(event)); }}>
      {hasThreads
        ? <button type="button" aria-expanded={expanded} aria-label={`${t('agsdl.run030.instances')} · ${title}`}
          title={t('agsdl.run030.instances')} onClick={onToggle} onKeyDown={arrows}
          className={cn('flex h-8 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground', operateRowFocusClass)}>
          <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={12} /></button>
        : <span aria-hidden="true" className="w-6 shrink-0" />}
      <button ref={openRef} type="button" onClick={() => openOperateRun(run)} onKeyDown={arrows} title={title}
        aria-label={statusWord ? `${title} · ${statusWord}` : title}
        className={cn('flex min-w-0 flex-1 items-start gap-2 py-1.5 pr-2 text-left', operateRowFocusClass)}>
        <Icon name={icon} size={12} className={cn('mt-1 shrink-0', operateToneClass[tone], spin && 'animate-spin')} />
        <span className="min-w-0 flex-1">
          <span className="flex min-h-5 items-center gap-1.5">
            <span className={cn('min-w-0 flex-1 truncate text-xs text-foreground', run.unopened ? 'font-semibold' : 'font-medium')}>{title}</span>
            {run.unopened && <UnreadDot />}
            {time && <span className={cn('shrink-0 text-[10px] tabular-nums', 'group-hover/run:opacity-0 group-focus-within/run:opacity-0', menu && 'opacity-0')}
              title={at === null ? undefined : full(at)}>{time}</span>}
          </span>
          {details.length > 0 && <span className="flex min-h-4 items-center gap-1.5 text-[10px] text-muted-foreground">
            {details.map(item => <span key={item.key} className="flex min-w-0 items-center gap-0.5 truncate">
              {item.icon && <Icon name={item.icon} size={11} className="shrink-0" />}<span className="truncate">{item.text}</span></span>)}
          </span>}
        </span>
      </button>
      <div className={cn('absolute right-1 top-1 z-10 flex rounded bg-accent', menu || stopping ? 'opacity-100' : 'opacity-0 group-hover/run:opacity-100 group-focus-within/run:opacity-100')}>
        <button type="button" aria-haspopup="menu" aria-expanded={menu !== null} disabled={stopping && !menu}
          title={t('agsdl.inbox.rowActions', { name: title })} aria-label={t('agsdl.inbox.rowActions', { name: title })}
          className={operateRowActionClass}
          onClick={event => {
            const rect = event.currentTarget.getBoundingClientRect();
            setMenu(current => current ? null : { left: rect.right - 208, top: rect.bottom + 4 });
          }}>
          <Icon name={stopping ? 'loader' : 'more-horizontal'} size={12} className={cn(stopping && 'animate-spin')} />
        </button>
      </div>
      {menu && <SidebarMenu position={menu} onClose={() => setMenu(null)} aria-label={title} className="w-52">
        <OperateMenuItem icon="workflow" onClick={() => { setMenu(null); openOperateRun(run); }}>{t('agsdl.inbox.menu.openRun')}</OperateMenuItem>
        {run.unopened && <OperateMenuItem icon="check" onClick={() => { setMenu(null); void markOperateRunOpened(run).catch(failed); }}>{t('agsdl.inbox.menu.markRead')}</OperateMenuItem>}
        {archiveRun && <>
          <OperateMenuItem icon="folder-open" onClick={() => { setMenu(null); void architectLaunch.openFolder(run.scope.systemStartId).catch(failed); }}>
            {t('agsdl.launch.openFolder')}
          </OperateMenuItem>
          <OperateMenuItem icon="lock" onClick={() => { setMenu(null); setEditingSecrets(true); }}>
            {t('agsdl.launch.secrets')}
          </OperateMenuItem>
        </>}
        {action && <OperateMenuItem icon={action.kind === 'resumeRun' ? 'play' : 'pause'} disabled={pending}
          onClick={() => { setMenu(null); void control(); }}>{t(`agsdl.operator.${action.kind}`)}</OperateMenuItem>}
        {run.canDelete && <>
          <OperateMenuSeparator />
          <OperateMenuItem icon="trash" danger disabled={pending} onClick={() => {
            setMenu(null); setFailedAction(false); setConfirming('delete');
          }}>{t('agsdl.inbox.menu.deleteRun')}</OperateMenuItem>
        </>}
        {run.canTerminate && <>
          <OperateMenuSeparator />
          <OperateMenuItem icon="square" danger disabled={stopping} onClick={() => { setMenu(null); setFailedAction(false); setConfirming('stop'); }}>
            {t('agsdl.inbox.menu.terminate')}</OperateMenuItem>
        </>}
      </SidebarMenu>}
    </div>
    {expanded && hasThreads && <ul className="space-y-0.5 pb-1 pl-4">
      {run.threads.map(thread => <li key={thread.key}><OperateThreadRowView thread={thread} variant="run" runFinished={finished} /></li>)}
    </ul>}
    {editingSecrets && archiveRun && <Suspense fallback={null}>
      <ArchiveRunSecrets version={archiveRun.version} onClose={() => setEditingSecrets(false)} />
    </Suspense>}
    <ConfirmPromptModal isOpen={confirming !== null} title={t(`agsdl.inbox.${dialog}.title`)}
      description={t(`agsdl.inbox.${dialog}.description`, { run: title })}
      confirmLabel={t(`agsdl.inbox.${dialog}.confirm`)} cancelLabel={t('agsdl.cancel')} confirmVariant="error"
      isSubmitting={pending} returnFocusRef={openRef}
      onCancel={() => setConfirming(null)} onConfirm={() => void submit()}>
      {confirming === 'stop' && waiting && <p className="text-xs text-muted-foreground">{t('agsdl.inbox.terminateDialog.waiting')}</p>}
      {failedAction && <p role="alert" className="text-[11px] text-red-400">{t(`agsdl.inbox.${dialog}.failed`)}</p>}
    </ConfirmPromptModal>
  </div>;
}
