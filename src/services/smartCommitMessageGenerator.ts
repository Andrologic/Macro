import { sendChatNonStreaming } from './streamingChat';
import { useProviderStore } from '../stores/useProviderStore';
import { devLogger } from '../utils/devLogger';
import {
  DEFAULT_SMART_COMMIT_PROMPT,
  PREF_KEYS,
  loadPreference,
} from './preferences';
import {
  ALLOWED_COMMIT_TYPES,
  formatConventionalCommitMessage,
  parseConventionalCommitMessage,
  validateConventionalCommitFields,
  validateConventionalCommitMessage,
  type ConventionalCommitType,
} from './conventionalCommit';
import type { SmartCommitModelConfig } from './smartCommitModelConfig';

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
  type: ConventionalCommitType;
  scope?: string | null;
  breaking?: boolean;
  subject: string;
  body?: string | null;
}

export interface GeneratedCommitMessages {
  repositories: GeneratedCommitMessageEntry[];
}

export const stripGeneratedCommitScopes = (
  generated: GeneratedCommitMessages
): GeneratedCommitMessages => ({
  repositories: generated.repositories.map((entry) => ({
    ...entry,
    scope: null,
  })),
});

export class SmartCommitMessageGenerationError extends Error {
  generatedMessages?: GeneratedCommitMessages;

  constructor(message: string, options: { generatedMessages?: GeneratedCommitMessages } = {}) {
    super(message);
    this.name = 'SmartCommitMessageGenerationError';
    this.generatedMessages = options.generatedMessages;
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

const extractBalancedJsonAt = (value: string, start: number): string | null => {
  const opener = value[start];
  const firstCloser = opener === '{' ? '}' : opener === '[' ? ']' : null;
  if (!firstCloser) {
    return null;
  }

  const stack = [firstCloser];
  let inString = false;
  let escaped = false;

  for (let index = start + 1; index < value.length; index += 1) {
    const character = value[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === '{') {
      stack.push('}');
      continue;
    }
    if (character === '[') {
      stack.push(']');
      continue;
    }
    if (character === '}' || character === ']') {
      if (stack.at(-1) !== character) {
        return null;
      }
      stack.pop();
      if (stack.length === 0) {
        return value.slice(start, index + 1);
      }
    }
  }

  return null;
};

const extractJsonCandidates = (value: string): string[] => {
  const stripped = stripCodeFence(value);
  const candidates = [stripped];
  const fencedBlocks = stripped.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi);
  for (const match of fencedBlocks) {
    if (match[1]?.trim()) {
      candidates.push(match[1].trim());
    }
  }

  const result = new Set<string>();
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))
    ) {
      result.add(trimmed);
    }

    for (let index = 0; index < trimmed.length; index += 1) {
      if (trimmed[index] !== '{' && trimmed[index] !== '[') {
        continue;
      }
      const balanced = extractBalancedJsonAt(trimmed, index);
      if (balanced) {
        result.add(balanced);
      }
    }
  }

  return Array.from(result);
};

const normalizeText = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

const describeUnknownError = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

const debugSmartCommitGenerationError = (
  message: string,
  details: Record<string, unknown>
): void => {
  devLogger.error(`[smartCommitMessageGenerator] ${message}`, details);
};

const normalizeGeneratedCommitType = (value: unknown): ConventionalCommitType | null => {
  const normalized = normalizeText(value).toLowerCase();
  return ALLOWED_COMMIT_TYPES.includes(normalized as ConventionalCommitType)
    ? normalized as ConventionalCommitType
    : null;
};

const coerceEditableGeneratedCommitMessages = (
  entries: unknown[],
  expectedRepositoryIds: string[]
): GeneratedCommitMessages => ({
  repositories: expectedRepositoryIds.map((repositoryId) => {
    const rawEntry = entries.find((entry) =>
      !!entry &&
      typeof entry === 'object' &&
      normalizeText((entry as { repositoryId?: unknown }).repositoryId) === repositoryId
    ) as {
      type?: unknown;
      scope?: unknown;
      breaking?: unknown;
      subject?: unknown;
      body?: unknown;
    } | undefined;
    return {
      repositoryId,
      type: normalizeGeneratedCommitType(rawEntry?.type) ?? 'chore',
      scope: null,
      breaking: Boolean(rawEntry?.breaking),
      subject: normalizeText(rawEntry?.subject) || 'update task changes',
      body: normalizeText(rawEntry?.body) || null,
    };
  }),
});

export const validateGeneratedCommitMessages = (
  payload: unknown,
  expectedRepositoryIds: string[]
): GeneratedCommitMessages => {
  if (Array.isArray(payload)) {
    return validateGeneratedCommitMessages({ repositories: payload }, expectedRepositoryIds);
  }

  if (!payload || typeof payload !== 'object') {
    throw new SmartCommitMessageGenerationError('Commit message response is not a JSON object.');
  }

  const value = payload as {
    repositoryId?: unknown;
    repositories?: unknown;
  };
  if (!Array.isArray(value.repositories) && normalizeText(value.repositoryId)) {
    return validateGeneratedCommitMessages({ repositories: [value] }, expectedRepositoryIds);
  }

  if (!Array.isArray(value.repositories)) {
    throw new SmartCommitMessageGenerationError('Commit message response is missing repositories.');
  }

  const expectedIds = new Set(expectedRepositoryIds);
  const seenIds = new Set<string>();
  const editableGeneratedMessages = coerceEditableGeneratedCommitMessages(
    value.repositories,
    expectedRepositoryIds
  );
  const repositories = value.repositories.map((entry, index): GeneratedCommitMessageEntry => {
    if (!entry || typeof entry !== 'object') {
      throw new SmartCommitMessageGenerationError(`Repository message ${index + 1} is invalid.`);
    }
    const repository = entry as {
      repositoryId?: unknown;
      type?: unknown;
      breaking?: unknown;
      subject?: unknown;
      body?: unknown;
    };
    const repositoryId = normalizeText(repository.repositoryId);
    const type = normalizeGeneratedCommitType(repository.type);
    const subject = normalizeText(repository.subject);
    const body = normalizeText(repository.body);
    if (!repositoryId || !expectedIds.has(repositoryId)) {
      throw new SmartCommitMessageGenerationError('Commit message response referenced an unexpected repository.');
    }
    if (seenIds.has(repositoryId)) {
      throw new SmartCommitMessageGenerationError('Commit message response contains duplicate repositories.');
    }
    const generatedEntry = {
      repositoryId,
      type: type ?? 'chore',
      scope: null,
      breaking: Boolean(repository.breaking),
      subject: subject || 'update task changes',
      body: body || null,
    };
    if (!type) {
      throw new SmartCommitMessageGenerationError(
        `Commit message type for ${repositoryId} must be one of: ${ALLOWED_COMMIT_TYPES.join(', ')}.`,
        { generatedMessages: editableGeneratedMessages }
      );
    }
    if (!subject) {
      throw new SmartCommitMessageGenerationError(`Commit message subject is missing for ${repositoryId}.`, {
        generatedMessages: editableGeneratedMessages,
      });
    }
    const validation = validateConventionalCommitFields(generatedEntry);
    if (!validation.ok) {
      throw new SmartCommitMessageGenerationError(
        validation.message || `Commit message for ${repositoryId} is invalid.`,
        { generatedMessages: editableGeneratedMessages }
      );
    }
    seenIds.add(repositoryId);
    return generatedEntry;
  });

  const missingRepositoryIds = expectedRepositoryIds.filter((repositoryId) => !seenIds.has(repositoryId));
  if (missingRepositoryIds.length > 0) {
    throw new SmartCommitMessageGenerationError('Commit message response is missing repositories.');
  }

  return { repositories };
};

const entryFromParsedConventionalCommit = (
  repositoryId: string,
  message: string
): GeneratedCommitMessageEntry | null => {
  const parsed = parseConventionalCommitMessage(message);
  if (!parsed.ok) {
    return null;
  }

  return {
    repositoryId,
    type: parsed.value.type,
    scope: null,
    breaking: parsed.value.breaking,
    subject: parsed.value.subject,
    body: parsed.value.body,
  };
};

const parsePlainConventionalCommitMessages = (
  raw: string,
  expectedRepositoryIds: string[]
): GeneratedCommitMessages | null => {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  if (expectedRepositoryIds.length === 1) {
    const direct = entryFromParsedConventionalCommit(expectedRepositoryIds[0], trimmed);
    if (direct) {
      return { repositories: [direct] };
    }
  }

  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*]\s+/, ''))
    .filter(Boolean);
  if (expectedRepositoryIds.length === 1) {
    const lineEntry = lines
      .map((line) => entryFromParsedConventionalCommit(expectedRepositoryIds[0], line))
      .find((entry): entry is GeneratedCommitMessageEntry => Boolean(entry));
    if (lineEntry) {
      return { repositories: [lineEntry] };
    }
  }

  const entries = expectedRepositoryIds
    .map((repositoryId) => {
      const line = lines.find((candidate) => {
        const normalized = candidate.toLowerCase();
        return normalized.startsWith(`${repositoryId.toLowerCase()}:`) ||
          normalized.startsWith(`${repositoryId.toLowerCase()} -`);
      });
      if (!line) {
        return null;
      }
      const message = line.replace(new RegExp(`^${repositoryId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[:-]\\s*`, 'i'), '');
      return entryFromParsedConventionalCommit(repositoryId, message);
    })
    .filter((entry): entry is GeneratedCommitMessageEntry => Boolean(entry));

  return entries.length === expectedRepositoryIds.length ? { repositories: entries } : null;
};

export const parseGeneratedCommitMessages = (
  raw: string,
  expectedRepositoryIds: string[]
): GeneratedCommitMessages => {
  const jsonCandidates = extractJsonCandidates(raw);
  if (jsonCandidates.length === 0) {
    const plainMessages = parsePlainConventionalCommitMessages(raw, expectedRepositoryIds);
    if (plainMessages) {
      return plainMessages;
    }
    debugSmartCommitGenerationError('Could not parse commit message response.', {
      expectedRepositoryIds,
      rawResponse: raw,
      reason: 'no-json-candidate-and-no-plain-conventional-commit',
    });
    throw new SmartCommitMessageGenerationError(
      'Commit message response did not include structured JSON or a valid Conventional Commit.'
    );
  }

  let structuredError: SmartCommitMessageGenerationError | null = null;
  const parseErrors: string[] = [];
  for (const jsonCandidate of jsonCandidates) {
    try {
      return validateGeneratedCommitMessages(
        JSON.parse(jsonCandidate),
        expectedRepositoryIds
      );
    } catch (error) {
      if (error instanceof SmartCommitMessageGenerationError) {
        structuredError = structuredError ?? error;
      } else {
        parseErrors.push(describeUnknownError(error));
      }
    }
  }

  const plainMessages = parsePlainConventionalCommitMessages(raw, expectedRepositoryIds);
  if (plainMessages) {
    return plainMessages;
  }

  if (structuredError) {
    debugSmartCommitGenerationError('Commit message response JSON parsed but failed validation.', {
      expectedRepositoryIds,
      rawResponse: raw,
      jsonCandidates,
      error: describeUnknownError(structuredError),
      generatedMessages: structuredError.generatedMessages ?? null,
    });
    throw structuredError;
  }

  debugSmartCommitGenerationError('Commit message response contained JSON-looking text but no valid JSON payload.', {
    expectedRepositoryIds,
    rawResponse: raw,
    jsonCandidates,
    parseErrors,
  });
  throw new SmartCommitMessageGenerationError('Commit message response was not valid JSON.');
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
  const message = formatConventionalCommitMessage({ ...entry, scope: null });
  const validation = validateConventionalCommitMessage(message);
  if (!validation.ok) {
    throw new SmartCommitMessageGenerationError(
      validation.message || 'Commit message must follow Conventional Commits.',
      { generatedMessages: generated }
    );
  }
  return message;
};

export interface GenerateSmartCommitMessagesOptions {
  modelConfig?: SmartCommitModelConfig | null;
  validationFeedback?: string | null;
}

export const generateSmartCommitMessages = async (
  input: GenerateSmartCommitMessagesInput,
  options: GenerateSmartCommitMessagesOptions = {}
): Promise<GeneratedCommitMessages> => {
  try {
    const providerState = useProviderStore.getState();
    const providerId = options.modelConfig?.mode === 'dedicated'
      ? options.modelConfig.providerId
      : providerState.selectedProviderId;
    const modelId = options.modelConfig?.mode === 'dedicated'
      ? options.modelConfig.modelId
      : providerState.selectedModelId;
    const reasoningEffort = options.modelConfig?.mode === 'dedicated'
      ? options.modelConfig.reasoningEffort
      : providerState.selectedReasoningEffort;
    if (!providerId || !modelId) {
      throw new SmartCommitMessageGenerationError('Select an AI provider and model before committing.');
    }

    const provider = providerState.providerConfigs.find((candidate) => candidate.id === providerId);
    if (!provider) {
      throw new SmartCommitMessageGenerationError('Selected AI provider is unavailable.');
    }

    const apiKey = await providerState.resolveProviderApiKey(providerId);
    const expectedRepositoryIds = input.repositories.map((repository) => repository.repositoryId);
    const validationFeedback = options.validationFeedback?.trim();
    const configuredPrompt = (
      await loadPreference<string>(PREF_KEYS.SMART_COMMIT_PROMPT)
    )?.trim();
    const systemPrompt = configuredPrompt || DEFAULT_SMART_COMMIT_PROMPT;
    const content = await sendChatNonStreaming({
      sessionId: `smart-review-commit-${input.task.id}`,
      conversationId: `smart-review-commit-${input.task.id}`,
      mode: 'Implement',
      providerId,
      providerType: provider.providerType,
      baseUrl: provider.baseUrl,
      apiKey,
      modelId,
      reasoningEffort,
      messages: [
        {
          role: 'system',
          content: systemPrompt,
        },
        {
          role: 'user',
          content:
            'Generate commit message fields for every repository. ' +
            'Choose type from this guide: feat=new user-facing capability, fix=bug fix, perf=performance, build=build/dependency packaging, chore=maintenance/metadata, ci=CI automation, docs=documentation, refactor=behavior-preserving code change, style=formatting only, test=test-only change, revert=reverts prior work. ' +
            'Do not generate or use scopes. Macro will format every header as type: subject, never type(scope): subject. ' +
            'The subject must be short, imperative, lower sentence style, no period, and no newline. ' +
            'Set body to null unless it adds useful context beyond the subject. ' +
            'Return exactly: {"repositories":[{"repositoryId":"...","type":"feat","breaking":false,"subject":"short subject","body":null}]}.' +
            (validationFeedback
              ? `\n\nPrevious attempt was rejected: ${validationFeedback}. Fix the invalid repository fields and keep the JSON shape unchanged.`
              : '') +
            '\n\n' +
            buildPromptPayload(input),
        },
      ],
      onComplete: () => undefined,
      onError: () => undefined,
    });

    return stripGeneratedCommitScopes(parseGeneratedCommitMessages(content, expectedRepositoryIds));
  } catch (error) {
    if (isSmartCommitMessageGenerationError(error)) {
      debugSmartCommitGenerationError('Smart commit message generation failed.', {
        taskId: input.task.id,
        expectedRepositoryIds: input.repositories.map((repository) => repository.repositoryId),
        providerId: options.modelConfig?.mode === 'dedicated'
          ? options.modelConfig.providerId
          : useProviderStore.getState().selectedProviderId,
        modelId: options.modelConfig?.mode === 'dedicated'
          ? options.modelConfig.modelId
          : useProviderStore.getState().selectedModelId,
        error: describeUnknownError(error),
        generatedMessages: error.generatedMessages ?? null,
      });
      throw error;
    }
    const message = error instanceof Error ? error.message : 'Failed to generate commit messages.';
    debugSmartCommitGenerationError('Unexpected smart commit message generation error.', {
      taskId: input.task.id,
      expectedRepositoryIds: input.repositories.map((repository) => repository.repositoryId),
      error: describeUnknownError(error),
    });
    throw new SmartCommitMessageGenerationError(message);
  }
};
