import { conversationSetArchives, conversationAcknowledge, conversationResponseVersion, getMessage, isTauriAvailable } from './tauriIpc';
import { buildAssistantMessagePresentation } from './chatDbMappers';
import type { ChatMessage } from '../types';

/** Capture the displayed bytes before asynchronous IPC. A concurrently replaced
 * or completed assistant cannot be acknowledged from an earlier UI frame. */
export async function acknowledgeDisplayedConversation(conversationId: string, messages: readonly ChatMessage[]): Promise<void> {
  if (!isTauriAvailable()) return;
  const displayed = messages.filter(m => m.conversation_id === conversationId && m.role === 'assistant' && m.content.length > 0).map(m => ({ id: m.id, content: m.content, completionReason: m.completion_reason ?? null }));
  const observed: number[] = [];
  for (const message of displayed) {
    try {
      const persisted = await getMessage(message.id);
      if (!persisted || persisted.conversation_id !== conversationId || (persisted.completion_reason ?? null) !== message.completionReason || buildAssistantMessagePresentation(persisted.content, persisted.hidden_context ?? undefined).content !== message.content) continue;
      observed.push(await conversationResponseVersion(message.id, persisted.content, message.completionReason));
    }
    catch { /* An edited/completing response stays unread until observed again. */ }
  }
  if (observed.length) await conversationAcknowledge(conversationId, observed);
}
export async function persistConversationArchives(ids: readonly string[], archived: boolean): Promise<void> {
  if (!isTauriAvailable()) return;
  await conversationSetArchives(ids, archived);
}
