import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import {
  DEFAULT_SMART_COMMIT_PROMPT,
  PREF_KEYS,
  PROMPT_PREFERENCE_DEFINITIONS,
  PROMPT_PREFERENCE_KEYS,
  getDefaultPromptForPreferenceKey,
  loadPreferences,
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

const usePromptState = (enabled: boolean) => {
  const [prompts, setPrompts] = useState<PromptState>(DEFAULT_PROMPT_STATE);
  const [savedPrompts, setSavedPrompts] = useState<PromptState>(DEFAULT_PROMPT_STATE);
  const touchedKeys = useRef(new Set<PromptEditorKey>());

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void loadPreferences<Partial<PromptState>>([...PROMPT_EDITOR_KEYS]).then((stored) => {
      if (cancelled) return;
      const loaded = { ...DEFAULT_PROMPT_STATE, ...stored };
      setSavedPrompts(loaded);
      setPrompts((current) => Object.fromEntries(
        PROMPT_EDITOR_KEYS.map((key) => [key, touchedKeys.current.has(key) ? current[key] : loaded[key]])
      ) as PromptState);
    });
    return () => { cancelled = true; };
  }, [enabled]);

  const changePrompt = (key: PromptEditorKey, value: string) => {
    touchedKeys.current.add(key);
    setPrompts((current) => ({ ...current, [key]: value }));
  };
  const restoreAll = () => {
    PROMPT_EDITOR_KEYS.forEach((key) => touchedKeys.current.add(key));
    setPrompts(createDefaultPromptState());
  };
  return { prompts, savedPrompts, setSavedPrompts, changePrompt, restoreAll };
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
