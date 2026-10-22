import { useEffect, useRef, useState, type SyntheticEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { Select } from '../ui/Select';
import { useConsumerReader } from '../../hooks/useConsumerReader';
import type { ConsumerReader, ConsumerReaderPorts, ReaderPanel, ReaderRow } from '../../services/macroPilot/consumerReader';
import { PilotClientError, type PilotClientErrorCode } from '../../services/macroPilot/clientError';
import type { ContentConversationCard, ContentTranscriptMessage } from '../../services/macroPilot/contentProtocol';

function ErrorMessage({ code }: { code: string | null }) {
  const { t } = useTranslation();
  return code ? <p role="status" className="text-xs text-destructive">{t(`settings.connectReader.errors.${code}`, { defaultValue: t('settings.connectReader.errors.unavailable') })}</p> : null;
}
function Navigation({ row, panel, kind, reader }: { row: ReaderRow; panel: ReaderPanel; kind: 'catalog' | 'detail'; reader: ConsumerReader }) {
  const { t } = useTranslation();
  const page = row.page?.response.result.page;
  return <div className="flex flex-wrap items-center gap-2 border-t border-border p-2 text-xs">
    {page && <span className="text-muted-foreground">{page.offset + (row.page!.response.result.items.length ? 1 : 0)}–{page.offset + row.page!.response.result.items.length} / {page.total}</span>}
    {row.busy && <span role="status">{t('common.loading')}</span>}
    <ErrorMessage code={row.error} />
    {page?.next_cursor && !row.limited && <Button size="sm" variant="secondary" disabled={row.busy || panel.phase !== 'ready'} onClick={() => reader.next(panel.key, kind)}>{t(kind === 'catalog' || !panel.history ? 'settings.connectReader.next' : 'settings.connectReader.older')}</Button>}
    <Button size="sm" variant="ghost" disabled={row.busy || panel.phase !== 'ready'} onClick={() => reader.restart(panel.key, kind)}>{t(kind === 'catalog' || !panel.history ? 'settings.connectReader.first' : 'settings.connectReader.latest')}</Button>
    {(kind === 'catalog' || row.limited) && <p role="status" className="w-full text-muted-foreground">{t('settings.connectReader.limit')}</p>}
    {row.limited && kind === 'detail' && panel.history && <Button size="sm" variant="secondary" disabled={panel.passive || panel.phase !== 'ready'} onClick={() => reader.restart(panel.key, kind, true)}>{t('settings.connectReader.anchor')}</Button>}
  </div>;
}
function Panel({ panel, reader }: { panel: ReaderPanel; reader: ConsumerReader }) {
  const { t } = useTranslation();
  const cardButtons = useRef(new Map<string, HTMLButtonElement>());
  const panelElement = useRef<HTMLElement>(null);
  useEffect(() => {
    const element = panelElement.current;
    if (!element) return;
    if (typeof IntersectionObserver === 'undefined') { reader.setPanelVisible(panel.key, true); return; }
    reader.setPanelVisible(panel.key, false);
    const observer = new IntersectionObserver(entries => reader.setPanelVisible(panel.key, entries.some(entry => entry.isIntersecting)), { threshold: 0 });
    observer.observe(element); return () => observer.disconnect();
  }, [reader, panel.key]);
  useEffect(() => {
    if (!panel.passive && panel.phase === 'ready') return;
    const selection = window.getSelection();
    if (selection && Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i)).some(range => panelElement.current && range.intersectsNode(panelElement.current))) selection.removeAllRanges();
  }, [panel.passive, panel.phase]);
  const guardCopy = (event: SyntheticEvent) => { if (panel.passive || panel.phase !== 'ready') { event.preventDefault(); event.stopPropagation(); } };
  const back = () => {
    const card = panel.selected && cardButtons.current.get(JSON.stringify(panel.selected.ref));
    reader.back(panel.key);
    (card?.isConnected ? card : panelElement.current)?.focus();
  };
  const cards = (panel.catalog.page?.response.result.items ?? []) as ContentConversationCard[];
  const messages = (panel.detail.page?.response.result.items ?? []) as ContentTranscriptMessage[];
  return <section ref={panelElement} onCopyCapture={guardCopy} onCutCapture={guardCopy} onDragStartCapture={guardCopy} onKeyDownCapture={event => { if ((event.metaKey || event.ctrlKey) && ['c', 'x', 'a'].includes(event.key.toLowerCase())) guardCopy(event); }} tabIndex={-1} aria-label={panel.label || t('settings.connectReader.computer')} className={`flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-background/50 ${panel.passive ? 'select-none' : ''}`}>
    <header className="flex items-center gap-2 border-b border-border px-3 py-2">
      <h3 className="min-w-0 flex-1 truncate text-sm font-semibold">{panel.label || t('settings.connectReader.computer')}</h3>
      <span role="status" className="text-xs text-muted-foreground">{t(`settings.connectReader.phase.${panel.phase}`, { defaultValue: t('common.loading') })}</span>
      <Button size="sm" variant="ghost" onClick={() => reader.close(panel.key)} aria-label={t('settings.connectReader.closeComputer', { computer: panel.label })}>{t('common.close')}</Button>
    </header>
    {panel.passive && <p role="status" className="px-3 py-2 text-xs text-muted-foreground">{t('settings.connectReader.passive')}</p>}
    {panel.error ? <div className="space-y-2 p-3"><ErrorMessage code={panel.error} /><Button size="sm" variant="secondary" disabled={!panel.retryable} onClick={() => void reader.retry(panel.key)}>{t('common.retry')}</Button></div> : null}
    <div className="grid min-h-0 flex-1 grid-cols-[minmax(140px,0.7fr)_minmax(0,1.3fr)]">
      <div className="flex min-h-0 min-w-0 flex-col border-r border-border">
        <div className="flex items-center gap-2 border-b border-border p-2"><h4 className="text-xs font-semibold">{t('settings.connectReader.chat')}</h4>
          <Select aria-label={t('settings.connectReader.archiveFilter')} className="!py-1 text-xs" disabled={panel.phase !== 'ready'} value={panel.archived ? 'archived' : 'active'} onChange={event => reader.filter(panel.key, event.target.value === 'archived')}>
            <option value="active">{t('settings.connectReader.active')}</option><option value="archived">{t('settings.connectReader.archived')}</option>
          </Select>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {cards.map(card => <button type="button" disabled={panel.passive || panel.phase !== 'ready'} key={JSON.stringify([panel.key, card.ref])} ref={node => { const key = JSON.stringify(card.ref); if (node) cardButtons.current.set(key, node); else cardButtons.current.delete(key); }} aria-pressed={panel.selected?.ref.conversation_id === card.ref.conversation_id} onClick={() => reader.select(panel.key, card.ref)} className="block w-full border-b border-border/50 px-3 py-2 text-left hover:bg-accent focus-visible:outline-primary aria-pressed:bg-accent">
            <span className="block break-words text-sm font-medium">{card.pinned ? '• ' : ''}{card.title}</span>
            <span className="line-clamp-2 text-xs text-muted-foreground">{card.description}</span>
            <span className="block text-xs text-muted-foreground">{card.project && <>{card.project.name} · </>}{new Date(card.updated_at).toLocaleDateString()}</span>
            {card.unread && <span className="mr-2 text-xs text-primary">{t('settings.connectReader.unread')}</span>}
            {card.attention !== 'none' && <span className="text-xs text-muted-foreground">{t(`settings.connectReader.attention.${card.attention}`)}</span>}
          </button>)}
          {panel.catalog.page && !cards.length && <p className="p-3 text-xs text-muted-foreground">{t('settings.connectReader.emptyCatalog')}</p>}
        </div>
        <Navigation row={panel.catalog} panel={panel} kind="catalog" reader={reader} />
      </div>
      <div className="flex min-h-0 min-w-0 flex-col">
        {panel.selected ? <>
          <div className="border-b border-border p-2"><Button size="sm" variant="ghost" disabled={panel.passive || panel.phase !== 'ready'} onClick={back}>{t('settings.connectReader.back')}</Button><h4 className="break-words text-sm font-medium">{panel.selected.title || t('settings.connectReader.conversation')}</h4>
            <p className="text-xs text-muted-foreground">{t(panel.history ? 'settings.connectReader.conversation' : 'settings.connectReader.beginning')}</p>
            {panel.freshAnchor && <p role="status" className="text-xs text-muted-foreground">{t('settings.connectReader.newCapture')}</p>}
          </div>
          <div className={`min-h-0 flex-1 overflow-auto p-3 ${panel.passive ? 'select-none' : 'select-text'}`}>
            {messages.map(message => <article key={JSON.stringify([panel.key, panel.selected!.ref, message.message_id])} className="mb-4 space-y-1">
              <p className="text-xs font-medium text-muted-foreground">{t(`settings.connectReader.role.${message.role}`)} {message.created_at ? new Date(message.created_at).toLocaleString() : ''}</p>
              <p className="whitespace-pre-wrap break-words text-sm">{'text' in message ? message.text : t(`settings.connectReader.content.${message.content_state}`)}</p>
              {(message.content_state !== 'complete' || message.completion !== 'complete') && <p className="text-xs text-muted-foreground">{t(`settings.connectReader.content.${message.content_state}`)} · {t(`settings.connectReader.completion.${message.completion}`)}</p>}
            </article>)}
            {panel.detail.page && !messages.length && <p className="text-xs text-muted-foreground">{t('settings.connectReader.emptyWindow')}</p>}
          </div>
          <Navigation row={panel.detail} panel={panel} kind="detail" reader={reader} />
        </> : <p className="p-3 text-xs text-muted-foreground">{t('settings.connectReader.chooseConversation')}</p>}
      </div>
    </div>
  </section>;
}
export function ConnectConsumerDialog({ ports, onClose, returnFocusRef }: { ports: ConsumerReaderPorts; onClose(): void; returnFocusRef?: React.RefObject<HTMLElement | null> }) {
  const { t } = useTranslation();
  const { reader, state } = useConsumerReader(ports);
  const [choice, setChoice] = useState(''); const [selectionError, setSelectionError] = useState<PilotClientErrorCode | null>(null); const select = useRef<HTMLSelectElement>(null);
  useEffect(() => { if (state.phase === 'ended') onClose(); }, [state.phase, onClose]);
  return <Dialog title={t('settings.connectReader.title')} onClose={onClose} initialFocusRef={select} returnFocusRef={returnFocusRef} panelClassName="flex h-[90vh] w-[96vw] max-w-[1440px] flex-col overflow-hidden rounded-xl border border-border bg-card shadow-xl">
    <header className="flex items-start gap-3 border-b border-border p-3"><div className="min-w-0 flex-1"><p aria-hidden="true" className="text-sm font-semibold">{t('settings.connectReader.title')}</p><p className="text-xs text-muted-foreground">{t('settings.connectReader.help')}</p></div><Button size="sm" variant="ghost" onClick={onClose}>{t('common.close')}</Button></header>
    <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
      <select ref={select} aria-label={t('settings.connectReader.chooseComputer')} value={choice} onChange={event => { setChoice(event.target.value); setSelectionError(null); }} disabled={state.phase !== 'ready' || state.panels.length >= 2} className="max-w-xs rounded-md border border-border bg-background p-2 text-sm">
        <option value="">{t('settings.connectReader.chooseComputer')}</option>
        {state.choices.map(item => <option key={item.id} value={item.id} disabled={!item.available || item.local || state.panels.some(panel => panel.instanceId === item.id)}>{item.label}{item.local ? ` · ${t('settings.connectReader.thisComputer')}` : !item.available ? ` · ${t('settings.connectReader.phase.error')}` : ''}</option>)}
      </select>
      <Button size="sm" disabled={!reader || !choice || state.phase !== 'ready' || state.panels.length >= 2 || !state.choices.some(item => item.id === choice && item.available && !item.local) || state.panels.some(panel => panel.instanceId === choice)} onClick={() => { try { reader?.open(choice, false); setChoice(''); setSelectionError(null); } catch (error) { setSelectionError(error instanceof PilotClientError ? error.code : 'unavailable'); } }}>{t('settings.connectReader.add')}</Button>
      <Button size="sm" variant="ghost" disabled={!reader || state.phase === 'loading' || state.phase === 'locked'} onClick={() => void reader?.refresh()}>{t('settings.connectReader.verify')}</Button>
      {state.panels.length === 2 && <span className="text-xs text-muted-foreground">{t('settings.connectReader.twoLimit')}</span>}
      {state.phase === 'loading' && <span role="status" className="text-xs">{t('common.loading')}</span>}
      {state.phase === 'locked' && <p role="status" className="text-xs">{t('settings.connectReader.locked')}</p>}
      <ErrorMessage code={selectionError ?? state.error} />
    </div>
    {reader && <div className={`grid min-h-0 flex-1 auto-rows-[minmax(420px,1fr)] gap-3 overflow-y-auto p-3 min-[1000px]:auto-rows-[minmax(0,1fr)] ${state.panels.length === 2 ? 'grid-cols-1 min-[1000px]:grid-cols-2' : 'grid-cols-1'}`}>
      {state.panels.map(panel => <Panel key={panel.key} panel={panel} reader={reader} />)}
      {!state.panels.length && <p className="p-3 text-sm text-muted-foreground">{t('settings.connectReader.chooseComputer')}</p>}
    </div>}
  </Dialog>;
}
