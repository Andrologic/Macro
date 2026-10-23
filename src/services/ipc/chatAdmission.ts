import { buildMessageUpdateParams, type MessageUpdateOptions } from './conversations';
import { invoke } from '../tauriRuntimeBridge';

/** Local native capability. Never persist it or include it in provider input. */
export interface ChatAdmissionContext {
  handle: string;
  runtime: string;
}

export type ProviderAdmission =
  | { kind: 'globalChat'; context: ChatAdmissionContext }
  | { kind: 'conversation' }
  | { kind: 'utility' };

export function chatAdmissionBegin(
  runtime: string, conversationId: string, turnId: string, attemptId: string, purpose: 'turn' | 'compaction',
): Promise<Exclude<ProviderAdmission, { kind: 'utility' }>> {
  return invoke('chat_admission_begin', { runtime, conversationId, turnId, attemptId, purpose });
}

export async function chatAdmissionClosePreparation(context: ChatAdmissionContext, conversationId: string): Promise<void> {
  await invoke('chat_admission_close_preparation', { context, conversationId });
  await chatAdmissionAcknowledgeCompletion(context, conversationId);
}

export type ChatWorkPhase = 'prepared' | 'dispatched' | 'result_pending' | 'completed' | 'no_effect' | 'unknown';

export function chatAdmissionJoinProvider(context: ChatAdmissionContext, conversationId: string, requestId: string): Promise<{
  phase: ChatWorkPhase; taskError: string | null;
}> {
  return invoke('chat_admission_join_provider', { context, conversationId, requestId });
}

export type AdmittedHttpPart =
  | { kind: 'headers'; status: number; url: string; headers: [string, string][] }
  | { kind: 'bytes'; data: number[] }
  | { kind: 'end' };

export function chatAdmissionHttpStart(context: ChatAdmissionContext, conversationId: string, request: {
  requestId: string; providerId: string; url: string; headers: [string, string][]; body: string;
}): Promise<void> {
  return invoke('chat_admission_http_start', { context, conversationId, request });
}

export function chatAdmissionHttpRead(requestId: string): Promise<AdmittedHttpPart> {
  return invoke('chat_admission_http_read', { requestId });
}

export function chatAdmissionHttpFinish(context: ChatAdmissionContext, conversationId: string, requestId: string,
  outcome: 'completed' | 'uncertain'): Promise<{ phase: ChatWorkPhase; taskError: string | null }> {
  return invoke('chat_admission_http_finish', { context, conversationId, requestId, outcome });
}

export async function chatAdmissionFinishResponse(context: ChatAdmissionContext, conversationId: string,
  id: string, content: string, options?: MessageUpdateOptions): Promise<void> {
  await invoke('chat_admission_finish_response', {
    context, conversationId, params: buildMessageUpdateParams(id, content, options),
  });
  await chatAdmissionAcknowledgeCompletion(context, conversationId);
}

export async function chatAdmissionFinishCompaction(context: ChatAdmissionContext, conversationId: string,
  input: import('./conversations.types').DbUpsertConversationCompactionStateInput | null): Promise<void> {
  await invoke('chat_admission_finish_compaction', { context, conversationId, input });
  await chatAdmissionAcknowledgeCompletion(context, conversationId);
}

/** Local tool association captured by the dispatch owner, never serialized in history. */
export interface ChatToolAdmission {
  context: ChatAdmissionContext;
  identity: import('../../types/generated/ipc').ToolInvocationIdentity;
}

export function chatAdmissionAcknowledgeCompletion(context: ChatAdmissionContext, conversationId: string): Promise<void> {
  return invoke('chat_admission_acknowledge_completion', { context, conversationId });
}

export function chatAdmissionOpenBrowser(runtime: string): Promise<void> {
  return invoke('chat_admission_open_browser', { runtime });
}

export function chatAdmissionCloseBrowser(runtime: string): Promise<void> {
  return invoke('chat_admission_close_browser', { runtime });
}


export interface ChatIntentIdentity {
  conversationId: string;
  kind: 'queue' | 'steer' | 'question' | 'approval' | 'unsaved' | 'recovery';
  id: string;
}
export interface ChatIntentReceipt {
  operationId: string;
  runtime: string;
  revision: number;
  identity: ChatIntentIdentity;
}
export type ChatIntentAdmission = { kind: 'conversation' } | { kind: 'globalChat'; receipt: ChatIntentReceipt };

export function chatAdmissionBeginIntent(runtime: string, identity: ChatIntentIdentity, mutation: 'retain' | 'remove'): Promise<ChatIntentAdmission> {
  return invoke('chat_admission_begin_intent', { runtime, identity, mutation });
}
export function chatAdmissionFinishIntent(receipt: ChatIntentReceipt): Promise<void> {
  return invoke('chat_admission_finish_intent', { receipt });
}

export function chatAdmissionWriteApprovalRegistry(conversationId: string, admission: ChatIntentAdmission,
  expectedValueJson: string | null, valueJson: string | null): Promise<void> {
  return invoke('chat_admission_write_approval_registry', {
    conversationId, receipt: admission.kind === 'globalChat' ? admission.receipt : null,
    expectedValueJson, valueJson,
  });
}

export function chatAdmissionCompleteSteerHandoff(context: ChatAdmissionContext, conversationId: string,
  requestId: string, receipts: ChatIntentReceipt[]): Promise<void> {
  return invoke('chat_admission_complete_steer_handoff', { context, conversationId, requestId, receipts });
}

export function chatAdmissionCompleteQuestionHandoff(context: ChatAdmissionContext, conversationId: string,
  responseMessageId: string, receipt: ChatIntentReceipt): Promise<void> {
  return invoke('chat_admission_complete_question_handoff', { context, conversationId, responseMessageId, receipt });
}

export function chatAdmissionReserveResponse(context: ChatAdmissionContext, conversationId: string, messageId: string): Promise<ChatIntentReceipt> {
  return invoke('chat_admission_reserve_response', { context, conversationId, messageId });
}

export function chatAdmissionPrepareResponseRecovery(runtime: string, conversationId: string, messageId: string, mutation: 'retain' | 'remove'): Promise<ChatIntentAdmission> {
  return invoke('chat_admission_prepare_response_recovery', { runtime, conversationId, messageId, mutation });
}
export function chatAdmissionRecoverResponse(receipt: ChatIntentReceipt, id: string, content: string, options?: MessageUpdateOptions): Promise<void> {
  return invoke('chat_admission_recover_response', { receipt, params: buildMessageUpdateParams(id, content, options) });
}

export interface ChatBrowserInspection {
  queue: string[]; unsaved: string[]; approvals: string[]; questions: string[]; drafts: string[]; steers: string[];
}
export function chatAdmissionBeginReconciliation(runtime: string, conversationId: string): Promise<string> {
  return invoke('chat_admission_begin_reconciliation', { runtime, conversationId });
}
export function chatAdmissionCompleteReconciliation(runtime: string, handle: string, observed: ChatBrowserInspection): Promise<void> {
  return invoke('chat_admission_complete_reconciliation', { runtime, handle, observed });
}
