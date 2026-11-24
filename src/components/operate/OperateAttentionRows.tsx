import { useRef, useState } from 'react';
import type { OperateAttentionRow, OperateThreadRow } from '../../services/operateInboxModel';
import {
  controlOperateRun, markOperateRunOpened, openOperateRun, openOperateThread,
} from '../../stores/useOperateInboxStore';
import { workflowAgentTaskId } from '../../services/workflowAgentTasks';
import { useAppStore } from '../../stores/useAppStore';
import { notify } from '../ui/toastService';
import type { SidebarMenuPosition } from '../ui/SidebarMenu';
import { OperateElapsed, OperateMarkers, OperateMenuItem, useOperateFormat } from './OperateColumnParts';
import { OperateChip, OperateMenuSeparator, OperateRow, OperateRunLink } from './OperateRow';
import { OperateSnoozeDialog, OperateSnoozeMenu } from './OperateSnooze';
import { operatorErrorKey030 } from '../../services/agsdl/operator030';
import { operateReasonPresentation, operateThreadState } from './operateColumnModel';
import { useAgsdlTranslation } from '../agsdl/useAgsdlTranslation';

const systemRunLabel = (item: { systemLabel: string; runLabel: string }) => `${item.systemLabel} · ${item.runLabel}`;

/** A thread listed in "À traiter" or "Reportés". */
export function OperateThreadRowView({ thread, variant, runFinished = false }: {
  thread: OperateThreadRow; variant: 'attention' | 'snoozed' | 'run'; runFinished?: boolean;
}) {
  const { t } = useAgsdlTranslation();
  const { clock, moment, full } = useOperateFormat();
  const selected = useAppStore(state => thread.location.kind === 'local'
    && state.selectedTaskId === workflowAgentTaskId(thread.scope.systemStartId, thread.instanceId));
  const openRef = useRef<HTMLButtonElement>(null);
  const [snoozeMenu, setSnoozeMenu] = useState<SidebarMenuPosition | null>(null);
  const [snoozeDialog, setSnoozeDialog] = useState(false);
  const failed = () => notify.error(t('agsdl.inbox.actionFailed'));
  const [pending, setPending] = useState(false);
  const action = thread.operatorAction;
  const reason = thread.reason ?? 'activity';
  const { icon, tone } = thread.reason || variant !== 'run'
    ? operateReasonPresentation[reason] : { icon: 'message-circle' as const, tone: 'muted' as const };
  const snoozedUntil = thread.facts?.snoozeUntilMs ?? null;
  const reasonWord = variant === 'run' ? t(`agsdl.inbox.threadState.${operateThreadState(thread, runFinished)}`)
    : t(`agsdl.inbox.reason.${reason}`);
  const runLabel = systemRunLabel(thread);
  const returns = variant === 'snoozed' && snoozedUntil !== null
    ? t('agsdl.inbox.returns', { time: new Date(snoozedUntil).toDateString() === new Date().toDateString() ? clock(snoozedUntil) : moment(snoozedUntil) })
    : null;
  const canSnooze = thread.canSnooze;
  const startSnooze = (position: SidebarMenuPosition) => setSnoozeMenu(position);
  const applyControl = async () => {
    if (!action || pending) return;
    setPending(true);
    try { await controlOperateRun(thread, action); }
    catch (error) { notify.error(t(`agsdl.operator.${operatorErrorKey030(error)}`)); }
    finally { setPending(false); }
  };
  return <>
    <OperateRow icon={icon} tone={tone} title={thread.agentLabel} selected={selected} dimmed={thread.hidden && variant !== 'attention'}
      openLabel={`${thread.agentLabel} · ${reasonWord}`} openTitle={`${thread.agentLabel} · ${runLabel}`}
      openRef={openRef} onOpen={() => void openOperateThread(thread).catch(failed)}
      markers={<OperateMarkers hidden={thread.hidden} location={thread.location} />}
      trailing={variant === 'attention' ? <OperateElapsed ms={thread.elapsedMs} at={thread.activityAtMs} /> : undefined}
      detail={<OperateRunLink label={runLabel} onOpen={() => openOperateRun(thread)} />}
      chip={returns
        ? <OperateChip label={returns} tone="muted" title={snoozedUntil === null ? undefined : t('agsdl.inbox.returns', { time: full(snoozedUntil) })} />
        : <OperateChip label={reasonWord} tone={tone} />}
      quickAction={canSnooze && variant === 'attention'
        ? { icon: 'clock', label: t('agsdl.inbox.snooze'), onClick: event => {
          const rect = event.currentTarget.getBoundingClientRect();
          startSnooze({ left: rect.right - 208, top: rect.bottom + 4 });
        } } : undefined}
      menuLabel={thread.agentLabel}
      renderMenu={(close, position) => <>
        <OperateMenuItem icon="message-circle" onClick={() => { close(); void openOperateThread(thread).catch(failed); }}>{t('agsdl.inbox.menu.openThread')}</OperateMenuItem>
        <OperateMenuItem icon="workflow" onClick={() => { close(); openOperateRun(thread); }}>{t('agsdl.inbox.menu.openRun')}</OperateMenuItem>
        {action && <OperateMenuItem icon={action.kind === 'resumeWork' ? 'play' : 'pause'} disabled={pending}
          onClick={() => { close(); void applyControl(); }}>{t(`agsdl.operator.${action.kind}`)}</OperateMenuItem>}
        {canSnooze && <>
          <OperateMenuSeparator />
          <OperateMenuItem icon="clock" onClick={() => { close(); startSnooze(position); }}>
            {t(variant === 'snoozed' ? 'agsdl.inbox.menu.editSnooze' : 'agsdl.inbox.menu.snooze')}</OperateMenuItem>
        </>}
      </>} />
    {snoozeMenu && <OperateSnoozeMenu thread={thread} position={snoozeMenu} onClose={() => setSnoozeMenu(null)}
      onCustom={() => setSnoozeDialog(true)} />}
    {snoozeDialog && <OperateSnoozeDialog thread={thread} returnFocusRef={openRef} onClose={() => setSnoozeDialog(false)} />}
  </>;
}

type RunAttention = Extract<OperateAttentionRow, { kind: 'runAttention' }>;
/**
 * A run-level item: a finished run not opened yet, or a request the engine could
 * not tie to a thread. It has no agent, so the run itself is the title.
 */
export function OperateRunAttentionRowView({ item }: { item: RunAttention }) {
  const { t } = useAgsdlTranslation();
  const { full } = useOperateFormat();
  const { run } = item;
  const { icon, tone } = operateReasonPresentation[item.reason];
  const finished = item.reason === 'finished';
  const title = systemRunLabel(run);
  const reasonWord = t(`agsdl.inbox.reason.${item.reason}`);
  const failed = () => notify.error(t('agsdl.inbox.actionFailed'));
  const markedAt = finished ? run.finishedAtMs : run.startedAtMs;
  return <OperateRow icon={icon} tone={tone} title={title} unread={finished}
    openLabel={`${title} · ${reasonWord}`} onOpen={() => openOperateRun(run, item.requestId)}
    markers={<OperateMarkers location={run.location} />}
    trailing={<OperateElapsed ms={item.elapsedMs} at={markedAt} />}
    detail={run.location.kind === 'remote'
      ? <span title={t('agsdl.inbox.onMachine', { machine: run.location.label })} className="block truncate text-[10px] text-muted-foreground">
        {t('agsdl.inbox.onMachine', { machine: run.location.label })}</span>
      // A finished run is already named by its motive; an open request also tells the run is still going.
      : finished ? undefined
        : <span className="block truncate text-[10px] text-muted-foreground" title={markedAt === null ? undefined : full(markedAt)}>{t(`agsdl.inbox.status.${run.status}`)}</span>}
    chip={<OperateChip label={reasonWord} tone={tone} />}
    menuLabel={title}
    renderMenu={close => <>
      <OperateMenuItem icon="workflow" onClick={() => { close(); openOperateRun(run, item.requestId); }}>{t('agsdl.inbox.menu.openRun')}</OperateMenuItem>
      {finished && <OperateMenuItem icon="check" onClick={() => { close(); void markOperateRunOpened(run).catch(failed); }}>{t('agsdl.inbox.menu.markRead')}</OperateMenuItem>}
    </>} />;
}
