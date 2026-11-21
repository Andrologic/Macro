export interface ImplementKickoffPromptInput {
  title: string;
  description?: string;
  projectScope: string;
  branchName: string;
  dependencies: string[];
  estimatedChanges: Array<{ operation: string; path: string }>;
  notes?: string;
}

export const buildImplementKickoffPrompt = (
  params: ImplementKickoffPromptInput,
): string => {
  const dependencyContext = params.dependencies.length > 0
    ? params.dependencies.join(', ')
    : 'none';
  const estimatedChanges = params.estimatedChanges.length > 0
    ? params.estimatedChanges
      .map((change) => `${change.operation} ${change.path}`)
      .join('\n')
    : 'No estimated file changes provided.';
  const executionNotes = params.notes?.trim();

  return [
    'You are starting implementation for this task.',
    'Start with a concise context summary so the developer immediately understands what needs to be done.',
    'Then propose an ordered execution plan.',
    'If critical information is missing, stop and ask blocking questions before coding.',
    'Use the question tool for blocking structured clarifications.',
    'When you use it, make a single question tool call in the turn, include 1 to 5 sequential questions, and provide exactly 3 suggested choices per question.',
    'Use the optional intro for short context, keep each prompt concrete, and wait for the user questionnaire response before continuing.',
    '',
    'TASK CONTEXT',
    `- Title: ${params.title}`,
    `- Description: ${params.description || 'No description provided.'}`,
    `- Project Scope: ${params.projectScope}`,
    `- Branch: ${params.branchName}`,
    `- Dependencies: ${dependencyContext}`,
    '- Estimated file changes:',
    estimatedChanges,
    ...(executionNotes ? ['', 'DEVELOPER NOTES', executionNotes] : []),
  ].join('\n');
};
