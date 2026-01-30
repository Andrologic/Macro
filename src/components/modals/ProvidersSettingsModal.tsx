import React, { useState, useMemo, useEffect } from 'react';
import { useAppStore } from '../../stores/useAppStore';
import { useProviderStore } from '../../stores/useProviderStore';
import { Icon } from '../ui/Icon';
import { Button } from '../ui/Button';
import { cn } from '../../utils/cn';
import type { ProviderConfig } from '../../types';

interface EditingProvider {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  isEnabled: boolean;
  isLocal: boolean;
  providerType: string;
}

export const ProvidersSettingsModal: React.FC = () => {
  const { providersSettingsOpen, closeProvidersSettings } = useAppStore();
  const {
    providerConfigs,
    connectionStatus,
    isLoading,
    loadProviderConfigs,
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

  useEffect(() => {
    if (providersSettingsOpen) {
      loadProviderConfigs();
    }
  }, [providersSettingsOpen, loadProviderConfigs]);

  const filteredProviders = useMemo(() => {
    const query = searchQuery.toLowerCase();
    return providerConfigs.filter(
      (p) =>
        p.name.toLowerCase().includes(query) ||
        p.providerType.toLowerCase().includes(query) ||
        p.baseUrl.toLowerCase().includes(query)
    );
  }, [providerConfigs, searchQuery]);

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
  };

  const handleSave = async () => {
    if (!editingProvider) return;
    setSaving(true);

    try {
      if (isCreating) {
        await createProviderConfig({
          name: editingProvider.name,
          baseUrl: editingProvider.baseUrl,
          apiKey: editingProvider.apiKey || undefined,
          isEnabled: editingProvider.isEnabled,
          isLocal: editingProvider.isLocal,
          providerType: editingProvider.providerType,
        });
      } else {
        await updateProviderConfig(editingProvider.id, {
          name: editingProvider.name,
          baseUrl: editingProvider.baseUrl,
          apiKey: editingProvider.apiKey || undefined,
          isEnabled: editingProvider.isEnabled,
        });
      }
      setEditingProvider(null);
      setIsCreating(false);
    } catch (error) {
      console.error('Failed to save provider:', error);
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async (providerId: string) => {
    setTestingId(providerId);
    setTestResult(null);

    try {
      const result = await testConnection(providerId);
      setTestResult({ id: providerId, ...result });
    } catch (error) {
      setTestResult({
        id: providerId,
        success: false,
        message: error instanceof Error ? error.message : 'Test failed',
      });
    } finally {
      setTestingId(null);
    }
  };

  const handleDelete = async (id: string) => {
    if (confirm('Are you sure you want to delete this provider?')) {
      await deleteProviderConfig(id);
    }
  };

  const handleToggleEnabled = async (config: ProviderConfig) => {
    await updateProviderConfig(config.id, { isEnabled: !config.isEnabled });
  };

  const getStatusIndicator = (id: string, config: ProviderConfig) => {
    const status = connectionStatus[id];
    
    if (status === 'checking') {
      return <div className="w-2.5 h-2.5 rounded-full bg-amber-500 animate-pulse" />;
    }
    if (status === 'online') {
      return <div className="w-2.5 h-2.5 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.4)]" />;
    }
    if (!config.isEnabled) {
      return <div className="w-2.5 h-2.5 rounded-full bg-muted" />;
    }
    return <div className="w-2.5 h-2.5 rounded-full bg-red-500" />;
  };

  if (!providersSettingsOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-md animate-fade-in">
      <div className="w-[700px] max-h-[85vh] bg-card border border-border rounded-2xl shadow-2xl flex flex-col overflow-hidden ring-1 ring-white/5">
        
        {/* Header */}
        <header className="shrink-0 border-b border-border bg-card/50">
          <div className="flex items-center justify-between px-6 py-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center text-primary">
                <Icon name="cpu" size={20} />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-foreground">AI Providers</h2>
                <p className="text-xs text-muted-foreground">Configure API keys and endpoints</p>
              </div>
            </div>
            <button
              onClick={closeProvidersSettings}
              className="p-2 rounded-lg hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
            >
              <Icon name="x" size={18} />
            </button>
          </div>

          {/* Search & Add */}
          <div className="px-6 pb-4 flex items-center gap-3">
            <div className="relative flex-1 group">
              <Icon name="search" size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground group-focus-within:text-foreground transition-colors" />
              <input
                type="text"
                placeholder="Search providers..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full bg-muted border border-border rounded-lg pl-9 pr-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/50 transition-all"
              />
            </div>
            <Button variant="primary" size="sm" onClick={handleCreate}>
              <Icon name="plus" size={14} />
              Add Provider
            </Button>
          </div>
        </header>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3 custom-scrollbar">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Icon name="loader" size={24} className="animate-spin text-muted-foreground" />
            </div>
          ) : filteredProviders.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <Icon name="cpu" size={32} className="mx-auto mb-3 opacity-50" />
              <p className="text-sm">No providers configured</p>
              <p className="text-xs mt-1">Add a provider to get started</p>
            </div>
          ) : (
            filteredProviders.map((config) => (
              <div
                key={config.id}
                className={cn(
                  'group flex items-center gap-4 p-4 rounded-xl border transition-all duration-200',
                  config.isEnabled
                    ? 'bg-card/80 border-border hover:border-primary/30'
                    : 'bg-muted/30 border-border/50 opacity-60'
                )}
              >
                {/* Status & Icon */}
                <div className="relative">
                  <div className={cn(
                    'w-10 h-10 rounded-lg flex items-center justify-center',
                    config.isLocal ? 'bg-purple-500/10 text-purple-400' : 'bg-primary/10 text-primary'
                  )}>
                    <Icon name={config.isLocal ? 'hard-drive' : 'cloud'} size={18} />
                  </div>
                  <div className="absolute -bottom-0.5 -right-0.5">
                    {getStatusIndicator(config.id, config)}
                  </div>
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-foreground">{config.name}</span>
                    {config.isLocal && (
                      <span className="px-1.5 py-0.5 text-[10px] font-medium bg-purple-500/10 text-purple-400 rounded">
                        LOCAL
                      </span>
                    )}
                    {!config.apiKey && !config.isLocal && (
                      <span className="px-1.5 py-0.5 text-[10px] font-medium bg-amber-500/10 text-amber-400 rounded">
                        NO KEY
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground truncate mt-0.5">
                    {config.baseUrl}
                  </p>
                  {testResult?.id === config.id && (
                    <p className={cn(
                      'text-xs mt-1',
                      testResult.success ? 'text-emerald-400' : 'text-red-400'
                    )}>
                      {testResult.message}
                    </p>
                  )}
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={() => handleTest(config.id)}
                    disabled={testingId === config.id}
                    className="p-2 rounded-lg hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
                    title="Test connection"
                  >
                    {testingId === config.id ? (
                      <Icon name="loader" size={14} className="animate-spin" />
                    ) : (
                      <Icon name="zap" size={14} />
                    )}
                  </button>
                  <button
                    onClick={() => handleEdit(config)}
                    className="p-2 rounded-lg hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
                    title="Edit"
                  >
                    <Icon name="edit" size={14} />
                  </button>
                  <button
                    onClick={() => handleToggleEnabled(config)}
                    className="p-2 rounded-lg hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
                    title={config.isEnabled ? 'Disable' : 'Enable'}
                  >
                    <Icon name={config.isEnabled ? 'eye' : 'eye-off'} size={14} />
                  </button>
                  <button
                    onClick={() => handleDelete(config.id)}
                    className="p-2 rounded-lg hover:bg-red-500/10 text-muted-foreground hover:text-red-400 transition-colors"
                    title="Delete"
                  >
                    <Icon name="trash" size={14} />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Edit/Create Panel */}
        {editingProvider && (
          <div className="shrink-0 border-t border-border bg-card/80 px-6 py-4">
            <div className="flex items-center gap-2 mb-4">
              <Icon name={isCreating ? 'plus' : 'edit'} size={16} className="text-primary" />
              <h3 className="font-medium text-foreground">
                {isCreating ? 'Add New Provider' : `Edit ${editingProvider.name}`}
              </h3>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
                  Name
                </label>
                <input
                  type="text"
                  value={editingProvider.name}
                  onChange={(e) => setEditingProvider({ ...editingProvider, name: e.target.value })}
                  placeholder="My Provider"
                  className="w-full bg-muted border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/50"
                />
              </div>

              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
                  Type
                </label>
                <select
                  value={editingProvider.providerType}
                  onChange={(e) => setEditingProvider({ ...editingProvider, providerType: e.target.value })}
                  className="w-full bg-muted border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary/50"
                  disabled={!isCreating}
                >
                  <option value="openai">OpenAI Compatible (z.ai, etc.)</option>
                  <option value="anthropic">Anthropic</option>
                  <option value="openrouter">OpenRouter</option>
                  <option value="ollama">Ollama</option>
                  <option value="lmstudio">LM Studio</option>
                </select>
              </div>

              <div className="col-span-2">
                <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
                  Base URL
                </label>
                <input
                  type="text"
                  value={editingProvider.baseUrl}
                  onChange={(e) => setEditingProvider({ ...editingProvider, baseUrl: e.target.value })}
                  placeholder="https://api.example.com/v1"
                  className="w-full bg-muted border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/50 font-mono"
                />
              </div>

              <div className="col-span-2">
                <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
                  API Key {editingProvider.isLocal && <span className="text-muted-foreground/50">(optional for local)</span>}
                </label>
                <input
                  type="password"
                  value={editingProvider.apiKey}
                  onChange={(e) => setEditingProvider({ ...editingProvider, apiKey: e.target.value })}
                  placeholder="sk-..."
                  className="w-full bg-muted border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/50 font-mono"
                />
              </div>

              {isCreating && (
                <div className="col-span-2">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={editingProvider.isLocal}
                      onChange={(e) => setEditingProvider({ ...editingProvider, isLocal: e.target.checked })}
                      className="rounded border-border"
                    />
                    <span className="text-sm text-foreground">Local provider (Ollama, LM Studio, etc.)</span>
                  </label>
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 mt-4">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setEditingProvider(null);
                  setIsCreating(false);
                }}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={handleSave}
                disabled={saving || !editingProvider.name || !editingProvider.baseUrl}
              >
                {saving ? (
                  <Icon name="loader" size={14} className="animate-spin" />
                ) : (
                  <Icon name="check" size={14} />
                )}
                {isCreating ? 'Add Provider' : 'Save Changes'}
              </Button>
            </div>
          </div>
        )}

        {/* Footer */}
        <footer className="shrink-0 border-t border-border bg-card/50 px-6 py-3 flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            {providerConfigs.filter((p) => p.isEnabled).length} of {providerConfigs.length} providers enabled
          </p>
          <Button variant="secondary" size="sm" onClick={closeProvidersSettings}>
            Done
          </Button>
        </footer>
      </div>
    </div>
  );
};
