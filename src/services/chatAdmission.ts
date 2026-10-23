import { responseOptions } from './chatResponsePayload';
import * as ipc from './tauriIpc';
import { MacroServiceError } from './contracts/errors';

const responseReservations = new Map<string, { context: ipc.ChatAdmissionContext; receipt: ipc.ChatIntentReceipt }>();

export async function reserveChatResponse(context: ipc.ChatAdmissionContext, conversationId: string, messageId: string): Promise<void> {
  const receipt = await ipc.chatAdmissionReserveResponse(context, conversationId, messageId);
  responseReservations.set(messageId, { context, receipt });
}

export function responseCopyAdmission(messageId: string, admission: ipc.ProviderAdmission): ipc.ChatIntentAdmission {
  if (admission.kind === 'conversation') return admission;
  const reservation = responseReservations.get(messageId);
  if (admission.kind !== 'globalChat' || !reservation || reservation.context.handle !== admission.context.handle ||
      reservation.context.runtime !== admission.context.runtime) {
    throw new MacroServiceError('CHAT_ADMISSION_REFUSED', 'The response recovery copy has no native admission.');
  }
  return { kind: 'globalChat', receipt: reservation.receipt };
}

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
    if (runtime === captured) { runtime = undefined; registration = undefined; responseReservations.clear(); }
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

async function removeResponseCopy(messageId: string, admission: ipc.ChatIntentAdmission, remove: () => boolean): Promise<void> {
  if (!remove()) throw new MacroServiceError('CHAT_RECOVERY_COPY_RETAINED', 'The saved recovery copy could not be removed.');
  await finishChatIntent(admission);
  responseReservations.delete(messageId);
}

export async function finishChatResponse(context: ipc.ChatAdmissionContext, conversationId: string,
  message: import('../types').ChatMessage, removeCopy: () => boolean): Promise<void> {
  if (message.conversation_id !== conversationId || message.role !== 'assistant') {
    throw new MacroServiceError('CHAT_ADMISSION_REFUSED', 'The final response does not belong to this turn.');
  }
  const admission = responseCopyAdmission(message.id, { kind: 'globalChat', context });
  await ipc.chatAdmissionFinishResponse(context, conversationId, message.id, message.content, responseOptions(message));
  await removeResponseCopy(message.id, admission, removeCopy);
}

export async function recoverChatResponse(message: import('../types').ChatMessage,
  persistConversation: () => Promise<void>, removeCopy: () => boolean): Promise<void> {
  const current = responseReservations.get(message.id);
  if (current) {
    await finishChatResponse(current.context, message.conversation_id, message, removeCopy);
    return;
  }
  if (!ipc.isTauriAvailable()) throw new MacroServiceError('CHAT_ADMISSION_UNAVAILABLE', 'Chat admission requires the desktop backend.');
  await retirement;
  runtime ??= crypto.randomUUID();
  const admission = await ipc.chatAdmissionPrepareResponseRecovery(runtime, message.conversation_id, message.id, 'retain');
  if (admission.kind === 'globalChat') {
    await ipc.chatAdmissionRecoverResponse(admission.receipt, message.id, message.content, responseOptions(message));
  } else {
    await persistConversation();
  }
  await removeResponseCopy(message.id, admission, removeCopy);
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

/** Explicit copy removal does not close its parent or any external effect. */
export async function discardChatResponseCopy(message: import('../types').ChatMessage, removeCopy: () => boolean): Promise<void> {
  if (!ipc.isTauriAvailable()) throw new MacroServiceError('CHAT_ADMISSION_UNAVAILABLE', 'Chat admission requires the desktop backend.');
  await retirement;
  runtime ??= crypto.randomUUID();
  const admission = await ipc.chatAdmissionPrepareResponseRecovery(runtime, message.conversation_id, message.id, 'remove');
  await removeResponseCopy(message.id, admission, removeCopy);
}
