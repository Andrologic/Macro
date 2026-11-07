import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useChatStore } from '../../stores/useChatStore';
import type { QueuedSubmissionPreview } from '../../stores/chat/chatQueuedSubmissionRuntime';
import { Button } from '../ui/Button';

const EMPTY_QUEUE: QueuedSubmissionPreview[] = [];

export function QueuedMessagesView({ entries, onRemove }: {
  entries: QueuedSubmissionPreview[];
  onRemove: (id: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const removing = useRef(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!entries.length) return null;

  const remove = async (id: string) => {
    if (removing.current) return;
    removing.current = true;
    setBusyId(id);
    setError(null);
    try { await onRemove(id); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { removing.current = false; setBusyId(null); }
  };

  return (
    <section aria-label={t('chat.queuedMessages', 'Queued messages')} className="rounded-lg border border-border bg-card/60 p-2 text-xs">
      <div className="font-medium text-foreground">{t('chat.queuedMessages', 'Queued messages')} · {entries.length}</div>
      <p className="mt-1 text-muted-foreground">
        {t('chat.stopQueueDescription', 'Stops the current response and pauses queued messages. Queued messages are retained.')}
      </p>
      <ol className="mt-2 max-h-40 space-y-2 overflow-y-auto">
        {entries.map((entry, index) => (
          <li key={entry.id} className="flex items-start gap-2 rounded border border-border/60 p-2">
            <span aria-hidden="true" className="text-muted-foreground">{index + 1}.</span>
            <div className="min-w-0 flex-1">
              <p className="whitespace-pre-wrap break-words text-foreground">{entry.content || t('chat.queueAttachmentOnly', 'Attachment only')}</p>
              <p className="mt-1 text-muted-foreground">{entry.state === 'sending'
                ? t('chat.queueSending', 'Sending…')
                : entry.state === 'paused'
                  ? t('chat.queuePaused', 'Paused. Resume from the recovery notice.')
                  : t('chat.queueWaiting', 'Waiting for the current response to finish')}</p>
            </div>
            <Button size="sm" variant="ghost" className="shrink-0 px-2 py-1 text-xs" disabled={entry.state === 'sending' || busyId !== null} isLoading={busyId === entry.id} onClick={() => void remove(entry.id)}>
              {t('chat.queueRemoveMessage', 'Remove from queue')}
            </Button>
          </li>
        ))}
      </ol>
      {error && <p role="alert" className="mt-2 whitespace-pre-wrap break-words text-destructive">{error}</p>}
    </section>
  );
}

export function QueuedMessagesPanel({ conversationId }: { conversationId: string }) {
  const previews = useChatStore(state => state.queuedSubmissionPreviews) ?? EMPTY_QUEUE;
  const remove = useChatStore(state => state.removeQueuedSubmission);
  return <QueuedMessagesView key={conversationId} entries={previews.filter(entry => entry.conversationId === conversationId)} onRemove={remove} />;
}
