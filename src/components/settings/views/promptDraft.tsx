import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import {
  PROMPT_PREFERENCE_KEYS,
  getDefaultPromptForPreferenceKey,
  loadPersistedPreference,
  savePreferences,
  type PromptPreferenceKey,
} from '../../../services/preferences';

type PromptState = Record<PromptPreferenceKey, string>;

export const createDefaultPromptState = (): PromptState =>
  Object.fromEntries(
    PROMPT_PREFERENCE_KEYS.map((key) => [key, getDefaultPromptForPreferenceKey(key)])
  ) as PromptState;

const DEFAULT_PROMPT_STATE = createDefaultPromptState();

// A reopened window must read after the save started in the previous window.
let pendingPromptSave: Promise<void> | null = null;

const usePromptState = (enabled: boolean) => {
  const [prompts, setPrompts] = useState<PromptState>(DEFAULT_PROMPT_STATE);
  const [savedPrompts, setSavedPrompts] = useState<PromptState>(DEFAULT_PROMPT_STATE);
  const touchedKeys = useRef(new Set<PromptPreferenceKey>());
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
        const entries = await Promise.all(PROMPT_PREFERENCE_KEYS.map(async (key) => {
          const stored = await loadPersistedPreference<string>(key);
          return [key, stored ?? getDefaultPromptForPreferenceKey(key)];
        }));
        if (cancelled) return;
        const loaded = Object.fromEntries(entries) as PromptState;
        setSavedPrompts(loaded);
        setPrompts((current) => Object.fromEntries(
          PROMPT_PREFERENCE_KEYS.map((key) => [key, touchedKeys.current.has(key) ? current[key] : loaded[key]])
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

  const changePrompt = (key: PromptPreferenceKey, value: string) => {
    setSaveSuccess(false);
    touchedKeys.current.add(key);
    setPrompts((current) => ({ ...current, [key]: value }));
  };
  const restoreAll = () => {
    setSaveSuccess(false);
    PROMPT_PREFERENCE_KEYS.forEach((key) => touchedKeys.current.add(key));
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
