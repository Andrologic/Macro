import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauriAvailable, listUnresolvedToolInvocations } from '../../services/tauriIpc';
import { TOOL_INVOCATIONS_CHANGED_EVENT } from '../../services/ipc/toolInvocations';
import type { ConversationExecutionPhase } from '../../types';
import type { ToolInvocation } from '../../types/generated/ipc';

interface Props {
  conversationId: string | null;
  phase: ConversationExecutionPhase;
  activeTurnId: string | null;
}

const isActiveTurn = (phase: ConversationExecutionPhase): boolean =>
  phase === 'preparing' || phase === 'streaming' || phase === 'overflow_recovery' || phase === 'persisting';

const isVisible = (
  item: ToolInvocation,
  phase: ConversationExecutionPhase,
  activeTurnId: string | null,
): boolean => item.status === 'unknown' ||
  (item.status === 'pending' && (!isActiveTurn(phase) || item.turn_id !== activeTurnId));

const isUnresolvedInvocation = (value: unknown, conversationId: string): value is ToolInvocation => {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<ToolInvocation>;
  return item.conversation_id === conversationId &&
    typeof item.turn_id === 'string' &&
    typeof item.message_id === 'string' &&
    typeof item.call_id === 'string' &&
    typeof item.tool_name === 'string' &&
    (item.status === 'pending' || item.status === 'unknown');
};

export function UnresolvedToolInvocationsNotice({ conversationId, phase, activeTurnId }: Props) {
  const { t } = useTranslation();
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{
    conversationId: string;
    phase: ConversationExecutionPhase;
    activeTurnId: string | null;
    revision: number;
    items: ToolInvocation[] | null;
  } | null>(null);

  useEffect(() => {
    if (!conversationId) return;
    const onChange = (event: Event) => {
      if ((event as CustomEvent<{ conversationId: string }>).detail?.conversationId === conversationId) {
        setRevision((current) => current + 1);
      }
    };
    window.addEventListener(TOOL_INVOCATIONS_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(TOOL_INVOCATIONS_CHANGED_EVENT, onChange);
  }, [conversationId]);

  useEffect(() => setResult(null), [conversationId]);

  useEffect(() => {
    let current = true;
    if (!conversationId) return () => { current = false; };

    if (!isTauriAvailable()) {
      return () => { current = false; };
    }

    void listUnresolvedToolInvocations(conversationId)
      .then((items) => {
        if (current) setResult({
          conversationId, phase, activeTurnId, revision,
          items: Array.isArray(items) && items.every((item) => isUnresolvedInvocation(item, conversationId))
            ? items : null,
        });
      })
      .catch(() => {
        if (current) setResult({ conversationId, phase, activeTurnId, revision, items: null });
      });
    return () => { current = false; };
  }, [conversationId, phase, activeTurnId, revision]);

  const isCurrentResult = result?.conversationId === conversationId &&
    result.phase === phase && result.activeTurnId === activeTurnId && result.revision === revision;
  const items = result?.conversationId === conversationId && Array.isArray(result.items)
    ? result.items.filter((item) => isVisible(item, phase, activeTurnId) &&
        (isCurrentResult || isVisible(item, result.phase, result.activeTurnId)))
    : [];
  if (isCurrentResult && result?.items === null) {
    return (
      <div role="alert" data-testid="unresolved-tool-invocations-error" className="border-b border-amber-500/20 bg-amber-500/5 px-4 py-2 text-xs text-foreground">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-3">
          <p>{t('chat.toolJournalUnavailable', 'Unable to check the local tool journal. Inspect recent tool effects before sending another request.')}</p>
          <button type="button" className="shrink-0 rounded border border-amber-500/30 px-2 py-1 hover:bg-amber-500/10" onClick={() => setRevision((current) => current + 1)}>
            {t('chat.toolJournalRetryRead', 'Retry journal read')}
          </button>
        </div>
      </div>
    );
  }
  if (items.length === 0) return null;

  return (
    <div role="alert" data-testid="unresolved-tool-invocations" className="border-b border-amber-500/20 bg-amber-500/5 px-4 py-2 text-xs text-foreground">
      <div className="mx-auto max-w-4xl">
        <p className="font-medium">{t('chat.toolJournalWarning', 'Tool effects need inspection')}</p>
        <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5">
          {items.map((item, index) => (
            <li key={`${item.turn_id}:${item.message_id}:${item.call_id}`}>
              <span className="text-muted-foreground">#{index + 1}</span>{' '}
              <span className="font-medium">{item.tool_name}</span>
              {' · '}
              {item.status === 'unknown'
                ? t('chat.toolOutcomeUnknown', 'outcome unknown')
                : t('chat.toolJournalPending', 'pending after turn ended')}
            </li>
          ))}
        </ul>
        <p className="mt-1 text-muted-foreground">
          {t('chat.toolJournalInspectFirst', 'Inspect the tool’s effect before sending another request. Do not assume it failed or run it again.')}
        </p>
      </div>
    </div>
  );
}
