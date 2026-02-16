import React, { useState, useMemo, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useProviderStore } from '../../../stores/useProviderStore';
import { Icon } from '../../ui/Icon';
import { Button } from '../../ui/Button';
import { Input } from '../../ui/Input';
import { Switch } from '../../ui/Switch';
import { ConfirmPromptModal } from '../../ui/ConfirmPromptModal';
import { toast } from '../../ui/Toaster';
import { cn } from '../../../utils/cn';
import type { ProviderConfig } from '../../../types';

interface EditingProvider {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  isEnabled: boolean;
  isLocal: boolean;
  providerType: string;
}

export const AIView: React.FC = () => {
  const { t } = useTranslation();
  const {
    providerConfigs,
    connectionStatus,
    // isLoading,
    loadProviderConfigs,
    loadProviderModels,
    scanModelsForProvider,
    modelsByProvider,
    providerSettingsById,
    setProviderModelEnabled,
    setAllProviderModelsEnabled,
    addManualModel,
    updateProviderSettings,
    updateProviderConfig,
    createProviderConfig,
    deleteProviderConfig,
    testConnection,
  } = useProviderStore();

  const [searchQuery, setSearchQuery] = useState('');
  const [editingProvider, setEditingProvider] = useState<EditingProvider | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ id: string; success: boolean; message: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [addingModelForProvider, setAddingModelForProvider] = useState<string | null>(null);
  const [manualModelId, setManualModelId] = useState('');
  const [manualModelName, setManualModelName] = useState('');
  const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = useState(false);

  useEffect(() => {
    loadProviderConfigs();
  }, [loadProviderConfigs]);

  useEffect(() => {
    providerConfigs.forEach((provider) => {
      loadProviderModels(provider.id);
    });
  }, [providerConfigs, loadProviderModels]);

  const filteredProviders = useMemo(() => {
    const query = searchQuery.toLowerCase();
    return providerConfigs.filter(
      (p) =>
        p.name.toLowerCase().includes(query) ||
        p.providerType.toLowerCase().includes(query) ||
        p.baseUrl.toLowerCase().includes(query)
    );
  }, [providerConfigs, searchQuery]);

  const getProviderStatus = (provider: ProviderConfig) => {
    if (!provider.isEnabled) {
      return { label: 'Disabled', dot: 'bg-muted-foreground', text: 'text-muted-foreground' };
    }
    if (!provider.apiKey) {
      return { label: 'No key', dot: 'bg-orange-500', text: 'text-orange-600' };
    }
    const status = connectionStatus[provider.id] ?? 'offline';
    if (status === 'checking') {
      return { label: 'Checking', dot: 'bg-blue-500', text: 'text-blue-600' };
    }
    if (status === 'online') {
      return { label: 'Active', dot: 'bg-emerald-500', text: 'text-emerald-600' };
    }
    return { label: 'Offline', dot: 'bg-red-500', text: 'text-red-600' };
  };

  const handleEdit = (config: ProviderConfig) => {
    setEditingProvider({
      id: config.id,
      name: config.name,
      baseUrl: config.baseUrl,
      apiKey: config.apiKey || '',
      isEnabled: config.isEnabled,
      isLocal: config.isLocal,
      providerType: config.providerType,
    });
    setIsCreating(false);
    setTestResult(null);
  };

  const handleCreate = () => {
    setEditingProvider({
      id: '',
      name: '',
      baseUrl: '',
      apiKey: '',
      isEnabled: true,
      isLocal: false,
      providerType: 'openai',
    });
    setIsCreating(true);
    setTestResult(null);
  };

  const handleSave = async () => {
    if (!editingProvider) return;
    setSaving(true);

    try {
      if (isCreating) {
        await createProviderConfig({
          name: editingProvider.name,
          baseUrl: editingProvider.baseUrl,
          apiKey: editingProvider.apiKey,
          isEnabled: editingProvider.isEnabled,
          isLocal: editingProvider.isLocal,
          providerType: editingProvider.providerType,
        });
        toast.success(t('providers.created') || 'Provider created');
      } else {
        await updateProviderConfig(editingProvider.id, {
          name: editingProvider.name,
          baseUrl: editingProvider.baseUrl,
          apiKey: editingProvider.apiKey,
          isEnabled: editingProvider.isEnabled,
          isLocal: editingProvider.isLocal,
          providerType: editingProvider.providerType,
        });
        toast.success(t('providers.updated') || 'Provider updated');
      }
      setEditingProvider(null);
      setIsCreating(false);
    } catch (error) {
      console.error('Failed to save provider:', error);
      toast.error(t('errors.saveFailed') || 'Failed to save provider');
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    if (!editingProvider) return;
    setTestingId('current');
    setTestResult(null);
    try {
        // We need to test the current state, but testConnection usually takes an ID.
        // If it's a new provider, we can't test it easily via store unless store supports testing a config object.
        // Assuming store only supports testing by ID for now, or we save first.
        // For simplicity, let's say we must save first OR the store has checkConnection method.
        // Checking ProviderStore usually: testConnection(id).
        
        if (isCreating) {
             toast.error("Please save the provider before testing.");
             return;
        }

        const response = await testConnection(editingProvider.id);
        const result = {
            id: editingProvider.id,
            success: response.success,
            message: response.message
        };
        setTestResult(result);

    } catch (error) {
         setTestResult({
            id: editingProvider.id || 'new',
            success: false,
            message: 'Connection failed'
        });
    } finally {
        setTestingId(null);
    }
  };
  
  const handleDelete = async () => {
      if(!editingProvider || isCreating) return;
      await deleteProviderConfig(editingProvider.id);
      setEditingProvider(null);
      setIsDeleteConfirmOpen(false);
      toast.success("Provider deleted");
    }

  if (editingProvider) {
    return (
      <div className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-300">
        <div className="flex items-center justify-between pb-4 border-b border-border">
          <div className="flex items-center gap-2">
             <button onClick={() => setEditingProvider(null)} className="p-1 hover:bg-muted rounded-full">
                 <Icon name="arrow-left" size={18} />
             </button>
             <h3 className="text-lg font-medium">
               {isCreating ? (t('providers.add') || 'Add Provider') : (t('providers.edit') || 'Edit Provider')}
             </h3>
          </div>
          <div className="flex items-center gap-2">
             {!isCreating && (
                 <Button variant="ghost" className="text-destructive hover:text-destructive hover:bg-destructive/10" onClick={() => setIsDeleteConfirmOpen(true)}>
                     <Icon name="trash" size={16} className="mr-2" />
                     {t('common.delete') || 'Delete'}
                 </Button>
             )}
          </div>
        </div>

        <div className="space-y-4 max-w-xl">
            <div className="space-y-1">
                <label className="text-sm font-medium">Name</label>
                <Input 
                    value={editingProvider.name} 
                    onChange={(e) => setEditingProvider({...editingProvider, name: e.target.value})}
                    placeholder="e.g. OpenAI, Local Mistral"
                />
            </div>
            
             <div className="grid grid-cols-2 gap-4">
                 <div className="space-y-1">
                    <label className="text-sm font-medium">Type</label>
                    <select 
                        className="w-full h-9 rounded-md border border-input bg-background px-3 py-1 text-sm"
                        value={editingProvider.providerType}
                        onChange={(e) => setEditingProvider({...editingProvider, providerType: e.target.value})}
                    >
                        <option value="openai">OpenAI Compatible</option>
                        <option value="anthropic">Anthropic</option>
                        <option value="gemini">Google Gemini</option>
                        <option value="ollama">Ollama</option>
                        <option value="lmstudio">LM Studio</option>
                    </select>
                 </div>
                  <div className="space-y-1">
                     <label className="text-sm font-medium">Status</label>
                     <div className="flex items-center h-9 px-1">
                        <span className="mr-3 text-sm text-muted-foreground">{editingProvider.isEnabled ? 'Enabled' : 'Disabled'}</span>
                        <Switch 
                            checked={editingProvider.isEnabled} 
                            onCheckedChange={(c) => setEditingProvider({...editingProvider, isEnabled: c})} 
                        />
                     </div>
                 </div>
            </div>

            <div className="space-y-1">
                <label className="text-sm font-medium">Base URL</label>
                <Input 
                    value={editingProvider.baseUrl} 
                    onChange={(e) => setEditingProvider({...editingProvider, baseUrl: e.target.value})}
                    placeholder="https://api.openai.com/v1"
                />
            </div>

            <div className="space-y-1">
                <label className="text-sm font-medium">API Key</label>
                <Input 
                    type="password"
                    value={editingProvider.apiKey} 
                    onChange={(e) => setEditingProvider({...editingProvider, apiKey: e.target.value})}
                    placeholder="sk-..."
                />
            </div>

            {testResult && (
                <div className={cn("p-3 rounded-md text-sm", testResult.success ? "bg-emerald-500/10 text-emerald-500" : "bg-destructive/10 text-destructive")}>
                    <div className="flex items-center gap-2">
                        <Icon name={testResult.success ? "check" : "alert-circle"} size={16} />
                        {testResult.message}
                    </div>
                </div>
            )}

            <div className="flex items-center justify-end gap-3 pt-4">
                <Button variant="secondary" onClick={handleTest} isLoading={testingId === 'current'}>
                    Test Connection
                </Button>
                <Button onClick={handleSave} isLoading={saving}>
                    Save Provider
                </Button>
            </div>
        </div>

        <ConfirmPromptModal
          isOpen={isDeleteConfirmOpen}
          title={t('common.delete', 'Delete')}
          description={t('common.confirmDelete') || 'Are you sure?'}
          confirmLabel={t('common.delete', 'Delete')}
          cancelLabel={t('common.cancel', 'Cancel')}
          confirmVariant="error"
          onCancel={() => setIsDeleteConfirmOpen(false)}
          onConfirm={() => {
            void handleDelete();
          }}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-300">
       <div className="flex items-center justify-between">
           <div className="relative w-64">
               <Icon name="search" size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
               <Input 
                   className="pl-9" 
                   placeholder="Search providers..." 
                   value={searchQuery}
                   onChange={(e) => setSearchQuery(e.target.value)}
               />
           </div>
           
           <Button onClick={handleCreate}>
               <Icon name="plus" size={16} className="mr-2" />
               {t('providers.add') || 'Add Provider'}
           </Button>
       </div>

       <div className="grid grid-cols-1 gap-3">
           {filteredProviders.map(provider => {
               const status = getProviderStatus(provider);
               const models = modelsByProvider[provider.id] || [];
               const settings = providerSettingsById[provider.id];
               const showFreeOnly = provider.providerType === 'openrouter' && settings?.filterFreeModels;
               const filteredModels = showFreeOnly
                 ? models.filter((model) => model.isFree)
                 : models;
               const hasKey = !!provider.apiKey;

               return (
                 <div key={provider.id} className="bg-card border border-border rounded-xl">
                   <div className="flex items-center justify-between p-4">
                     <div className="flex items-center gap-4">
                         <div className={cn(
                             "w-10 h-10 rounded-lg flex items-center justify-center",
                             provider.isEnabled ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
                         )}>
                             <Icon name="cpu" size={20} />
                         </div>
                         <div>
                             <h4 className="font-medium text-foreground">{provider.name}</h4>
                             <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                 <span className="capitalize">{provider.providerType}</span>
                                 <span>•</span>
                                 <span>{provider.baseUrl}</span>
                             </div>
                         </div>
                     </div>
                     
                     <div className="flex items-center gap-3">
                          <div className="flex items-center gap-1.5 px-2 py-1 bg-muted/50 rounded-md">
                              <div className={cn("w-2 h-2 rounded-full", status.dot)} />
                              <span className={cn("text-xs font-medium", status.text)}>{status.label}</span>
                          </div>
                          <Button variant="ghost" size="sm" onClick={() => handleEdit(provider)}>
                              Edit
                          </Button>
                     </div>
                   </div>

                   <div className="border-t border-border px-4 py-3">
                     <div className="flex items-center justify-between mb-3">
                       <div>
                         <h5 className="text-sm font-medium">Models</h5>
                         <p className="text-xs text-muted-foreground">
                           {models.length} total • {models.filter((m) => m.isEnabled !== false).length} enabled
                         </p>
                       </div>
                       <div className="flex items-center gap-2">
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => {
                            setAddingModelForProvider(provider.id);
                            setManualModelId('');
                            setManualModelName('');
                          }}
                        >
                          <Icon name="plus" size={14} className="mr-1" />
                          Add model
                        </Button>
                         {provider.providerType === 'openrouter' && (
                           <div className="flex items-center gap-2 pr-2 border-r border-border">
                             <span className="text-xs text-muted-foreground">Free only</span>
                             <Switch
                               checked={!!settings?.filterFreeModels}
                               onCheckedChange={(checked) =>
                                 updateProviderSettings(provider.id, { filterFreeModels: checked })
                               }
                             />
                           </div>
                         )}
                         <Button
                           variant="secondary"
                           size="sm"
                           onClick={async () => {
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
                           Enable all
                         </Button>
                         <Button
                           variant="secondary"
                           size="sm"
                           onClick={async () => {
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
                           Disable all
                         </Button>
                         <Button
                           variant="ghost"
                           size="sm"
                           onClick={() => scanModelsForProvider(provider.id)}
                           disabled={!hasKey}
                         >
                           Refresh
                         </Button>
                       </div>
                     </div>

                     <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                       {filteredModels.map((model) => (
                         <div key={model.id} className="flex items-center justify-between p-2 rounded-md border border-border/60 bg-muted/30">
                           <div>
                             <div className="flex items-center gap-2">
                               <span className="text-sm font-medium text-foreground">{model.name || model.id}</span>
                               {model.isFree && (
                                 <span className="px-2 py-0.5 text-[10px] rounded-full bg-emerald-500/10 text-emerald-600">
                                   Free
                                 </span>
                               )}
                             </div>
                             <div className="text-xs text-muted-foreground">{model.id}</div>
                           </div>
                           <Switch
                             checked={model.isEnabled !== false}
                             onCheckedChange={(checked) => setProviderModelEnabled(provider.id, model.id, checked)}
                           />
                         </div>
                       ))}

                       {filteredModels.length === 0 && (
                         <div className="text-xs text-muted-foreground py-3">
                           {models.length === 0
                             ? hasKey
                               ? 'No models yet. Refresh to scan.'
                               : 'Add an API key to scan models.'
                             : 'No models match the current filter.'}
                         </div>
                       )}
                     </div>
                   </div>
                 </div>
               );
           })}

           {filteredProviders.length === 0 && (
               <div className="text-center py-12 text-muted-foreground">
                   <Icon name="search" size={32} className="mx-auto mb-3 opacity-50" />
                   <p>No providers found matching your search.</p>
               </div>
           )}
       </div>
      {addingModelForProvider && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-md rounded-lg border border-border bg-card p-4 shadow-xl">
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-sm font-medium">Add model</h4>
              <button
                className="p-1 rounded-full hover:bg-muted"
                onClick={() => setAddingModelForProvider(null)}
              >
                <Icon name="x" size={16} />
              </button>
            </div>
            <div className="space-y-3">
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Model ID</label>
                <Input
                  value={manualModelId}
                  onChange={(e) => setManualModelId(e.target.value)}
                  placeholder="e.g. zai-large-32k"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Display name</label>
                <Input
                  value={manualModelName}
                  onChange={(e) => setManualModelName(e.target.value)}
                  placeholder="Optional (defaults to model id)"
                />
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 pt-4">
              <Button variant="ghost" onClick={() => setAddingModelForProvider(null)}>
                Cancel
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
                }}
                disabled={!manualModelId.trim()}
              >
                Add
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
