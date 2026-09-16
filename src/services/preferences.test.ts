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

  it('rejects native write failures without publishing a cache value or change', async () => {
    installTauriRuntimeMock(mock(async (command) => {
      if (command === 'state_get_snapshot') return { schemaVersion: 1, values: { windowWidth: 1250 } };
      if (command === 'state_set_value' || command === 'state_clear') throw new Error('disk unavailable');
      return undefined;
    }));
    const prefs = await loadPreferencesModule();
    await prefs.loadPreference(prefs.PREF_KEYS.WINDOW_WIDTH);
    const changed = mock(() => undefined);
    const failed = mock(() => undefined);
    const unsubscribe = prefs.subscribePreference(prefs.PREF_KEYS.WINDOW_WIDTH, changed);
    const unsubscribeErrors = prefs.subscribePreferencePersistenceErrors(failed);
    await expect(prefs.savePreference(prefs.PREF_KEYS.WINDOW_WIDTH, 1337)).rejects.toThrow('disk unavailable');
    expect(prefs.getCachedPreference(prefs.PREF_KEYS.WINDOW_WIDTH)).toBe(1250);
    expect(changed).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledTimes(1);
    await expect(prefs.clearPreferences()).rejects.toThrow('disk unavailable');
    expect(prefs.getCachedPreference(prefs.PREF_KEYS.WINDOW_WIDTH)).toBe(1250);
    unsubscribe();
    unsubscribeErrors();
  });

  it('rejects invalid native acknowledgments and permits retrying failed reads', async () => {
    let failRead = true;
    installTauriRuntimeMock(mock(async (command) => {
      if (command === 'state_get_snapshot') {
        if (failRead) throw new Error('read unavailable');
        return { schemaVersion: 1, values: { windowWidth: 1250 } };
      }
      return { schemaVersion: 0, values: {} };
    }));
    const prefs = await loadPreferencesModule();
    await expect(prefs.loadPersistedPreference(prefs.PREF_KEYS.WINDOW_WIDTH)).rejects.toThrow('read unavailable');
    failRead = false;
    expect(await prefs.loadPersistedPreference(prefs.PREF_KEYS.WINDOW_WIDTH)).toBe(1250);
    await expect(prefs.savePreference(prefs.PREF_KEYS.WINDOW_WIDTH, 1337)).rejects.toThrow('Invalid native state snapshot');
    expect(prefs.getCachedPreference(prefs.PREF_KEYS.WINDOW_WIDTH)).toBe(1250);
  });

  it('isolates malformed persisted state without breaking startup collections', async () => {
    installTauriRuntimeMock(mock(async () => ({ schemaVersion: 1, values: {
      recentProjects: 'oops',
      macroEnabledProjects: [{ projectId: 'p', groupId: null, name: 'Project', path: 42, lastOpenedAt: 'now' }],
      architectPinnedPlanIds: [42],
      windowWidth: 'wide',
      isMaximized: {},
      lastActiveMode: 'invalid',
      terminalLastManualProjectByTask: { task: 42 },
      windowHeight: 900,
    } })));
    const prefs = await loadPreferencesModule();
    const loaded = await prefs.loadPreferences([
      prefs.PREF_KEYS.RECENT_PROJECTS, prefs.PREF_KEYS.MACRO_ENABLED_PROJECTS,
      prefs.PREF_KEYS.ARCHITECT_PINNED_PLAN_IDS, prefs.PREF_KEYS.WINDOW_WIDTH,
      prefs.PREF_KEYS.IS_MAXIMIZED, prefs.PREF_KEYS.LAST_ACTIVE_MODE,
      prefs.PREF_KEYS.TERMINAL_LAST_MANUAL_PROJECT_BY_TASK, prefs.PREF_KEYS.WINDOW_HEIGHT,
    ]);
    expect(loaded.recentProjects.filter(() => true)).toEqual([]);
    expect(loaded.macroEnabledProjects).toEqual([]);
    expect(loaded.architectPinnedPlanIds).toEqual([]);
    expect(loaded.windowWidth).toBe(1200);
    expect(loaded.isMaximized).toBe(false);
    expect(loaded.lastActiveMode).toBe('Implement');
    expect(loaded.terminalLastManualProjectByTask).toEqual({});
    expect(loaded.windowHeight).toBe(900);
    expect(await prefs.loadPersistedPreference(prefs.PREF_KEYS.RECENT_PROJECTS)).toBeUndefined();
    await expect(prefs.savePreference(prefs.PREF_KEYS.RECENT_PROJECTS, 'oops')).rejects.toThrow('Invalid preference value');
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

  it('serializes concurrent speech preferences against the latest providers ETag', async () => {
    let revision = 0;
    let providersDocument = {
      kind: 'providers' as const,
      scope: { type: 'user' as const },
      value: { $schema: './schemas/v1/providers.schema.json', schemaVersion: 1 } as Record<string, unknown>,
      etag: 'providers-etag-0',
      readOnly: false,
      invalid: false,
      filePath: 'providers.json',
      diagnostics: [],
    };
    const appliedEtags: string[] = [];
    installTauriRuntimeMock(mock(async (command, payload) => {
      if (command === 'config_get_document') {
        return structuredClone(providersDocument);
      }
      if (command === 'config_apply_patch') {
        const request = payload?.request as {
          expectedEtag: string;
          patch: Array<{ op: string; path: string; value: unknown }>;
        };
        if (request.expectedEtag !== providersDocument.etag) {
          throw new Error('stale ETag');
        }
        appliedEtags.push(request.expectedEtag);
        const operation = request.patch[0];
        if (operation?.op === 'add' && operation.path === '/speech') {
          providersDocument = {
            ...providersDocument,
            value: { ...providersDocument.value, speech: operation.value },
            etag: `providers-etag-${++revision}`,
          };
        }
        return {
          status: 'applied',
          document: structuredClone(providersDocument),
          pendingChange: null,
          restartRequired: false,
        };
      }
      if (command === 'config_get_snapshot') {
        return {
          schemaVersion: 1,
          effective: { providers: providersDocument.value },
          projectEffective: {},
          documents: [structuredClone(providersDocument)],
          provenance: [],
          diagnostics: [],
          pendingRestartPaths: [],
        };
      }
      if (command === 'config_list_pending_changes') return [];
      return undefined;
    }));
    const { savePreference, PREF_KEYS } = await loadPreferencesModule();

    await Promise.all([
      savePreference(PREF_KEYS.SPEECH_PROVIDER_ID, 'speech-custom'),
      savePreference(PREF_KEYS.SPEECH_MAX_DURATION_SECONDS, 240),
    ]);

    expect(appliedEtags).toEqual(['providers-etag-0', 'providers-etag-1']);
    expect(providersDocument.value).toMatchObject({
      speech: {
        providerId: 'speech-custom',
        maxDurationSeconds: 240,
      },
    });
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
