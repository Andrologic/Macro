import * as ipc from './tauriIpc';
import { MacroServiceError } from './contracts/errors';

let runtime: string | undefined;
let registration: Promise<void> | undefined;
let retirement: Promise<void> = Promise.resolve();

export async function ensureChatBrowser(): Promise<string> {
  if (!ipc.isTauriAvailable()) {
    throw new MacroServiceError('CHAT_ADMISSION_UNAVAILABLE', 'Chat admission requires the desktop backend.');
  }
  await retirement;
  runtime ??= crypto.randomUUID();
  const captured = runtime;
  registration ??= ipc.chatAdmissionOpenBrowser(captured).catch(error => {
    if (runtime === captured) registration = undefined;
    throw error;
  });
  await registration;
  return captured;
}

export function retireChatBrowser(): Promise<void> {
  const captured = runtime;
  if (!captured) return retirement;
  const pending = registration;
  retirement = retirement.then(async () => {
    await Promise.allSettled([pending]);
    await ipc.chatAdmissionCloseBrowser(captured);
    if (runtime === captured) { runtime = undefined; registration = undefined; }
  });
  return retirement;
}

export async function beginChatAdmission(conversationId: string, turnId: string, attemptId: string, purpose: 'turn' | 'compaction' = 'turn') {
  if (!ipc.isTauriAvailable()) {
    throw new MacroServiceError('CHAT_ADMISSION_UNAVAILABLE', 'Chat admission requires the desktop backend.');
  }
  await retirement;
  runtime ??= crypto.randomUUID();
  // Native scope classification precedes global browser registration. Project
  // and Goal callers keep their existing owners without taking this lease.
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


export async function beginChatIntent(identity: ipc.ChatIntentIdentity, mutation: 'retain' | 'remove' = 'retain'): Promise<ipc.ChatIntentAdmission> {
  if (!ipc.isTauriAvailable()) {
    throw new MacroServiceError('CHAT_ADMISSION_UNAVAILABLE', 'Chat admission requires the desktop backend.');
  }
  await retirement;
  runtime ??= crypto.randomUUID();
  return ipc.chatAdmissionBeginIntent(runtime, identity, mutation);
}

export async function finishChatIntent(admission: ipc.ChatIntentAdmission): Promise<void> {
  if (admission.kind === 'globalChat') await ipc.chatAdmissionFinishIntent(admission.receipt);
}
