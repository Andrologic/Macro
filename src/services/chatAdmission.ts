import * as ipc from './tauriIpc';
import { MacroServiceError } from './contracts/errors';

let runtime: string | undefined;

export async function beginChatAdmission(conversationId: string, turnId: string, attemptId: string, purpose: 'turn' | 'compaction' = 'turn') {
  if (!ipc.isTauriAvailable()) {
    throw new MacroServiceError('CHAT_ADMISSION_UNAVAILABLE', 'Chat admission requires the desktop backend.');
  }
  runtime ??= crypto.randomUUID();
  return ipc.chatAdmissionBegin(runtime, conversationId, turnId, attemptId, purpose);
}

export const closeChatPreparation = ipc.chatAdmissionClosePreparation;

export async function finishChatResponse(context: ipc.ChatAdmissionContext, conversationId: string,
  message: import('../types').ChatMessage): Promise<void> {
  if (message.conversation_id !== conversationId || message.role !== 'assistant') {
    throw new MacroServiceError('CHAT_ADMISSION_REFUSED', 'The final response does not belong to this turn.');
  }
  await ipc.chatAdmissionFinishResponse(context, conversationId, message.id, message.content, {
    turnId: message.turn_id, toolTraces: message.tool_traces, hiddenContext: message.hidden_context,
    providerInputItems: message.provider_input_items, providerTurnState: message.provider_turn_state,
    contextRefs: message.context_refs, completionReason: message.completion_reason,
    generationAttempts: message.generation_attempts,
  });
}
