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

export const buildTerminalDisplayMetadata = (
  input: TerminalDisplayMetadataInput
): TerminalDisplayMetadata => {
  const promptContext = buildTerminalPromptContext({
    projectLabel: input.projectLabel,
    taskLabel: input.taskLabel,
    branchLabel: null,
  });

  const segments = [promptContext?.projectLabel, promptContext?.taskLabel].filter(
    (segment): segment is string => typeof segment === 'string' && segment.trim().length > 0
  );
  const baseTitle = segments.length > 0 ? segments.join(' - ') : 'Terminal';
  const instanceIndex =
    typeof input.instanceIndex === 'number' && input.instanceIndex > 1
      ? Math.floor(input.instanceIndex)
      : null;

  return {
    title: instanceIndex ? `${baseTitle} #${instanceIndex}` : baseTitle,
    promptContext,
  };
};
