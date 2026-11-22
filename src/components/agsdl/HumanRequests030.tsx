import { useEffect, useId, useRef, useState } from 'react';
import type { RunAttestedHumanAnswer030, RunHumanOccurrence030, RunHumanRequest030, RunRead030 } from '../../types/agsdlRunUi030';
import {
  humanDuration030, humanRemainingMs030, humanRequestKey030, nativeCommandSummary030, runHumanView030,
  type HumanFormDraft030, type HumanRequestClient030, type HumanSendOutcome030, type ReadHuman030,
} from '../../services/agsdl/humanRequests030';
import { claimHumanAttention030 } from '../../services/agsdl/humanAttention030';
import { notify } from '../ui/toastService';
import { ExecutionHumanRequest, type ExecutionHumanAnswer } from './ExecutionHumanRequest';
import { useAgsdlTranslation } from './useAgsdlTranslation';

export interface HumanRequests030Props {
  requests: RunRead030<readonly RunHumanRequest030[]>;
  client: HumanRequestClient030;
  /** Navigate to this exact scope/request, including from the notification centre. */
  onOpenRequest: (target: Parameters<ReadHuman030>[0]) => void | Promise<void>;
  onOpenOccurrence: (activation: Extract<RunHumanOccurrence030['activation'], { kind: 'available' }>) => void;
  showRequest?: (request: RunHumanRequest030) => boolean;
  showOccurrence?: (occurrence: RunHumanOccurrence030) => boolean;
}

function AttestedAnswer({ answer }: { answer: RunAttestedHumanAnswer030 }) {
  const { t } = useAgsdlTranslation();
  const a = answer.answer;
  return <div className="space-y-1 rounded border border-border p-2" data-human-answer>
    <h4 className="font-medium">{t('agsdl.human030.recordedAnswer')}</h4>
    {a.kind === 'question' ? <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{a.answerJson}</p> : <>
      <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{a.kind === 'approval' ? a.choice : t(`agsdl.human030.decision.${a.decision}`)}</p>
      <p>{t('agsdl.human030.comment')}</p>
      <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{a.comment === '' ? t('agsdl.human030.noComment') : a.comment}</p>
    </>}
    <p className="text-muted-foreground">{t(`agsdl.human030.origin.${answer.origin}`)}</p>
  </div>;
}

function HumanRequestCard030({ request: observed, client, fresh, onOpenRequest, onOpenOccurrence, showRequest, showOccurrence }: {
  request: RunHumanRequest030; client: HumanRequestClient030; fresh: boolean;
  onOpenRequest: HumanRequests030Props['onOpenRequest'];
  onOpenOccurrence: HumanRequests030Props['onOpenOccurrence'];
  showRequest: HumanRequests030Props['showRequest'];
  showOccurrence: HumanRequests030Props['showOccurrence'];
}) {
  const { t } = useAgsdlTranslation();
  const headingId = useId();
  const card = useRef<HTMLElement>(null);
  const [readback, setReadback] = useState<{ basis: RunHumanRequest030; current: RunHumanRequest030 }>();
  const request = readback && (readback.basis === observed || BigInt(readback.current.revision) > BigInt(observed.revision)) ? readback.current : observed;
  const visible = !showRequest || showRequest(request);
  const [draft, setDraft] = useState<HumanFormDraft030>(() => {
    try { return client.loadDraft(observed) ?? { choice: null, text: '' }; }
    catch { return { choice: null, text: '' }; }
  });
  const [storageFailed, setStorageFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [readFailed, setReadFailed] = useState(false);
  const [outcome, setOutcome] = useState<HumanSendOutcome030['result']>(null);
  const working = useRef(false);
  let blocked = true;
  let revisionStale = false;
  let storageUnavailable = false;
  try { blocked = client.blocked(request); revisionStale = client.stale(request); } catch { storageUnavailable = true; }
  const content = request.content;
  const command = content.kind === 'actionApproval' ? nativeCommandSummary030(content.actionJson) : null;
  const qualified = content.kind !== 'unclassified' && (content.kind !== 'question' || content.answerContract.kind === 'available');
  const open = visible && request.state.kind === 'open' && fresh && !readFailed && !revisionStale && !blocked && !storageFailed && !storageUnavailable && qualified && !busy;
  const view = runHumanView030(request, { plan: t('agsdl.human030.plan'), question: t('agsdl.human030.question'), unknown: t('agsdl.human030.unknown') });

  useEffect(() => {
    if (!visible || !fresh || request.state.kind !== 'open' || !qualified) return;
    if (!claimHumanAttention030(request)) return;
    notify.actionRequired(t('agsdl.human030.notification'), {
      description: view.title,
      notificationKey: `human030:${humanRequestKey030(request)}`,
      actions: [{ label: t('agsdl.human030.openRequest'), onClick: async () => {
        await onOpenRequest({ scope: request.scope, requestId: request.id });
        card.current?.focus();
        card.current?.scrollIntoView?.({ block: 'nearest' });
      } }],
    });
  }, [visible, fresh, request, qualified, view.title, onOpenRequest, t]);

  // Readback can move the same request ID to a different instance. Keep the
  // observation while this card is mounted so the previous response stays closed.
  if (!visible) return null;

  const saveDraft = (next: HumanFormDraft030) => {
    setDraft(next);
    try { client.saveDraft(request, next); setStorageFailed(false); }
    catch { setStorageFailed(true); }
  };
  const send = async (answer: ExecutionHumanAnswer) => {
    if (!open || working.current) return;
    working.current = true; setBusy(true);
    try {
      const next = await client.send(request, answer);
      setOutcome(next.result); setReadFailed(next.readFailed);
      if (next.current) setReadback({ basis: observed, current: next.current });
    } catch {
      setReadFailed(true);
      setOutcome({ kind: 'uncertain', code: 'UNCERTAIN', receiptId: null });
    } finally { working.current = false; setBusy(false); }
  };
  const refresh = async () => {
    if (working.current) return;
    working.current = true; setBusy(true);
    try { setReadback({ basis: observed, current: await client.refresh(request) }); setReadFailed(false); }
    catch { setReadFailed(true); }
    finally { working.current = false; setBusy(false); }
  };
  const state = request.state;
  const resolution = 'resolution' in state ? state.resolution : null;
  const answer = state.kind === 'submitted' ? state.answer : resolution?.answer;
  const clock = request.clock.kind === 'available' ? request.clock.value : null;
  const remaining = clock ? humanRemainingMs030(clock) : null;
  return <article ref={card} tabIndex={-1} aria-labelledby={headingId} className="min-w-0 space-y-2 rounded border border-border p-2 text-xs focus:outline focus:outline-1 focus:outline-ring" data-human-request={request.id}>
    <h3 id={headingId} className="font-medium">{t(`agsdl.human030.type.${content.kind}`)}</h3>
    <p role="status">{t(`agsdl.human030.state.${state.kind}`)}</p>
    {command && <div className="space-y-2" data-native-command-summary>
      <p>{t('agsdl.human030.nativeCommandHint')}</p>
      <dl className="space-y-1 [overflow-wrap:anywhere]">
        <dt className="text-muted-foreground">{t('agsdl.human030.command')}</dt><dd className="whitespace-pre-wrap">{command.command}</dd>
        <dt className="text-muted-foreground">{t('agsdl.human030.file')}</dt><dd className="whitespace-pre-wrap">{command.file}</dd>
        <dt className="text-muted-foreground">{t('agsdl.human030.cwd')}</dt><dd className="whitespace-pre-wrap">{command.cwd}</dd>
      </dl>
    </div>}
    {state.kind !== "open" && <details><summary>{t("agsdl.human030.draftHint")}</summary>
      <ExecutionHumanRequest request={view} labels={{ choice: t("agsdl.human030.choice"), comment: t("agsdl.human030.comment"), answer: t("agsdl.human030.answer"), submit: t("agsdl.human030.submit"), approve: t("agsdl.human030.approve"), reject: t("agsdl.human030.reject"), failed: t("agsdl.human030.sendUncertain") }} open={false} onAnswer={send} draft={draft} />
    </details>}
    {state.kind === "open" && <ExecutionHumanRequest request={view} labels={{ choice: t('agsdl.human030.choice'), comment: t('agsdl.human030.comment'), answer: t('agsdl.human030.answer'),
      submit: t('agsdl.human030.submit'), approve: t('agsdl.human030.approve'), reject: t('agsdl.human030.reject'), failed: t('agsdl.human030.sendUncertain'),
      messageDetails: content.kind === 'flowChoice' ? t('agsdl.human030.messageDetails') : content.kind === 'actionApproval' ? t('agsdl.human030.actionDetails')
        : view.kind === 'plan' ? t('agsdl.human030.planDetails') : view.kind === 'question' ? t('agsdl.human030.questionDetails') : undefined }}
      open={open} onAnswer={send} draft={draft} onDraftChange={saveDraft} />}
    {state.kind !== 'open' && (draft.choice !== null || draft.text !== '') && <p className="text-muted-foreground">{t('agsdl.human030.draftHint')}</p>}
    {resolution && <p data-human-reason>{t(`agsdl.human030.reason.${resolution.reason}`)}</p>}
    {answer && <AttestedAnswer answer={answer} />}
    {resolution && !answer && <p>{t('agsdl.human030.noAnswer')}</p>}
    {resolution && answer && <p>{t(resolution.accepted ? 'agsdl.human030.answerAccepted' : 'agsdl.human030.answerNotAccepted')}</p>}
    {state.kind === 'uncertain' && <p>{t(state.phase === 'afterResolution' ? 'agsdl.human030.uncertainAfter' : 'agsdl.human030.uncertainBefore')}</p>}
    {outcome?.kind === 'refused' && (state.kind === 'open' || readback?.basis === observed) && <div role="alert">
      <p>{t(state.kind === 'open' && (outcome.refusal.code === 'CONFLICT' || outcome.refusal.code === 'REVISION_CONFLICT') ? 'agsdl.human030.conflict' : 'agsdl.human030.refused')}</p>
      <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{outcome.refusal.message}</p>
    </div>}
    {state.kind === 'open' && !storageUnavailable && (blocked || outcome?.kind === 'uncertain') && <p role="alert">{t('agsdl.human030.sendUncertain')}</p>}
    {(storageFailed || storageUnavailable) && <p role="alert">{t('agsdl.human030.storageFailed')}</p>}
    {(!fresh || readFailed || revisionStale) && <p role="alert">{t('agsdl.human030.stale')}</p>}
    <details><summary>{t("agsdl.viewer.technicalDetails")}</summary>
    {request.occurrences.map((occurrence, index) => {
      if (showOccurrence && !showOccurrence(occurrence)) return null;
      const activation = occurrence.activation;
      return <p key={occurrence.workId}>{activation.kind === 'available'
        ? <button type="button" className="underline disabled:opacity-50" disabled={!!showOccurrence && !fresh} onClick={() => onOpenOccurrence(activation)}>{t('agsdl.human030.openOccurrence', { number: index + 1 })}</button>
        : t('agsdl.human030.occurrenceUnavailable', { number: index + 1 })}</p>;
    })}
    {content.kind === 'actionApproval' && <p className="text-muted-foreground">{t('agsdl.human030.askHint')}</p>}
    {content.kind === 'flowChoice' && <p className="text-muted-foreground">{t('agsdl.human030.choiceHint')}</p>}
    {content.kind === 'plan' && <p className="text-muted-foreground">{t('agsdl.human030.planHint')}</p>}
    {content.kind === 'unclassified' && <p role="alert">{t('agsdl.human030.purposeUnavailable')}</p>}
    {content.kind === 'question' && (content.answerContract.kind === 'available' ? <>
      <p>{t('agsdl.human030.questionHint')}</p>
      <details className="min-w-0"><summary>{t('agsdl.human030.answerFormat')}</summary>
        <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{content.answerContract.value.protocol}</p>
        <pre className="whitespace-pre-wrap [overflow-wrap:anywhere]">{content.answerContract.value.schemaJson}</pre>
      </details>
    </> : <p role="alert">{t('agsdl.human030.questionUnavailable')}</p>)}
    <div className="space-y-1 text-muted-foreground" data-human-clock>
      <p>{t('agsdl.human030.clockHint')}</p>
      {!clock ? <p>{t('agsdl.human030.clockUnavailable')}</p> : <>
        <p>{remaining === null ? t('agsdl.human030.noDeadline') : t('agsdl.human030.remaining', { duration: humanDuration030(remaining) })}</p>
        {remaining === '0' && state.kind === 'open' && <p>{t('agsdl.human030.deadlineObserved')}</p>}
        {clock.works.map((work, index) => <p key={work.workId}>
          {t(work.machinePaused ? 'agsdl.human030.machinePaused' : 'agsdl.human030.machineRunning', { number: index + 1 })}{' '}
          {work.machineRemainingMs === null ? t('agsdl.human030.noBudget') : t('agsdl.human030.machineRemaining', { duration: humanDuration030(work.machineRemainingMs) })}
        </p>)}
      </>}
    </div>
    </details>
    <button type="button" className="rounded border border-border px-2 py-1 disabled:opacity-50" disabled={busy} onClick={() => void refresh()}>{t('agsdl.human030.refresh')}</button>
  </article>;
}

/** Receives only a complete typed read. Retained stale requests remain readable
 * but cannot be answered. The execution store and IPC stay outside this view. */
export function HumanRequests030({ requests, client, onOpenRequest, onOpenOccurrence, showRequest, showOccurrence }: HumanRequests030Props) {
  const { t } = useAgsdlTranslation();
  const items = requests.kind === 'ready' ? requests.value : requests.kind === 'loading' || requests.kind === 'stale' ? requests.retained : null;
  return <section className="min-w-0 space-y-2 text-xs" aria-label={t('agsdl.human030.title')}>
    <h2 className="font-medium">{t('agsdl.human030.title')}</h2>
    {requests.kind === 'error' && <p role="alert">{t('agsdl.run030.readFailed')}</p>}
    {requests.kind === 'unavailable' && <p>{t('agsdl.human030.unavailable')}</p>}
    {requests.kind === 'loading' && <p role="status">{t('agsdl.human030.loading')}</p>}
    {requests.kind === 'stale' && <p role="alert">{t('agsdl.human030.stale')}</p>}
    {requests.kind === 'ready' && items?.length === 0 && <p>{t('agsdl.human030.empty')}</p>}
    {items?.map(request => <HumanRequestCard030 key={humanRequestKey030(request)} request={request} client={client} fresh={requests.kind === 'ready'} onOpenRequest={onOpenRequest} onOpenOccurrence={onOpenOccurrence} showRequest={showRequest} showOccurrence={showOccurrence} />)}
  </section>;
}
