import i18n from '../../i18n';
import type { ChatMessage } from '../../types';
import type { ChatSendResult, SendImage } from '../../services/chatSend/contracts';
import { toServiceError } from '../../services/contracts/errors';
import { captureQueuedSubmission, loadQueuedSubmissions, saveQueuedSubmissions, type QueuedSubmission } from './chatQueuedSubmissions';

export type QueuedSubmissionRecoveries = Record<string, { count: number; error?: string }>;
interface QueuePorts {
  blocked(id: string): boolean;
  cancelled(id: string): boolean;
  read(id: string): Promise<ChatMessage[]>;
  send(entry: QueuedSubmission): Promise<ChatSendResult>;
  publish(message: ChatMessage): void;
  saveImages(messageId: string, images: SendImage[]): boolean;
  recovery(value: QueuedSubmissionRecoveries): void;
}

/** Owns deferred submissions only; the chat runtime still owns active turns. */
export function createQueuedSubmissionRuntime(ports: QueuePorts) {
  let entries = loadQueuedSubmissions();
  const paused = new Set(entries.map(entry => entry.input.conversationId));
  const draining = new Set<string>();
  let recoveries: QueuedSubmissionRecoveries = {};
  const publishRecovery = () => ports.recovery(recoveries);
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
    if (!entries.some(candidate => candidate.id === entry.id)) return;
    if (entry.input.images?.length && !ports.saveImages(message.id, entry.input.images)) {
      throw new Error(i18n.t('chat.queueImagesSaveFailed', 'The message is saved, but its images still need saving. Retry the queued submission.'));
    }
    persist(entries.filter(candidate => candidate.id !== entry.id));
  };
  const drain = async (id: string): Promise<void> => {
    if (draining.has(id) || paused.has(id) || ports.blocked(id)) return;
    const next = entries.find(entry => entry.input.conversationId === id);
    if (!next || ports.cancelled(id)) return;
    draining.add(id);
    let continueQueue = false;
    try {
      const persisted = await ports.read(id);
      if (ports.cancelled(id) || !entries.some(entry => entry.id === next.id)) return;
      const saved = persisted.find(message => message.role === 'user' && message.turn_id === next.id);
      if (saved) {
        ports.publish(saved);
        acknowledge(next, saved);
      } else {
        const result = await ports.send(next);
        if (result.status === 'cancelled') throw new Error(i18n.t('chat.queueInterrupted', 'The queued send was interrupted. Its content is retained.'));
      }
      continueQueue = true;
    } catch (error) {
      pause(id, toServiceError(error).message);
    } finally {
      draining.delete(id);
      if (continueQueue) queueMicrotask(() => void drain(id));
    }
  };
  return {
    capture: captureQueuedSubmission,
    accept(entry: QueuedSubmission) {
      persist([...entries, entry]);
      queueMicrotask(() => void drain(entry.input.conversationId));
    },
    acknowledge,
    pause,
    drain,
    async retry(id: string) { paused.delete(id); await drain(id); },
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
