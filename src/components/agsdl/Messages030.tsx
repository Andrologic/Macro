import { useEffect, useState } from 'react';
import { useAgsdlTranslation } from './useAgsdlTranslation';
import type { RunInspection030 } from '../../services/agsdl/runtimeProjection030';
import { messagePrompt030, messageTargets030, runMessages030, sendRunMessage030 } from '../../services/agsdl/messages030';

export function Messages030({ run, stale, refresh, instanceId }: { instanceId?: string; run: RunInspection030; stale: boolean; refresh: () => void }) {
  const { t } = useAgsdlTranslation();
  const tr = (key: string) => t(`agsdl.messages030.${key}`);
  const targets = messageTargets030(run, instanceId);
  const [agent, setAgent] = useState('');
  const [mode, setMode] = useState<'queue' | 'steer'>('steer');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const messages = runMessages030(run, instanceId);
  const instanceView = instanceId !== undefined;
  const readOnly = instanceView && stale;
  const title = tr(instanceView ? 'instanceTrace' : 'title');
  const target = targets.includes(agent) ? agent : targets[0];
  const canSend = target && run.state.verdict === null && !run.state.stopping && run.state.ownerStatus === 'live';
  const sendDisabled = stale || busy || error || !prompt.trim();
  useEffect(() => { setError(false); }, [run.state.revision]);
  const send = async () => {
    if (!canSend || sendDisabled) return;
    setBusy(true); setError(false);
    try { await sendRunMessage030(run, target, mode, prompt, instanceId); setPrompt(''); refresh(); }
    catch { setError(true); }
    finally { setBusy(false); }
  };
  if (!instanceView && !targets.length && !messages.length) return null;
  return <section aria-label={title} className="space-y-2 rounded border border-border p-2">
    <h3 className="font-medium">{title}</h3>
    {instanceView && (
      messages.length ? <p className="text-muted-foreground">{tr('traceLimit')}</p>
        : <p role="status">{tr('traceUnavailable')}</p>
    )}
    {canSend && <div className="space-y-1">
      {!instanceView && <label className="block">{tr('agent')}<select className="ml-2 max-w-full rounded border border-border bg-background p-1" value={target} onChange={event => setAgent(event.target.value)}>{targets.map(name => <option key={name}>{name}</option>)}</select></label>}
      <label className="block">{tr('delivery')}<select className="ml-2 max-w-full rounded border border-border bg-background p-1" value={mode} disabled={readOnly} onChange={event => setMode(event.target.value as 'queue' | 'steer')}><option value="steer">{tr('steer')}</option><option value="queue">{tr('queue')}</option></select></label>
      <textarea className="w-full rounded border border-border bg-background p-2" aria-label={tr('prompt')} value={prompt} readOnly={readOnly} onChange={event => setPrompt(event.target.value)} />
      <button type="button" disabled={sendDisabled} className="rounded border border-border px-2 py-1 disabled:opacity-50" onClick={() => void send()}>{tr(busy ? 'sending' : 'send')}</button>
      {error && <p role="alert">{tr('error')}</p>}
    </div>}
    <ol className="space-y-2">{messages.map(row => {
      const destination = row.step?.join(' / ') || row.agent;
      const message = row.message;
      const prompt = message && messagePrompt030(message.messageJson);
      return <li key={row.id} className="min-w-0 break-words border-t border-border pt-1">
        {message && <>
          <p>{!instanceView && message.sender === 'host' ? tr('you') : message.sender} → {destination}</p>
          <p>{message.statuses.map(status => ['sent', 'queued', 'delivered', 'consumed', 'fallback'].includes(status) ? tr(status) : status).join(' · ')}</p>
          <p className="whitespace-pre-wrap">{prompt}</p>
          {instanceView && prompt !== message.messageJson && <details>
            <summary>{t('agsdl.human030.messageDetails')}</summary>
            <pre className="whitespace-pre-wrap break-all">{message.messageJson}</pre>
          </details>}
        </>}
        {row.workText && <>
          {instanceView && <p className="text-muted-foreground">{destination} · {tr('workText')}</p>}
          <p className="whitespace-pre-wrap">{row.workText}</p>
        </>}
      </li>;
    })}</ol>
  </section>;
}
