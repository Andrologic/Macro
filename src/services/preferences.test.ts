import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { installTauriRuntimeMock, removeTauriRuntimeMock } from '../test-utils/tauriRuntime';
import { useConfigStore } from '../stores/useConfigStore';

let isolatedImportCounter = 0;

const loadPreferencesModule = async () => {
  isolatedImportCounter += 1;
  return import(`./preferences.ts?json-config=${isolatedImportCounter}`);
};

const baseDocuments = {
  settings: {
    kind: 'settings',
    scope: { type: 'user' },
    value: { $schema: './schemas/v1/settings.schema.json', schemaVersion: 1 },
    etag: 'settings-etag',
    readOnly: false,
    invalid: false,
    filePath: 'settings.json',
    diagnostics: [],
  },
  agents: {
    kind: 'agents',
    scope: { type: 'user' },
    value: { $schema: './schemas/v1/agents.schema.json', schemaVersion: 1 },
    etag: 'agents-etag',
    readOnly: false,
    invalid: false,
    filePath: 'agents.json',
    diagnostics: [],
  },
} as const;

const installConfigRuntime = () => {
  const calls: Array<{ command: string; payload?: Record<string, unknown> }> = [];
  const invoke = installTauriRuntimeMock(mock(async (command, payload) => {
    calls.push({ command, payload });
    if (command === 'config_get_snapshot') {
      return {
        schemaVersion: 1,
        effective: {
          settings: { language: 'fr', appearance: { theme: 'macro-dark' } },
          agents: { maxTurns: 0 },
          providers: { speech: { maxDurationSeconds: 120, enhancementEnabled: false } },
          tools: { riskLevel: 'balanced' },
          skills: {},
          git: {},
          runtime: {},
        },
        documents: Object.values(baseDocuments),
        provenance: [],
        diagnostics: [],
        pendingRestartPaths: [],
      };
    }
    if (command === 'config_get_document') {
      const kind = payload?.kind as keyof typeof baseDocuments;
      return baseDocuments[kind];
    }
    if (command === 'config_apply_patch') {
      const request = payload?.request as { kind: keyof typeof baseDocuments };
      return {
        status: 'applied',
        document: baseDocuments[request.kind],
        pendingChange: null,
        restartRequired: false,
      };
    }
    if (command === 'state_get_snapshot') {
      return { schemaVersion: 1, values: {} };
    }
    if (command === 'state_set_value') {
      return { schemaVersion: 1, values: { [String(payload?.key)]: payload?.value } };
    }
    return undefined;
  }));
  return { calls, invoke };
};

describe('preferences JSON configuration adapter', () => {
  beforeEach(() => {
    localStorage.clear();
    removeTauriRuntimeMock();
    useConfigStore.setState({
      snapshot: null,
      status: 'idle',
      error: null,
      activeProjectIds: [],
      pendingChanges: [],
    });
  });

  afterEach(() => {
    removeTauriRuntimeMock();
  });

  it('does not import or delete legacy preferences during the clean reset', async () => {
    localStorage.setItem('macro_implementExecutionMode', JSON.stringify('full_auto'));
    const { purgeLegacyImplementExecutionModePreference } = await loadPreferencesModule();

    await purgeLegacyImplementExecutionModePreference();

    expect(localStorage.getItem('macro_implementExecutionMode')).toBe('"full_auto"');
  });

  it('ignores legacy localStorage and reads the effective JSON snapshot', async () => {
    localStorage.setItem('macro_language', JSON.stringify('de'));
    installConfigRuntime();
    const { loadPreference, PREF_KEYS } = await loadPreferencesModule();

    expect(await loadPreference(PREF_KEYS.LANGUAGE)).toBe('fr');
  });

  it('writes a durable setting to the correct sparse document with an ETag', async () => {
    const { calls } = installConfigRuntime();
    const { savePreference, PREF_KEYS } = await loadPreferencesModule();

    await savePreference(PREF_KEYS.THEME, 'light');

    const patchCall = calls.find((call) => call.command === 'config_apply_patch');
    expect(patchCall?.payload).toEqual({
      request: {
        kind: 'settings',
        scope: { type: 'user' },
        expectedEtag: 'settings-etag',
        patch: [{
          op: 'add',
          path: '/appearance',
          value: { theme: 'light' },
          from: null,
        }],
        source: 'userInterface',
      },
    });
    expect(localStorage.getItem('macro_theme')).toBeNull();
  });

  it('stores the dedicated metadata model in the agents model-selection format', async () => {
    const { calls } = installConfigRuntime();
    const { savePreference, PREF_KEYS } = await loadPreferencesModule();

    await savePreference(PREF_KEYS.METADATA_MODEL_CONFIG, {
      mode: 'dedicated',
      providerId: 'openai',
      modelId: 'gpt-5.6',
      reasoningEffort: 'medium',
    });

    const patchCall = calls.find((call) => call.command === 'config_apply_patch');
    expect(patchCall?.payload).toEqual({
      request: {
        kind: 'agents',
        scope: { type: 'user' },
        expectedEtag: 'agents-etag',
        patch: [{
          op: 'add',
          path: '/models',
          value: {
            metadata: {
              providerId: 'openai',
              modelId: 'gpt-5.6',
              reasoningEffort: 'medium',
            },
          },
          from: null,
        }],
        source: 'userInterface',
      },
    });
  });

  it('writes window and panel state to state.json instead of configuration', async () => {
    const { calls } = installConfigRuntime();
    const { savePreference, PREF_KEYS } = await loadPreferencesModule();

    await savePreference(PREF_KEYS.WINDOW_WIDTH, 1440);

    expect(calls).toContainEqual({
      command: 'state_set_value',
      payload: { key: 'windowWidth', value: 1440 },
    });
  });

  it('uses defaults in a non-Tauri test environment and validates values', async () => {
    const { loadPreference, PREF_KEYS } = await loadPreferencesModule();

    expect(await loadPreference(PREF_KEYS.CHAT_MAX_TURNS)).toBeNull();
    expect(await loadPreference(PREF_KEYS.SPEECH_MAX_DURATION_SECONDS)).toBe(120);
    expect(await loadPreference(PREF_KEYS.SPEECH_ENHANCEMENT_ENABLED)).toBe(false);
  });

  it('keeps the Architect prompt aligned with the conversation-first workflow', async () => {
    const { getDefaultPromptForPreferenceKey, PREF_KEYS } = await loadPreferencesModule();
    const prompt = getDefaultPromptForPreferenceKey(PREF_KEYS.PROMPT_ARCHITECT);

    expect(prompt).toContain('retains its own conversation and strategy');
    expect(prompt).toContain('Generate or regenerate strategy only after an explicit user request');
    expect(prompt).toContain('Do not create a "Finalize plan" strategy node yourself');
  });

  it('keeps the goal auditor prompt read-only, evidence-based, and JSON-only', async () => {
    const { getDefaultPromptForPreferenceKey, PREF_KEYS } = await loadPreferencesModule();

    const prompt = getDefaultPromptForPreferenceKey(PREF_KEYS.PROMPT_GOAL_AUDITOR);
    const lowercasePrompt = prompt.toLowerCase();

    expect(prompt).toContain('GOAL_AUDITOR');
    expect(lowercasePrompt).toContain('read-only');
    expect(lowercasePrompt).toContain('untrusted data');
    expect(lowercasePrompt).toContain('sourced evidence');
    expect(prompt).toContain('JSON object');
    expect(prompt).toContain('Only you, the GOAL_AUDITOR agent, may rule a goal achieved');
    expect(prompt).toContain('"status":"unmet"');
    expect(prompt).toContain('"feedback":"What the executor must do next"');
    expect(() => {
      const jsonStart = prompt.indexOf('{');
      const jsonEnd = prompt.indexOf('}. Allowed verdict values');
      JSON.parse(prompt.slice(jsonStart, jsonEnd + 1));
    }).not.toThrow();
  });

  it('notifies same-window subscribers once for an immediate preference save', async () => {
    const { PREF_KEYS, savePreference, subscribePreference } = await loadPreferencesModule();
    const listener = mock((_value: unknown) => undefined);
    const unsubscribe = subscribePreference(PREF_KEYS.METADATA_MODEL_CONFIG, listener);

    await savePreference(PREF_KEYS.METADATA_MODEL_CONFIG, { mode: 'conversation' });

    unsubscribe();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ mode: 'conversation' }, PREF_KEYS.METADATA_MODEL_CONFIG);
  });

  it('does not emit a second same-window notification when a debounced save flushes to the store', async () => {
    const {
      PREF_KEYS,
      savePreference,
      savePreferenceDebounced,
      subscribePreference,
    } = await loadPreferencesModule();
    const listener = mock((_value: unknown) => undefined);
    const unsubscribe = subscribePreference(PREF_KEYS.WINDOW_WIDTH, listener);

    await savePreference(PREF_KEYS.WINDOW_WIDTH, 1201);
    savePreferenceDebounced(PREF_KEYS.WINDOW_WIDTH, 1202, 1);
    await new Promise((resolve) => setTimeout(resolve, 10));

    unsubscribe();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('rejects a failed JSON configuration write without retaining a phantom preference', async () => {
    const calls: string[] = [];
    installTauriRuntimeMock(mock(async (command) => {
      calls.push(command);
      if (command === 'config_get_document') return baseDocuments.settings;
      if (command === 'config_apply_patch') throw new Error('disk is read-only');
      if (command === 'config_get_snapshot') {
        return {
          schemaVersion: 1,
          effective: {
            settings: { appearance: { theme: 'macro-dark' } },
            agents: {}, providers: {}, tools: {}, skills: {}, git: {}, runtime: {},
          },
          projectEffective: {},
          documents: Object.values(baseDocuments),
          provenance: [], diagnostics: [], pendingRestartPaths: [],
        };
      }
      if (command === 'config_list_pending_changes') return [];
      return undefined;
    }));
    const {
      getCachedPreference,
      loadPreference,
      PREF_KEYS,
      savePreference,
      subscribePreferencePersistenceErrors,
    } = await loadPreferencesModule();
    const persistenceError = mock((_error: unknown, _key: unknown) => undefined);
    const unsubscribe = subscribePreferencePersistenceErrors(persistenceError);

    await expect(savePreference(PREF_KEYS.THEME, 'light')).rejects.toThrow('disk is read-only');
    unsubscribe();
    expect(persistenceError).toHaveBeenCalledWith(expect.any(Error), PREF_KEYS.THEME);
    expect(getCachedPreference(PREF_KEYS.THEME)).toBe('macro-dark');
    expect(await loadPreference(PREF_KEYS.THEME)).toBe('macro-dark');
    expect(calls).toContain('config_apply_patch');
  });

  it('reports a failed debounced JSON configuration write without caching it as saved', async () => {
    installTauriRuntimeMock(mock(async (command) => {
      if (command === 'config_get_document') return baseDocuments.settings;
      if (command === 'config_apply_patch') throw new Error('write failed');
      return undefined;
    }));
    const {
      getCachedPreference,
      PREF_KEYS,
      savePreferenceDebounced,
      subscribePreferencePersistenceErrors,
    } = await loadPreferencesModule();
    const listener = mock((_error: unknown, _key: unknown) => undefined);
    const unsubscribe = subscribePreferencePersistenceErrors(listener);

    savePreferenceDebounced(PREF_KEYS.THEME, 'light', 1);
    await new Promise((resolve) => setTimeout(resolve, 20));

    unsubscribe();
    expect(listener).toHaveBeenCalledWith(expect.any(Error), PREF_KEYS.THEME);
    expect(getCachedPreference(PREF_KEYS.THEME)).toBe('macro-dark');
  });
});
