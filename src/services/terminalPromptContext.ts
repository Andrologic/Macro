export interface TerminalPromptContextInput {
  projectLabel?: string | null;
  taskLabel?: string | null;
  branchLabel?: string | null;
}

const MAX_PROJECT_LABEL_LENGTH = 18;
const MAX_TASK_LABEL_LENGTH = 28;
const ELLIPSIS = '...';

const collapseWhitespace = (value: string): string => value.replace(/\s+/g, ' ').trim();

const sanitizeSegment = (value?: string | null): string | null => {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = collapseWhitespace(value.replace(/[|><\r\n\t]+/g, ' '));
  return normalized.length > 0 ? normalized : null;
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

  const promptContext: TerminalPromptContextInput = {
    projectLabel: projectLabel ? truncateMiddle(projectLabel, MAX_PROJECT_LABEL_LENGTH, 6) : null,
    taskLabel: taskLabel ? truncateMiddle(taskLabel, MAX_TASK_LABEL_LENGTH, 6) : null,
    branchLabel: null,
  };

  if (!promptContext.projectLabel && !promptContext.taskLabel && !promptContext.branchLabel) {
    return null;
  }

  return promptContext;
};
