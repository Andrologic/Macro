export const ALLOWED_COMMIT_TYPES = [
  'feat',
  'fix',
  'perf',
  'build',
  'chore',
  'ci',
  'docs',
  'refactor',
  'style',
  'test',
  'revert',
] as const;

export type ConventionalCommitType = typeof ALLOWED_COMMIT_TYPES[number];

export interface ConventionalCommitFields {
  type: ConventionalCommitType;
  scope?: string | null;
  breaking?: boolean;
  subject: string;
  body?: string | null;
}

export interface ConventionalCommitValidationResult {
  ok: boolean;
  message?: string;
}

export interface ConventionalCommitParseSuccess {
  ok: true;
  value: Required<Pick<ConventionalCommitFields, 'type' | 'subject'>> & {
    scope: string | null;
    breaking: boolean;
    body: string | null;
  };
}

export type ConventionalCommitParseResult =
  | ConventionalCommitParseSuccess
  | { ok: false; message: string };

const COMMIT_HEADER_PATTERN = /^([a-z]+)(?:\(([a-z0-9][a-z0-9-]*)\))?(!)?: (.+)$/;
const ALLOWED_COMMIT_TYPES_LABEL = ALLOWED_COMMIT_TYPES.join(', ');

export const normalizeCommitScope = (value?: string | null): string | null => {
  const normalized = (value || '')
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  return normalized || null;
};

const normalizeCommitSubject = (value: string): string =>
  value.trim().replace(/\s+/g, ' ').replace(/\.$/, '');

export const parseConventionalCommitMessage = (message: string): ConventionalCommitParseResult => {
  const trimmed = message.trim();
  const [header = '', ...bodyLines] = trimmed.split(/\r?\n/);
  const body = bodyLines.join('\n').trim();

  if (!header) {
    return {
      ok: false,
      message: 'Commit message must follow Conventional Commits: type(scope)?: subject',
    };
  }

  if (!header.includes(': ')) {
    return {
      ok: false,
      message: 'Commit message must follow Conventional Commits: type(scope)?: subject',
    };
  }

  const match = header.match(COMMIT_HEADER_PATTERN);
  if (!match) {
    if (header.includes('(') && !header.includes('): ')) {
      return {
        ok: false,
        message: "Commit scope must close with ')'",
      };
    }
    return {
      ok: false,
      message: 'Commit message must follow Conventional Commits: type(scope)?: subject',
    };
  }

  const [, type, scope = null, breakingMarker, subject] = match;
  if (!type) {
    return {
      ok: false,
      message: 'Commit type is required',
    };
  }

  if (!ALLOWED_COMMIT_TYPES.includes(type as ConventionalCommitType)) {
    return {
      ok: false,
      message: `Commit type must be one of: ${ALLOWED_COMMIT_TYPES_LABEL}`,
    };
  }

  if (scope !== null && !normalizeCommitScope(scope)) {
    return {
      ok: false,
      message: 'Commit scope cannot be empty',
    };
  }

  const normalizedSubject = normalizeCommitSubject(subject || '');
  if (!normalizedSubject) {
    return {
      ok: false,
      message: 'Commit subject is required',
    };
  }

  return {
    ok: true,
    value: {
      type: type as ConventionalCommitType,
      scope,
      breaking: Boolean(breakingMarker),
      subject: normalizedSubject,
      body: body || null,
    },
  };
};

export const formatConventionalCommitMessage = (fields: ConventionalCommitFields): string => {
  const scope = normalizeCommitScope(fields.scope);
  const subject = normalizeCommitSubject(fields.subject);
  const header = [
    fields.type,
    scope ? `(${scope})` : '',
    fields.breaking ? '!' : '',
    ': ',
    subject,
  ].join('');
  const body = fields.body?.trim();
  return body ? `${header}\n\n${body}` : header;
};

export const validateConventionalCommitFields = (
  fields: ConventionalCommitFields
): ConventionalCommitValidationResult => {
  const validation = parseConventionalCommitMessage(formatConventionalCommitMessage(fields));
  return validation.ok ? { ok: true } : { ok: false, message: validation.message };
};

export const validateConventionalCommitMessage = (
  message: string
): ConventionalCommitValidationResult => {
  const validation = parseConventionalCommitMessage(message);
  return validation.ok ? { ok: true } : { ok: false, message: validation.message };
};

export const validateGeneratedCommitTitle = (
  title: string
): ConventionalCommitValidationResult => {
  if (title.trim().split(/\r?\n/).length > 1) {
    return {
      ok: false,
      message: 'Commit title must be a single Conventional Commits line.',
    };
  }

  return validateConventionalCommitMessage(title);
};
