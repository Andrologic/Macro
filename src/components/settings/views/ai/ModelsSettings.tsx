import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { providerHasCredentials, useProviderStore } from '../../../../stores/useProviderStore';
import { Icon } from '../../../ui/Icon';
import { Button } from '../../../ui/Button';
import { ConfirmPromptModal } from '../../../ui/ConfirmPromptModal';
import { Input } from '../../../ui/Input';
import { Switch } from '../../../ui/Switch';
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from '../../../ui/Accordion';
import { notify } from '../../../ui/toastService';
import { cn } from '../../../../utils/cn';
import {
  DEFAULT_SMART_COMMIT_PROMPT,
  PREF_KEYS,
  loadPreference,
  savePreference,
  savePreferenceDebounced,
} from '../../../../services/preferences';
import {
  normalizeSmartCommitModelConfig,
  smartCommitModelConfigsEqual,
  type SmartCommitModelConfig,
} from '../../../../services/smartCommitModelConfig';
import {
  loadSmartCommitModelConfig,
  saveSmartCommitModelConfig,
  subscribeSmartCommitModelConfig,
} from '../../../../services/smartCommitModelPreference';
import type { ReasoningEffort } from '../../../../types';

const getErrorMessage = (error: unknown, fallback: string): string => {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return fallback;
};

const MANUAL_MODEL_MENU_WIDTH = 168;
const MANUAL_MODEL_MENU_HEIGHT = 88;
const MANUAL_MODEL_MENU_GAP = 6;
const MANUAL_MODEL_MENU_VIEWPORT_PADDING = 12;

const getManualModelMenuPosition = (
  trigger: HTMLElement | null
): { top: number; left: number } => {
  if (!trigger || typeof window === 'undefined') {
    return {
      top: MANUAL_MODEL_MENU_VIEWPORT_PADDING,
      left: MANUAL_MODEL_MENU_VIEWPORT_PADDING,
    };
  }

  const rect = trigger.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const preferredLeft = rect.right - MANUAL_MODEL_MENU_WIDTH;
  const left = Math.min(
    Math.max(MANUAL_MODEL_MENU_VIEWPORT_PADDING, preferredLeft),
    viewportWidth - MANUAL_MODEL_MENU_WIDTH - MANUAL_MODEL_MENU_VIEWPORT_PADDING
  );
  const wouldOverflowBottom =
    rect.bottom + MANUAL_MODEL_MENU_GAP + MANUAL_MODEL_MENU_HEIGHT >
    viewportHeight - MANUAL_MODEL_MENU_VIEWPORT_PADDING;
  const preferredTop = wouldOverflowBottom
    ? rect.top - MANUAL_MODEL_MENU_HEIGHT - MANUAL_MODEL_MENU_GAP
    : rect.bottom + MANUAL_MODEL_MENU_GAP;
  const top = Math.min(
    Math.max(MANUAL_MODEL_MENU_VIEWPORT_PADDING, preferredTop),
    viewportHeight - MANUAL_MODEL_MENU_HEIGHT - MANUAL_MODEL_MENU_VIEWPORT_PADDING
  );

  return { top, left };
};

export const ModelsSettings: React.FC = () => {
  const { t } = useTranslation();
  const {
    providerConfigs,
    modelsByProvider,
    providerSettingsById,
    setProviderModelEnabled,
    setAllProviderModelsEnabled,
    addManualModel,
    updateManualModel,
    deleteManualModel,
    resetProviderModelContextOverflowLimit,
    updateProviderSettings,
    scanModelsForProvider,
    getAvailableReasoningEfforts,
  } = useProviderStore();

  const [manualModelEditor, setManualModelEditor] = useState<{
    providerId: string;
    originalModelId: string | null;
  } | null>(null);
  const [activeManualModelActions, setActiveManualModelActions] = useState<{
    providerId: string;
    modelId: string;
    label: string;
    position: { top: number; left: number };
  } | null>(null);
  const [manualModelPendingDelete, setManualModelPendingDelete] = useState<{
    providerId: string;
    modelId: string;
    label: string;
  } | null>(null);
  const [manualModelId, setManualModelId] = useState('');
  const [manualModelName, setManualModelName] = useState('');
  const [isSavingManualModel, setIsSavingManualModel] = useState(false);
  const [isDeletingManualModel, setIsDeletingManualModel] = useState(false);
  const [smartCommitModelConfig, setSmartCommitModelConfig] = useState<SmartCommitModelConfig | null>(null);
  const [smartCommitPrompt, setSmartCommitPrompt] = useState(DEFAULT_SMART_COMMIT_PROMPT);
  const manualModelActionsRef = useRef<HTMLDivElement | null>(null);
  const manualModelActionsTriggerRef = useRef<HTMLButtonElement | null>(null);

  const providers = providerConfigs;
  const enabledCommitProviders = providers.filter((provider) => providerHasCredentials(provider));
  const normalizedSmartCommitModelConfig = normalizeSmartCommitModelConfig(smartCommitModelConfig, {
    providerConfigs: enabledCommitProviders,
    modelsByProvider,
    getAvailableReasoningEfforts,
  });
  const activeSmartCommitModelConfig = normalizedSmartCommitModelConfig ?? smartCommitModelConfig;
  const dedicatedCommitProviderId = activeSmartCommitModelConfig?.mode === 'dedicated'
    ? activeSmartCommitModelConfig.providerId
    : enabledCommitProviders[0]?.id ?? '';
  const dedicatedCommitModels = dedicatedCommitProviderId
    ? (modelsByProvider[dedicatedCommitProviderId] || []).filter((model) => model.isEnabled !== false)
    : [];
  const dedicatedCommitModelId = activeSmartCommitModelConfig?.mode === 'dedicated'
    ? activeSmartCommitModelConfig.modelId
    : dedicatedCommitModels[0]?.id ?? '';
  const dedicatedCommitReasoningEfforts = getAvailableReasoningEfforts(
    dedicatedCommitProviderId || null,
    dedicatedCommitModelId || null
  );
  const isEditingManualModel =
    manualModelEditor !== null && manualModelEditor.originalModelId !== null;

  useEffect(() => {
    let disposed = false;
    void Promise.all([
      loadSmartCommitModelConfig(),
      loadPreference<string>(PREF_KEYS.SMART_COMMIT_PROMPT),
    ])
      .then(([modelConfig, prompt]) => {
        if (!disposed) {
          setSmartCommitModelConfig(modelConfig);
          setSmartCommitPrompt(prompt?.trim() || DEFAULT_SMART_COMMIT_PROMPT);
        }
      });
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    const unsubscribe = subscribeSmartCommitModelConfig((config) => {
      setSmartCommitModelConfig(config);
    });
    return unsubscribe;
  }, []);

  const saveCommitModelConfig = useCallback((config: SmartCommitModelConfig) => {
    setSmartCommitModelConfig(config);
    void saveSmartCommitModelConfig(config);
  }, []);

  useEffect(() => {
    if (!smartCommitModelConfig || !normalizedSmartCommitModelConfig) return;
    if (smartCommitModelConfigsEqual(smartCommitModelConfig, normalizedSmartCommitModelConfig)) {
      return;
    }
    saveCommitModelConfig(normalizedSmartCommitModelConfig);
  }, [normalizedSmartCommitModelConfig, saveCommitModelConfig, smartCommitModelConfig]);

  const saveSmartCommitPrompt = (prompt: string) => {
    const nextPrompt = prompt.trim() || DEFAULT_SMART_COMMIT_PROMPT;
    setSmartCommitPrompt(nextPrompt);
    void savePreference(PREF_KEYS.SMART_COMMIT_PROMPT, nextPrompt);
  };

  const closeManualModelEditor = () => {
    setManualModelEditor(null);
    setManualModelId('');
    setManualModelName('');
  };

  const resetManualModelEditor = () => {
    if (isSavingManualModel) return;
    closeManualModelEditor();
  };

  const openAddManualModel = (providerId: string) => {
    setManualModelEditor({ providerId, originalModelId: null });
    setManualModelId('');
    setManualModelName('');
    setActiveManualModelActions(null);
  };

  const openEditManualModel = (providerId: string, model: { id: string; name: string }) => {
    setManualModelEditor({ providerId, originalModelId: model.id });
    setManualModelId(model.id);
    setManualModelName(model.name === model.id ? '' : model.name);
    setActiveManualModelActions(null);
  };

  useEffect(() => {
    if (!activeManualModelActions) {
      manualModelActionsTriggerRef.current = null;
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (manualModelActionsRef.current?.contains(target)) return;
      if (manualModelActionsTriggerRef.current?.contains(target)) return;
      setActiveManualModelActions(null);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setActiveManualModelActions(null);
      }
    };

    const handleViewportChange = () => {
      setActiveManualModelActions(null);
    };

    document.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', handleViewportChange);
    window.addEventListener('scroll', handleViewportChange, true);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', handleViewportChange);
      window.removeEventListener('scroll', handleViewportChange, true);
    };
  }, [activeManualModelActions]);

  if (providers.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground animate-in fade-in duration-300">
        <Icon name="layers" size={32} className="mx-auto mb-3 opacity-50" />
        <p>{t('models.noProviders', 'No providers configured yet. Add a provider first.')}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4 animate-in fade-in duration-300">
      <section
        id="commit-message-model-settings"
        data-settings-section="commit-messages"
        className="rounded-xl border border-border bg-card px-4 py-4"
      >
        <div className="flex flex-col gap-4">
          <div>
            <h3 className="text-sm font-semibold text-foreground">
              {t('models.commitMessagesTitle', 'Commit messages')}
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              {t(
                'models.commitMessagesDescription',
                'Choose which model Macro uses to generate Conventional Commit messages.'
              )}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-2 rounded-lg border border-border bg-muted/20 p-1">
            <button
              type="button"
              className={cn(
                'rounded-md px-3 py-2 text-sm transition-colors',
                activeSmartCommitModelConfig?.mode !== 'dedicated'
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground'
              )}
              onClick={() => saveCommitModelConfig({ mode: 'conversation' })}
            >
              {t('models.commitUseConversationModel', 'Use conversation model')}
            </button>
            <button
              type="button"
              className={cn(
                'rounded-md px-3 py-2 text-sm transition-colors',
                activeSmartCommitModelConfig?.mode === 'dedicated'
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground'
              )}
              disabled={!dedicatedCommitProviderId || !dedicatedCommitModelId}
              onClick={() => {
                if (!dedicatedCommitProviderId || !dedicatedCommitModelId) return;
                saveCommitModelConfig({
                  mode: 'dedicated',
                  providerId: dedicatedCommitProviderId,
                  modelId: dedicatedCommitModelId,
                  reasoningEffort: activeSmartCommitModelConfig?.mode === 'dedicated'
                    ? activeSmartCommitModelConfig.reasoningEffort
                    : null,
                });
              }}
            >
              {t('models.commitUseDedicatedModel', 'Use dedicated model')}
            </button>
          </div>

          {activeSmartCommitModelConfig?.mode === 'dedicated' && (
            <div className="grid gap-3 md:grid-cols-3">
              <label className="space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">
                  {t('settings.providers', 'AI Providers')}
                </span>
                <select
                  className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground"
                  value={dedicatedCommitProviderId}
                  onChange={(event) => {
                    const providerId = event.target.value;
                    const firstModel = (modelsByProvider[providerId] || [])
                      .find((model) => model.isEnabled !== false);
                    if (!providerId || !firstModel) return;
                    saveCommitModelConfig({
                      mode: 'dedicated',
                      providerId,
                      modelId: firstModel.id,
                      reasoningEffort: null,
                    });
                  }}
                >
                  {enabledCommitProviders.map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">
                  {t('chat.selectModel', 'Select a model')}
                </span>
                <select
                  className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground"
                  value={dedicatedCommitModelId}
                  onChange={(event) => {
                    if (!dedicatedCommitProviderId || !event.target.value) return;
                    saveCommitModelConfig({
                      mode: 'dedicated',
                      providerId: dedicatedCommitProviderId,
                      modelId: event.target.value,
                      reasoningEffort: null,
                    });
                  }}
                >
                  {dedicatedCommitModels.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name || model.id}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">
                  {t('models.reasoningEffort', 'Reasoning')}
                </span>
                <select
                  className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground"
                  value={activeSmartCommitModelConfig.reasoningEffort ?? ''}
                  onChange={(event) => {
                    if (!dedicatedCommitProviderId || !dedicatedCommitModelId) return;
                    saveCommitModelConfig({
                      mode: 'dedicated',
                      providerId: dedicatedCommitProviderId,
                      modelId: dedicatedCommitModelId,
                      reasoningEffort: event.target.value ? event.target.value as ReasoningEffort : null,
                    });
                  }}
                  disabled={dedicatedCommitReasoningEfforts.length === 0}
                >
                  <option value="">{t('models.defaultReasoning', 'Default')}</option>
                  {dedicatedCommitReasoningEfforts.map((effort) => (
                    <option key={effort} value={effort}>
                      {effort}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}

          <label className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              {t('models.commitPromptLabel', 'Commit generation prompt')}
            </span>
            <textarea
              className="min-h-36 w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground"
              value={smartCommitPrompt}
              onChange={(event) => {
                const prompt = event.target.value;
                setSmartCommitPrompt(prompt);
                savePreferenceDebounced(PREF_KEYS.SMART_COMMIT_PROMPT, prompt);
              }}
              onBlur={() => saveSmartCommitPrompt(smartCommitPrompt)}
            />
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                {t(
                  'models.commitPromptDescription',
                  'This prompt guides smart commit generation. Macro still validates the final message and removes scopes before committing.'
                )}
              </p>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => saveSmartCommitPrompt(DEFAULT_SMART_COMMIT_PROMPT)}
              >
                {t('common.reset', 'Reset')}
              </Button>
            </div>
          </label>
        </div>
      </section>

      <Accordion type="multiple" className="space-y-3">
        {providers.map((provider) => {
          const models = modelsByProvider[provider.id] || [];
          const settings = providerSettingsById[provider.id];
          const showFreeOnly = provider.providerType === 'openrouter' && settings?.filterFreeModels;
          const filteredModels = showFreeOnly ? models.filter((model) => model.isFree) : models;
          const hasKey = providerHasCredentials(provider);

          return (
            <AccordionItem
              key={provider.id}
              value={provider.id}
              className="bg-card border border-border rounded-xl px-4 overflow-hidden"
            >
              <AccordionTrigger className="hover:no-underline py-4">
                <div className="flex items-center justify-between w-full pr-4">
                  <div className="flex items-center gap-3">
                    <div
                      className={cn(
                        'w-8 h-8 rounded-md flex items-center justify-center',
                        provider.isEnabled
                          ? 'bg-primary/10 text-primary'
                          : 'bg-muted text-muted-foreground'
                      )}
                    >
                      <Icon name="cpu" size={16} />
                    </div>
                    <div className="text-left">
                      <div className="font-medium text-sm flex items-center gap-2">
                        {provider.name}
                        {!provider.isEnabled && (
                          <span className="text-[10px] bg-muted px-1.5 py-0.5 rounded text-muted-foreground">
                            {t('common.disabled', 'Disabled')}
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {t('models.providerSummary', '{{total}} total • {{enabled}} enabled', {
                          total: models.length,
                          enabled: models.filter((model) => model.isEnabled !== false).length,
                        })}
                      </div>
                    </div>
                  </div>
                </div>
              </AccordionTrigger>

              <AccordionContent className="pt-0 pb-4">
                <div className="border-t border-border pt-4">
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={(event) => {
                          event.preventDefault();
                          openAddManualModel(provider.id);
                        }}
                      >
                        <Icon name="plus" size={14} className="mr-1" />
                        {t('models.addModel', 'Add Model')}
                      </Button>

                      {provider.providerType === 'openrouter' && (
                        <div className="flex items-center gap-2 px-3 py-1.5 bg-muted/30 rounded-md border border-border/50">
                          <span className="text-xs text-muted-foreground font-medium">
                            {t('models.freeOnly', 'Free only')}
                          </span>
                          <Switch
                            className="scale-90"
                            checked={!!settings?.filterFreeModels}
                            onCheckedChange={(checked) =>
                              updateProviderSettings(provider.id, { filterFreeModels: checked })
                            }
                          />
                        </div>
                      )}
                    </div>

                    <div className="flex items-center gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={async (event) => {
                          event.preventDefault();
                          if (showFreeOnly) {
                            await Promise.all(
                              filteredModels.map((model) =>
                                setProviderModelEnabled(provider.id, model.id, true)
                              )
                            );
                            return;
                          }
                          await setAllProviderModelsEnabled(provider.id, true);
                        }}
                        disabled={filteredModels.length === 0}
                      >
                        {t('models.enableAll', 'Enable All')}
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={async (event) => {
                          event.preventDefault();
                          if (showFreeOnly) {
                            await Promise.all(
                              filteredModels.map((model) =>
                                setProviderModelEnabled(provider.id, model.id, false)
                              )
                            );
                            return;
                          }
                          await setAllProviderModelsEnabled(provider.id, false);
                        }}
                        disabled={filteredModels.length === 0}
                      >
                        {t('models.disableAll', 'Disable All')}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={async (event) => {
                          event.preventDefault();
                          try {
                            await scanModelsForProvider(provider.id);
                            notify.success(t('models.modelsRefreshed', 'Models refreshed'));
                          } catch (error) {
                            notify.error(
                              getErrorMessage(
                                error,
                                t('models.refreshFailed', 'Failed to refresh models')
                              )
                            );
                          }
                        }}
                        disabled={!hasKey}
                      >
                        <Icon name="refresh-cw" size={14} className="mr-1.5" />
                        {t('models.sync', 'Sync')}
                      </Button>
                    </div>
                  </div>

                  <div className="space-y-2 max-h-[320px] overflow-y-auto pr-2 custom-scrollbar">
                    {filteredModels.map((model) => (
                      <div
                        key={model.id}
                        className="flex items-center justify-between gap-3 p-3 rounded-md border border-border/60 bg-muted/20 hover:bg-muted/40 transition-colors"
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-sm font-medium text-foreground">
                              {model.name || model.id}
                            </span>
                            {model.isFree && (
                              <span className="px-2 py-0.5 text-[10px] rounded-full bg-emerald-500/10 text-emerald-600 border border-emerald-500/20">
                                {t('models.freeBadge', 'Free')}
                              </span>
                            )}
                            {model.contextWindowSource === 'provider_overflow_error' && (
                              <span className="px-2 py-0.5 text-[10px] rounded-full border border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300">
                                {t('models.learnedContextLimit', 'Learned limit')}
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-muted-foreground mt-0.5 font-mono">
                            {model.id}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          <Switch
                            checked={model.isEnabled !== false}
                            onCheckedChange={(checked) =>
                              setProviderModelEnabled(provider.id, model.id, checked)
                            }
                          />

                          {model.contextWindowSource === 'provider_overflow_error' && (
                            <button
                              type="button"
                              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border/70 bg-background/60 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                              title={t('models.resetLearnedContextLimit', 'Reset learned context limit')}
                              aria-label={t('models.resetLearnedContextLimit', 'Reset learned context limit')}
                              onClick={async () => {
                                try {
                                  await resetProviderModelContextOverflowLimit(provider.id, model.id);
                                  notify.success(t('models.learnedContextLimitReset', 'Learned context limit reset'));
                                } catch (error) {
                                  notify.error(
                                    getErrorMessage(
                                      error,
                                      t('models.learnedContextLimitResetFailed', 'Failed to reset learned context limit')
                                    )
                                  );
                                }
                              }}
                            >
                              <Icon name="rotate-ccw" size={14} />
                            </button>
                          )}

                          {model.isManual && (
                            <button
                              type="button"
                              className={cn(
                                'inline-flex h-8 w-8 items-center justify-center rounded-md border transition-colors',
                                activeManualModelActions?.providerId === provider.id &&
                                  activeManualModelActions?.modelId === model.id
                                  ? 'border-primary/40 bg-primary/10 text-primary'
                                  : 'border-border/70 bg-background/60 text-muted-foreground hover:bg-accent hover:text-foreground'
                              )}
                              title={t('models.manualModelActions', 'Model actions')}
                              onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                const isOpenForCurrent =
                                  activeManualModelActions?.providerId === provider.id &&
                                  activeManualModelActions?.modelId === model.id;
                                if (isOpenForCurrent) {
                                  manualModelActionsTriggerRef.current = null;
                                  setActiveManualModelActions(null);
                                  return;
                                }

                                manualModelActionsTriggerRef.current = event.currentTarget;
                                setActiveManualModelActions({
                                  providerId: provider.id,
                                  modelId: model.id,
                                  label: model.name || model.id,
                                  position: getManualModelMenuPosition(event.currentTarget),
                                });
                              }}
                            >
                              <Icon name="more-horizontal" size={14} />
                            </button>
                          )}
                        </div>
                      </div>
                    ))}

                    {filteredModels.length === 0 && (
                      <div className="text-sm text-center text-muted-foreground py-8 border border-dashed border-border/60 rounded-md">
                        {models.length === 0
                          ? hasKey
                            ? t(
                                'models.noModelsSynced',
                                'No models synced yet. Click sync to load models.'
                              )
                            : t(
                                'models.connectProvider',
                                'Connect this provider to sync models.'
                              )
                          : t(
                              'models.noModelsFiltered',
                              'No models match the current filter.'
                            )}
                      </div>
                    )}
                  </div>
                </div>
              </AccordionContent>
            </AccordionItem>
          );
        })}
      </Accordion>

      {activeManualModelActions &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={manualModelActionsRef}
            role="menu"
            aria-label={t('models.manualModelActions', 'Model actions')}
            style={{
              position: 'fixed',
              top: `${activeManualModelActions.position.top}px`,
              left: `${activeManualModelActions.position.left}px`,
              width: `${MANUAL_MODEL_MENU_WIDTH}px`,
            }}
            className="z-[9999] overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl animate-in fade-in zoom-in-95 duration-100"
          >
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm text-foreground transition-colors hover:bg-accent"
              onClick={() =>
                openEditManualModel(activeManualModelActions.providerId, {
                  id: activeManualModelActions.modelId,
                  name: activeManualModelActions.label,
                })
              }
            >
              <Icon name="edit" size={14} />
              {t('common.edit', 'Edit')}
            </button>
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm text-destructive transition-colors hover:bg-destructive/10"
              onClick={() => {
                setManualModelPendingDelete({
                  providerId: activeManualModelActions.providerId,
                  modelId: activeManualModelActions.modelId,
                  label: activeManualModelActions.label,
                });
                setActiveManualModelActions(null);
              }}
            >
              <Icon name="trash" size={14} />
              {t('common.delete', 'Delete')}
            </button>
          </div>,
          document.body
        )}

      {manualModelEditor && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4">
          <div className="flex max-h-[calc(100vh-2rem)] w-full max-w-md flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
            <div className="mb-0 flex shrink-0 items-center justify-between border-b border-border px-5 py-4">
              <h4 className="text-base font-semibold">
                {isEditingManualModel
                  ? t('models.editCustomTitle', 'Edit Custom Model')
                  : t('models.addCustomTitle', 'Add Custom Model')}
              </h4>
              <button
                className="p-1.5 rounded-full hover:bg-muted text-muted-foreground transition-colors"
                onClick={resetManualModelEditor}
                title={t('common.close', 'Close')}
                disabled={isSavingManualModel}
              >
                <Icon name="x" size={16} />
              </button>
            </div>

            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
              <div className="space-y-1.5">
                <label className="text-sm font-medium">{t('models.modelId', 'Model ID')}</label>
                <Input
                  value={manualModelId}
                  onChange={(event) => setManualModelId(event.target.value)}
                  placeholder={t('models.modelIdPlaceholder', 'e.g. gpt-4o-mini')}
                  className="font-mono text-sm"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-sm font-medium">
                  {t('models.displayName', 'Display Name')}{' '}
                  <span className="text-muted-foreground font-normal">
                    ({t('common.optional', 'optional')})
                  </span>
                </label>
                <Input
                  value={manualModelName}
                  onChange={(event) => setManualModelName(event.target.value)}
                  placeholder={t('models.displayNamePlaceholder', 'e.g. GPT-4o Mini')}
                />
              </div>
            </div>

            <div className="flex shrink-0 flex-wrap items-center justify-end gap-3 border-t border-border px-5 py-4">
              <Button variant="ghost" onClick={resetManualModelEditor} disabled={isSavingManualModel}>
                {t('common.cancel', 'Cancel')}
              </Button>
              <Button
                isLoading={isSavingManualModel}
                onClick={async () => {
                  const modelId = manualModelId.trim();
                  if (!modelId) return;
                  const name = manualModelName.trim() || modelId;
                  setIsSavingManualModel(true);
                  try {
                    if (manualModelEditor.originalModelId) {
                      await updateManualModel(
                        manualModelEditor.providerId,
                        manualModelEditor.originalModelId,
                        modelId,
                        name
                      );
                      notify.success(t('models.modelUpdated', 'Model updated successfully'));
                    } else {
                      await addManualModel(manualModelEditor.providerId, modelId, name);
                      notify.success(t('models.modelAdded', 'Model added successfully'));
                    }
                    closeManualModelEditor();
                  } catch (error) {
                    notify.error(
                      getErrorMessage(
                        error,
                        isEditingManualModel
                          ? t('models.updateFailed', 'Failed to update model')
                          : t('models.addFailed', 'Failed to add model')
                      )
                    );
                  } finally {
                    setIsSavingManualModel(false);
                  }
                }}
                disabled={!manualModelId.trim()}
              >
                {isEditingManualModel ? t('common.save', 'Save') : t('models.addModel', 'Add Model')}
              </Button>
            </div>
          </div>
        </div>
      )}

      <ConfirmPromptModal
        isOpen={!!manualModelPendingDelete}
        title={t('models.deleteCustomTitle', 'Delete Custom Model')}
        description={
          manualModelPendingDelete
            ? t('models.deleteCustomDescription', 'Delete "{{modelName}}" from this provider?', {
                modelName: manualModelPendingDelete.label,
              })
            : undefined
        }
        confirmLabel={t('common.delete', 'Delete')}
        confirmVariant="error"
        isSubmitting={isDeletingManualModel}
        onCancel={() => {
          if (isDeletingManualModel) return;
          setManualModelPendingDelete(null);
        }}
        onConfirm={async () => {
          if (!manualModelPendingDelete) return;
          setIsDeletingManualModel(true);
          try {
            await deleteManualModel(
              manualModelPendingDelete.providerId,
              manualModelPendingDelete.modelId
            );
            setManualModelPendingDelete(null);
            notify.success(t('models.modelDeleted', 'Model deleted successfully'));
          } catch (error) {
            notify.error(
              getErrorMessage(error, t('models.deleteFailed', 'Failed to delete model'))
            );
          } finally {
            setIsDeletingManualModel(false);
          }
        }}
      />
    </div>
  );
};
