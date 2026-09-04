/** Persisted navigation only. Tool approvals and other mutations are never replayed. */
export type WorkflowNotificationNavigation =
  | { kind: 'conversation'; requestKind: 'approval' | 'questionnaire'; conversationId: string }
  | { kind: 'review'; taskId: string };

export const sanitizeWorkflowNotificationNavigation = (
  value: unknown,
): WorkflowNotificationNavigation | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Record<string, unknown>;
  const validId = (id: unknown): id is string =>
    typeof id === 'string' && id.length > 0 && id.length <= 2048 && id.trim() === id;
  if (candidate.kind === 'conversation' &&
      (candidate.requestKind === 'approval' || candidate.requestKind === 'questionnaire') &&
      validId(candidate.conversationId)) {
    return { kind: 'conversation', requestKind: candidate.requestKind, conversationId: candidate.conversationId };
  }
  if (candidate.kind === 'review' && validId(candidate.taskId)) {
    return { kind: 'review', taskId: candidate.taskId };
  }
  return undefined;
};
