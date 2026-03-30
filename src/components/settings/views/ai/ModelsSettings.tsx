import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { providerHasCredentials, useProviderStore } from '../../../../stores/useProviderStore';
import { Icon } from '../../../ui/Icon';
import { Button } from '../../../ui/Button';
import { Input } from '../../../ui/Input';
import { Switch } from '../../../ui/Switch';
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from '../../../ui/Accordion';
import { toast } from '../../../ui/Toaster';
import { cn } from '../../../../utils/cn';

const getErrorMessage = (error: unknown, fallback: string): string => {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return fallback;
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
    updateProviderSettings,
    scanModelsForProvider,
  } = useProviderStore();

  const [addingModelForProvider, setAddingModelForProvider] = useState<string | null>(null);
  const [manualModelId, setManualModelId] = useState('');
  const [manualModelName, setManualModelName] = useState('');

  const providers = providerConfigs;

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
                          setAddingModelForProvider(provider.id);
                          setManualModelId('');
                          setManualModelName('');
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
                            toast.success(t('models.modelsRefreshed', 'Models refreshed'));
                          } catch (error) {
                            toast.error(
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
                        className="flex items-center justify-between p-3 rounded-md border border-border/60 bg-muted/20 hover:bg-muted/40 transition-colors"
                      >
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-foreground">
                              {model.name || model.id}
                            </span>
                            {model.isFree && (
                              <span className="px-2 py-0.5 text-[10px] rounded-full bg-emerald-500/10 text-emerald-600 border border-emerald-500/20">
                                {t('models.freeBadge', 'Free')}
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-muted-foreground mt-0.5 font-mono">
                            {model.id}
                          </div>
                        </div>
                        <Switch
                          checked={model.isEnabled !== false}
                          onCheckedChange={(checked) =>
                            setProviderModelEnabled(provider.id, model.id, checked)
                          }
                        />
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

      {addingModelForProvider && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-xl border border-border bg-card p-5 shadow-2xl">
            <div className="flex items-center justify-between mb-4">
              <h4 className="text-base font-semibold">
                {t('models.addCustomTitle', 'Add Custom Model')}
              </h4>
              <button
                className="p-1.5 rounded-full hover:bg-muted text-muted-foreground transition-colors"
                onClick={() => setAddingModelForProvider(null)}
                title={t('common.close', 'Close')}
              >
                <Icon name="x" size={16} />
              </button>
            </div>

            <div className="space-y-4">
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

            <div className="flex items-center justify-end gap-3 pt-6">
              <Button variant="ghost" onClick={() => setAddingModelForProvider(null)}>
                {t('common.cancel', 'Cancel')}
              </Button>
              <Button
                onClick={async () => {
                  const modelId = manualModelId.trim();
                  if (!modelId) return;
                  const name = manualModelName.trim() || modelId;
                  await addManualModel(addingModelForProvider, modelId, name);
                  setAddingModelForProvider(null);
                  setManualModelId('');
                  setManualModelName('');
                  toast.success(t('models.modelAdded', 'Model added successfully'));
                }}
                disabled={!manualModelId.trim()}
              >
                {t('models.addModel', 'Add Model')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
