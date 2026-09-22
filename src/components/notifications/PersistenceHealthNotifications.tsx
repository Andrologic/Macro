import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePersistenceHealth } from '../../services/persistenceHealth';
import { useAppStore } from '../../stores/useAppStore';
import { useChatStore } from '../../stores/useChatStore';
import { Button } from '../ui/Button';
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
    if (retryingConversationIdsRef.current.has(conversationId)) return;
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
      className="pointer-events-auto fixed bottom-4 right-4 z-[60] w-[min(28rem,calc(100vw-2rem))] max-w-full"
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
              return (
                <div
                  key={conversationId}
                  className="flex items-start gap-2 rounded-lg border border-border/60 bg-background/60 p-2"
                >
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
                    disabled={isRetrying}
                    aria-label={`${t('common.retry', 'Retry')} ${conversationLabel}`}
                    onClick={() => void retry(conversationId)}
                  >
                    {t('common.retry', 'Retry')}
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      />
    </aside>
  );
}
