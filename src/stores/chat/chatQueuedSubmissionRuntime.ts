import i18n from '../../i18n';
import { isSuccessfulCompletionReason } from '../../services/ai/completionRecovery';
import type { ChatIntentAdmission } from '../../services/ipc/chatAdmission';
import type { ChatMessage } from '../../types';
import type { ChatSendResult, SendImage } from '../../services/chatSend/contracts';
import { toServiceError } from '../../services/contracts/errors';
import { captureQueuedSubmission, loadQueuedSubmissions, saveQueuedSubmissions, type QueuedSubmission, type QueuedSendIntent } from './chatQueuedSubmissions';

export type QueuedSubmissionRecoveries = Record<string, { count: number; error?: string }>;
export type QueuedSubmissionPreview = { id: string; conversationId: string; content: string; state: 'waiting' | 'sending' | 'paused' };
interface QueuePorts {
  admit(entry: QueuedSubmission, mutation: 'retain' | 'remove'): Promise<ChatIntentAdmission>;
  finish(admission: ChatIntentAdmission): Promise<void>;
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
  let retired = false;
  const jobs = new Set<Promise<void>>();
  const paused = new Set(entries.map(entry => entry.input.conversationId));
  const draining = new Set<string>();
  const attempted = new Map<string, string>();
  const claimed = new Set<string>();
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
    if (retired) return;
    ports.recovery(recoveries);
    ports.pending(entries.map(entry => ({ id: entry.id, conversationId: entry.input.conversationId })));
    ports.attempted(Array.from(attempted, ([id, conversationId]) => ({ id, conversationId })));
    ports.previews(entries.map(entry => ({
      id: entry.id, conversationId: entry.input.conversationId, content: entry.input.content,
      state: claimed.has(entry.id) ? 'sending' : paused.has(entry.input.conversationId) ? 'paused' : 'waiting',
    })));
  };
  publishRecovery();
  const mutating = new Set<string>();
  const pendingEntry = async (id: string, allowSaved = false): Promise<QueuedSubmission> => {
    const entry = entries.find(candidate => candidate.id === id);
    if (!entry || claimed.has(id) || mutating.has(id) ||
      (!allowSaved && (!paused.has(entry.input.conversationId) || draining.has(entry.input.conversationId)))) {
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
      if (!entries.includes(entry) || claimed.has(id) ||
        (!allowSaved && (!paused.has(entry.input.conversationId) || draining.has(entry.input.conversationId)))) {
        throw new Error(i18n.t('chat.queueNoLongerEditable', 'This queued message is no longer available to edit.'));
      }
      assertNoDirectionWrite(id);
      return entry;
    } catch (error) {
      mutating.delete(id);
      queueMicrotask(() => void drain(entry.input.conversationId));
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
  const admissions = new Map<string, ChatIntentAdmission>();
  let writes: Promise<void> = Promise.resolve();
  const persist = (update: (current: QueuedSubmission[]) => QueuedSubmission[]) => {
    const write = writes.catch(() => undefined).then(async () => {
      if (retired) throw new Error('Queued submission owner has retired.');
      const next = update(entries);
      const removed = entries.filter(entry => !next.some(candidate => candidate.id === entry.id));
      for (const entry of [...next.filter(entry => !entries.includes(entry)), ...removed]) {
        admissions.set(entry.id, await ports.admit(entry, removed.includes(entry) ? 'remove' : 'retain'));
      }
      if (retired) throw new Error('Queued submission owner has retired.');
      if (!saveQueuedSubmissions(next)) throw new Error(i18n.t(
        'chat.queueSaveFailed', 'Queued messages could not be saved. Keep this session open and try again.',
      ));
      // Keep later serialized mutations based on what was actually saved,
      // even when the following native ACK is lost. Never reinsert a removed copy.
      entries = next;
      for (const entry of removed) {
        const admission = admissions.get(entry.id);
        if (!admission) throw new Error('Queued submission admission is missing.');
        await ports.finish(admission);
        admissions.delete(entry.id);
      }
      refreshRecovery();
    });
    writes = write;
    return write;
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
  const retireConfirmed = async (confirmed: (entry: QueuedSubmission) => boolean) => {
    const selected = entries.filter(entry => !entry.direction?.deletionRequested && confirmed(entry));
    if (!selected.length) return;
    await persist(current => current.filter(entry => entry.direction?.deletionRequested || !confirmed(entry)));
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
  const complete = (entry: QueuedSubmission) => persist(current => current.filter(candidate => candidate.id !== entry.id));
  const assertCanDispatch = (entry: QueuedSubmission) => {
    const id = entry.input.conversationId;
    if (!claimed.has(entry.id) || paused.has(id) || ports.cancelled(id) ||
      !entries.some(candidate => candidate.id === entry.id)) {
      throw new Error(i18n.t('chat.queueInterrupted', 'The queued send was interrupted. Its content is retained.'));
    }
  };
  const beforeAssistantStart = (entry: QueuedSubmission, assistant?: ChatMessage) => {
    assertCanDispatch(entry);
    return persist(current => {
      assertCanDispatch(entry);
      return current.map(candidate => candidate.id === entry.id ? { ...candidate, assistantStartAttempted: true, ...(candidate.direction ? { direction: { ...candidate.direction, recoveryAssistantMessageId: assistant?.id } } : {}) } : candidate);
    });
  };
  const drainInner = async (id: string, explicit = false): Promise<void> => {
    if (retired || draining.has(id) || paused.has(id) || ports.blocked(id)) return;
    const next = entries.find(entry => entry.input.conversationId === id);
    if (!next || mutating.has(next.id) || ports.cancelled(id) || (next.direction && !explicit)) return;
    draining.add(id);
    claimed.add(next.id);
    publishRecovery();
    let continueQueue = false;
    try {
      if (next.direction?.deletionRequested) {
        throw new Error(i18n.t('chat.queueDirectionDeleted',
          'This direction was invalidated by deletion or replay. Remove this recovery entry before continuing manually.'));
      }
      admissions.set(next.id, await ports.admit(next, 'retain'));
      const persisted = await ports.read(id);
      if (retired || paused.has(id) || ports.cancelled(id) || !entries.some(entry => entry.id === next.id && !entry.direction?.deletionRequested)) return;
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
        await retireConfirmed(entry => entry.id === next.id);
      } else if (!next.direction && assistant?.completion_reason === 'completed') {
        await complete(next);
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
      claimed.delete(next.id);
      draining.delete(id);
      publishRecovery();
      if (continueQueue && !retired) queueMicrotask(() => void drain(id));
    }
  };
  const drain = (id: string, explicit = false): Promise<void> => {
    const job = drainInner(id, explicit);
    jobs.add(job);
    return job.finally(() => jobs.delete(job));
  };
  return {
    async joinWrites() {
      let pending: Promise<void>;
      do { pending = writes; await pending.catch(() => undefined); } while (pending !== writes);
    },
    async retire() {
      retired = true;
      await Promise.allSettled([writes, ...jobs]);
    },
    capture: captureQueuedSubmission,
    excludedDirectionMessageIds(conversationId: string, resumedMessageId?: string) {
      return new Set(entries.filter(entry => entry.input.conversationId === conversationId && entry.direction &&
        (entry.direction.deletionRequested || !entry.direction.delivery?.requestEnded) && entry.direction.userMessageId !== resumedMessageId)
        .map(entry => entry.direction!.userMessageId));
    },
    async bindDirectionIntent(conversationId: string, sessionId: string, turnId: string, intent: QueuedSendIntent) {
      const belongs = (entry: QueuedSubmission) => entry.input.conversationId === conversationId &&
        entry.direction?.target.sessionId === sessionId && entry.direction.target.turnId === turnId && !entry.direction.delivery && !entry.direction.deletionRequested;
      if (entries.some(belongs)) await persist(current => current.map(entry => belongs(entry) ? {
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
      await persist(current => [...current, ...retained.filter(item => !current.some(entry => entry.id === item.id))].map(entry => ids.includes(entry.id) && entry.direction ? {
        ...entry, direction: { ...entry.direction, deletionRequested: true },
      } : entry));
      await Promise.allSettled(ids.flatMap(id => directionWrites.has(id) ? [directionWrites.get(id)!.pending] : []));
      return ids;
    },
    async finishDirectionDeletion(ids: readonly string[]) {
      if (!ids.length) return;
      await persist(current => current.filter(entry => !ids.includes(entry.id)));
      // DB deletion is authoritative; a refused write leaves only invalidated entries on disk.
      refreshRecovery();
    },
    async markDirectionDelivery(ids: string[], identity: { conversationId: string; sessionId: string; turnId: string | null; assistantMessageId: string }, requestId: string) {
      await persist(current => {
        for (const id of ids) {
          const entry = current.find(candidate => candidate.id === id);
          const target = entry?.direction?.target;
          if (!target || entry?.input.conversationId !== identity.conversationId || target.sessionId !== identity.sessionId ||
            target.turnId !== identity.turnId || (target.assistantMessageId !== null && target.assistantMessageId !== identity.assistantMessageId) || entry.direction?.delivery || entry.direction?.deletionRequested) {
            throw new Error('The direction no longer belongs to this request.');
          }
        }
        return current.map(entry => ids.includes(entry.id) && entry.direction ? { ...entry, direction: {
          ...entry.direction, delivery: { requestId, assistantMessageId: identity.assistantMessageId, requestEnded: false },
        } } : entry);
      });
    },
    async directionRequestEnded(ids: string[], requestId: string) {
      if (!ids.length) return;
      await persist(current => current.map(entry => ids.includes(entry.id) && entry.direction?.delivery?.requestId === requestId ? {
        ...entry, direction: { ...entry.direction, delivery: { ...entry.direction.delivery, requestEnded: true } },
      } : entry));
    },
    confirmDirections(ids: string[], assistantMessageId: string) {
      return retireConfirmed(entry => ids.includes(entry.id) && entry.direction?.delivery?.requestEnded === true &&
        entry.direction.delivery.assistantMessageId === assistantMessageId);
    },
    async directionRecoveryRequestEnded(assistantMessageId: string) {
      const affected = entries.some(entry => entry.direction?.recoveryAssistantMessageId === assistantMessageId);
      if (affected) await persist(current => current.map(entry => entry.direction?.recoveryAssistantMessageId === assistantMessageId ? {
        ...entry, direction: { ...entry.direction, recoveryRequestEnded: true },
      } : entry));
    },
    confirmDirectionRecovery(assistantMessageId: string) {
      return retireConfirmed(entry => entry.direction?.recoveryAssistantMessageId === assistantMessageId && entry.direction.recoveryRequestEnded === true);
    },
    confirmPersistedAssistant(assistant: ChatMessage) { return retireConfirmed(entry => Boolean(confirmedBy(entry, assistant, true))); },
    async accept(entry: QueuedSubmission, pausedOnAccept = false) {
      await persist(current => [...current, entry]);
      if (pausedOnAccept) pause(entry.input.conversationId);
      queueMicrotask(() => void drain(entry.input.conversationId));
    },
    assertCanDispatch,
    acknowledge,
    beforeAssistantStart,
    complete,
    pause,
    drain,
    async retry(id: string) {
      if (entries.some(entry => entry.input.conversationId === id && mutating.has(entry.id))) {
        throw new Error(i18n.t('chat.queueEditInProgress', 'Wait for the queued message change to finish.'));
      }
      // A retry cannot revive a dispatch whose asynchronous preparation was stopped.
      if (draining.has(id) || ports.blocked(id) || ports.cancelled(id)) return;
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
        await persist(current => current.map(candidate => candidate.id === id ? { ...candidate, input: { ...candidate.input, content } } : candidate));
      } finally { mutating.delete(id); }
    },
    async removeEntry(id: string) {
      const entry = await pendingEntry(id, true);
      try {
        await persist(current => current.filter(candidate => candidate.id !== id));
        if (!entries.some(candidate => candidate.input.conversationId === entry.input.conversationId)) {
          paused.delete(entry.input.conversationId);
        }
      }
      finally {
        mutating.delete(id);
        queueMicrotask(() => void drain(entry.input.conversationId));
      }
    },
    async remove(ids: readonly string[]) {
      await persist(current => current.filter(entry => !ids.includes(entry.input.conversationId)));
      ids.forEach(id => paused.delete(id));
      refreshRecovery();
    },
    async restore(conversationIds: readonly string[]) {
      if (entries.some(entry => !conversationIds.includes(entry.input.conversationId))) {
        await persist(current => current.filter(entry => conversationIds.includes(entry.input.conversationId)));
      }
      for (const id of paused) pause(id);
    },
  };
}
export type QueuedSubmissionRuntime = ReturnType<typeof createQueuedSubmissionRuntime>;
