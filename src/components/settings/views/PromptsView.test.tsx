import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const promptDefaults = {
  promptArchitect: 'Architect default prompt',
  promptImplement: 'Implement default prompt',
  promptChat: 'Chat default prompt',
  promptPlanExplorer: 'Plan explorer default prompt',
  promptTaskReviewer: 'Task reviewer default prompt',
  promptRepoAuditor: 'Repo auditor default prompt',
  smartCommitPrompt: 'Commit default prompt',
} as const;

const promptDefinitions = [
  {
    key: 'promptArchitect',
    label: 'Architect Mode',
    description: 'Base system prompt for Architect conversations.',
    scope: 'mode',
  },
  {
    key: 'promptImplement',
    label: 'Implement Mode',
    description: 'Base system prompt for Implement conversations.',
    scope: 'mode',
  },
  {
    key: 'promptChat',
    label: 'Chat Mode',
    description: 'Base system prompt for general chat conversations.',
    scope: 'mode',
  },
  {
    key: 'promptPlanExplorer',
    label: 'Plan Explorer Profile',
    description: 'Extra guidance injected for Architect planning and exploration flows.',
    scope: 'internal_profile',
  },
  {
    key: 'promptTaskReviewer',
    label: 'Task Reviewer Profile',
    description: 'Extra guidance injected while reviewing an Implement task in review.',
    scope: 'internal_profile',
  },
  {
    key: 'promptRepoAuditor',
    label: 'Repo Auditor Profile',
    description: 'Extra guidance injected for Git conflict, finalization, and repository audit flows.',
    scope: 'internal_profile',
  },
] as const;

let promptValues: Record<string, string>;
const loadPreferencesMock = mock(async (_keys: string[]) => ({}));
const savePreferencesMock = mock(async (_preferences: Record<string, string>) => undefined);
let importCounter = 0;

const loadPromptsView = async () => {
  const actualPreferences = await import(
    `../../../services/preferences.ts?prompts-view-preferences-test=${importCounter + 1}`
  );

  mock.module('../../../services/preferences', () => ({
    ...actualPreferences,
    PROMPT_PREFERENCE_DEFINITIONS: promptDefinitions,
    PROMPT_PREFERENCE_KEYS: promptDefinitions.map((definition) => definition.key),
    DEFAULT_SMART_COMMIT_PROMPT: promptDefaults.smartCommitPrompt,
    getDefaultPromptForPreferenceKey: (key: keyof typeof promptDefaults) =>
      promptDefaults[key],
    loadPreferences: (keys: string[]) => loadPreferencesMock(keys),
    savePreferences: (preferences: Record<string, string>) =>
      savePreferencesMock(preferences),
  }));

  mock.module('../../ui/Icon', () => ({
    Icon: ({ name }: { name: string }) => <span data-icon={name} />,
  }));

  mock.module('../../../utils/cn', () => ({
    cn: (...values: Array<string | false | null | undefined>) =>
      values.filter(Boolean).join(' '),
  }));

  importCounter += 1;
  return import(`./PromptsView.tsx?test=${importCounter}`);
};

describe('PromptsView', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    promptValues = {
      ...promptDefaults,
      promptPlanExplorer: 'Customized plan explorer prompt',
      promptRepoAuditor: 'Customized repo auditor prompt',
      smartCommitPrompt: 'Customized commit generation prompt',
    };

    loadPreferencesMock.mockImplementation(async () => ({ ...promptValues }));
    savePreferencesMock.mockClear();

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
      await Promise.resolve();
    });
    container?.remove();
    root = null;
    container = null;
    mock.restore();
  });

  it('renders prompt editors for public modes and internal profiles', async () => {
    const { PromptsView } = await loadPromptsView();

    await act(async () => {
      root?.render(<PromptsView />);
      await Promise.resolve();
    });

    const textareas = Array.from(container?.querySelectorAll('textarea') ?? []);
    expect(textareas).toHaveLength(7);
    expect(
      (container?.querySelector('#promptPlanExplorer') as HTMLTextAreaElement | null)?.value
    ).toBe('Customized plan explorer prompt');
    expect(
      (container?.querySelector('#promptRepoAuditor') as HTMLTextAreaElement | null)?.value
    ).toBe('Customized repo auditor prompt');
    expect(
      (container?.querySelector('#smartCommitPrompt') as HTMLTextAreaElement | null)?.value
    ).toBe('Customized commit generation prompt');
  });

  it('restores a modified prompt to its default and saves the updated prompt set', async () => {
    const { PromptsView } = await loadPromptsView();

    await act(async () => {
      root?.render(<PromptsView />);
      await Promise.resolve();
    });

    const planExplorerField = container?.querySelector(
      '#promptPlanExplorer'
    ) as HTMLTextAreaElement | null;
    expect(planExplorerField?.value).toBe('Customized plan explorer prompt');

    const restoreButton = planExplorerField?.parentElement?.querySelector('button');
    await act(async () => {
      restoreButton?.click();
      await Promise.resolve();
    });

    expect(planExplorerField?.value).toBe(promptDefaults.promptPlanExplorer);

    const saveButton = Array.from(container?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent?.includes('Save Changes')
    );
    await act(async () => {
      saveButton?.click();
      await Promise.resolve();
    });

    expect(savePreferencesMock).toHaveBeenCalledWith({
      promptArchitect: promptDefaults.promptArchitect,
      promptImplement: promptDefaults.promptImplement,
      promptChat: promptDefaults.promptChat,
      promptPlanExplorer: promptDefaults.promptPlanExplorer,
      promptTaskReviewer: promptDefaults.promptTaskReviewer,
      promptRepoAuditor: 'Customized repo auditor prompt',
      smartCommitPrompt: 'Customized commit generation prompt',
    });
  });
});
