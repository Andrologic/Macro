import React, { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useProviderStore } from '../../../stores/useProviderStore';
import { Icon } from '../../ui/Icon';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../../ui/Tabs';
import { ProvidersSettings } from './ai/ProvidersSettings';
import { ModelsSettings } from './ai/ModelsSettings';

export const AIView: React.FC = () => {
  const { t } = useTranslation();
  const {
    providerConfigs,
    loadProviderConfigs,
    loadProviderModels,
  } = useProviderStore();

  useEffect(() => {
    loadProviderConfigs();
  }, [loadProviderConfigs]);

  useEffect(() => {
    providerConfigs.forEach((provider) => {
      loadProviderModels(provider.id);
    });
  }, [providerConfigs, loadProviderModels]);

  return (
    <div className="space-y-6 animate-in fade-in duration-300 h-full flex flex-col">
      <div className="flex flex-col">
        <h2 className="text-xl font-semibold">{t('settings.ai', 'AI & Models')}</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Configure your AI providers, API keys, and manage available models.
        </p>
      </div>

      <Tabs defaultValue="providers" className="flex-1 flex flex-col pt-2 min-h-0">
        <TabsList className="w-full sm:w-auto self-start bg-transparent border-b border-border p-0 gap-4 mb-6 rounded-none h-auto">
          <TabsTrigger 
            value="providers" 
            className="flex items-center gap-2 pb-2 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none px-1"
          >
            <Icon name="server" size={16} />
            Providers
          </TabsTrigger>
          <TabsTrigger 
            value="models" 
            className="flex items-center gap-2 pb-2 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none px-1"
          >
            <Icon name="cpu" size={16} />
            Models
          </TabsTrigger>
        </TabsList>

        <TabsContent value="providers" className="flex-1 overflow-y-auto pr-2 min-h-0 focus-visible:outline-none">
          <ProvidersSettings />
        </TabsContent>

        <TabsContent value="models" className="flex-1 overflow-y-auto pr-2 min-h-0 focus-visible:outline-none">
          <ModelsSettings />
        </TabsContent>
      </Tabs>
    </div>
  );
};
