import {
  buildTerminalPromptContext,
  type TerminalPromptContextInput,
} from './terminalPromptContext';

export interface TerminalDisplayMetadataInput {
  projectLabel?: string | null;
  taskLabel?: string | null;
  instanceIndex?: number | null;
}

export interface TerminalDisplayMetadata {
  title: string;
  promptContext: TerminalPromptContextInput | null;
}

const collapseWhitespace = (value: string): string => value.replace(/\s+/g, ' ').trim();

const sanitizeTitleSegment = (value?: string | null): string | null => {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = collapseWhitespace(value.replace(/[|><\r\n\t]+/g, ' '));
  return normalized.length > 0 ? normalized : null;
};

export const buildTerminalDisplayMetadata = (
  input: TerminalDisplayMetadataInput
): TerminalDisplayMetadata => {
  const promptContext = buildTerminalPromptContext({
    projectLabel: input.projectLabel,
    taskLabel: input.taskLabel,
    branchLabel: null,
  });

  const titleSegments = [sanitizeTitleSegment(input.projectLabel), sanitizeTitleSegment(input.taskLabel)].filter(
    (segment): segment is string => typeof segment === 'string' && segment.trim().length > 0
  );
  const baseTitle = titleSegments.length > 0 ? titleSegments.join(' - ') : 'Terminal';
  const instanceIndex =
    typeof input.instanceIndex === 'number' && input.instanceIndex > 1
      ? Math.floor(input.instanceIndex)
      : null;

  return {
    title: instanceIndex ? `${baseTitle} #${instanceIndex}` : baseTitle,
    promptContext,
  };
};
