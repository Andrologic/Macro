import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { Select } from '../ui/Select';
import type { ConsumerReaderPorts } from '../../services/macroPilot/consumerReader';
import type { ConsumerConnections, ConsumerLease } from '../../services/macroPilot/consumerConnections';
import type { ContentInstanceModels } from '../../services/macroPilot/contentProtocol';
import { stableJson } from '../../services/macroPilot/protocol';

type Model = ContentInstanceModels['models'][number];
export interface TransferConversationDialogProps {
  ports: ConsumerReaderPorts;
  source: { id: string; title: string; providerId: string | null; modelId: string | null };
  send(target: string, selection: { providerId: string; modelId: string }): Promise<string>;
  onClose(): void;
  onTransferred(): void;
}
const modelKey = (model: Pick<Model, 'provider_id' | 'model_id'>) => JSON.stringify([model.provider_id, model.model_id]);
export function TransferConversationDialog({ ports, source, send, onClose, onTransferred }: TransferConversationDialogProps) {
  const { t } = useTranslation();
  const [choices, setChoices] = useState<Array<{ id: string; label: string }>>([]);
  const [target, setTarget] = useState(''), [models, setModels] = useState<Model[]>([]), [selection, setSelection] = useState('');
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const owner = useRef<ConsumerConnections | null>(null), lease = useRef<ConsumerLease | null>(null);
  const generation = useRef(0), alive = useRef(true), loadingRequest = useRef<AbortController | null>(null);
  useEffect(() => {
    alive.current = true;
    const runs = generation;
    let current: ConsumerConnections;
    try { current = ports.createOwner(); } catch { setError('context_changed'); setLoading(false); return; }
    owner.current = current;
    const context = stableJson(ports.context());
    const unavailable = () => {
      if (stableJson(ports.context()) !== context) throw Error('context_changed');
    };
    const unsubscribe = ports.subscribe(() => { try { unavailable(); } catch { generation.current++; loadingRequest.current?.abort(); setChoices([]); setModels([]); setSelection(''); setLoading(false); setError('context_changed'); } });
    let active = true;
    void current.refreshDirectory().then(directory => {
      unavailable(); if (!active) return;
      setChoices(directory.instances.filter(pc => pc.ref.instance_id !== ports.localInstanceId && pc.connection_state === 'reachable' &&
        directory.accesses.some(access => access.ref.instance_id === pc.ref.instance_id && access.state === 'granted' && access.permissions.includes('supervise') && access.permissions.includes('respond')))
        .map(pc => ({ id: pc.ref.instance_id, label: pc.label })));
    }).catch(() => { if (active) setError('unavailable'); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; alive.current = false; runs.current++; loadingRequest.current?.abort(); unsubscribe(); lease.current?.release(); current.dispose(); if (owner.current === current) owner.current = null; };
  }, [ports]);
  const choose = async (id: string) => {
    const run = ++generation.current;
    loadingRequest.current?.abort(); lease.current?.release(); lease.current = null;
    setTarget(id); setSelection(''); setModels([]); setError(null);
    if (!id || !owner.current) return;
    setLoading(true); const request = new AbortController(); loadingRequest.current = request;
    try {
      const current = owner.current.acquire(id); lease.current = current;
      const page = await current.read('instance.models', { instance_id: id }, { signal: request.signal });
      if (!alive.current || run !== generation.current) return;
      const catalog = page.response.result.models; setModels(catalog);
      const retained = catalog.find(m => m.provider_id === source.providerId && m.model_id === source.modelId);
      setSelection(retained ? modelKey(retained) : '');
      if (!catalog.length) setError('noModels');
    } catch { if (alive.current && run === generation.current) setError('unavailable'); }
    finally { if (alive.current && run === generation.current) setLoading(false); }
  };
  const transfer = async () => {
    const selected = models.find(m => modelKey(m) === selection), current = lease.current;
    if (!selected || !current || loading || busy) return;
    setBusy(true); setError(null); const run = generation.current;
    try {
      // Read again before the native source can freeze. Native target checks again.
      const fresh = await current.read('instance.models', { instance_id: target });
      if (!alive.current || run !== generation.current) throw Error('context_changed');
      if (!fresh.response.result.models.some(m => modelKey(m) === selection)) { setModels(fresh.response.result.models); setSelection(''); setError('modelChanged'); return; }
      await send(target, { providerId: selected.provider_id, modelId: selected.model_id });
      if (alive.current) onTransferred();
    } catch { if (alive.current) setError('unavailable'); }
    finally { if (alive.current) setBusy(false); }
  };
  const close = () => { if (!busy) onClose(); };
  const retained = models.some(m => m.provider_id === source.providerId && m.model_id === source.modelId);
  return <Dialog title={t('chat.transfer.title')} onClose={close} panelClassName="w-full max-w-md overflow-hidden rounded-xl border border-border bg-card shadow-xl">
    <div className="space-y-4 p-4">
      <div><h2 className="text-sm font-semibold">{t('chat.transfer.title')}</h2><p className="mt-1 truncate text-xs text-muted-foreground">{source.title}</p></div>
      <Select label={t('chat.transfer.computer')} value={target} disabled={busy || !choices.length} onChange={event => void choose(event.target.value)}>
        <option value="">{t('chat.transfer.chooseComputer')}</option>{choices.map(pc => <option key={pc.id} value={pc.id}>{pc.label}</option>)}
      </Select>
      {target && !loading && models.length > 0 && <div className="space-y-2">
        {!retained && <p className="text-xs text-muted-foreground">{t('chat.transfer.chooseAlternative')}</p>}
        <Select label={t('chat.transfer.model')} value={selection} disabled={busy} onChange={event => setSelection(event.target.value)}>
          <option value="">{t('chat.transfer.chooseModel')}</option>{models.map(model => <option key={modelKey(model)} value={modelKey(model)}>{model.model_name} · {model.provider_name}</option>)}
        </Select>
      </div>}
      {loading && <p role="status" className="text-xs text-muted-foreground">{t('common.loading')}</p>}
      {!loading && choices.length === 0 && !error && <p role="status" className="text-xs text-muted-foreground">{t('chat.transfer.noComputers')}</p>}
      {error && <p role="alert" className="text-xs text-destructive">{t(`chat.transfer.errors.${error}`, { defaultValue: t('chat.transfer.errors.unavailable') })}</p>}
      {busy && <p role="status" className="text-xs text-muted-foreground">{t('chat.transfer.progress')}</p>}
    </div>
    <footer className="flex justify-end gap-2 border-t border-border p-3"><Button size="sm" variant="ghost" disabled={busy} onClick={close}>{t('common.cancel')}</Button><Button size="sm" disabled={loading || busy || !selection || !target} onClick={() => void transfer()}>{t('chat.transfer.send')}</Button></footer>
  </Dialog>;
}
