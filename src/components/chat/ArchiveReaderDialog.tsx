import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '../ui/Dialog';
import { HistoricalMessageContent } from './HistoricalMessageContent';
import { createLifecycleScope } from '../../services/lifecycleScope';
import { ArchiveReaderSession, onArchiveReadersRetiring, readArchiveTextPage,
  readPreviousArchiveTextPage, type ArchiveValue } from '../../services/conversationPortableArchive';
import { archiveContextReference } from '../../services/archiveContext';
import { useChatStore } from '../../stores/useChatStore';
import { toServiceError } from '../../services/contracts/errors';
import type { ArchiveBacking, ArchiveItem, ArchivePage, ArchiveResource, ArchiveSelector } from '../../services/ipc/connectArchive';

type Entry = Extract<ArchiveItem, { kind: 'entry' }>;
const entries: ArchiveSelector = { kind: 'entries' };

/** A single admitted text/image page. Continuations keep the native selector;
 * editable offsets and encoded payloads are absent from the product reader. */
function ArchiveContent({ conversationId, selector, uuid, date, title, image = false }: {
  conversationId: string; selector: ArchiveSelector; uuid: string;
  date?: string | null; title: string; image?: boolean;
}) {
  const { t } = useTranslation();
  const [backing, setBacking] = useState<ArchiveValue<ArchiveBacking> | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState(false);
  const reader = useRef<ArchiveReaderSession | null>(null);
  const scope = useRef<ReturnType<typeof createLifecycleScope> | null>(null);
  const held = useRef(new Set<ArchiveValue<ArchiveBacking>>());
  const pending = useRef(false);
  const key = JSON.stringify([conversationId, selector, uuid, image]);
  const [loadedKey, setLoadedKey] = useState('');
  useLayoutEffect(() => () => { if (backing) { held.current.delete(backing); backing.release(); } }, [backing]);
  useEffect(() => {
    const owner = createLifecycleScope(); scope.current = owner; const values = held.current;
    pending.current = true; setBusy(true); setError(''); setAdded(false); setBacking(null); setLoadedKey(key);
    void owner.track((async () => {
      const opened = await ArchiveReaderSession.open({ conversationId, selector }, owner);
      owner.own(() => opened.close()); reader.current = opened;
      const page = await opened.page(null, 1);
      try {
        const field = page.value.items.find(item => item.kind === 'fragment');
        if (!field || field.kind !== 'fragment') throw new Error('archive_resource_unavailable');
        const value = image ? await opened.materialize({ resourceUuid: uuid, use: 'image', range: null })
          : await readArchiveTextPage(opened, uuid, '0', field.resource.bytes);
        if (!owner.isActive()) { value.release(); return; }
        held.current.add(value); setBacking(value);
      } finally { page.release(); }
    })()).catch(cause => { if (owner.isActive()) setError(toServiceError(cause).message); })
      .finally(() => { if (owner.isActive()) { pending.current = false; setBusy(false); } });
    return () => {
      owner.stop(); reader.current = null;
      for (const value of values) value.release();
      values.clear();
    };
    // `key` encodes every input of this read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const data = loadedKey === key ? backing?.value : undefined;
  const next = (previous: boolean) => {
    const opened = reader.current, owner = scope.current;
    if (!opened || !owner || !data || pending.current) return;
    pending.current = true; setBusy(true); setError(''); setAdded(false);
    const work = previous ? readPreviousArchiveTextPage(opened, uuid, data.start)
      : readArchiveTextPage(opened, uuid, data.end, data.resource.bytes);
    void owner.track(work.then(value => {
      if (!owner.isActive()) { value.release(); return; }
      held.current.add(value); setBacking(value);
    })).catch(cause => { if (owner.isActive()) setError(toServiceError(cause).message); })
      .finally(() => { if (owner.isActive()) { pending.current = false; setBusy(false); } });
  };
  return <section className="space-y-2 rounded-lg border border-border p-3 text-sm">
    <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    {data?.text !== null && data?.text !== undefined && <HistoricalMessageContent content={data.text} date={date ?? null} />}
    {data?.readyDataUrl && <img src={data.readyDataUrl} alt={t('chat.attachedImage')} width={data.width ?? undefined} height={data.height ?? undefined} className="h-auto max-w-full" />}
    {data && <div className="flex flex-wrap items-center gap-3 text-xs">
      <span className="text-muted-foreground">{data.complete ? t('chat.archive.complete') : t('chat.archive.partial')}</span>
      {!image && data.start !== '0' && <button type="button" disabled={busy} onClick={() => next(true)} className="underline disabled:opacity-50">{t('common.previous')}</button>}
      {!image && data.end !== data.resource.bytes && <button type="button" disabled={busy} onClick={() => next(false)} className="underline disabled:opacity-50">{t('chat.archive.readMore')}</button>}
      {data.text !== null && <button type="button" disabled={added || busy} className="underline disabled:opacity-50" onClick={() => {
        const ref = archiveContextReference(data, selector, title);
        ref.subtitle = data.complete ? t('chat.archive.complete') : t('chat.archive.partial');
        useChatStore.getState().addComposerContextRef(ref); setAdded(true);
      }}>{added ? t('chat.archive.added') : t('chat.archive.recover')}</button>}
    </div>}
    {busy && <p role="status" className="text-xs text-muted-foreground">{t('common.loading')}</p>}
  </section>;
}

function ArchiveEntry({ entry, conversationId }: { entry: Entry; conversationId: string }) {
  const { t } = useTranslation();
  // Native validated presentation data never grants execution authority.
  const header = JSON.parse(entry.headerJson) as { entry: { kind: string; purpose?: string; role?: string; mime?: string } };
  const kind = header.entry;
  if (kind.kind === 'association') return <p className="text-xs text-muted-foreground">{t('chat.archive.related')}</p>;
  if (kind.purpose === 'portable_metadata') return <p className="text-xs text-muted-foreground">{t('chat.archive.provenance')}</p>;
  if (!entry.targetUuid) return <p role="alert">{t('chat.archive.unavailable')}</p>;
  const title = kind.kind === 'message' ? t(kind.role === 'assistant' ? 'chat.archive.assistant' : 'chat.archive.user')
    : t(kind.kind === 'asset' ? 'chat.archive.attachment' : kind.kind === 'citation' ? 'chat.archive.reference' : 'chat.archive.history');
  return <ArchiveContent conversationId={conversationId} selector={{ kind: 'records', ordinal: entry.ordinal, uuid: null }}
    uuid={entry.targetUuid} date={entry.origin?.displayDate} title={title} image={kind.kind === 'asset' && kind.mime !== 'text_plain'} />;
}

export function ArchiveReaderDialog({ conversationId, messageId, onClose }: {
  conversationId: string; messageId?: string; onClose(): void;
}) {
  const { t } = useTranslation();
  const [selection, setSelection] = useState<ArchiveSelector>(messageId ? { kind: 'resources', messageId } : entries);
  const [page, setPage] = useState<ArchiveValue<ArchivePage> | null>(null);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [resource, setResource] = useState<ArchiveResource | null>(null);
  const reader = useRef<ArchiveReaderSession | null>(null);
  const scope = useRef<ReturnType<typeof createLifecycleScope> | null>(null);
  const held = useRef(new Set<ArchiveValue<ArchivePage>>());
  const pending = useRef(false); const close = useRef(onClose);
  useLayoutEffect(() => { close.current = onClose; });
  const key = JSON.stringify([conversationId, selection]); const [loadedKey, setLoadedKey] = useState('');
  useLayoutEffect(() => () => { if (page) { held.current.delete(page); page.release(); } }, [page]);
  useEffect(() => onArchiveReadersRetiring(id => { if (!id || id === conversationId) close.current(); }), [conversationId]);
  useEffect(() => {
    const owner = createLifecycleScope(); scope.current = owner; const values = held.current;
    pending.current = true; setLoadedKey(key); setPage(null); setResource(null); setBusy(true); setError('');
    void owner.track((async () => {
      const opened = await ArchiveReaderSession.open({ conversationId, selector: selection }, owner);
      owner.own(() => opened.close()); reader.current = opened;
      const value = await opened.page(null);
      if (!owner.isActive()) { value.release(); return; }
      held.current.add(value); setPage(value);
    })()).catch(cause => { if (owner.isActive()) setError(toServiceError(cause).message); })
      .finally(() => { if (owner.isActive()) { pending.current = false; setBusy(false); } });
    return () => { owner.stop(); for (const value of values) value.release(); values.clear(); };
    // `key` encodes every input of this read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const next = () => {
    const opened = reader.current, owner = scope.current, cursor = page?.value.nextCursorId;
    if (!opened || !owner || !cursor || pending.current) return;
    pending.current = true; setBusy(true); setError(''); setResource(null);
    void owner.track(opened.page(cursor).then(value => {
      if (!owner.isActive()) { value.release(); return; }
      held.current.add(value); setPage(value);
    })).catch(cause => { if (owner.isActive()) setError(toServiceError(cause).message); })
      .finally(() => { if (owner.isActive()) { pending.current = false; setBusy(false); } });
  };
  const visible = loadedKey === key ? page?.value : undefined;
  return <Dialog title={t('chat.archive.title')} onClose={onClose} panelClassName="flex max-h-[85vh] w-full max-w-3xl flex-col gap-3 overflow-hidden rounded-lg border border-border bg-card p-4">
    <div className="flex gap-3 text-xs">
      <button type="button" onClick={() => setSelection(entries)} className="underline">{t('chat.archive.allRecords')}</button>
      {messageId && <button type="button" onClick={() => setSelection({ kind: 'resources', messageId })} className="underline">{t('chat.archive.resources')}</button>}
    </div>
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    <div className="min-h-0 space-y-3 overflow-auto">
      {resource && <ArchiveContent key={resource.uuid + resource.field} conversationId={conversationId} uuid={resource.uuid}
        selector={resource.kind === 'asset' ? { kind: 'asset', assetId: resource.uuid } : { kind: 'citation', citationId: resource.uuid, field: resource.field }}
        title={t(resource.kind === 'asset' ? 'chat.archive.attachment' : 'chat.archive.reference')} image={resource.mimeType?.startsWith('image/')} />}
      {visible?.items.map((item, index) => item.kind === 'entry' ? <ArchiveEntry key={item.ordinal} entry={item} conversationId={conversationId} />
        : item.kind === 'resource' ? <button type="button" key={index} className="block rounded border border-border p-2 text-left text-sm hover:bg-accent" onClick={() => setResource(item.resource)}>
          {t(item.resource.kind === 'asset' ? 'chat.archive.attachment' : 'chat.archive.reference')} · {t(`chat.archive.fields.${item.resource.field}`, { defaultValue: t('chat.archive.body') })}
        </button> : null)}
    </div>
    <div className="flex gap-3 text-xs">
      {busy ? <span>{t('common.loading')}</span> : visible && !visible.nextCursorId ? <span>{t('chat.archive.endOfSelection')}</span> : null}
      {visible?.nextCursorId && <button type="button" disabled={busy} onClick={next} className="underline disabled:opacity-50">{t('common.next')}</button>}
      <button type="button" onClick={onClose} className="ml-auto underline">{t('common.close')}</button>
    </div>
  </Dialog>;
}
