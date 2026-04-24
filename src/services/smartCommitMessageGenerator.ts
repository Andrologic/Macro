import { sendChatNonStreaming } from './streamingChat';
import { useProviderStore } from '../stores/useProviderStore';

export interface SmartCommitMessageFileContext {
  path: string;
  summary: string;
}

export interface SmartCommitMessageRepositoryContext {
  repositoryId: string;
  projectId: string;
  projectName?: string | null;
  branchName: string;
  stagedPaths: string[];
  additions: number;
  deletions: number;
  files: SmartCommitMessageFileContext[];
}

export interface GenerateSmartCommitMessagesInput {
  task: {
    id: string;
    title: string;
    description?: string | null;
  };
  repositories: SmartCommitMessageRepositoryContext[];
}

export interface GeneratedCommitMessageEntry {
  repositoryId: string;
  subject?: string;
  body: string;
}

export interface GeneratedCommitMessages {
  title: string;
  repositories: GeneratedCommitMessageEntry[];
}

export class SmartCommitMessageGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SmartCommitMessageGenerationError';
  }
}

export const isSmartCommitMessageGenerationError = (
  error: unknown
): error is SmartCommitMessageGenerationError =>
  error instanceof SmartCommitMessageGenerationError ||
  (
    !!error &&
    typeof error === 'object' &&
    (error as { name?: unknown }).name === 'SmartCommitMessageGenerationError'
  );

const MAX_PROMPT_JSON_CHARS = 24000;

const stripCodeFence = (value: string): string => {
  const trimmed = value.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
};

const extractJsonObject = (value: string): string => {
  const stripped = stripCodeFence(value);
  if (stripped.startsWith('{') && stripped.endsWith('}')) {
    return stripped;
  }

  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start >= 0 && end > start) {
    return stripped.slice(start, end + 1);
  }

  return stripped;
};

const normalizeText = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

export const validateGeneratedCommitMessages = (
  payload: unknown,
  expectedRepositoryIds: string[]
): GeneratedCommitMessages => {
  if (!payload || typeof payload !== 'object') {
    throw new SmartCommitMessageGenerationError('Commit message response is not a JSON object.');
  }

  const value = payload as {
    title?: unknown;
    repositories?: unknown;
  };
  const title = normalizeText(value.title);
  if (!title) {
    throw new SmartCommitMessageGenerationError('Commit message response is missing a title.');
  }
  if (!Array.isArray(value.repositories)) {
    throw new SmartCommitMessageGenerationError('Commit message response is missing repositories.');
  }

  const expectedIds = new Set(expectedRepositoryIds);
  const seenIds = new Set<string>();
  const repositories = value.repositories.map((entry, index): GeneratedCommitMessageEntry => {
    if (!entry || typeof entry !== 'object') {
      throw new SmartCommitMessageGenerationError(`Repository message ${index + 1} is invalid.`);
    }
    const repository = entry as {
      repositoryId?: unknown;
      subject?: unknown;
      body?: unknown;
    };
    const repositoryId = normalizeText(repository.repositoryId);
    const body = normalizeText(repository.body);
    const subject = normalizeText(repository.subject);
    if (!repositoryId || !expectedIds.has(repositoryId)) {
      throw new SmartCommitMessageGenerationError('Commit message response referenced an unexpected repository.');
    }
    if (seenIds.has(repositoryId)) {
      throw new SmartCommitMessageGenerationError('Commit message response contains duplicate repositories.');
    }
    if (!body) {
      throw new SmartCommitMessageGenerationError(`Commit message body is missing for ${repositoryId}.`);
    }
    seenIds.add(repositoryId);
    return {
      repositoryId,
      ...(subject ? { subject } : {}),
      body,
    };
  });

  const missingRepositoryIds = expectedRepositoryIds.filter((repositoryId) => !seenIds.has(repositoryId));
  if (missingRepositoryIds.length > 0) {
    throw new SmartCommitMessageGenerationError('Commit message response is missing repositories.');
  }

  return {
    title,
    repositories,
  };
};

const parseGeneratedCommitMessages = (
  raw: string,
  expectedRepositoryIds: string[]
): GeneratedCommitMessages => {
  try {
    return validateGeneratedCommitMessages(
      JSON.parse(extractJsonObject(raw)),
      expectedRepositoryIds
    );
  } catch (error) {
    if (error instanceof SmartCommitMessageGenerationError) {
      throw error;
    }
    throw new SmartCommitMessageGenerationError('Commit message response was not valid JSON.');
  }
};

const buildPromptPayloadCandidate = (
  input: GenerateSmartCommitMessagesInput,
  options: {
    maxFilesPerRepository: number;
    maxSummaryChars: number;
    maxStagedPathsPerRepository: number;
  }
): string => JSON.stringify({
  task: input.task,
  repositories: input.repositories.map((repository) => ({
    repositoryId: repository.repositoryId,
    projectId: repository.projectId,
    projectName: repository.projectName,
    branchName: repository.branchName,
    additions: repository.additions,
    deletions: repository.deletions,
    stagedPaths: repository.stagedPaths.slice(0, options.maxStagedPathsPerRepository),
    omittedStagedPathCount: Math.max(
      0,
      repository.stagedPaths.length - options.maxStagedPathsPerRepository
    ),
    files: repository.files.slice(0, options.maxFilesPerRepository).map((file) => ({
      path: file.path,
      summary: file.summary.slice(0, options.maxSummaryChars),
    })),
    omittedFileContextCount: Math.max(
      0,
      repository.files.length - options.maxFilesPerRepository
    ),
  })),
}, null, 2);

const buildPromptPayload = (input: GenerateSmartCommitMessagesInput): string => {
  const candidates = [
    { maxFilesPerRepository: 40, maxSummaryChars: 800, maxStagedPathsPerRepository: 120 },
    { maxFilesPerRepository: 20, maxSummaryChars: 400, maxStagedPathsPerRepository: 80 },
    { maxFilesPerRepository: 10, maxSummaryChars: 220, maxStagedPathsPerRepository: 50 },
    { maxFilesPerRepository: 4, maxSummaryChars: 120, maxStagedPathsPerRepository: 30 },
    { maxFilesPerRepository: 0, maxSummaryChars: 0, maxStagedPathsPerRepository: 20 },
  ];

  for (const candidate of candidates) {
    const payload = buildPromptPayloadCandidate(input, candidate);
    if (payload.length <= MAX_PROMPT_JSON_CHARS) {
      return payload;
    }
  }

  // Preserve every repository id even in extreme cases; validation requires one message per repo.
  return buildPromptPayloadCandidate(input, {
    maxFilesPerRepository: 0,
    maxSummaryChars: 0,
    maxStagedPathsPerRepository: 5,
  });
};

export const formatGeneratedCommitMessageForRepository = (
  generated: GeneratedCommitMessages,
  repositoryId: string
): string => {
  const entry = generated.repositories.find((repository) => repository.repositoryId === repositoryId);
  if (!entry) {
    throw new SmartCommitMessageGenerationError(`Missing generated commit message for ${repositoryId}.`);
  }
  const parts = [
    generated.title.trim(),
    entry.subject?.trim(),
    entry.body.trim(),
  ].filter((part): part is string => Boolean(part));
  return parts.join('\n\n');
};

export const generateSmartCommitMessages = async (
  input: GenerateSmartCommitMessagesInput
): Promise<GeneratedCommitMessages> => {
  try {
    const providerState = useProviderStore.getState();
    const providerId = providerState.selectedProviderId;
    const modelId = providerState.selectedModelId;
    if (!providerId || !modelId) {
      throw new SmartCommitMessageGenerationError('Select an AI provider and model before committing.');
    }

    const provider = providerState.providerConfigs.find((candidate) => candidate.id === providerId);
    if (!provider) {
      throw new SmartCommitMessageGenerationError('Selected AI provider is unavailable.');
    }

    const apiKey = await providerState.resolveProviderApiKey(providerId);
    const expectedRepositoryIds = input.repositories.map((repository) => repository.repositoryId);
    const content = await sendChatNonStreaming({
      sessionId: `smart-review-commit-${input.task.id}`,
      conversationId: `smart-review-commit-${input.task.id}`,
      mode: 'Implement',
      providerId,
      providerType: provider.providerType,
      baseUrl: provider.baseUrl,
      apiKey,
      modelId,
      reasoningEffort: providerState.selectedReasoningEffort,
      messages: [
        {
          role: 'system',
          content:
            'You generate concise Git commit messages. Return JSON only. Do not include markdown fences.',
        },
        {
          role: 'user',
          content:
            'Generate one shared commit title and one repository-specific body for each repository. ' +
            'The title must be suitable as the first line of every Git commit. ' +
            'Each body must summarize only that repository changes. ' +
            'Return exactly: {"title":"...","repositories":[{"repositoryId":"...","subject":"optional short line","body":"..."}]}.\n\n' +
            buildPromptPayload(input),
        },
      ],
      onComplete: () => undefined,
      onError: () => undefined,
    });

    return parseGeneratedCommitMessages(content, expectedRepositoryIds);
  } catch (error) {
    if (isSmartCommitMessageGenerationError(error)) {
      throw error;
    }
    const message = error instanceof Error ? error.message : 'Failed to generate commit messages.';
    throw new SmartCommitMessageGenerationError(message);
  }
};
