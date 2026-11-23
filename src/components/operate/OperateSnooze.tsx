import { useMemo, useState, type RefObject } from 'react';
import { operateSnoozeDeadlineWarning, type OperateThreadRow } from '../../services/operateInboxModel';
import { snoozeOperateThread } from '../../stores/useOperateInboxStore';
import { ConfirmPromptModal } from '../ui/ConfirmPromptModal';
import { Icon } from '../ui/Icon';
import { Input } from '../ui/Input';
import { SidebarMenu, type SidebarMenuPosition } from '../ui/SidebarMenu';
import { notify } from '../ui/toastService';
import { OperateMenuItem, useOperateFormat } from './OperateColumnParts';
import {
  defaultOperateSnoozeInput, operateSnoozeOptions, parseOperateSnoozeInput, type OperateSnoozeChoice,
} from './operateColumnModel';
import { useAgsdlTranslation } from '../agsdl/useAgsdlTranslation';

/** Quick choices. Nothing is forbidden: a choice past an approval deadline is only flagged. */
export function OperateSnoozeMenu({ thread, position, onClose, onCustom }: {
  thread: OperateThreadRow;
  position: SidebarMenuPosition;
  onClose: () => void;
  onCustom: () => void;
}) {
  const { t } = useAgsdlTranslation();
  const { clock, moment } = useOperateFormat();
  const [openedAt] = useState(Date.now);
  const deadline = thread.responseDeadlineMs;
  const options = useMemo(() => operateSnoozeOptions(openedAt, deadline), [openedAt, deadline]);
  const label = (id: OperateSnoozeChoice, untilMs: number) => id === 'hour'
    ? t('agsdl.inbox.snoozeMenu.hour') : t(`agsdl.inbox.snoozeMenu.${id}`, { time: clock(untilMs) });
  const warning = deadline === null ? undefined : t('agsdl.inbox.snoozeMenu.deadlineWarn', { time: moment(deadline) });
  const choose = (untilMs: number) => {
    onClose();
    // The row leaving "À traiter" is the confirmation; only a failure is announced.
    void snoozeOperateThread(thread, untilMs).catch(() => notify.error(t('agsdl.inbox.actionFailed')));
  };
  return <SidebarMenu position={position} onClose={onClose} aria-label={t('agsdl.inbox.snoozeMenu.title')} className="w-52">
    <p className="px-2 py-1 text-[10px] font-medium text-muted-foreground">{t('agsdl.inbox.snoozeMenu.title')}</p>
    {options.map(option => <OperateMenuItem key={option.id} icon="clock" title={option.warns ? warning : undefined}
      onClick={() => choose(option.untilMs)}>
      <span className="min-w-0 flex-1 truncate">{label(option.id, option.untilMs)}</span>
      {option.warns && <Icon name="triangle-alert" size={11} className="shrink-0 text-amber-500" />}
    </OperateMenuItem>)}
    <OperateMenuItem icon="edit" onClick={() => { onClose(); onCustom(); }}>{t('agsdl.inbox.snoozeMenu.custom')}</OperateMenuItem>
    {deadline !== null && options.some(option => option.warns) &&
      <p className="px-2 pb-1 pt-1.5 text-[10px] text-amber-500">{t('agsdl.inbox.snoozeMenu.deadlineNote', { time: moment(deadline) })}</p>}
  </SidebarMenu>;
}

export function OperateSnoozeDialog({ thread, returnFocusRef, onClose }: {
  thread: OperateThreadRow;
  returnFocusRef: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const { t } = useAgsdlTranslation();
  const { moment } = useOperateFormat();
  const initial = useMemo(() => defaultOperateSnoozeInput(Date.now()), []);
  const [date, setDate] = useState(initial.date);
  const [time, setTime] = useState(initial.time);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const untilMs = parseOperateSnoozeInput(date, time);
  const deadline = Number.isFinite(untilMs) ? operateSnoozeDeadlineWarning(thread, untilMs) : null;
  const submit = async () => {
    if (!(untilMs > Date.now())) { setError(t('agsdl.inbox.snoozeDialog.past')); return; }
    setBusy(true); setError('');
    try { await snoozeOperateThread(thread, untilMs); onClose(); }
    catch { setError(t('agsdl.inbox.actionFailed')); setBusy(false); }
  };
  const field = 'mt-1 h-8 text-xs';
  return <ConfirmPromptModal isOpen title={t('agsdl.inbox.snoozeDialog.title')} returnFocusRef={returnFocusRef}
    confirmLabel={t('agsdl.inbox.snooze')} cancelLabel={t('agsdl.cancel')} isSubmitting={busy}
    onCancel={onClose} onConfirm={() => void submit()}>
    <div className="space-y-3">
      <div className="flex gap-2">
        <label className="min-w-0 flex-1 text-xs text-muted-foreground">{t('agsdl.inbox.snoozeDialog.date')}
          <Input type="date" value={date} className={field} onChange={event => { setDate(event.target.value); setError(''); }} /></label>
        <label className="w-28 shrink-0 text-xs text-muted-foreground">{t('agsdl.inbox.snoozeDialog.time')}
          <Input type="time" value={time} className={field} onChange={event => { setTime(event.target.value); setError(''); }} /></label>
      </div>
      {deadline !== null && <div role="status" className="flex items-start gap-2 rounded-md border border-amber-500/20 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-500">
        <Icon name="triangle-alert" size={12} className="mt-0.5 shrink-0" />
        <span>{t('agsdl.inbox.snoozeDialog.deadlineWarning', { time: moment(deadline) })}</span>
      </div>}
      {error && <p role="alert" className="text-[11px] text-red-400">{error}</p>}
    </div>
  </ConfirmPromptModal>;
}
