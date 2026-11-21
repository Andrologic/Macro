import { useEffect, useState } from 'react';
import { useAgsdlTranslation } from './useAgsdlTranslation';
import type { RunInspection030 } from '../../services/agsdl/runtimeProjection030';
import { messagePrompt030, messageTargets030, runMessages030, sendRunMessage030 } from '../../services/agsdl/messages030';

export function Messages030({ run, stale, refresh }: { run: RunInspection030; stale: boolean; refresh: () => void }) {
  const { t } = useAgsdlTranslation();
  const tr = (key: string) => t(`agsdl.messages030.${key}`);
  const targets = messageTargets030(run);
  const [agent, setAgent] = useState('');
  const [mode, setMode] = useState<'queue' | 'steer'>('steer');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const messages = runMessages030(run);
  useEffect(() => { setError(false); }, [run.state.revision]);
  const send = async () => {
    setBusy(true); setError(false);
    try { await sendRunMessage030(run, agent || targets[0], mode, prompt); setPrompt(''); refresh(); }
    catch { setError(true); }
    finally { setBusy(false); }
  };
  if (!targets.length && !messages.length) return null;
  return <section aria-label={tr('title')} className="space-y-2 rounded border border-border p-2">
    <h3 className="font-medium">{tr('title')}</h3>
    {targets.length > 0 && run.state.verdict === null && !run.state.stopping && <div className="space-y-1">
      <label className="block">{tr('agent')}<select className="ml-2 max-w-full rounded border border-border bg-background p-1" value={agent || targets[0]} onChange={event => setAgent(event.target.value)}>{targets.map(name => <option key={name}>{name}</option>)}</select></label>
      <label className="block">{tr('delivery')}<select className="ml-2 max-w-full rounded border border-border bg-background p-1" value={mode} onChange={event => setMode(event.target.value as 'queue' | 'steer')}><option value="steer">{tr('steer')}</option><option value="queue">{tr('queue')}</option></select></label>
      <textarea className="w-full rounded border border-border bg-background p-2" aria-label={tr('prompt')} value={prompt} onChange={event => setPrompt(event.target.value)} />
      <button type="button" disabled={stale || busy || error || !prompt.trim()} className="rounded border border-border px-2 py-1 disabled:opacity-50" onClick={() => void send()}>{tr(busy ? 'sending' : 'send')}</button>
      {error && <p role="alert">{tr('error')}</p>}
    </div>}
    <ol className="space-y-2">{messages.map(row => <li key={row.id} className="min-w-0 break-words border-t border-border pt-1">
      <p>{row.message!.sender === 'host' ? tr('you') : row.message!.sender} → {row.step?.join(' / ') || row.agent}</p>
      <p>{row.message!.statuses.map(status => tr(['sent', 'queued', 'delivered', 'consumed', 'fallback'].includes(status) ? status : 'sent')).join(' · ')}</p>
      <p className="whitespace-pre-wrap">{messagePrompt030(row.message!.messageJson)}</p>
      {row.workText && <p className="whitespace-pre-wrap">{row.workText}</p>}
    </li>)}</ol>
  </section>;
}
