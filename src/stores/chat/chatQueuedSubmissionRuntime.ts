import i18n from '../../i18n';
import type { ChatIntentAdmission } from '../../services/ipc/chatAdmission';
import type { ChatMessage } from '../../types';
import type { ChatSendResult, SendImage } from '../../services/chatSend/contracts';
import { toServiceError } from '../../services/contracts/errors';
import { captureQueuedSubmission, loadQueuedSubmissions, saveQueuedSubmissions, type QueuedSubmission } from './chatQueuedSubmissions';

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
  let recoveries: QueuedSubmissionRecoveries = {};
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
    mutating.add(id);
    try {
      const persisted = await ports.read(entry.input.conversationId);
      if (!allowSaved && persisted.some(message => message.role === 'user' && message.turn_id === id)) {
        throw new Error(i18n.t('chat.queueAlreadySent', 'This message was already saved. Retry recovery instead.'));
      }
      if (!entries.includes(entry) || claimed.has(id) ||
        (!allowSaved && (!paused.has(entry.input.conversationId) || draining.has(entry.input.conversationId)))) {
        throw new Error(i18n.t('chat.queueNoLongerEditable', 'This queued message is no longer available to edit.'));
      }
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
    if (!entries.some(candidate => candidate.id === entry.id)) return;
    if (entry.input.images?.length && !ports.saveImages(message.id, entry.input.images)) {
      throw new Error(i18n.t('chat.queueImagesSaveFailed', 'The message is saved, but its images still need saving. Retry the queued submission.'));
    }
  };
  const complete = (entry: QueuedSubmission) => persist(current => current.filter(candidate => candidate.id !== entry.id));
  const assertCanDispatch = (entry: QueuedSubmission) => {
    const id = entry.input.conversationId;
    if (!claimed.has(entry.id) || paused.has(id) || ports.cancelled(id) ||
      !entries.some(candidate => candidate.id === entry.id)) {
      throw new Error(i18n.t('chat.queueInterrupted', 'The queued send was interrupted. Its content is retained.'));
    }
  };
  const beforeAssistantStart = (entry: QueuedSubmission) => {
    assertCanDispatch(entry);
    return persist(current => {
      assertCanDispatch(entry);
      return current.map(candidate => candidate.id === entry.id ? { ...candidate, assistantStartAttempted: true } : candidate);
    });
  };
  const drainInner = async (id: string): Promise<void> => {
    if (retired || draining.has(id) || paused.has(id) || ports.blocked(id)) return;
    const next = entries.find(entry => entry.input.conversationId === id);
    if (!next || mutating.has(next.id) || ports.cancelled(id)) return;
    draining.add(id);
    claimed.add(next.id);
    publishRecovery();
    let continueQueue = false;
    try {
      admissions.set(next.id, await ports.admit(next, 'retain'));
      const persisted = await ports.read(id);
      if (retired || ports.cancelled(id) || paused.has(id) || !entries.some(entry => entry.id === next.id)) return;
      const saved = persisted.find(message => message.role === 'user' && message.turn_id === next.id);
      if (saved) {
        ports.publish(saved);
        acknowledge(next, saved);
      }
      const assistant = persisted.find(message => message.role === 'assistant' && message.turn_id === next.id);
      if (assistant?.completion_reason === 'completed') {
        await complete(next);
      } else if (next.assistantStartAttempted || assistant) {
        throw new Error(i18n.t('chat.queueAssistantInterrupted',
          'This saved instruction may have started executing. Review the response and tool effects, then remove this recovery entry before continuing manually.'));
      } else {
        attempted.set(next.id, id);
        publishRecovery();
        const result = await ports.send(next, saved);
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
  const drain = (id: string): Promise<void> => {
    const job = drainInner(id);
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
      publishRecovery();
      await drain(id);
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
