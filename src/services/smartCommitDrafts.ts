import {
  parseConventionalCommitMessage,
  type ConventionalCommitFields,
  type ConventionalCommitType,
} from './conventionalCommit';
import type { GeneratedCommitMessages } from './smartCommitMessageGenerator';
import type { ReviewRepositoryState } from '../stores/useFileChangesStore';

export const buildDefaultCommitMessage = (title?: string | null): string => {
  const trimmed = title?.trim();
  if (!trimmed) return 'chore: update task changes';
  const normalized = trimmed.charAt(0).toLowerCase() + trimmed.slice(1);
  return `chore: ${normalized}`;
};

export const isRepositoryReadyToCommit = (
  repository: Pick<ReviewRepositoryState, 'commitState' | 'stats' | 'stagedPaths'>
): boolean =>
  repository.commitState === 'idle' &&
  repository.stats.validatedStagedFileCount > 0 &&
  repository.stagedPaths.length > 0;

export const getReadyCommitRepositories = <T extends Pick<ReviewRepositoryState, 'commitState' | 'stats' | 'stagedPaths'>>(
  repositories: T[]
): T[] => repositories.filter(isRepositoryReadyToCommit);

const fieldsFromCommitMessage = (message?: string | null): ConventionalCommitFields | null => {
  const parsed = parseConventionalCommitMessage(message || '');
  if (!parsed.ok) {
    return null;
  }
  return {
    type: parsed.value.type,
    scope: null,
    breaking: parsed.value.breaking,
    subject: parsed.value.subject,
    body: parsed.value.body,
  };
};

export const buildEditableCommitMessages = (
  generatedMessages: GeneratedCommitMessages,
  repositories: ReviewRepositoryState[]
): Record<string, ConventionalCommitFields> => Object.fromEntries(
  getReadyCommitRepositories(repositories).map((repository) => {
    const generated = generatedMessages.repositories.find((entry) => entry.repositoryId === repository.id);
    return [repository.id, {
      type: generated?.type ?? 'chore',
      scope: null,
      breaking: generated?.breaking ?? false,
      subject: generated?.subject?.trim() || 'update task changes',
      body: generated?.body?.trim() || null,
    }];
  })
);

export const buildManualCommitMessageDrafts = (
  repositories: ReviewRepositoryState[],
  options: { taskTitle?: string | null } = {}
): Record<string, ConventionalCommitFields> => Object.fromEntries(
  getReadyCommitRepositories(repositories).map((repository) => {
    const parsedRepositoryDraft = fieldsFromCommitMessage(repository.commitMessageDraft);
    if (parsedRepositoryDraft) {
      return [repository.id, parsedRepositoryDraft];
    }

    const parsedTaskDraft = fieldsFromCommitMessage(buildDefaultCommitMessage(options.taskTitle));
    return [repository.id, parsedTaskDraft ?? {
      type: 'chore' as ConventionalCommitType,
      scope: null,
      breaking: false,
      subject: 'update task changes',
      body: null,
    }];
  })
);
