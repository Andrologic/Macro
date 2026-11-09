import { useId, useRef, useState, type FormEvent } from 'react';
import type { ExecutionHumanRequestView, ExecutionHumanAnswer, HumanFormDraft030 } from '../../services/agsdl/humanRequests030';
export type { ExecutionHumanRequestView, ExecutionHumanAnswer } from '../../services/agsdl/humanRequests030';

export interface ExecutionHumanRequestLabels {
  choice: string; comment: string; answer: string; submit: string;
  approve: string; reject: string; failed: string;
  messageDetails?: string;
}

/** Key by scope/request, never by revision. A controlled draft also survives
 * unmounting; its owner persists it independently of native answer history. */
export function ExecutionHumanRequest({ request, labels, open, onAnswer, draft, onDraftChange }: {
  request: ExecutionHumanRequestView;
  labels: ExecutionHumanRequestLabels;
  open: boolean;
  onAnswer: (answer: ExecutionHumanAnswer) => Promise<void>;
  draft?: HumanFormDraft030;
  onDraftChange?: (draft: HumanFormDraft030) => void;
}) {
  const id = useId();
  const [localDraft, setLocalDraft] = useState<HumanFormDraft030>({ text: '', choice: null });
  const value = draft ?? localDraft;
  const update = (next: HumanFormDraft030) => { setLocalDraft(next); onDraftChange?.(next); };
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const sending = useRef(false);
  const send = async (answer: ExecutionHumanAnswer) => {
    if (!open || sending.current) return;
    sending.current = true; setBusy(true); setFailed(false);
    try { await onAnswer(answer); } catch { setFailed(true); } finally { sending.current = false; setBusy(false); }
  };
  const validChoice = request.kind === 'approval' && value.choice !== null && request.choices.some(item => item.value === value.choice);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (request.kind === 'approval' && validChoice) void send({ kind: 'approval', choice: value.choice!, comment: value.text });
    if (request.kind === 'question' && value.text.trim()) void send({ kind: 'question', answer: value.text });
  };
  return <form onSubmit={submit} className="my-2 flex min-w-0 flex-col gap-2 rounded border border-border p-2 text-xs">
    <h3 className="break-words font-medium">{request.title}</h3>
    {request.description && <p className="whitespace-pre-wrap break-words text-muted-foreground">{request.description}</p>}
    {labels.messageDetails ? <details>
      <summary className="cursor-pointer">{labels.messageDetails}</summary>
      <p className="mt-1 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{request.message}</p>
    </details> : <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{request.message}</p>}
    {request.kind === 'approval' && <>
      <label htmlFor={`${id}-choice`}>{labels.choice}</label>
      <select id={`${id}-choice`} className="min-w-0 max-w-full rounded border border-border bg-card px-2 py-1" value={validChoice ? String(request.choices.findIndex(item => item.value === value.choice)) : ''}
        onChange={event => update({ ...value, choice: request.choices[Number(event.target.value)].value })} disabled={!open || busy}>
        <option value="" disabled>{labels.choice}</option>
        {request.choices.map((item, index) => <option key={item.value} value={String(index)}>{item.label}</option>)}
      </select>
    </>}
    <label htmlFor={`${id}-text`}>{request.kind === 'question' ? labels.answer : labels.comment}</label>
    <textarea id={`${id}-text`} className="min-h-16 w-full min-w-0 rounded border border-border bg-card px-2 py-1" value={value.text}
      onChange={event => update({ ...value, text: event.target.value })} readOnly={!open || busy} />
    {failed && <p role="alert">{labels.failed}</p>}
    {request.kind === 'plan' || request.kind === 'actionApproval' ? <div className="flex flex-wrap gap-2">
      <button className="rounded border border-border px-2 py-1 disabled:opacity-50" type="button" disabled={!open || busy}
        onClick={() => void send(request.kind === 'plan' ? { kind: 'plan', approve: true, comment: value.text } : { kind: 'decision', decision: 'yes', comment: value.text })}>{labels.approve}</button>
      <button className="rounded border border-border px-2 py-1 disabled:opacity-50" type="button" disabled={!open || busy}
        onClick={() => void send(request.kind === 'plan' ? { kind: 'plan', approve: false, comment: value.text } : { kind: 'decision', decision: 'no', comment: value.text })}>{labels.reject}</button>
    </div> : <button className="self-start rounded border border-border px-2 py-1 disabled:opacity-50" type="submit"
      disabled={!open || busy || (request.kind === 'approval' ? !validChoice : !value.text.trim())}>{labels.submit}</button>}
  </form>;
}
