import React, { useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_SMART_COMMIT_PROMPT,
  PREF_KEYS,
  PROMPT_PREFERENCE_DEFINITIONS,
  PROMPT_PREFERENCE_KEYS,
  getDefaultPromptForPreferenceKey,
  loadPreferences,
  savePreferences,
  type PromptPreferenceKey,
} from '../../../services/preferences';
import { Icon } from '../../ui/Icon';
import { cn } from '../../../utils/cn';

type CommitPromptKey = typeof PREF_KEYS.SMART_COMMIT_PROMPT;
type PromptEditorKey = PromptPreferenceKey | CommitPromptKey;
type PromptState = Record<PromptPreferenceKey, string> & Record<CommitPromptKey, string>;
type PromptEditorDefinition = {
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

const PROMPT_EDITOR_DEFINITIONS: PromptEditorDefinition[] = [
  ...PROMPT_PREFERENCE_DEFINITIONS,
  COMMIT_PROMPT_DEFINITION,
];

const PROMPT_EDITOR_KEYS = [
  ...PROMPT_PREFERENCE_KEYS,
  PREF_KEYS.SMART_COMMIT_PROMPT,
] as PromptEditorKey[];

const getDefaultPromptValue = (key: PromptEditorKey): string =>
  key === PREF_KEYS.SMART_COMMIT_PROMPT
    ? DEFAULT_SMART_COMMIT_PROMPT
    : getDefaultPromptForPreferenceKey(key);

const createDefaultPromptState = (): PromptState =>
  Object.fromEntries(
    PROMPT_EDITOR_KEYS.map((key) => [key, getDefaultPromptValue(key)])
  ) as PromptState;

const DEFAULT_PROMPT_STATE = createDefaultPromptState();

export const PromptsView: React.FC = () => {
  const [prompts, setPrompts] = useState<PromptState>(DEFAULT_PROMPT_STATE);
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

  useEffect(() => {
    const loadPromptValues = async () => {
      const storedPrompts = await loadPreferences<Partial<PromptState>>([
        ...PROMPT_EDITOR_KEYS,
      ]);

      setPrompts({
        ...DEFAULT_PROMPT_STATE,
        ...storedPrompts,
      });
    };

    void loadPromptValues();
  }, []);

  const hasAnyModifiedPrompt = useMemo(
    () =>
      PROMPT_EDITOR_KEYS.some((key) => prompts[key] !== getDefaultPromptValue(key)),
    [prompts]
  );

  const handlePromptChange = (key: PromptEditorKey, value: string) => {
    setPrompts((current) => ({
      ...current,
      [key]: value,
    }));
  };

  const handleRestorePrompt = (key: PromptEditorKey) => {
    handlePromptChange(key, getDefaultPromptValue(key));
  };

  const handleSave = async () => {
    setIsSaving(true);
    setSaveSuccess(false);

    await savePreferences(prompts);

    setIsSaving(false);
    setSaveSuccess(true);

    setTimeout(() => setSaveSuccess(false), 3000);
  };

  const handleRestoreAll = () => {
    setPrompts(createDefaultPromptState());
  };

  const renderPromptEditor = (definition: PromptEditorDefinition) => {
    const key = definition.key;
    const isModified = prompts[key] !== getDefaultPromptValue(key);

    return (
      <div key={key} className="space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <label
              htmlFor={key}
              className="text-sm font-medium text-foreground"
            >
              {definition.label}
            </label>
            <p className="text-xs text-muted-foreground">
              {definition.description}
            </p>
          </div>
          <button
            type="button"
            onClick={() => handleRestorePrompt(key)}
            disabled={!isModified}
            className={cn(
              'shrink-0 px-3 py-1.5 rounded-md text-xs font-medium transition-colors',
              isModified
                ? 'text-foreground hover:bg-accent hover:text-accent-foreground'
                : 'text-muted-foreground/60 cursor-not-allowed'
            )}
          >
            Restore
          </button>
        </div>
        <textarea
          id={key}
          value={prompts[key]}
          onChange={(event) => handlePromptChange(key, event.target.value)}
          className="w-full min-h-[140px] p-3 rounded-lg bg-background border border-border/50 text-sm focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary resize-y font-mono"
          spellCheck={false}
        />
      </div>
    );
  };

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-300 pb-10">
      <div className="flex items-center justify-between gap-4 mb-4">
        <div>
          <h4 className="text-sm font-medium text-primary uppercase tracking-wider">
            System Prompts
          </h4>
          <p className="text-xs text-muted-foreground mt-1">
            Customize the base mode prompts and the internal profile prompts used
            during plan, review, and repo-audit flows.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleRestoreAll}
            disabled={!hasAnyModifiedPrompt}
            className={cn(
              'px-3 py-1.5 text-xs font-medium transition-colors rounded-md',
              hasAnyModifiedPrompt
                ? 'text-muted-foreground hover:text-foreground hover:bg-accent'
                : 'text-muted-foreground/60 cursor-not-allowed'
            )}
          >
            Restore All
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={isSaving}
            className={cn(
              'px-4 py-1.5 rounded-md text-xs font-medium transition-all duration-200 flex items-center gap-2',
              saveSuccess
                ? 'bg-emerald-500/20 text-emerald-500'
                : 'bg-primary text-primary-foreground hover:bg-primary/90'
            )}
          >
            {isSaving ? (
              <Icon name="loader" size={14} className="animate-spin" />
            ) : saveSuccess ? (
              <Icon name="check" size={14} />
            ) : (
              <Icon name="edit" size={14} />
            )}
            {saveSuccess ? 'Saved' : 'Save Changes'}
          </button>
        </div>
      </div>

      <div className="space-y-6 bg-card/40 p-5 rounded-xl border border-border/50">
        {PROMPT_EDITOR_DEFINITIONS.map((definition, index) => (
          <React.Fragment key={definition.key}>
            {renderPromptEditor(definition)}
            {index < PROMPT_EDITOR_DEFINITIONS.length - 1 ? (
              <div className="h-px bg-border/50" />
            ) : null}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
};
