import { useRef, useState } from 'react';
import type { RuntimeInstance030 } from '../../types/generated/ipc';
import type { RunInspection030 } from '../../services/agsdl/runtimeProjection030';
import { instanceOperatorState030, operatorErrorKey030, runOperatorAction030, threadOperatorAction030, type ObservedOperatorAction030 } from '../../services/agsdl/operator030';
import { retainedRunValue030 } from '../../services/agsdl/runtimeProjection030';
import { runCaptureKey030 } from '../../services/agsdl/runGraphProjection030';
import { controlOperateRun, terminateOperateRun } from '../../stores/useOperateInboxStore';
import { ConfirmPromptModal } from '../ui/ConfirmPromptModal';
import { PanelHeaderIconButton } from '../ui/PanelHeaderIconButton';
import { SidebarMenu, type SidebarMenuPosition } from '../ui/SidebarMenu';
import { notify } from '../ui/toastService';
import { OperateMenuItem } from '../operate/OperateColumnParts';
import { useAgsdlTranslation } from './useAgsdlTranslation';

export function RunOperatorControls030({ run, stale, local, conversationId, instance }: {
  run: RunInspection030;
  stale: boolean;
  local: boolean;
  conversationId?: string;
  instance?: RuntimeInstance030;
}) {
  const { t } = useAgsdlTranslation();
  const button = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<SidebarMenuPosition | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [failedStop, setFailedStop] = useState(false);
  const { state } = run;
  const canAct = local && !stale && !state.stopping && state.verdict === null && state.ownerStatus === 'live';
  const action = canAct ? instance ? threadOperatorAction030(run, instance) : runOperatorAction030(run) : undefined;
  const target = { scope: state.scope, conversationId };
  const apply = async (action: ObservedOperatorAction030) => {
    setBusy(true);
    setMenu(null);
    try { await controlOperateRun(target, action); }
    catch (error) { notify.error(t(`agsdl.operator.${operatorErrorKey030(error)}`)); }
    finally { setBusy(false); }
  };
  const stop = async () => {
    setBusy(true);
    setFailedStop(false);
    try {
      await terminateOperateRun({ ...target, key: JSON.stringify([null, runCaptureKey030(state.scope)]), canTerminate: canAct });
      setConfirm(false);
    } catch { setFailedStop(true); }
    finally { setBusy(false); }
  };
  const controlButton = 'rounded border border-border px-2 py-1 text-xs hover:bg-accent disabled:opacity-60';
  if (instance) {
    const hold = instanceOperatorState030(run, instance);
    return <>
      {hold && <p role="status">{t(`agsdl.operator.${hold}`)}</p>}
      {action && <button type="button" className={controlButton} disabled={busy} onClick={() => void apply(action)}>
        {t(`agsdl.operator.${action.kind}`)}
      </button>}
    </>;
  }
  const expiring = (retainedRunValue030(state.humans) ?? []).some(request =>
    request.content.kind === 'flowChoice' && request.state.kind === 'open'
    && request.clock.kind === 'available' && request.clock.value.timeoutMs !== null);
  if (!canAct && !state.paused && !state.interruptedWhilePaused) return null;
  return <div className="flex items-start gap-2 rounded bg-background/95 text-xs">
    {state.interruptedWhilePaused && <span role="status" className="px-2 py-1">{t('agsdl.operator.interrupted')}</span>}
    {state.paused && <div className="max-w-64 px-2 py-1 text-amber-500">
      <p role="status">{t('agsdl.operator.paused')}</p>
      {expiring && <p>{t('agsdl.operator.approvalsExpiring')}</p>}
      {action && <button type="button" className={controlButton} disabled={busy} onClick={() => void apply(action)}>
        {t('agsdl.operator.resumeWork')}
      </button>}
    </div>}
    {canAct && <PanelHeaderIconButton ref={button} icon="more-horizontal" label={t('agsdl.operator.runMenu')} disabled={busy}
      pressed={menu !== null} aria-haspopup="menu" aria-expanded={menu !== null} onClick={event => {
        const rect = event.currentTarget.getBoundingClientRect();
        setMenu(current => current ? null : { left: rect.right - 208, top: rect.bottom + 4 });
      }} />}
    {menu && <SidebarMenu position={menu} onClose={() => setMenu(null)} aria-label={t('agsdl.operator.runMenu')} className="w-52">
      {action && <OperateMenuItem icon={action.kind === 'resumeRun' ? 'play' : 'pause'} onClick={() => void apply(action)}>
        {t(`agsdl.operator.${action.kind}`)}
      </OperateMenuItem>}
      <OperateMenuItem icon="square" danger onClick={() => { setMenu(null); setConfirm(true); }}>
        {t('agsdl.inbox.menu.terminate')}
      </OperateMenuItem>
    </SidebarMenu>}
    <ConfirmPromptModal isOpen={confirm} title={t('agsdl.inbox.terminateDialog.title')}
      description={t('agsdl.operator.stopDescription')}
      confirmLabel={t('agsdl.inbox.terminateDialog.confirm')} cancelLabel={t('agsdl.cancel')}
      confirmVariant="error" isSubmitting={busy} returnFocusRef={button} onCancel={() => setConfirm(false)}
      onConfirm={() => void stop()}>
      {failedStop && <p role="alert">{t('agsdl.inbox.terminateDialog.failed')}</p>}
    </ConfirmPromptModal>
  </div>;
}
