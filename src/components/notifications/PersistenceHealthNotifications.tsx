import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePersistenceHealth } from '../../services/persistenceHealth';
import { useAppStore } from '../../stores/useAppStore';
import { useChatStore } from '../../stores/useChatStore';
import { Button } from '../ui/Button';
import { Textarea } from '../ui/Textarea';
import { NotificationSurface } from '../ui/notifications/NotificationSurface';
import { notify } from '../ui/toastService';

export function PersistenceHealthNotifications() {
  const { t } = useTranslation();
  const issues = usePersistenceHealth((state) => state.issues);
  const conversations = useChatStore((state) => state.conversations);
  const queuedRecovery = useChatStore(
    (state) => state.queuedSubmissionRecoveryByConversationId,
  );
  const retryQueuedSubmissions = useChatStore((state) => state.retryQueuedSubmissions);
  const queuedPreviews = useChatStore((state) => state.queuedSubmissionPreviews) ?? [];
  const editQueuedSubmission = useChatStore((state) => state.editQueuedSubmission);
  const removeQueuedSubmission = useChatStore((state) => state.removeQueuedSubmission);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [retryingConversationIds, setRetryingConversationIds] = useState<Set<string>>(
    () => new Set(),
  );
  const retryingConversationIdsRef = useRef(new Set<string>());

  useEffect(() => {
    const announced = new Map<string, string>();
    const report = ({ issues }: ReturnType<typeof usePersistenceHealth.getState>) => {
      for (const [key, message] of Object.entries(issues)) {
        if (announced.get(key) === message) continue;
        announced.set(key, message);
        notify.actionRequired(t('backup.recovery', 'Recovery required. Original data preserved.'), {
          description: message,
          notificationKey: `persistence:${key}`,
          actions: [{ label: t('settings.title', 'Settings'), onClick: () => useAppStore.getState().openSettings('general') }],
        });
      }
      for (const key of announced.keys()) if (!(key in issues)) announced.delete(key);
    };
    report(usePersistenceHealth.getState());
    return usePersistenceHealth.subscribe(report);
  }, [t]);

  const issueEntries = Object.entries(issues);
  const recoveryEntries = Object.entries(queuedRecovery).filter(([, recovery]) => recovery.count > 0);
  if (issueEntries.length === 0 && recoveryEntries.length === 0) return null;

  const retry = async (conversationId: string) => {
    if (retryingConversationIdsRef.current.has(conversationId) || busyId) return;
    retryingConversationIdsRef.current.add(conversationId);
    setRetryingConversationIds((current) => new Set(current).add(conversationId));
    try {
      await retryQueuedSubmissions(conversationId);
    } catch {
      // The store publishes durable retry failures. Keep this UI guard from
      // turning an unexpected action rejection into an unhandled promise.
    } finally {
      retryingConversationIdsRef.current.delete(conversationId);
      setRetryingConversationIds((current) => {
        const next = new Set(current);
        next.delete(conversationId);
        return next;
      });
    }
  };

  const changeQueuedMessage = async (id: string, action: 'save' | 'remove') => {
    if (busyId) return;
    setBusyId(id);
    setActionError(null);
    try {
      if (action === 'save') await editQueuedSubmission(id, draft);
      else await removeQueuedSubmission(id);
      setEditingId(null);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally { setBusyId(null); }
  };

  const panelTitle = issueEntries.length > 0
    ? t('backup.recovery', 'Recovery required. Original data preserved.')
    : t('chat.queueRecoveryTitle', 'Queued messages need attention');
  const panelDescription = recoveryEntries.length > 0
    ? t(
      'chat.queueRecoveryDescription',
      '{{count}} queued message(s) are retained. Retry resumes them in their original context.',
      { count: recoveryEntries.reduce((total, [, recovery]) => total + recovery.count, 0) },
    )
    : undefined;

  return (
    <aside
      aria-label={panelTitle}
      data-persistence-recovery-panel="true"
      className="pointer-events-auto fixed bottom-4 right-4 z-40 w-[min(28rem,calc(100vw-2rem))] max-w-full"
    >
      <NotificationSurface
        tone={issueEntries.length > 0 ? 'error' : 'warning'}
        title={panelTitle}
        description={panelDescription}
        className="max-h-[min(70vh,32rem)] overflow-y-auto"
        footer={(
          <div className="space-y-2">
            {issueEntries.map(([key, message]) => (
              <div
                key={key}
                role="alert"
                className="rounded-lg border border-red-400/20 bg-red-500/10 p-2 text-xs text-red-100"
              >
                <div className="font-medium">{t('backup.recovery', 'Recovery required. Original data preserved.')}</div>
                <p className="mt-1 whitespace-pre-wrap break-words text-red-100/90">{message}</p>
              </div>
            ))}

            {recoveryEntries.map(([conversationId, recovery]) => {
              const conversation = conversations.find((candidate) => candidate.id === conversationId);
              const conversationLabel = conversation?.title || conversationId;
              const isRetrying = retryingConversationIds.has(conversationId);
              const previews = queuedPreviews.filter(entry => entry.conversationId === conversationId);
              return (
                <div
                  key={conversationId}
                  className="rounded-lg border border-border/60 bg-background/60 p-2"
                >
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-medium" title={conversationLabel}>
                        {conversationLabel}
                      </div>
                      <div className="text-[11px] text-muted-foreground">×{recovery.count}</div>
                      {recovery.error ? (
                        <p role="alert" className="mt-1 break-words text-xs text-destructive">
                          {recovery.error}
                        </p>
                      ) : null}
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      isLoading={isRetrying}
                      disabled={isRetrying || Boolean(busyId) || editingId !== null}
                      aria-label={`${t('common.retry', 'Retry')} ${conversationLabel}`}
                      onClick={() => void retry(conversationId)}
                    >
                      {t('common.retry', 'Retry')}
                    </Button>
                  </div>
                  {previews.map(entry => (
                    <div key={entry.id} className="mt-2 rounded-md border border-border/50 p-2 text-xs">
                      {editingId === entry.id ? (
                        <>
                          <label htmlFor={`queue-edit-${entry.id}`} className="mb-1 block font-medium">
                            {t('chat.queueEditMessage', 'Edit queued message')}
                          </label>
                          <Textarea
                            id={`queue-edit-${entry.id}`}
                            value={draft}
                            onChange={event => setDraft(event.target.value)}
                            maxLength={200000}
                            rows={4}
                            disabled={busyId === entry.id}
                          />
                          <div className="mt-2 flex gap-2">
                            <Button type="button" size="sm" isLoading={busyId === entry.id} disabled={!draft.trim() || Boolean(busyId)} onClick={() => void changeQueuedMessage(entry.id, 'save')}>
                              {t('common.save', 'Save')}
                            </Button>
                            <Button type="button" size="sm" variant="ghost" disabled={Boolean(busyId)} onClick={() => setEditingId(null)}>
                              {t('common.cancel', 'Cancel')}
                            </Button>
                          </div>
                        </>
                      ) : (
                        <>
                          <p className="max-h-24 overflow-y-auto whitespace-pre-wrap break-words">{entry.content || t('chat.queueAttachmentOnly', 'Attachment only')}</p>
                          <div className="mt-2 flex gap-2">
                            <Button type="button" size="sm" variant="ghost" disabled={Boolean(busyId) || isRetrying} onClick={() => { setEditingId(entry.id); setDraft(entry.content); setActionError(null); }}>
                              {t('common.edit', 'Edit')}
                            </Button>
                            <Button type="button" size="sm" variant="ghost" disabled={Boolean(busyId) || isRetrying} onClick={() => void changeQueuedMessage(entry.id, 'remove')}>
                              {t('chat.queueRemoveMessage', 'Remove from queue')}
                            </Button>
                          </div>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              );
            })}
            {actionError ? <p role="alert" className="text-xs text-destructive">{actionError}</p> : null}
          </div>
        )}
      />
    </aside>
  );
}
