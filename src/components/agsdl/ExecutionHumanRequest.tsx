import { useId, useRef, useState, type FormEvent } from 'react';
import type { ExecutionHumanRequestView, ExecutionHumanAnswer } from '../../services/agsdl/humanRequests030';
export type { ExecutionHumanRequestView, ExecutionHumanAnswer } from '../../services/agsdl/humanRequests030';

export interface ExecutionHumanRequestLabels {
  choice: string; comment: string; answer: string; submit: string;
  approve: string; reject: string; failed: string;
}

/** Mount with a key unique to the run and request, not its revision. This keeps
 * the draft when the native request is refreshed after a conflicting decision. */
export function ExecutionHumanRequest({ request, labels, open, onAnswer }: {
  request: ExecutionHumanRequestView;
  labels: ExecutionHumanRequestLabels;
  open: boolean;
  onAnswer: (answer: ExecutionHumanAnswer) => Promise<void>;
}) {
  const id = useId();
  const [text, setText] = useState('');
  const [choice, setChoice] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const sending = useRef(false);
  const send = async (answer: ExecutionHumanAnswer) => {
    if (!open || sending.current) return;
    sending.current = true; setBusy(true); setFailed(false);
    try { await onAnswer(answer); } catch { setFailed(true); } finally { sending.current = false; setBusy(false); }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (request.kind === 'approval' && request.choices.some(item => item.value === choice)) void send({ kind: 'approval', choice, comment: text });
    if (request.kind === 'question' && text.trim()) void send({ kind: 'question', answer: text });
  };
  return <form onSubmit={submit} className="my-2 flex flex-col gap-1 rounded border border-border p-2">
    <h3 className="font-medium">{request.title}</h3>
    {request.description && <p className="whitespace-pre-wrap break-words text-muted-foreground">{request.description}</p>}
    <p className="whitespace-pre-wrap break-words">{request.message}</p>
    {request.kind === 'approval' && <>
      <label htmlFor={`${id}-choice`}>{labels.choice}</label>
      <select id={`${id}-choice`} className="rounded border border-border bg-card px-2 py-1" value={choice} onChange={event => setChoice(event.target.value)} disabled={!open || busy}>
        <option value="" disabled>{labels.choice}</option>
        {request.choices.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
      </select>
    </>}
    <label htmlFor={`${id}-text`}>{request.kind === 'question' ? labels.answer : labels.comment}</label>
    <textarea id={`${id}-text`} className="min-h-12 rounded border border-border bg-card px-2 py-1" value={text} onChange={event => setText(event.target.value)} readOnly={!open || busy} />
    {failed && <p role="alert">{labels.failed}</p>}
    {request.kind === 'plan' ? <>
      <button type="button" disabled={!open || busy} onClick={() => void send({ kind: 'plan', approve: true, comment: text })}>{labels.approve}</button>
      <button type="button" disabled={!open || busy} onClick={() => void send({ kind: 'plan', approve: false, comment: text })}>{labels.reject}</button>
    </> : <button type="submit" disabled={!open || busy || (request.kind === 'approval' ? !request.choices.some(item => item.value === choice) : !text.trim())}>{labels.submit}</button>}
  </form>;
}
