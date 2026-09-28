import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauriAvailable, listUnresolvedToolInvocations } from '../../services/tauriIpc';
import type { ConversationExecutionPhase } from '../../types';
import type { ToolInvocation } from '../../types/generated/ipc';

interface Props {
  conversationId: string | null;
  phase: ConversationExecutionPhase;
}

const isActiveTurn = (phase: ConversationExecutionPhase): boolean =>
  phase === 'preparing' || phase === 'streaming' || phase === 'overflow_recovery' || phase === 'persisting';

export function UnresolvedToolInvocationsNotice({ conversationId, phase }: Props) {
  const { t } = useTranslation();
  const [result, setResult] = useState<{ conversationId: string; phase: ConversationExecutionPhase; items: ToolInvocation[] } | null>(null);

  useEffect(() => {
    let current = true;
    setResult(null);
    if (!conversationId) return () => { current = false; };

    if (!isTauriAvailable()) {
      return () => { current = false; };
    }

    void listUnresolvedToolInvocations(conversationId)
      .then((items) => {
        if (current) setResult({ conversationId, phase, items: Array.isArray(items) ? items : [] });
      })
      .catch(() => {
        if (current) setResult(null);
      });
    return () => { current = false; };
  }, [conversationId, phase]);

  const items = result?.conversationId === conversationId && result.phase === phase
    ? result.items.filter((item) => item.status === 'unknown' ||
        (item.status === 'pending' && !isActiveTurn(phase)))
    : [];
  if (items.length === 0) return null;

  return (
    <div role="alert" data-testid="unresolved-tool-invocations" className="border-b border-amber-500/20 bg-amber-500/5 px-4 py-2 text-xs text-foreground">
      <div className="mx-auto max-w-4xl">
        <p className="font-medium">{t('chat.toolJournalWarning', 'Tool effects need inspection')}</p>
        <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5">
          {items.map((item) => (
            <li key={`${item.turn_id}:${item.message_id}:${item.call_id}`}>
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
