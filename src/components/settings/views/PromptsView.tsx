import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  PROMPT_EDITOR_DEFINITIONS,
  PROMPT_EDITOR_KEYS,
  getDefaultPromptValue,
  usePromptDraft,
  type PromptEditorDefinition,
} from './promptDraft';
import { Icon } from '../../ui/Icon';
import { cn } from '../../../utils/cn';
import { SettingsSectionHeader } from '../SettingsSectionHeader';
import { notify } from '../../ui/toastService';

export const PromptsView: React.FC = () => {
  const { t } = useTranslation();
  const { prompts, savedPrompts, changePrompt, restoreAll, loadState, retryLoad, save, isSaving, saveSuccess } = usePromptDraft();

  const hasAnyModifiedPrompt = useMemo(
    () =>
      PROMPT_EDITOR_KEYS.some((key) => prompts[key] !== getDefaultPromptValue(key)),
    [prompts]
  );
  const isDirty = useMemo(
    () => PROMPT_EDITOR_KEYS.some((key) => prompts[key] !== savedPrompts[key]),
    [prompts, savedPrompts]
  );
  const handleSave = async () => {
    try {
      await save();
    } catch (error) {
      notify.error(t('prompts.saveFailed', 'Unable to save system prompts.'), {
        description: error instanceof Error ? error.message : undefined,
      });

    }
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
              {t(`prompts.editors.${key}.label`, definition.label)}
            </label>
            <p className="text-xs text-muted-foreground">
              {t(`prompts.editors.${key}.description`, definition.description)}
            </p>
          </div>
          <button
            type="button"
            onClick={() => changePrompt(key, getDefaultPromptValue(key))}
            disabled={!isModified}
            className={cn(
              'shrink-0 px-3 py-1.5 rounded-md text-xs font-medium transition-colors',
              isModified
                ? 'text-foreground hover:bg-accent hover:text-accent-foreground'
                : 'text-muted-foreground/60 cursor-not-allowed'
            )}
          >
            {t('common.restore', 'Restore')}
          </button>
        </div>
        <textarea
          id={key}
          value={prompts[key]}
          onChange={(event) => changePrompt(key, event.target.value)}
          className="w-full min-h-[140px] p-3 rounded-lg bg-background border border-border/50 text-sm focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary resize-y font-mono"
          spellCheck={false}
        />
      </div>
    );
  };

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-300 pb-10">
      <SettingsSectionHeader
        className="mb-4"
        title={t('prompts.title', 'System Prompts')}
        description={t('prompts.description', 'Customize the base mode prompts and the internal profile prompts used during plan, review, and repo-audit flows.')}
        action={
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={restoreAll}
              disabled={!hasAnyModifiedPrompt}
              className={cn(
                'px-3 py-1.5 text-xs font-medium transition-colors rounded-md',
                hasAnyModifiedPrompt
                  ? 'text-muted-foreground hover:text-foreground hover:bg-accent'
                  : 'text-muted-foreground/60 cursor-not-allowed'
              )}
            >
              {t('prompts.restoreAll', 'Restore All')}
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={loadState !== 'ready' || isSaving || !isDirty}
              className={cn(
                'px-4 py-1.5 rounded-md text-xs font-medium transition-all duration-200 flex items-center gap-2',
                saveSuccess
                  ? 'bg-emerald-500/20 text-emerald-500'
                  : isDirty
                    ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                    : 'bg-muted text-muted-foreground cursor-not-allowed'
              )}
            >
              {isSaving ? (
                <Icon name="loader" size={14} className="animate-spin" />
              ) : saveSuccess ? (
                <Icon name="check" size={14} />
              ) : (
                <Icon name="edit" size={14} />
              )}
              {saveSuccess && !isDirty ? t('common.saved', 'Saved') : t('common.saveChanges', 'Save Changes')}
            </button>
          </div>
        }
      />

      {loadState === 'loading' && <p role="status">{t('common.loading', 'Loading...')}</p>}
      {loadState === 'error' && (
        <div role="alert" className="space-y-2 text-sm text-destructive">
          <p>{t('prompts.loadFailed', 'Unable to load system prompts. Retry before saving.')}</p>
          <button type="button" onClick={retryLoad} className="rounded-md border border-border px-3 py-1.5">
            {t('common.retry', 'Retry')}
          </button>
        </div>
      )}

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
