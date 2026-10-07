import i18n from '../../i18n';
import { isSuccessfulCompletionReason } from '../../services/ai/completionRecovery';
import type { ChatMessage } from '../../types';
import type { ChatSendResult, SendImage } from '../../services/chatSend/contracts';
import { toServiceError } from '../../services/contracts/errors';
import { captureQueuedSubmission, loadQueuedSubmissions, saveQueuedSubmissions, type QueuedSubmission, type QueuedSendIntent } from './chatQueuedSubmissions';

export type QueuedSubmissionRecoveries = Record<string, { count: number; error?: string }>;
export type QueuedSubmissionPreview = { id: string; conversationId: string; content: string };
interface QueuePorts {
  blocked(id: string): boolean;
  cancelled(id: string): boolean;
  read(id: string): Promise<ChatMessage[]>;
  send(entry: QueuedSubmission, saved?: ChatMessage): Promise<ChatSendResult>;
  publish(message: ChatMessage): void;
  saveImages(messageId: string, images: SendImage[]): boolean;
  recovery(value: QueuedSubmissionRecoveries): void;
  previews(value: QueuedSubmissionPreview[]): void;
  pending(value: Array<{ id: string; conversationId: string }>): void;
  attempted(value: Array<{ id: string; conversationId: string }>): void;
}

/** Owns deferred submissions only; the chat runtime still owns active turns. */
export function createQueuedSubmissionRuntime(ports: QueuePorts) {
  let entries = loadQueuedSubmissions();
  const paused = new Set(entries.map(entry => entry.input.conversationId));
  const draining = new Set<string>();
  const attempted = new Map<string, string>();
  // IO ownership outlives presentation/confirmation removal of its queue entry.
  const directionWrites = new Map<string, { entry: QueuedSubmission; pending: Promise<unknown> }>();
  const assertNoDirectionWrite = (id: string) => {
    if (directionWrites.has(id)) {
      throw new Error(i18n.t('chat.queueWriteInProgress',
        'This direction is still being saved. Wait for its save to finish before retrying.'));
    }
  };
  const writeDirection = async <T>(id: string, write: () => Promise<T>): Promise<T> => {
    const entry = entries.find(entry => entry.id === id && !entry.direction?.deletionRequested);
    if (!entry) throw new Error('The direction was invalidated before its write.');
    if (mutating.has(id)) throw new Error(i18n.t('chat.queueEditInProgress', 'Wait for the queued message change to finish.'));
    // Keep the first IO tracked until it settles. A retry must never replace it.
    assertNoDirectionWrite(id);
    const pending = Promise.resolve().then(() => {
      if (!entries.some(entry => entry.id === id && !entry.direction?.deletionRequested)) {
        throw new Error('The direction was invalidated before its write.');
      }
      return write();
    });
    const ownership = { entry, pending };
    directionWrites.set(id, ownership);
    try { return await pending; }
    finally { if (directionWrites.get(id) === ownership) directionWrites.delete(id); }
  };
  let recoveries: QueuedSubmissionRecoveries = Object.fromEntries(Array.from(paused, id => [id, {
    count: entries.filter(entry => entry.input.conversationId === id).length,
  }]));
  const publishRecovery = () => {
    ports.recovery(recoveries);
    ports.pending(entries.map(entry => ({ id: entry.id, conversationId: entry.input.conversationId })));
    ports.attempted(Array.from(attempted, ([id, conversationId]) => ({ id, conversationId })));
    ports.previews(entries.filter(entry => paused.has(entry.input.conversationId)).map(entry => ({
      id: entry.id, conversationId: entry.input.conversationId, content: entry.input.content,
    })));
  };
  publishRecovery();
  const mutating = new Set<string>();
  const pendingEntry = async (id: string, allowSaved = false): Promise<QueuedSubmission> => {
    const entry = entries.find(candidate => candidate.id === id);
    if (!entry || !paused.has(entry.input.conversationId) || draining.has(entry.input.conversationId) || mutating.has(id)) {
      throw new Error(i18n.t('chat.queueNoLongerEditable', 'This queued message is no longer available to edit.'));
    }
    if (entry.direction?.deletionRequested && !allowSaved) throw new Error("This direction was invalidated by deletion. Remove its recovery entry.");
    assertNoDirectionWrite(id);
    mutating.add(id);
    try {
      const persisted = await ports.read(entry.input.conversationId);
      if (!allowSaved && persisted.some(message => message.role === 'user' &&
        (entry.direction ? message.id === entry.direction.userMessageId : message.turn_id === id))) {
        throw new Error(i18n.t('chat.queueAlreadySent', 'This message was already saved. Retry recovery instead.'));
      }
      if (!entries.includes(entry) || !paused.has(entry.input.conversationId) || draining.has(entry.input.conversationId)) {
        throw new Error(i18n.t('chat.queueNoLongerEditable', 'This queued message is no longer available to edit.'));
      }
      assertNoDirectionWrite(id);
      return entry;
    } catch (error) {
      mutating.delete(id);
      throw error;
    }
  };
  const refreshRecovery = () => {
    recoveries = Object.fromEntries(Object.entries(recoveries).flatMap(([id, recovery]) => {
      const count = entries.filter(entry => entry.input.conversationId === id).length;
      return count ? [[id, { ...recovery, count }]] : [];
    }));
    publishRecovery();
  };
  const persist = (next: QueuedSubmission[]) => {
    if (!saveQueuedSubmissions(next)) throw new Error(i18n.t(
      'chat.queueSaveFailed', 'Queued messages could not be saved. Keep this session open and try again.',
    ));
    entries = next;
    refreshRecovery();
  };
  const pause = (id: string, error?: string) => {
    const count = entries.filter(entry => entry.input.conversationId === id).length;
    if (!count) return;
    paused.add(id);
    recoveries = { ...recoveries, [id]: { count, error } };
    publishRecovery();
  };
  const acknowledge = (entry: QueuedSubmission, message: ChatMessage) => {
    if (!entries.some(candidate => candidate.id === entry.id && !candidate.direction?.deletionRequested)) return;
    if (entry.input.images?.length && !ports.saveImages(message.id, entry.input.images)) {
      throw new Error(i18n.t('chat.queueImagesSaveFailed', 'The message is saved, but its images still need saving. Retry the queued submission.'));
    }
  };
  const complete = (entry: QueuedSubmission) => persist(entries.filter(candidate => candidate.id !== entry.id));
  const retireConfirmed = (confirmed: (entry: QueuedSubmission) => boolean) => {
    const selected = entries.filter(entry => !entry.direction?.deletionRequested && confirmed(entry));
    if (!selected.length) return;
    persist(entries.filter(entry => !selected.includes(entry)));
    for (const id of new Set(selected.map(entry => entry.input.conversationId))) {
      if (!entries.some(entry => entry.input.conversationId === id && entry.direction) && !recoveries[id]?.error) paused.delete(id);
    }
    publishRecovery();
  };
  const confirmedBy = (entry: QueuedSubmission, assistant: ChatMessage, savedNow = false) => entry.direction && !entry.direction.deletionRequested &&
    entry.input.conversationId === assistant.conversation_id && entry.direction.target.turnId === assistant.turn_id &&
    (savedNow || assistant.completion_reason !== undefined) && isSuccessfulCompletionReason(assistant.completion_reason) && (
      (entry.direction.delivery?.assistantMessageId === assistant.id && entry.direction.delivery.requestEnded) ||
      (entry.direction.recoveryAssistantMessageId === assistant.id && entry.direction.recoveryRequestEnded));
  const beforeAssistantStart = (entry: QueuedSubmission, assistant?: ChatMessage) => {
    if (!entries.some(candidate => candidate.id === entry.id && !candidate.direction?.deletionRequested)) throw new Error('The queued submission is no longer available.');
    persist(entries.map(candidate => candidate.id === entry.id ? {
      ...candidate, assistantStartAttempted: true,
      ...(candidate.direction ? { direction: { ...candidate.direction, recoveryAssistantMessageId: assistant?.id } } : {}),
    } : candidate));
  };
  const drain = async (id: string, explicit = false): Promise<void> => {
    if (draining.has(id) || paused.has(id) || ports.blocked(id)) return;
    const next = entries.find(entry => entry.input.conversationId === id);
    if (!next || ports.cancelled(id) || (next.direction && !explicit)) return;
    draining.add(id);
    let continueQueue = false;
    try {
      if (next.direction?.deletionRequested) {
        throw new Error(i18n.t('chat.queueDirectionDeleted',
          'This direction was invalidated by deletion or replay. Remove this recovery entry before continuing manually.'));
      }
      const persisted = await ports.read(id);
      if (ports.cancelled(id) || !entries.some(entry => entry.id === next.id && !entry.direction?.deletionRequested)) return;
      const saved = persisted.find(message => message.role === 'user' &&
        (next.direction ? message.id === next.direction.userMessageId : message.turn_id === next.id));
      if (saved && (saved.conversation_id !== id || (next.direction && saved.turn_id !== next.direction.target.turnId))) {
        throw new Error('The saved message does not belong to this direction.');
      }
      if (saved) {
        ports.publish(saved);
        acknowledge(next, saved);
      }
      const assistant = persisted.find(message => message.role === 'assistant' &&
        (next.direction ? message.id === (next.direction.delivery?.assistantMessageId ?? next.direction.recoveryAssistantMessageId) : message.turn_id === next.id));
      if (saved && assistant && confirmedBy(next, assistant)) {
        retireConfirmed(entry => entry.id === next.id);
      } else if (!next.direction && assistant?.completion_reason === 'completed') {
        complete(next);
      } else if (next.assistantStartAttempted || next.direction?.delivery || assistant) {
        throw new Error(i18n.t('chat.queueAssistantInterrupted',
          'This saved instruction may have started executing. Review the response and tool effects, then remove this recovery entry before continuing manually.'));
      } else {
        attempted.set(next.id, id);
        publishRecovery();
        const result = next.direction ? await writeDirection(next.id, () => ports.send(next, saved)) : await ports.send(next, saved);
        if (result.status === 'cancelled' || !result.assistantMessageId) throw new Error(i18n.t('chat.queueInterrupted', 'The queued send was interrupted. Its content is retained.'));
      }
      continueQueue = true;
    } catch (error) {
      pause(id, toServiceError(error).message);
    } finally {
      attempted.delete(next.id);
      publishRecovery();
      draining.delete(id);
      if (continueQueue) queueMicrotask(() => void drain(id));
    }
  };
  return {
    capture: captureQueuedSubmission,
    excludedDirectionMessageIds(conversationId: string, resumedMessageId?: string) {
      return new Set(entries.filter(entry => entry.input.conversationId === conversationId && entry.direction &&
        (entry.direction.deletionRequested || !entry.direction.delivery?.requestEnded) && entry.direction.userMessageId !== resumedMessageId)
        .map(entry => entry.direction!.userMessageId));
    },
    bindDirectionIntent(conversationId: string, sessionId: string, turnId: string, intent: QueuedSendIntent) {
      const belongs = (entry: QueuedSubmission) => entry.input.conversationId === conversationId &&
        entry.direction?.target.sessionId === sessionId && entry.direction.target.turnId === turnId && !entry.direction.delivery && !entry.direction.deletionRequested;
      if (entries.some(belongs)) persist(entries.map(entry => belongs(entry) ? {
        ...entry, intent: { ...intent, composerContextRefs: entry.input.contextRefs ?? [] },
      } : entry));
    },
    hasDirections(conversationId: string) { return entries.some(entry => entry.input.conversationId === conversationId && entry.direction); },
    hasEntry(id: string) { return entries.some(entry => entry.id === id && !entry.direction?.deletionRequested); },
    writeDirection,
    async invalidateDirectionTurns(conversationId: string, turnIds: readonly string[]) {
      const belongs = (entry: QueuedSubmission) => entry.input.conversationId === conversationId &&
        entry.direction && turnIds.includes(entry.direction.target.turnId);
      const selected = new Map(entries.filter(belongs).map(entry => [entry.id, entry]));
      for (const { entry } of directionWrites.values()) {
        if (belongs(entry) && !selected.has(entry.id)) selected.set(entry.id, entry);
      }
      if (!selected.size) return [];
      const ids = [...selected.keys()];
      // Reattach an active owner only as an invalidated record, never as a replayable direction.
      const retained = [...entries, ...[...selected.values()].filter(entry => !entries.some(current => current.id === entry.id))];
      // Refusal happens before DB deletion. A later cleanup refusal retains this marker on disk.
      persist(retained.map(entry => ids.includes(entry.id) && entry.direction ? {
        ...entry, direction: { ...entry.direction, deletionRequested: true },
      } : entry));
      await Promise.allSettled(ids.flatMap(id => directionWrites.has(id) ? [directionWrites.get(id)!.pending] : []));
      return ids;
    },
    finishDirectionDeletion(ids: readonly string[]) {
      if (!ids.length) return;
      const remaining = entries.filter(entry => !ids.includes(entry.id));
      saveQueuedSubmissions(remaining);
      // DB deletion is authoritative; a refused write leaves only invalidated entries on disk.
      entries = remaining;
      refreshRecovery();
    },
    markDirectionDelivery(ids: string[], identity: { conversationId: string; sessionId: string; turnId: string | null; assistantMessageId: string }, requestId: string) {
      for (const id of ids) {
        const entry = entries.find(candidate => candidate.id === id);
        const target = entry?.direction?.target;
        if (!target || entry?.input.conversationId !== identity.conversationId || target.sessionId !== identity.sessionId ||
          target.turnId !== identity.turnId || (target.assistantMessageId !== null && target.assistantMessageId !== identity.assistantMessageId) || entry.direction?.delivery || entry.direction?.deletionRequested) {
          throw new Error('The direction no longer belongs to this request.');
        }
      }
      persist(entries.map(entry => ids.includes(entry.id) && entry.direction ? { ...entry, direction: {
        ...entry.direction, delivery: { requestId, assistantMessageId: identity.assistantMessageId, requestEnded: false },
      } } : entry));
    },
    directionRequestEnded(ids: string[], requestId: string) {
      if (!ids.length) return;
      persist(entries.map(entry => ids.includes(entry.id) && entry.direction?.delivery?.requestId === requestId ? {
        ...entry, direction: { ...entry.direction, delivery: { ...entry.direction.delivery, requestEnded: true } },
      } : entry));
    },
    confirmDirections(ids: string[], assistantMessageId: string) {
      retireConfirmed(entry => ids.includes(entry.id) && entry.direction?.delivery?.requestEnded === true &&
        entry.direction.delivery.assistantMessageId === assistantMessageId);
    },
    directionRecoveryRequestEnded(assistantMessageId: string) {
      const affected = entries.some(entry => entry.direction?.recoveryAssistantMessageId === assistantMessageId);
      if (affected) persist(entries.map(entry => entry.direction?.recoveryAssistantMessageId === assistantMessageId ? {
        ...entry, direction: { ...entry.direction, recoveryRequestEnded: true },
      } : entry));
    },
    confirmDirectionRecovery(assistantMessageId: string) {
      retireConfirmed(entry => entry.direction?.recoveryAssistantMessageId === assistantMessageId && entry.direction.recoveryRequestEnded === true);
    },
    confirmPersistedAssistant(assistant: ChatMessage) { retireConfirmed(entry => Boolean(confirmedBy(entry, assistant, true))); },
    accept(entry: QueuedSubmission) {
      persist([...entries, entry]);
      queueMicrotask(() => void drain(entry.input.conversationId));
    },
    acknowledge,
    beforeAssistantStart,
    complete,
    pause,
    drain,
    async retry(id: string) {
      if (entries.some(entry => entry.input.conversationId === id && mutating.has(entry.id))) {
        throw new Error(i18n.t('chat.queueEditInProgress', 'Wait for the queued message change to finish.'));
      }
      if (ports.blocked(id) || ports.cancelled(id)) return;
      paused.delete(id);
      if (recoveries[id]?.error) {
        recoveries = { ...recoveries, [id]: { count: recoveries[id].count } };
      }
      publishRecovery();
      await drain(id, true);
    },
    async edit(id: string, content: string) {
      await pendingEntry(id);
      try {
        if (!content.trim()) throw new Error(i18n.t('chat.queueEmptyMessage', 'The queued message cannot be empty.'));
        persist(entries.map(candidate => candidate.id === id ? { ...candidate, input: { ...candidate.input, content } } : candidate));
      } finally { mutating.delete(id); }
    },
    async removeEntry(id: string) {
      const entry = await pendingEntry(id, true);
      try {
        persist(entries.filter(candidate => candidate.id !== id));
        if (!entries.some(candidate => candidate.input.conversationId === entry.input.conversationId)) {
          paused.delete(entry.input.conversationId);
        }
      }
      finally { mutating.delete(id); }
    },
    remove(ids: readonly string[]) {
      const remaining = entries.filter(entry => !ids.includes(entry.input.conversationId));
      if (remaining.length !== entries.length) saveQueuedSubmissions(remaining);
      // Deletion is authoritative even if local cleanup fails; storage reports the failure.
      entries = remaining;
      ids.forEach(id => paused.delete(id));
      refreshRecovery();
    },
    restore(conversationIds: readonly string[]) {
      const retained = entries.filter(entry => conversationIds.includes(entry.input.conversationId));
      if (retained.length !== entries.length && saveQueuedSubmissions(retained)) entries = retained;
      for (const id of paused) pause(id);
    },
  };
}
export type QueuedSubmissionRuntime = ReturnType<typeof createQueuedSubmissionRuntime>;
