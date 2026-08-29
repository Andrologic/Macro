import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { providerHasCredentials, useProviderStore } from '../../../../stores/useProviderStore';
import { useAppStore } from '../../../../stores/useAppStore';
import { SettingsEmptyState } from '../../../shared/SettingsEmptyState';
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
  metadataModelConfigsEqual,
  normalizeMetadataModelConfig,
  resolveMetadataModelReasoningEfforts,
  type MetadataModelConfig,
} from '../../../../services/metadataModelConfig';
import {
  loadMetadataModelConfig,
  saveMetadataModelConfig,
  subscribeMetadataModelConfig,
} from '../../../../services/metadataModelPreference';
import type { AIModel, ReasoningEffort } from '../../../../types';
import { MetadataModelConfigPersistence } from './metadataModelConfigPersistence';
import { getReasoningEffortLabel } from '../../../ai/reasoningLabels';
import {
  normalizeReasoningEfforts,
  normalizeReasoningEffortValue,
} from '../../../../services/reasoningCatalog';
import {
  SettingsCollectionHeader,
  SettingsSearchEmpty,
  useSettingsSearch,
} from '../../search/SettingsSearch';

const getErrorMessage = (error: unknown, fallback: string): string => {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return fallback;
};

const MANUAL_MODEL_MENU_WIDTH = 168;
const MANUAL_MODEL_MENU_HEIGHT = 88;
const MANUAL_MODEL_MENU_GAP = 6;
const MANUAL_MODEL_MENU_VIEWPORT_PADDING = 12;
const STANDARD_REASONING_EFFORTS: ReasoningEffort[] = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

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

const formatContextWindowTokens = (tokens?: number): string | null => {
  if (!tokens || !Number.isFinite(tokens)) return null;
  if (tokens >= 1_000_000) {
    return `${Number((tokens / 1_000_000).toFixed(1)).toLocaleString()}m`;
  }
  if (tokens >= 1_000) {
    return `${Math.round(tokens / 1_000).toLocaleString()}k`;
  }
  return tokens.toLocaleString();
};

const parseContextWindowInput = (value: string): number | null => {
  const normalized = value.replace(/[,_\s]/g, '');
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : null;
};

export const ModelsSettings: React.FC = () => {
  const { t } = useTranslation();
  const setSettingsTab = useAppStore((state) => state.setSettingsTab);
  const { matches, query } = useSettingsSearch();
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
    setProviderModelContextWindowOverride,
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
  const [manualReasoningConfigurable, setManualReasoningConfigurable] = useState(false);
  const [manualReasoningEfforts, setManualReasoningEfforts] = useState<ReasoningEffort[]>([]);
  const [manualDefaultReasoningEffort, setManualDefaultReasoningEffort] =
    useState<ReasoningEffort | null>(null);
  const [manualCustomReasoningEffort, setManualCustomReasoningEffort] = useState('');
  const [contextWindowEditor, setContextWindowEditor] = useState<{
    providerId: string;
    modelId: string;
    label: string;
    currentTokens?: number;
    source?: string;
  } | null>(null);
  const [contextWindowInput, setContextWindowInput] = useState('');
  const [isSavingManualModel, setIsSavingManualModel] = useState(false);
  const [isDeletingManualModel, setIsDeletingManualModel] = useState(false);
  const [isSavingContextWindow, setIsSavingContextWindow] = useState(false);
  const [openProviderIds, setOpenProviderIds] = useState<string[]>([]);
  const [metadataModelConfig, setMetadataModelConfig] = useState<MetadataModelConfig | null>(null);
  const manualModelActionsRef = useRef<HTMLDivElement | null>(null);
  const manualModelActionsTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [metadataModelConfigPersistence] = useState(
    () => new MetadataModelConfigPersistence({
      save: saveMetadataModelConfig,
      applyConfig: setMetadataModelConfig,
      onSaveError: (error) => {
        notify.error(
          getErrorMessage(error, t('models.metadataPreferenceSaveFailed', 'Failed to save metadata model preference'))
        );
      },
    })
  );

  const handleProviderSettingsChange = async (
    providerId: string,
    updates: Parameters<typeof updateProviderSettings>[1]
  ) => {
    try {
      await updateProviderSettings(providerId, updates);
    } catch (error) {
      notify.error(
        getErrorMessage(error, t('models.updateFailed', 'Failed to save model settings'))
      );
    }
  };

  const handleProviderModelEnabledChange = async (
    providerId: string,
    modelId: string,
    enabled: boolean
  ) => {
    try {
      await setProviderModelEnabled(providerId, modelId, enabled);
    } catch (error) {
      notify.error(
        getErrorMessage(error, t('models.updateFailed', 'Failed to update model'))
      );
    }
  };

  const handleAllProviderModelsEnabledChange = async (providerId: string, enabled: boolean) => {
    try {
      await setAllProviderModelsEnabled(providerId, enabled);
    } catch (error) {
      notify.error(
        getErrorMessage(error, t('models.updateFailed', 'Failed to update models'))
      );
    }
  };

  const providers = providerConfigs;
  const filteredProviderModels = providers.flatMap((provider) => {
    const allModels = modelsByProvider[provider.id] || [];
    const showFreeOnly =
      provider.providerType === 'openrouter' && providerSettingsById[provider.id]?.filterFreeModels;
    const models = showFreeOnly ? allModels.filter((model) => model.isFree) : allModels;
    const providerMatches = matches(provider.name, provider.id, provider.providerType);
    const matchingModels = providerMatches
      ? models
      : models.filter((model) =>
          matches(
            model.name,
            model.id,
            model.provider_id,
            model.description,
            model.owned_by,
            ...(model.capabilities ?? [])
          )
        );
    return providerMatches || matchingModels.length > 0
      ? [{ provider, models: matchingModels }]
      : [];
  });
  const hasSearchResults = filteredProviderModels.length > 0;
  const enabledCommitProviders = providers.filter((provider) => providerHasCredentials(provider));
  const normalizedMetadataModelConfig = normalizeMetadataModelConfig(metadataModelConfig, {
    providerConfigs: enabledCommitProviders,
    modelsByProvider,
    getAvailableReasoningEfforts,
  });
  const activeMetadataModelConfig = normalizedMetadataModelConfig ?? metadataModelConfig;
  const dedicatedCommitProviderId = activeMetadataModelConfig?.mode === 'dedicated'
    ? activeMetadataModelConfig.providerId
    : enabledCommitProviders[0]?.id ?? '';
  const dedicatedCommitModels = dedicatedCommitProviderId
    ? (modelsByProvider[dedicatedCommitProviderId] || []).filter((model) => model.isEnabled !== false)
    : [];
  const dedicatedCommitModelId = activeMetadataModelConfig?.mode === 'dedicated'
    ? activeMetadataModelConfig.modelId
    : dedicatedCommitModels[0]?.id ?? '';
  const dedicatedCommitReasoningEfforts = resolveMetadataModelReasoningEfforts(
    dedicatedCommitProviderId || null,
    dedicatedCommitModelId || null,
    {
      providerConfigs: enabledCommitProviders,
      modelsByProvider,
      getAvailableReasoningEfforts,
    }
  );
  const isMetadataReasoningUnavailable = dedicatedCommitReasoningEfforts.length === 0;
  const isEditingManualModel =
    manualModelEditor !== null && manualModelEditor.originalModelId !== null;
  const manualCustomReasoningCandidate = normalizeReasoningEffortValue(
    manualCustomReasoningEffort.trim()
  );
  const getContextWindowSourceLabel = (source?: AIModel['contextWindowSource']): string => {
    switch (source) {
      case 'user_override':
        return t('models.contextWindowSourceUser', 'Set');
      case 'provider_metadata':
      case 'model_metadata':
        return t('models.contextWindowSourceProvider', 'Provider');
      case 'models_dev':
        return t('models.contextWindowSourceCatalog', 'Catalog');
      case 'provider_overflow_error':
        return t('models.contextWindowSourceLearned', 'Learned');
      case 'macro_fallback':
      default:
        return t('models.contextWindowSourceEstimated', 'Estimated');
    }
  };

  useEffect(() => {
    let disposed = false;
    const hydrationVersion = metadataModelConfigPersistence.getVersion();
    void loadMetadataModelConfig()
      .then((modelConfig) => {
        if (!disposed) metadataModelConfigPersistence.hydrate(modelConfig, hydrationVersion);
      })
      .catch((error) => {
        if (!disposed) {
          notify.error(
            getErrorMessage(error, t('models.metadataPreferenceLoadFailed', 'Failed to load metadata model preference'))
          );
        }
      });
    return () => {
      disposed = true;
    };
  }, [metadataModelConfigPersistence, t]);

  useEffect(() => {
    const unsubscribe = subscribeMetadataModelConfig((config) => {
      metadataModelConfigPersistence.acceptExternal(config);
    });
    return unsubscribe;
  }, [metadataModelConfigPersistence]);

  const saveCommitModelConfig = useCallback((config: MetadataModelConfig) => {
    void metadataModelConfigPersistence.persist(config);
  }, [metadataModelConfigPersistence]);

  useEffect(() => {
    if (!metadataModelConfig || !normalizedMetadataModelConfig) return;
    if (metadataModelConfigsEqual(metadataModelConfig, normalizedMetadataModelConfig)) {
      return;
    }
    saveCommitModelConfig(normalizedMetadataModelConfig);
  }, [normalizedMetadataModelConfig, saveCommitModelConfig, metadataModelConfig]);

  const closeManualModelEditor = () => {
    setManualModelEditor(null);
    setManualModelId('');
    setManualModelName('');
    setManualReasoningConfigurable(false);
    setManualReasoningEfforts([]);
    setManualDefaultReasoningEffort(null);
    setManualCustomReasoningEffort('');
  };

  const resetManualModelEditor = () => {
    if (isSavingManualModel) return;
    closeManualModelEditor();
  };

  const openAddManualModel = (providerId: string) => {
    setManualModelEditor({ providerId, originalModelId: null });
    setManualModelId('');
    setManualModelName('');
    setManualReasoningConfigurable(false);
    setManualReasoningEfforts([]);
    setManualDefaultReasoningEffort(null);
    setManualCustomReasoningEffort('');
    setActiveManualModelActions(null);
  };

  const openEditManualModel = (providerId: string, model: AIModel) => {
    const manualCapability = model.reasoningCapability?.source === 'manual_override'
      ? model.reasoningCapability
      : null;
    setManualModelEditor({ providerId, originalModelId: model.id });
    setManualModelId(model.id);
    setManualModelName(model.name === model.id ? '' : model.name);
    setManualReasoningConfigurable(!!manualCapability?.configurable);
    setManualReasoningEfforts(manualCapability?.reasoningEfforts ?? []);
    setManualDefaultReasoningEffort(manualCapability?.defaultReasoningEffort ?? null);
    setManualCustomReasoningEffort('');
    setActiveManualModelActions(null);
  };

  const addManualReasoningEffort = (effort: ReasoningEffort) => {
    if (!effort || manualReasoningEfforts.includes(effort)) return;
    const nextEfforts = normalizeReasoningEfforts([...manualReasoningEfforts, effort]);
    setManualReasoningEfforts(nextEfforts);
    setManualDefaultReasoningEffort((current) => current ?? nextEfforts[0]);
  };

  const removeManualReasoningEffort = (effort: ReasoningEffort) => {
    const nextEfforts = manualReasoningEfforts.filter((candidate) => candidate !== effort);
    setManualReasoningEfforts(nextEfforts);
    setManualDefaultReasoningEffort((current) =>
      current === effort ? nextEfforts[0] ?? null : current
    );
  };

  const moveManualReasoningEffort = (index: number, direction: -1 | 1) => {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= manualReasoningEfforts.length) return;
    const currentEffort = manualReasoningEfforts[index];
    const adjacentEffort = manualReasoningEfforts[nextIndex];
    if (
      STANDARD_REASONING_EFFORTS.includes(currentEffort) ||
      STANDARD_REASONING_EFFORTS.includes(adjacentEffort)
    ) {
      return;
    }
    const nextEfforts = [...manualReasoningEfforts];
    [nextEfforts[index], nextEfforts[nextIndex]] = [nextEfforts[nextIndex], nextEfforts[index]];
    setManualReasoningEfforts(nextEfforts);
  };

  const closeContextWindowEditor = () => {
    setContextWindowEditor(null);
    setContextWindowInput('');
  };

  const openContextWindowEditor = (
    providerId: string,
    model: AIModel,
  ) => {
    setContextWindowEditor({
      providerId,
      modelId: model.id,
      label: model.name || model.id,
      currentTokens: model.contextWindowTokens,
      source: model.contextWindowSource,
    });
    setContextWindowInput(model.contextWindowTokens ? String(model.contextWindowTokens) : '');
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
      <SettingsEmptyState
        className="animate-in fade-in duration-300"
        icon="layers"
        title={t('models.noProvidersTitle', 'Add a provider before adding models')}
        description={t('models.noProviders', 'Models must be connected to a configured provider.')}
        action={<Button onClick={() => setSettingsTab('providers')}>
          <Icon name="plus" size={14} className="mr-2" />
          {t('providers.add', 'Add Provider')}
        </Button>}
      />
    );
  }

  return (
    <div className="space-y-4 animate-in fade-in duration-300">
      <section
          id="metadata-generation-model-settings"
          data-settings-section="metadata-generation"
          className="rounded-xl border border-border bg-card px-4 py-4"
        >
        <div className="flex flex-col gap-4">
          <div>
            <h3 className="text-sm font-semibold text-foreground">
              {t('models.metadataGenerationTitle', 'Metadata generation')}
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              {t(
                'models.metadataGenerationDescription',
                'Choose which model Macro uses for generated commit messages, plan names, conversation titles, summaries, and feature slugs.'
              )}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-2 rounded-lg border border-border bg-muted/20 p-1">
            <button
              type="button"
              className={cn(
                'rounded-md px-3 py-2 text-sm transition-colors',
                activeMetadataModelConfig?.mode !== 'dedicated'
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground'
              )}
              onClick={() => saveCommitModelConfig({ mode: 'conversation' })}
            >
              {t('models.metadataUseConversationModel', 'Use conversation model')}
            </button>
            <button
              type="button"
              className={cn(
                'rounded-md px-3 py-2 text-sm transition-colors',
                activeMetadataModelConfig?.mode === 'dedicated'
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
                  reasoningEffort: activeMetadataModelConfig?.mode === 'dedicated'
                    ? activeMetadataModelConfig.reasoningEffort
                    : null,
                });
              }}
            >
              {t('models.metadataUseDedicatedModel', 'Use dedicated model')}
            </button>
          </div>

          {activeMetadataModelConfig?.mode === 'dedicated' && (
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
              <label className={cn(
                'space-y-1.5',
                isMetadataReasoningUnavailable && 'text-muted-foreground opacity-60'
              )}>
                <span className="text-xs font-medium text-muted-foreground">
                  {t('models.reasoningEffort', 'Reasoning')}
                </span>
                <select
                  aria-label={t('models.reasoningEffort', 'Reasoning')}
                  className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground disabled:cursor-not-allowed disabled:border-border disabled:bg-muted disabled:text-muted-foreground"
                  value={activeMetadataModelConfig.reasoningEffort ?? ''}
                  onChange={(event) => {
                    if (!dedicatedCommitProviderId || !dedicatedCommitModelId) return;
                    saveCommitModelConfig({
                      mode: 'dedicated',
                      providerId: dedicatedCommitProviderId,
                      modelId: dedicatedCommitModelId,
                      reasoningEffort: event.target.value ? event.target.value as ReasoningEffort : null,
                    });
                  }}
                  disabled={isMetadataReasoningUnavailable}
                >
                  <option value="">{t('models.defaultReasoning', 'Default')}</option>
                  {dedicatedCommitReasoningEfforts.map((effort) => (
                    <option key={effort} value={effort}>
                      {getReasoningEffortLabel(t, effort)}
                    </option>
                  ))}
                </select>
                {isMetadataReasoningUnavailable && (
                  <span className="block text-xs text-muted-foreground">
                    {t('models.reasoningUnavailable', 'Not supported by this model')}
                  </span>
                )}
              </label>
            </div>
          )}

        </div>
      </section>

      <SettingsCollectionHeader
        title={t('models.collectionTitle', 'Models')}
        description={t('models.collectionDescription', 'Manage models by provider')}
        searchPlaceholder={t('models.searchPlaceholder', 'Search models...')}
        className="pt-2"
      />

      {!hasSearchResults && (
        <SettingsSearchEmpty
          message={t('models.noModelsFiltered', 'No models match the current filter.')}
        />
      )}

      {filteredProviderModels.length > 0 && (
        <Accordion
          type="multiple"
          value={query.trim() ? filteredProviderModels.map(({ provider }) => provider.id) : openProviderIds}
          onValueChange={setOpenProviderIds}
          className="space-y-3"
        >
          {filteredProviderModels.map(({ provider, models }) => {
          const settings = providerSettingsById[provider.id];
          const showFreeOnly = provider.providerType === 'openrouter' && settings?.filterFreeModels;
          const filteredModels = models;
          const allProviderModels = modelsByProvider[provider.id] || [];
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
                          total: allProviderModels.length,
                          enabled: allProviderModels.filter((model) => model.isEnabled !== false).length,
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
                            aria-label={t('models.freeOnly', 'Free only')}
                            onCheckedChange={(checked) => {
                              void handleProviderSettingsChange(provider.id, {
                                filterFreeModels: checked,
                              });
                            }}
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
                                handleProviderModelEnabledChange(provider.id, model.id, true)
                              )
                            );
                            return;
                          }
                          await handleAllProviderModelsEnabledChange(provider.id, true);
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
                                handleProviderModelEnabledChange(provider.id, model.id, false)
                              )
                            );
                            return;
                          }
                          await handleAllProviderModelsEnabledChange(provider.id, false);
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
                          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                            <span>
                              {t('models.contextWindowLabel', 'Context')}:{' '}
                              <span className="font-medium text-foreground">
                                {formatContextWindowTokens(model.contextWindowTokens) ??
                                  t('models.contextWindowUnknown', 'Estimated')}
                              </span>
                            </span>
                            <span className="rounded border border-border/60 px-1.5 py-0.5">
                              {getContextWindowSourceLabel(model.contextWindowSource)}
                            </span>
                            <button
                              type="button"
                              className="rounded px-1.5 py-0.5 text-primary transition-colors hover:bg-primary/10"
                              onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                openContextWindowEditor(provider.id, model);
                              }}
                            >
                              {model.contextWindowSource === 'user_override'
                                ? t('models.contextWindowEdit', 'Edit')
                                : t('models.contextWindowSet', 'Set')}
                            </button>
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          <Switch
                            checked={model.isEnabled !== false}
                            aria-label={t('common.enable', 'Enable')}
                            onCheckedChange={(checked) => {
                              void handleProviderModelEnabledChange(provider.id, model.id, checked);
                            }}
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
      )}

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
              onClick={() => {
                const model = modelsByProvider[activeManualModelActions.providerId]?.find(
                  (candidate) => candidate.id === activeManualModelActions.modelId
                );
                if (model) openEditManualModel(activeManualModelActions.providerId, model);
              }}
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

              <div className="space-y-3 rounded-lg border border-border bg-muted/20 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <label className="text-sm font-medium">
                      {t('models.configurableReasoning', 'Configurable reasoning')}
                    </label>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {t(
                        'models.configurableReasoningDescription',
                        'Set the reasoning levels accepted by this model.'
                      )}
                    </p>
                  </div>
                  <Switch
                    checked={manualReasoningConfigurable}
                    aria-label={t('models.configurableReasoning', 'Configurable reasoning')}
                    onCheckedChange={(checked) => {
                      setManualReasoningConfigurable(checked);
                    }}
                  />
                </div>

                {manualReasoningConfigurable && (
                  <div className="space-y-3 border-t border-border pt-3">
                    <fieldset className="space-y-2">
                      <legend className="text-xs font-medium text-muted-foreground">
                        {t('models.standardReasoningLevels', 'Standard levels')}
                      </legend>
                      <div className="flex flex-wrap gap-x-3 gap-y-2">
                        {STANDARD_REASONING_EFFORTS.map((effort) => (
                          <label key={effort} className="flex items-center gap-1.5 text-xs">
                            <input
                              type="checkbox"
                              checked={manualReasoningEfforts.includes(effort)}
                              onChange={(event) => {
                                if (event.target.checked) addManualReasoningEffort(effort);
                                else removeManualReasoningEffort(effort);
                              }}
                            />
                            {getReasoningEffortLabel(t, effort)}
                          </label>
                        ))}
                      </div>
                    </fieldset>

                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-muted-foreground">
                        {t('models.customReasoningLevel', 'Custom level')}
                      </label>
                      <div className="flex gap-2">
                        <Input
                          value={manualCustomReasoningEffort}
                          onChange={(event) => setManualCustomReasoningEffort(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key !== 'Enter') return;
                            event.preventDefault();
                            if (!manualCustomReasoningCandidate) return;
                            addManualReasoningEffort(manualCustomReasoningCandidate);
                            setManualCustomReasoningEffort('');
                          }}
                          placeholder={t('models.customReasoningLevelPlaceholder', 'e.g. ultra')}
                          className="font-mono text-sm"
                        />
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={!manualCustomReasoningCandidate}
                          onClick={() => {
                            if (!manualCustomReasoningCandidate) return;
                            addManualReasoningEffort(manualCustomReasoningCandidate);
                            setManualCustomReasoningEffort('');
                          }}
                        >
                          {t('common.add', 'Add')}
                        </Button>
                      </div>
                      {manualCustomReasoningEffort.trim() && !manualCustomReasoningCandidate && (
                        <p className="text-xs text-destructive">
                          {t(
                            'models.invalidCustomReasoningLevel',
                            'Use letters, numbers, dots, underscores, or hyphens.'
                          )}
                        </p>
                      )}
                    </div>

                    {manualReasoningEfforts.length > 0 ? (
                      <div className="space-y-2">
                        <label className="text-xs font-medium text-muted-foreground">
                          {t('models.reasoningLevelOrder', 'Level order')}
                        </label>
                        <div className="space-y-1">
                          {manualReasoningEfforts.map((effort, index) => (
                            <div
                              key={effort}
                              className="flex items-center gap-2 rounded-md border border-border bg-background px-2 py-1.5"
                            >
                              <span className="min-w-0 flex-1 truncate font-mono text-xs">
                                {getReasoningEffortLabel(t, effort)}
                              </span>
                              <button
                                type="button"
                                aria-label={t('models.moveReasoningLevelUp', 'Move level up')}
                                className="text-muted-foreground disabled:opacity-30"
                                disabled={
                                  index === 0 ||
                                  STANDARD_REASONING_EFFORTS.includes(effort) ||
                                  STANDARD_REASONING_EFFORTS.includes(
                                    manualReasoningEfforts[index - 1]
                                  )
                                }
                                onClick={() => moveManualReasoningEffort(index, -1)}
                              >
                                <Icon name="arrow-up" size={13} />
                              </button>
                              <button
                                type="button"
                                aria-label={t('models.moveReasoningLevelDown', 'Move level down')}
                                className="text-muted-foreground disabled:opacity-30"
                                disabled={
                                  index === manualReasoningEfforts.length - 1 ||
                                  STANDARD_REASONING_EFFORTS.includes(effort) ||
                                  STANDARD_REASONING_EFFORTS.includes(
                                    manualReasoningEfforts[index + 1]
                                  )
                                }
                                onClick={() => moveManualReasoningEffort(index, 1)}
                              >
                                <Icon name="chevron-down" size={13} />
                              </button>
                              <button
                                type="button"
                                aria-label={t('models.removeReasoningLevel', 'Remove level')}
                                className="text-destructive"
                                onClick={() => removeManualReasoningEffort(effort)}
                              >
                                <Icon name="x" size={13} />
                              </button>
                            </div>
                          ))}
                        </div>

                        <label className="block space-y-1.5">
                          <span className="text-xs font-medium text-muted-foreground">
                            {t('models.defaultReasoningLevel', 'Default level')}
                          </span>
                          <select
                            aria-label={t('models.defaultReasoningLevel', 'Default level')}
                            className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground"
                            value={manualDefaultReasoningEffort ?? ''}
                            onChange={(event) =>
                              setManualDefaultReasoningEffort(event.target.value as ReasoningEffort)
                            }
                          >
                            {manualReasoningEfforts.map((effort) => (
                              <option key={effort} value={effort}>
                                {getReasoningEffortLabel(t, effort)}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                    ) : (
                      <p className="text-xs text-amber-700 dark:text-amber-300">
                        {t(
                          'models.reasoningLevelRequired',
                          'Add at least one reasoning level.'
                        )}
                      </p>
                    )}
                  </div>
                )}
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
                  const reasoning = manualReasoningConfigurable
                    ? {
                        reasoningEfforts: manualReasoningEfforts,
                        defaultReasoningEffort: manualDefaultReasoningEffort,
                      }
                    : null;
                  setIsSavingManualModel(true);
                  try {
                    if (manualModelEditor.originalModelId) {
                      await updateManualModel(
                        manualModelEditor.providerId,
                        manualModelEditor.originalModelId,
                        modelId,
                        name,
                        reasoning
                      );
                      notify.success(t('models.modelUpdated', 'Model updated successfully'));
                    } else {
                      await addManualModel(manualModelEditor.providerId, modelId, name, reasoning);
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
                disabled={
                  !manualModelId.trim() ||
                  (manualReasoningConfigurable &&
                    (manualReasoningEfforts.length === 0 || !manualDefaultReasoningEffort))
                }
              >
                {isEditingManualModel ? t('common.save', 'Save') : t('models.addModel', 'Add Model')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {contextWindowEditor && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4">
          <div className="flex max-h-[calc(100vh-2rem)] w-full max-w-md flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
            <div className="mb-0 flex shrink-0 items-center justify-between border-b border-border px-5 py-4">
              <div className="min-w-0">
                <h4 className="text-base font-semibold">
                  {t('models.contextWindowTitle', 'Context window')}
                </h4>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  {contextWindowEditor.label}
                </p>
              </div>
              <button
                className="p-1.5 rounded-full hover:bg-muted text-muted-foreground transition-colors"
                onClick={closeContextWindowEditor}
                title={t('common.close', 'Close')}
                disabled={isSavingContextWindow}
              >
                <Icon name="x" size={16} />
              </button>
            </div>

            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
              <div className="space-y-1.5">
                <label className="text-sm font-medium">
                  {t('models.contextWindowTokens', 'Context tokens')}
                </label>
                <Input
                  value={contextWindowInput}
                  onChange={(event) => setContextWindowInput(event.target.value)}
                  placeholder={t('models.contextWindowPlaceholder', 'e.g. 32768')}
                  inputMode="numeric"
                  className="font-mono text-sm"
                />
              </div>
            </div>

            <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-border px-5 py-4">
              <div>
                {contextWindowEditor.source === 'user_override' && (
                  <Button
                    variant="ghost"
                    onClick={async () => {
                      if (isSavingContextWindow) return;
                      setIsSavingContextWindow(true);
                      try {
                        await setProviderModelContextWindowOverride(
                          contextWindowEditor.providerId,
                          contextWindowEditor.modelId,
                          null,
                        );
                        notify.success(
                          t('models.contextWindowResetSuccess', 'Context window reset')
                        );
                        closeContextWindowEditor();
                      } catch (error) {
                        notify.error(
                          getErrorMessage(
                            error,
                            t('models.contextWindowResetFailed', 'Failed to reset context window')
                          )
                        );
                      } finally {
                        setIsSavingContextWindow(false);
                      }
                    }}
                    disabled={isSavingContextWindow}
                  >
                    {t('models.contextWindowReset', 'Reset')}
                  </Button>
                )}
              </div>
              <div className="flex items-center gap-3">
                <Button
                  variant="ghost"
                  onClick={closeContextWindowEditor}
                  disabled={isSavingContextWindow}
                >
                  {t('common.cancel', 'Cancel')}
                </Button>
                <Button
                  isLoading={isSavingContextWindow}
                  onClick={async () => {
                    const tokens = parseContextWindowInput(contextWindowInput);
                    if (!tokens) return;
                    setIsSavingContextWindow(true);
                    try {
                      await setProviderModelContextWindowOverride(
                        contextWindowEditor.providerId,
                        contextWindowEditor.modelId,
                        tokens,
                      );
                      notify.success(
                        t('models.contextWindowSaved', 'Context window saved')
                      );
                      closeContextWindowEditor();
                    } catch (error) {
                      notify.error(
                        getErrorMessage(
                          error,
                          t('models.contextWindowSaveFailed', 'Failed to save context window')
                        )
                      );
                    } finally {
                      setIsSavingContextWindow(false);
                    }
                  }}
                  disabled={!parseContextWindowInput(contextWindowInput)}
                >
                  {t('common.save', 'Save')}
                </Button>
              </div>
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
