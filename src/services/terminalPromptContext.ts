export interface TerminalPromptContextInput {
  projectLabel?: string | null;
  taskLabel?: string | null;
  branchLabel?: string | null;
}

const MAX_PROJECT_LABEL_LENGTH = 18;
const MAX_TASK_LABEL_LENGTH = 28;
const MAX_BRANCH_LABEL_LENGTH = 28;
const ELLIPSIS = '...';
const BRANCH_PREFIXES = ['feature/', 'plan/', 'fix/', 'chore/', 'bugfix/'];

const collapseWhitespace = (value: string): string => value.replace(/\s+/g, ' ').trim();

const sanitizeSegment = (value?: string | null): string | null => {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = collapseWhitespace(value.replace(/[|><\r\n\t]+/g, ' '));
  return normalized.length > 0 ? normalized : null;
};

const stripVerboseBranchPrefix = (value: string): string => {
  const lowerValue = value.toLowerCase();
  const matchedPrefix = BRANCH_PREFIXES.find((prefix) => lowerValue.startsWith(prefix));
  return matchedPrefix ? value.slice(matchedPrefix.length) : value;
};

const truncateMiddle = (value: string, maxLength: number, tailLength = 8): string => {
  if (value.length <= maxLength) {
    return value;
  }

  const safeTailLength = Math.max(4, Math.min(tailLength, maxLength - ELLIPSIS.length - 4));
  const headLength = maxLength - safeTailLength - ELLIPSIS.length;
  if (headLength <= 0) {
    return value.slice(0, maxLength);
  }

  return `${value.slice(0, headLength)}${ELLIPSIS}${value.slice(-safeTailLength)}`;
};

export const buildTerminalPromptContext = (
  input: TerminalPromptContextInput
): TerminalPromptContextInput | null => {
  const projectLabel = sanitizeSegment(input.projectLabel);
  const taskLabel = sanitizeSegment(input.taskLabel);
  const rawBranchLabel = sanitizeSegment(input.branchLabel);
  const normalizedBranchLabel = rawBranchLabel ? stripVerboseBranchPrefix(rawBranchLabel) : null;

  const promptContext: TerminalPromptContextInput = {
    projectLabel: projectLabel ? truncateMiddle(projectLabel, MAX_PROJECT_LABEL_LENGTH, 6) : null,
    taskLabel: taskLabel ? truncateMiddle(taskLabel, MAX_TASK_LABEL_LENGTH, 6) : null,
    branchLabel: normalizedBranchLabel
      ? truncateMiddle(normalizedBranchLabel, MAX_BRANCH_LABEL_LENGTH, 8)
      : null,
  };

  if (!promptContext.projectLabel && !promptContext.taskLabel && !promptContext.branchLabel) {
    return null;
  }

  return promptContext;
};
