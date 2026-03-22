import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useProviderStore } from '../../../../stores/useProviderStore';
import { Icon } from '../../../ui/Icon';
import { Button } from '../../../ui/Button';
import { Input } from '../../../ui/Input';
import { Switch } from '../../../ui/Switch';
import { ConfirmPromptModal } from '../../../ui/ConfirmPromptModal';
import { toast } from '../../../ui/Toaster';
import { cn } from '../../../../utils/cn';
import type { ProviderConfig } from '../../../../types';

interface EditingProvider {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  isEnabled: boolean;
  isLocal: boolean;
  providerType: string;
}

const getErrorMessage = (error: unknown, fallback: string): string => {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  return fallback;
};

const providerTypeOptions = [
  { value: 'openai', labelKey: 'providers.types.openaiCompatible', fallback: 'OpenAI Compatible' },
  { value: 'anthropic', labelKey: 'providers.types.anthropic', fallback: 'Anthropic' },
  { value: 'gemini', labelKey: 'providers.types.gemini', fallback: 'Google Gemini' },
  { value: 'ollama', labelKey: 'providers.types.ollama', fallback: 'Ollama' },
  { value: 'lmstudio', labelKey: 'providers.types.lmstudio', fallback: 'LM Studio' },
  { value: 'openrouter', labelKey: 'providers.types.openrouter', fallback: 'OpenRouter' },
];

export const ProvidersSettings: React.FC = () => {
  const { t } = useTranslation();
  const {
    providerConfigs,
    connectionStatus,
    updateProviderConfig,
    createProviderConfig,
    deleteProviderConfig,
    startChatGptAuth,
    authErrorsByProvider,
    disconnectProviderAuth,
    testConnection,
  } = useProviderStore();

  const [searchQuery, setSearchQuery] = useState('');
  const [editingProvider, setEditingProvider] = useState<EditingProvider | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ id: string; success: boolean; message: string } | null>(
    null
  );
  const [saving, setSaving] = useState(false);
  const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = useState(false);

  const filteredProviders = useMemo(() => {
    const query = searchQuery.toLowerCase();
    return providerConfigs.filter(
      (provider) =>
        provider.name.toLowerCase().includes(query) ||
        provider.providerType.toLowerCase().includes(query) ||
        provider.baseUrl.toLowerCase().includes(query)
    );
  }, [providerConfigs, searchQuery]);

  const translateAuthError = (code: string, fallback: string) =>
    t(`providers.authErrors.${code}`, fallback);

  const getProviderStatus = (provider: ProviderConfig) => {
    if (provider.providerType === 'chatgpt') {
      const authStatus = provider.authStatus ?? 'unauthenticated';
      if (authStatus === 'authorizing') {
        return {
          label: t('providers.status.connecting', 'Connecting'),
          dot: 'bg-blue-500',
          text: 'text-blue-600',
        };
      }
      if (authStatus === 'refreshing') {
        return {
          label: t('providers.status.refreshing', 'Refreshing'),
          dot: 'bg-blue-500',
          text: 'text-blue-600',
        };
      }
      if (authStatus === 'authenticated') {
        return {
          label: t('providers.status.linked', 'Linked'),
          dot: 'bg-emerald-500',
          text: 'text-emerald-600',
        };
      }
      if (authStatus === 'expired') {
        return {
          label: t('providers.status.expired', 'Expired'),
          dot: 'bg-amber-500',
          text: 'text-amber-600',
        };
      }
      if (authStatus === 'error') {
        return {
          label: t('providers.status.error', 'Error'),
          dot: 'bg-red-500',
          text: 'text-red-600',
        };
      }
      return {
        label: t('providers.status.notLinked', 'Not linked'),
        dot: 'bg-muted-foreground',
        text: 'text-muted-foreground',
      };
    }

    if (!provider.isEnabled) {
      return {
        label: t('providers.status.disabled', 'Disabled'),
        dot: 'bg-muted-foreground',
        text: 'text-muted-foreground',
      };
    }

    if (!provider.apiKey) {
      return {
        label: t('providers.status.noKey', 'No key'),
        dot: 'bg-orange-500',
        text: 'text-orange-600',
      };
    }

    const status = connectionStatus[provider.id] ?? 'offline';
    if (status === 'checking') {
      return {
        label: t('providers.status.checking', 'Checking'),
        dot: 'bg-blue-500',
        text: 'text-blue-600',
      };
    }
    if (status === 'online') {
      return {
        label: t('providers.status.active', 'Active'),
        dot: 'bg-emerald-500',
        text: 'text-emerald-600',
      };
    }
    return {
      label: t('providers.status.offline', 'Offline'),
      dot: 'bg-red-500',
      text: 'text-red-600',
    };
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
        toast.success(t('providers.created', 'Provider created'));
      } else {
        await updateProviderConfig(editingProvider.id, {
          name: editingProvider.name,
          baseUrl: editingProvider.baseUrl,
          apiKey: editingProvider.apiKey,
          isEnabled: editingProvider.isEnabled,
          isLocal: editingProvider.isLocal,
          providerType: editingProvider.providerType,
        });
        toast.success(t('providers.updated', 'Provider updated'));
      }
      setEditingProvider(null);
      setIsCreating(false);
    } catch (error) {
      console.error('Failed to save provider:', error);
      toast.error(t('errors.saveFailed', 'Failed to save provider'));
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    if (!editingProvider) return;

    setTestingId('current');
    setTestResult(null);
    try {
      if (isCreating) {
        toast.error(t('providers.testSaveFirst', 'Please save the provider before testing.'));
        return;
      }
      const response = await testConnection(editingProvider.id);
      setTestResult({
        id: editingProvider.id,
        success: response.success,
        message: response.message,
      });
    } catch {
      setTestResult({
        id: editingProvider.id || 'new',
        success: false,
        message: t('toast.connectionFailed', 'Connection failed'),
      });
    } finally {
      setTestingId(null);
    }
  };

  const handleDelete = async () => {
    if (!editingProvider || isCreating) return;
    await deleteProviderConfig(editingProvider.id);
    setEditingProvider(null);
    setIsDeleteConfirmOpen(false);
    toast.success(t('providers.deleted', 'Provider deleted'));
  };

  if (editingProvider) {
    return (
      <div className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-300">
        <div className="flex items-center justify-between pb-4 border-b border-border">
          <div className="flex items-center gap-2">
            <button onClick={() => setEditingProvider(null)} className="p-1 hover:bg-muted rounded-full">
              <Icon name="arrow-left" size={18} />
            </button>
            <h3 className="text-lg font-medium">
              {isCreating
                ? t('providers.add', 'Add Provider')
                : t('providers.edit', 'Edit Provider')}
            </h3>
          </div>
          {!isCreating && (
            <Button
              variant="ghost"
              className="text-destructive hover:text-destructive hover:bg-destructive/10"
              onClick={() => setIsDeleteConfirmOpen(true)}
            >
              <Icon name="trash" size={16} className="mr-2" />
              {t('common.delete', 'Delete')}
            </Button>
          )}
        </div>

        <div className="space-y-4 max-w-xl">
          <div className="space-y-1">
            <label className="text-sm font-medium">{t('common.name', 'Name')}</label>
            <Input
              value={editingProvider.name}
              onChange={(event) =>
                setEditingProvider({ ...editingProvider, name: event.target.value })
              }
              placeholder={t('providers.form.namePlaceholder', 'e.g. OpenAI, Local Mistral')}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <label className="text-sm font-medium">{t('common.type', 'Type')}</label>
              <select
                className="w-full h-9 rounded-md border border-input bg-background px-3 py-1 text-sm"
                value={editingProvider.providerType}
                onChange={(event) =>
                  setEditingProvider({ ...editingProvider, providerType: event.target.value })
                }
              >
                {providerTypeOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {t(option.labelKey, option.fallback)}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1">
              <label className="text-sm font-medium">{t('common.status', 'Status')}</label>
              <div className="flex items-center h-9 px-1">
                <span className="mr-3 text-sm text-muted-foreground">
                  {editingProvider.isEnabled
                    ? t('common.enabled', 'Enabled')
                    : t('common.disabled', 'Disabled')}
                </span>
                <Switch
                  checked={editingProvider.isEnabled}
                  onCheckedChange={(checked) =>
                    setEditingProvider({ ...editingProvider, isEnabled: checked })
                  }
                />
              </div>
            </div>
          </div>

          {editingProvider.providerType !== 'chatgpt' && (
            <>
              <div className="space-y-1">
                <label className="text-sm font-medium">
                  {t('providers.form.baseUrlLabel', 'Base URL')}
                </label>
                <Input
                  value={editingProvider.baseUrl}
                  onChange={(event) =>
                    setEditingProvider({ ...editingProvider, baseUrl: event.target.value })
                  }
                  placeholder={t('providers.form.baseUrlPlaceholder', 'https://api.openai.com/v1')}
                />
              </div>

              <div className="space-y-1">
                <label className="text-sm font-medium">
                  {t('providers.form.apiKeyLabel', 'API Key')}
                </label>
                <Input
                  type="password"
                  value={editingProvider.apiKey}
                  onChange={(event) =>
                    setEditingProvider({ ...editingProvider, apiKey: event.target.value })
                  }
                  placeholder={t('providers.form.apiKeyPlaceholder', 'sk-...')}
                />
              </div>
            </>
          )}

          {testResult && (
            <div
              className={cn(
                'p-3 rounded-md text-sm',
                testResult.success
                  ? 'bg-emerald-500/10 text-emerald-500'
                  : 'bg-destructive/10 text-destructive'
              )}
            >
              <div className="flex items-center gap-2">
                <Icon name={testResult.success ? 'check' : 'alert-circle'} size={16} />
                {testResult.message}
              </div>
            </div>
          )}

          <div className="flex items-center justify-end gap-3 pt-4">
            {editingProvider.providerType !== 'chatgpt' && (
              <Button variant="secondary" onClick={handleTest} isLoading={testingId === 'current'}>
                {t('providers.testConnection', 'Test Connection')}
              </Button>
            )}
            <Button onClick={handleSave} isLoading={saving}>
              {t('providers.saveProvider', 'Save Provider')}
            </Button>
          </div>
        </div>

        <ConfirmPromptModal
          isOpen={isDeleteConfirmOpen}
          title={t('common.delete', 'Delete')}
          description={t('common.confirmDelete', 'Are you sure?')}
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
    <div className="space-y-6 animate-in fade-in duration-300">
      <div className="flex items-center justify-between">
        <div className="relative w-64">
          <Icon
            name="search"
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            className="pl-9"
            placeholder={t('providers.searchPlaceholder', 'Search providers...')}
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
          />
        </div>

        <Button onClick={handleCreate}>
          <Icon name="plus" size={16} className="mr-2" />
          {t('providers.add', 'Add Provider')}
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-3">
        {filteredProviders.map((provider) => {
          const status = getProviderStatus(provider);
          const authError = authErrorsByProvider[provider.id];
          const hasKey =
            provider.providerType === 'chatgpt'
              ? ['authenticated', 'refreshing', 'expired'].includes(provider.authStatus ?? '')
              : !!provider.apiKey;

          if (provider.providerType === 'chatgpt') {
            return (
              <div key={provider.id} className="bg-card border border-border rounded-xl">
                <div className="flex items-center justify-between p-4">
                  <div className="flex items-center gap-4">
                    <div className="w-10 h-10 rounded-lg flex items-center justify-center bg-primary/10 text-primary">
                      <Icon name="cpu" size={20} />
                    </div>
                    <div>
                      <h4 className="font-medium text-foreground">{provider.name}</h4>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span className="capitalize">{provider.providerType}</span>
                        <span>•</span>
                        <span>{provider.baseUrl}</span>
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {provider.accountLabel ||
                          t(
                            'providers.connectBrowserHint',
                            'Connect with ChatGPT in your browser.'
                          )}
                        {provider.planType ? ` • ${provider.planType}` : ''}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-3">
                    <div className="flex items-center gap-1.5 px-2 py-1 bg-muted/50 rounded-md">
                      <div className={cn('w-2 h-2 rounded-full', status.dot)} />
                      <span className={cn('text-xs font-medium', status.text)}>{status.label}</span>
                    </div>

                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={async () => {
                        try {
                          await startChatGptAuth(provider.id);
                          toast.success(t('providers.chatgptLinked', 'ChatGPT linked'));
                        } catch (error) {
                          toast.error(
                            getErrorMessage(
                              error,
                              t(
                                'providers.failedConnectChatGpt',
                                'Failed to connect with ChatGPT'
                              )
                            )
                          );
                        }
                      }}
                      disabled={provider.authStatus === 'authorizing'}
                    >
                      {provider.authStatus === 'authorizing'
                        ? t('providers.connectingChatGpt', 'Connecting…')
                        : t('providers.connectChatGpt', 'Connect with ChatGPT')}
                    </Button>

                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={async () => {
                        try {
                          await disconnectProviderAuth(provider.id);
                          toast.success(
                            t('providers.chatgptDisconnected', 'ChatGPT disconnected')
                          );
                        } catch (error) {
                          toast.error(
                            getErrorMessage(
                              error,
                              t('providers.failedDisconnect', 'Failed to disconnect')
                            )
                          );
                        }
                      }}
                      disabled={!hasKey}
                    >
                      {t('providers.disconnect', 'Disconnect')}
                    </Button>
                  </div>
                </div>

                {authError && (
                  <div className="mx-4 mb-4 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                    {translateAuthError(authError.code, authError.message)}
                  </div>
                )}
              </div>
            );
          }

          return (
            <div key={provider.id} className="bg-card border border-border rounded-xl">
              <div className="flex items-center justify-between p-4">
                <div className="flex items-center gap-4">
                  <div
                    className={cn(
                      'w-10 h-10 rounded-lg flex items-center justify-center',
                      provider.isEnabled
                        ? 'bg-primary/10 text-primary'
                        : 'bg-muted text-muted-foreground'
                    )}
                  >
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
                    <div className={cn('w-2 h-2 rounded-full', status.dot)} />
                    <span className={cn('text-xs font-medium', status.text)}>{status.label}</span>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => handleEdit(provider)}>
                    {t('common.edit', 'Edit')}
                  </Button>
                </div>
              </div>
            </div>
          );
        })}

        {filteredProviders.length === 0 && (
          <div className="text-center py-12 text-muted-foreground">
            <Icon name="search" size={32} className="mx-auto mb-3 opacity-50" />
            <p>{t('providers.noProvidersFound', 'No providers found matching your search.')}</p>
          </div>
        )}
      </div>
    </div>
  );
};
