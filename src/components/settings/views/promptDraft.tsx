import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import {
  DEFAULT_SMART_COMMIT_PROMPT,
  PREF_KEYS,
  PROMPT_PREFERENCE_DEFINITIONS,
  PROMPT_PREFERENCE_KEYS,
  getDefaultPromptForPreferenceKey,
  loadPersistedPreference,
  savePreferences,
  type PromptPreferenceKey,
} from '../../../services/preferences';

type CommitPromptKey = typeof PREF_KEYS.SMART_COMMIT_PROMPT;
export type PromptEditorKey = PromptPreferenceKey | CommitPromptKey;
type PromptState = Record<PromptPreferenceKey, string> & Record<CommitPromptKey, string>;
export type PromptEditorDefinition = {
  key: PromptEditorKey;
  label: string;
  description: string;
};

const COMMIT_PROMPT_DEFINITION: PromptEditorDefinition = {
  key: PREF_KEYS.SMART_COMMIT_PROMPT,
  label: 'Commit generation prompt',
  description:
    'Guides AI-generated Conventional Commit messages. Macro still validates the final message and removes scopes before committing.',
};

export const PROMPT_EDITOR_DEFINITIONS: PromptEditorDefinition[] = [
  ...PROMPT_PREFERENCE_DEFINITIONS,
  COMMIT_PROMPT_DEFINITION,
];

export const PROMPT_EDITOR_KEYS = [
  ...PROMPT_PREFERENCE_KEYS,
  PREF_KEYS.SMART_COMMIT_PROMPT,
] as PromptEditorKey[];

export const getDefaultPromptValue = (key: PromptEditorKey): string =>
  key === PREF_KEYS.SMART_COMMIT_PROMPT
    ? DEFAULT_SMART_COMMIT_PROMPT
    : getDefaultPromptForPreferenceKey(key);

export const createDefaultPromptState = (): PromptState =>
  Object.fromEntries(
    PROMPT_EDITOR_KEYS.map((key) => [key, getDefaultPromptValue(key)])
  ) as PromptState;

const DEFAULT_PROMPT_STATE = createDefaultPromptState();

// A reopened window must read after the save started in the previous window.
let pendingPromptSave: Promise<void> | null = null;

const usePromptState = (enabled: boolean) => {
  const [prompts, setPrompts] = useState<PromptState>(DEFAULT_PROMPT_STATE);
  const [savedPrompts, setSavedPrompts] = useState<PromptState>(DEFAULT_PROMPT_STATE);
  const touchedKeys = useRef(new Set<PromptEditorKey>());
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const savingRef = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const load = async () => {
      try {
        // A failed save can be partial; read the actual values in either case.
        await pendingPromptSave?.catch(() => undefined);
        const entries = await Promise.all(PROMPT_EDITOR_KEYS.map(async (key) => {
          const stored = await loadPersistedPreference<string>(key);
          return [key, stored ?? getDefaultPromptValue(key)];
        }));
        if (cancelled) return;
        const loaded = Object.fromEntries(entries) as PromptState;
        setSavedPrompts(loaded);
        setPrompts((current) => Object.fromEntries(
          PROMPT_EDITOR_KEYS.map((key) => [key, touchedKeys.current.has(key) ? current[key] : loaded[key]])
        ) as PromptState);
        setLoadState('ready');
      } catch {
        if (!cancelled) setLoadState('error');
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [enabled, loadAttempt]);

  useEffect(() => {
    if (!saveSuccess) return;
    const timer = setTimeout(() => setSaveSuccess(false), 3000);
    return () => clearTimeout(timer);
  }, [saveSuccess]);

  const save = async () => {
    if (loadState !== 'ready' || savingRef.current || pendingPromptSave) return;
    savingRef.current = true;
    setIsSaving(true);
    setSaveSuccess(false);
    const snapshot = prompts;
    const operation = savePreferences(snapshot);
    pendingPromptSave = operation;
    try {
      await operation;
      setSavedPrompts(snapshot);
      setSaveSuccess(true);
    } finally {
      pendingPromptSave = null;
      savingRef.current = false;
      setIsSaving(false);
    }
  };
  const retryLoad = () => {
    setLoadState('loading');
    setLoadAttempt((attempt) => attempt + 1);
  };

  const changePrompt = (key: PromptEditorKey, value: string) => {
    setSaveSuccess(false);
    touchedKeys.current.add(key);
    setPrompts((current) => ({ ...current, [key]: value }));
  };
  const restoreAll = () => {
    setSaveSuccess(false);
    PROMPT_EDITOR_KEYS.forEach((key) => touchedKeys.current.add(key));
    setPrompts(createDefaultPromptState());
  };
  return { prompts, savedPrompts, changePrompt, restoreAll, loadState, retryLoad, save, isSaving, saveSuccess };
};

const PromptDraftContext = createContext<ReturnType<typeof usePromptState> | null>(null);

/** Drafts live for one open settings window and are discarded on explicit close. */
export const PromptDraftProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const value = usePromptState(true);
  return <PromptDraftContext.Provider value={value}>{children}</PromptDraftContext.Provider>;
};

export const usePromptDraft = () => {
  const shared = useContext(PromptDraftContext);
  const local = usePromptState(!shared);
  return shared ?? local;
};
