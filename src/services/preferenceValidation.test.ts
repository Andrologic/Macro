import { describe, expect, it } from 'bun:test';
import { isPreferenceValueValid } from './preferenceValidation';

const rememberedProject = {
  projectId: 'project-1',
  groupId: null,
  name: 'Project one',
  path: '/tmp/project-one',
  lastOpenedAt: '2026-09-16T08:00:00.000Z',
};

const defaultProjects = [rememberedProject];

describe('preferenceValidation', () => {
  it('rejects malformed native collections before initialization can consume them', () => {
    expect(isPreferenceValueValid('recentProjects', 'oops', defaultProjects)).toBe(false);
    expect(
      isPreferenceValueValid(
        'macroEnabledProjects',
        [{ ...rememberedProject, path: 42 }],
        defaultProjects,
      ),
    ).toBe(false);
    expect(isPreferenceValueValid('recentProjects', [rememberedProject], [])).toBe(true);
  });

  it('validates scalar state and native titlebar values by their runtime type', () => {
    expect(isPreferenceValueValid('windowWidth', '1200', 1200)).toBe(false);
    expect(isPreferenceValueValid('windowWidth', 1440, 1200)).toBe(true);
    expect(isPreferenceValueValid('isMaximized', {}, false)).toBe(false);
    expect(isPreferenceValueValid('nativeMacosTitlebarTheme', 'blue', 'dark')).toBe(false);
    expect(isPreferenceValueValid('nativeMacosTitlebarTheme', 'light', 'dark')).toBe(true);
    expect(isPreferenceValueValid('speech.maxDurationSeconds', 601, 120)).toBe(false);
  });

  it('keeps field normalization with view filters while rejecting non-record values', () => {
    const fallback = { version: 1, projectId: '__all_projects__', status: 'all', showArchived: false };

    expect(isPreferenceValueValid('implementViewFilters', { version: 99 }, fallback)).toBe(true);
    expect(isPreferenceValueValid('implementViewFilters', 'oops', fallback)).toBe(false);
  });

  it('validates structured maps used during startup', () => {
    const fallback = {
      version: 2,
      modeSelections: {},
      conversationSelections: {},
      providerSelectionsByConversationId: {},
      providerSelectionsByMode: {},
    };
    const selection = {
      providerId: 'provider-1',
      modelId: 'model-1',
      reasoningEffort: null,
      updatedAt: '2026-09-16T08:00:00.000Z',
    };

    expect(
      isPreferenceValueValid(
        'aiContextSelections',
        { ...fallback, conversationSelections: [] },
        fallback,
      ),
    ).toBe(false);
    expect(
      isPreferenceValueValid(
        'aiContextSelections',
        { ...fallback, conversationSelections: { 'conversation-1': selection } },
        fallback,
      ),
    ).toBe(true);
    expect(
      isPreferenceValueValid(
        'aiContextSelections',
        { version: 1, modeSelections: { ChatDebug: { providerId: null, modelId: null } } },
        fallback,
      ),
    ).toBe(true);
    expect(
      isPreferenceValueValid(
        'terminalLastManualProjectByTask',
        { 'task-1': 'project-1' },
        {},
      ),
    ).toBe(true);
    expect(
      isPreferenceValueValid(
        'terminalLastManualProjectByTask',
        { 'task-1': 1 },
        {},
      ),
    ).toBe(false);
  });

  it('validates persisted onboarding and notification values', () => {
    const onboardingDefault = {
      version: 1,
      completedAt: null,
      dismissedAt: null,
      lastStepId: null,
    };
    expect(
      isPreferenceValueValid(
        'onboardingState',
        { ...onboardingDefault, completedAt: 'not-a-date' },
        onboardingDefault,
      ),
    ).toBe(false);
    expect(
      isPreferenceValueValid(
        'onboardingState',
        { ...onboardingDefault, lastStepId: 'welcome' },
        onboardingDefault,
      ),
    ).toBe(true);

    const channelsDefault = {
      task_attention_required: 'both',
      task_run_completed: 'desktop',
      task_completed: 'both',
      git_sync_completed: 'desktop',
      git_sync_attention_required: 'both',
    };
    expect(
      isPreferenceValueValid(
        'notificationChannelModes',
        { task_completed: 'invalid' },
        channelsDefault,
      ),
    ).toBe(false);
    expect(
      isPreferenceValueValid(
        'notificationChannelModes',
        { task_completed: 'toast' },
        channelsDefault,
      ),
    ).toBe(true);
  });
});
