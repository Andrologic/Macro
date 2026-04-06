import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  isLinkedProviderType,
  providerHasAuthSession,
  useProviderStore,
} from '../../../../stores/useProviderStore';
import { Icon } from '../../../ui/Icon';
import { Button } from '../../../ui/Button';
import { Input } from '../../../ui/Input';
import { Switch } from '../../../ui/Switch';
import { ConfirmPromptModal } from '../../../ui/ConfirmPromptModal';
import { toast } from '../../../ui/toastService';
import { cn } from '../../../../utils/cn';
import type { ProviderConfig } from '../../../../types';

interface EditingProvider {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  hasStoredApiKey: boolean;
  apiKeyLoaded: boolean;
  apiKeyTouched: boolean;
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

const COPILOT_TROUBLESHOOT_DOCS_URL =
  'https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/troubleshoot-copilot-cli-auth';
const COPILOT_DEVICE_FLOW_URL = 'https://github.com/login/device';

const formatBytes = (value: number): string => {
  if (value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const normalized = value / 1024 ** exponent;
  return `${normalized.toFixed(normalized >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
};

const formatCopilotAuthSource = (authSource?: string | null): string | null => {
  if (authSource === 'oauth') return 'Copilot login';
  if (authSource === 'gh-cli') return 'GitHub CLI';
  if (authSource === 'env') return 'environment token';
  if (authSource === 'unknown') return 'another terminal session';
  return null;
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
    copilotStatusByProvider,
    copilotDownloadStateByProvider,
    copilotAuthStateByProvider,
    updateProviderConfig,
    createProviderConfig,
    deleteProviderConfig,
    startChatGptAuth,
    startCopilotRuntimeDownload,
    cancelCopilotRuntimeDownload,
    startCopilotAuth,
    cancelCopilotAuth,
    authErrorsByProvider,
    disconnectProviderAuth,
    testConnection,
    resolveProviderApiKey,
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
  const [refreshingCopilotProviderIds, setRefreshingCopilotProviderIds] = useState<string[]>([]);
  const [revealingProviderId, setRevealingProviderId] = useState<string | null>(null);
  const [showApiKey, setShowApiKey] = useState(false);
  const apiKeyInputRef = React.useRef<HTMLInputElement | null>(null);

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

  const refreshCopilotProviderStatus = useCallback(
    async (providerId: string, options?: { silent?: boolean }) => {
      const silent = options?.silent === true;
      if (!silent) {
        setRefreshingCopilotProviderIds((current) =>
          current.includes(providerId) ? current : [...current, providerId]
        );
      }

      try {
        await testConnection(providerId);
      } catch {
        // The provider card already renders the refreshed status and auth error state.
      } finally {
        if (!silent) {
          setRefreshingCopilotProviderIds((current) =>
            current.filter((currentProviderId) => currentProviderId !== providerId)
          );
        }
      }
    },
    [testConnection]
  );

  const sequentialCopilotProviderIds = useMemo(
    () =>
      providerConfigs
        .filter((provider) => provider.providerType === 'copilot')
        .map((provider) => provider.id),
    [providerConfigs]
  );
  const sequentialCopilotProviderKey = useMemo(
    () => sequentialCopilotProviderIds.join('|'),
    [sequentialCopilotProviderIds]
  );
  const sequentialCopilotProviderIdList = useMemo(
    () => (sequentialCopilotProviderKey ? sequentialCopilotProviderKey.split('|') : []),
    [sequentialCopilotProviderKey]
  );

  useEffect(() => {
    if (sequentialCopilotProviderIdList.length === 0) {
      return;
    }

    sequentialCopilotProviderIdList.forEach((providerId) => {
      void refreshCopilotProviderStatus(providerId, { silent: true });
    });
  }, [refreshCopilotProviderStatus, sequentialCopilotProviderIdList]);

  useEffect(() => {
    if (sequentialCopilotProviderIdList.length === 0) {
      return;
    }

    const refreshOnFocus = () => {
      sequentialCopilotProviderIdList.forEach((providerId) => {
        void refreshCopilotProviderStatus(providerId, { silent: true });
      });
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refreshOnFocus();
      }
    };

    window.addEventListener('focus', refreshOnFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('focus', refreshOnFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [refreshCopilotProviderStatus, sequentialCopilotProviderIdList]);

  useEffect(() => {
    setShowApiKey(false);
  }, [editingProvider?.id]);

  const openExternalDocs = (url: string) => {
    if (typeof window !== 'undefined') {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  };

  const copyToClipboard = useCallback(
    async (value: string, successMessage: string) => {
      if (!value) return;
      try {
        await navigator.clipboard.writeText(value);
        toast.success(successMessage);
      } catch (error) {
        toast.error(getErrorMessage(error, 'Failed to copy'));
      }
    },
    []
  );

  const getProviderStatus = (provider: ProviderConfig) => {
    if (provider.providerType === 'copilot') {
      const runtime = copilotStatusByProvider[provider.id];
      const downloadState = copilotDownloadStateByProvider[provider.id];
      const authState = copilotAuthStateByProvider[provider.id];
      const isRefreshing = refreshingCopilotProviderIds.includes(provider.id);

      if (downloadState) {
        return {
          label: t('providers.status.downloading', 'Downloading'),
          dot: 'bg-blue-500',
          text: 'text-blue-600',
        };
      }

      if (authState) {
        return {
          label: t('providers.status.connecting', 'Connecting'),
          dot: 'bg-blue-500',
          text: 'text-blue-600',
        };
      }

      if (isRefreshing && !runtime) {
        return {
          label: t('providers.status.checking', 'Checking'),
          dot: 'bg-blue-500',
          text: 'text-blue-600',
        };
      }

      if (!runtime || runtime.runtime_status === 'missing') {
        return {
          label: t('providers.status.runtimeMissing', 'Not installed'),
          dot: 'bg-amber-500',
          text: 'text-amber-600',
        };
      }

      if (runtime.runtime_status === 'update_required') {
        return {
          label: t('providers.status.updateRequired', 'Update required'),
          dot: 'bg-amber-500',
          text: 'text-amber-600',
        };
      }

      if (runtime.runtime_status === 'error') {
        return {
          label: t('providers.status.error', 'Error'),
          dot: 'bg-red-500',
          text: 'text-red-600',
        };
      }

      if (runtime.auth_status === 'connected') {
        return {
          label: t('providers.status.connected', 'Connected'),
          dot: 'bg-emerald-500',
          text: 'text-emerald-600',
        };
      }

      if (runtime.auth_status === 'policy_blocked') {
        return {
          label: t('providers.status.policyBlocked', 'Policy blocked'),
          dot: 'bg-red-500',
          text: 'text-red-600',
        };
      }

      if (runtime.auth_status === 'quota_or_auth_error' || runtime.auth_status === 'error') {
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

    if (isLinkedProviderType(provider.providerType)) {
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

      if (authStatus === 'authenticated' || authStatus === 'connected') {
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

      if (authStatus === 'policy_blocked') {
        return {
          label: t('providers.status.policyBlocked', 'Policy blocked'),
          dot: 'bg-red-500',
          text: 'text-red-600',
        };
      }

      if (authStatus === 'quota_or_auth_error' || authStatus === 'error') {
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

    if (!provider.hasStoredApiKey && !provider.apiKey) {
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
      hasStoredApiKey: config.hasStoredApiKey,
      apiKeyLoaded: config.apiKeyLoaded === true,
      apiKeyTouched: false,
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
      hasStoredApiKey: false,
      apiKeyLoaded: true,
      apiKeyTouched: false,
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
        const apiKeyUpdate =
          editingProvider.apiKeyTouched
            ? editingProvider.apiKey
            : undefined;
        await updateProviderConfig(editingProvider.id, {
          name: editingProvider.name,
          baseUrl: editingProvider.baseUrl,
          apiKey: apiKeyUpdate,
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
      if (editingProvider.apiKeyTouched) {
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

  const handleRevealApiKey = async () => {
    if (!editingProvider) return;

    if (editingProvider.apiKeyLoaded) {
      setShowApiKey((current) => !current);
      return;
    }

    if (isCreating || !editingProvider.hasStoredApiKey) {
      return;
    }

    setRevealingProviderId(editingProvider.id);
    try {
      const revealedApiKey = await resolveProviderApiKey(editingProvider.id);
      setEditingProvider((current) =>
        current && current.id === editingProvider.id
          ? {
              ...current,
              apiKey: revealedApiKey || '',
              hasStoredApiKey: !!revealedApiKey,
              apiKeyLoaded: true,
              apiKeyTouched: false,
            }
          : current
      );
      setShowApiKey(true);
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to reveal the stored API key.'));
    } finally {
      setRevealingProviderId(null);
    }
  };

  const handleReplaceApiKey = () => {
    setShowApiKey(false);
    setEditingProvider((current) =>
      current
        ? {
            ...current,
            apiKey: '',
            apiKeyLoaded: true,
            apiKeyTouched: false,
          }
        : current
    );
    queueMicrotask(() => {
      apiKeyInputRef.current?.focus();
    });
  };

  const handleClearStoredApiKey = () => {
    setShowApiKey(false);
    setEditingProvider((current) =>
      current
        ? {
            ...current,
            apiKey: '',
            hasStoredApiKey: false,
            apiKeyLoaded: true,
            apiKeyTouched: true,
          }
        : current
    );
  };

  if (editingProvider) {
    const showLinkedFields = !isLinkedProviderType(editingProvider.providerType);

    return (
      <div className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-300">
        <div className="flex items-center justify-between border-b border-border pb-4">
          <div className="flex items-center gap-2">
            <button onClick={() => setEditingProvider(null)} className="rounded-full p-1 hover:bg-muted">
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
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={() => setIsDeleteConfirmOpen(true)}
            >
              <Icon name="trash" size={16} className="mr-2" />
              {t('common.delete', 'Delete')}
            </Button>
          )}
        </div>

        <div className="max-w-xl space-y-4">
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
                className="h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
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
              <div className="flex h-9 items-center px-1">
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

          {showLinkedFields && (
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
                <div className="space-y-2">
                  <div className="relative">
                    <Input
                      ref={apiKeyInputRef}
                      type={showApiKey ? 'text' : 'password'}
                      value={editingProvider.apiKey}
                      onChange={(event) =>
                        setEditingProvider({
                          ...editingProvider,
                          apiKey: event.target.value,
                          apiKeyLoaded: true,
                          apiKeyTouched: true,
                        })
                      }
                      placeholder={
                        !isCreating &&
                        editingProvider.hasStoredApiKey &&
                        !editingProvider.apiKeyLoaded &&
                        !editingProvider.apiKeyTouched
                          ? t('providers.form.apiKeyStoredPlaceholder', 'Stored in Keychain')
                          : t('providers.form.apiKeyPlaceholder', 'sk-...')
                      }
                      className="pr-10 font-mono"
                    />
                    {(editingProvider.apiKeyLoaded || editingProvider.hasStoredApiKey) && (
                      <button
                        type="button"
                        onClick={() => void handleRevealApiKey()}
                        disabled={revealingProviderId === editingProvider.id}
                        className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                        aria-label={
                          showApiKey
                            ? t('providers.form.hideApiKey', 'Hide API key')
                            : t('providers.form.revealApiKey', 'Reveal API key')
                        }
                        title={
                          showApiKey
                            ? t('providers.form.hideApiKey', 'Hide API key')
                            : t('providers.form.revealApiKey', 'Reveal API key')
                        }
                      >
                        {revealingProviderId === editingProvider.id ? (
                          <Icon name="loader" size={16} className="animate-spin" />
                        ) : (
                          <Icon name={showApiKey ? 'eye-off' : 'eye'} size={16} />
                        )}
                      </button>
                    )}
                  </div>
                  {!isCreating &&
                    editingProvider.hasStoredApiKey &&
                    !editingProvider.apiKeyTouched && (
                      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <span>{t('providers.form.apiKeyStoredHint', 'This key is stored in the system keychain.')}</span>
                        <Button variant="ghost" size="sm" onClick={handleReplaceApiKey}>
                          {t('providers.form.replaceApiKey', 'Replace')}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:text-destructive"
                          onClick={handleClearStoredApiKey}
                        >
                          {t('providers.form.clearApiKey', 'Clear stored key')}
                        </Button>
                      </div>
                    )}
                </div>
              </div>
            </>
          )}

          {testResult && (
            <div
              className={cn(
                'rounded-md p-3 text-sm',
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
            {showLinkedFields && (
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
          const hasLinkedSession = providerHasAuthSession(provider);

          if (isLinkedProviderType(provider.providerType)) {
            const isCopilot = provider.providerType === 'copilot';
            const isRefreshingCopilotStatus =
              isCopilot && refreshingCopilotProviderIds.includes(provider.id);
            const copilotStatus = isCopilot ? copilotStatusByProvider[provider.id] : undefined;
            const copilotDownloadState = isCopilot
              ? copilotDownloadStateByProvider[provider.id]
              : undefined;
            const copilotAuthState = isCopilot ? copilotAuthStateByProvider[provider.id] : undefined;
            const isCopilotDownloading = !!copilotDownloadState;
            const isCopilotAuthorizing = !!copilotAuthState;
            const showDownloadCopilotCta =
              isCopilot &&
              !isCopilotDownloading &&
              !isCopilotAuthorizing &&
              (!copilotStatus ||
                copilotStatus.runtime_status === 'missing' ||
                copilotStatus.runtime_status === 'update_required');
            const showTroubleshootCopilotCta =
              isCopilot &&
              !isCopilotDownloading &&
              !isCopilotAuthorizing &&
              !!copilotStatus &&
              (copilotStatus.runtime_status === 'error' ||
                ['policy_blocked', 'quota_or_auth_error', 'error'].includes(
                  copilotStatus.auth_status
                ));
            const showConnectCopilotCta =
              isCopilot &&
              !isCopilotDownloading &&
              !isCopilotAuthorizing &&
              !!copilotStatus &&
              copilotStatus.runtime_status === 'ready' &&
              copilotStatus.auth_status === 'login_required';
            const showChatGptConnectCta = !isCopilot && !hasLinkedSession;
            const showDisconnectCta = !isCopilot && hasLinkedSession;
            const copilotSourceLabel = formatCopilotAuthSource(copilotStatus?.auth_source);
            const copilotConnectionHint =
              copilotStatus?.auth_source === 'oauth'
                ? t(
                    'providers.copilot.oauthConnectedHint',
                    'Use Copilot CLI on this machine to switch accounts.'
                  )
                : copilotStatus?.auth_source === 'gh-cli'
                  ? t(
                      'providers.copilot.ghCliConnectedHint',
                      'Using the GitHub CLI session available on this machine.'
                    )
                  : copilotStatus?.auth_source === 'env'
                    ? t(
                        'providers.copilot.envConnectedHint',
                        'Using a Copilot token provided by this machine environment.'
                      )
                    : t(
                        'providers.copilot.connectedInTerminalHint',
                        'Connected in this machine terminal session.'
                      );
            const linkedHint = isCopilot
              ? isCopilotDownloading
                ? copilotDownloadState?.totalBytes
                  ? `${copilotDownloadState.message} • ${formatBytes(copilotDownloadState.downloadedBytes)} / ${formatBytes(copilotDownloadState.totalBytes)}`
                  : copilotDownloadState?.message || 'Downloading GitHub Copilot runtime...'
                : isCopilotAuthorizing
                  ? copilotAuthState?.message ||
                    'Finish GitHub Copilot login in your browser with the device code below.'
                  : !copilotStatus || copilotStatus.runtime_status === 'missing'
                    ? t(
                        'providers.copilot.downloadHint',
                        'Download the official GitHub Copilot runtime to continue.'
                      )
                    : copilotStatus.runtime_status === 'update_required'
                      ? copilotStatus.error_message ||
                        t(
                          'providers.copilot.updateHint',
                          'Download a Macro-managed GitHub Copilot runtime to continue.'
                        )
                      : copilotStatus.runtime_status === 'error' || showTroubleshootCopilotCta
                        ? authError?.message ||
                          copilotStatus.error_message ||
                          copilotStatus.status_message ||
                          t(
                            'providers.copilot.troubleshootHint',
                            'GitHub Copilot needs attention before it can be used.'
                          )
                        : copilotStatus.auth_status === 'connected'
                          ? [
                              provider.accountLabel,
                              copilotSourceLabel,
                              copilotConnectionHint,
                            ]
                              .filter(Boolean)
                              .join(' • ')
                          : t(
                              'providers.copilot.connectHint',
                              'Connect GitHub Copilot to finish setup.'
                            )
              : provider.accountLabel ||
                t('providers.connectBrowserHint', 'Connect with ChatGPT in your browser.');
            const showAuthError =
              !!authError &&
              (!isCopilot ||
                showTroubleshootCopilotCta ||
                copilotStatus?.runtime_status === 'error');
            const copilotDownloadProgressPercent =
              copilotDownloadState?.totalBytes && copilotDownloadState.totalBytes > 0
                ? Math.min(
                    100,
                    Math.round(
                      (copilotDownloadState.downloadedBytes / copilotDownloadState.totalBytes) * 100
                    )
                  )
                : null;
            const copilotDeviceUrl = copilotAuthState?.verificationUrl || COPILOT_DEVICE_FLOW_URL;

            return (
              <div key={provider.id} className="rounded-xl border border-border bg-card">
                <div className="flex items-center justify-between p-4">
                  <div className="flex items-center gap-4">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
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
                        {linkedHint}
                        {!isCopilot && provider.planType ? ` • ${provider.planType}` : ''}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-3">
                    <div className="flex items-center gap-1.5 rounded-md bg-muted/50 px-2 py-1">
                      <div className={cn('h-2 w-2 rounded-full', status.dot)} />
                      <span className={cn('text-xs font-medium', status.text)}>{status.label}</span>
                    </div>

                    {isRefreshingCopilotStatus ? (
                      <Button variant="ghost" size="sm" isLoading>
                        {t('providers.status.checking', 'Checking')}
                      </Button>
                    ) : isCopilotDownloading ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void cancelCopilotRuntimeDownload(provider.id)}
                      >
                        {t('common.cancel', 'Cancel')}
                      </Button>
                    ) : showDownloadCopilotCta ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={async () => {
                          try {
                            await startCopilotRuntimeDownload(provider.id);
                            toast.success(
                              t(
                                'providers.copilot.runtimeDownloaded',
                                'GitHub Copilot runtime is ready'
                              )
                            );
                          } catch (error) {
                            const message = getErrorMessage(
                              error,
                              t(
                                'providers.copilot.runtimeDownloadFailed',
                                'Failed to download GitHub Copilot runtime'
                              )
                            );
                            if (message !== 'GitHub Copilot runtime download was cancelled.') {
                              toast.error(message);
                            }
                          }
                        }}
                      >
                        {t('providers.copilot.downloadRuntime', 'Download Copilot')}
                      </Button>
                    ) : showTroubleshootCopilotCta ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openExternalDocs(COPILOT_TROUBLESHOOT_DOCS_URL)}
                      >
                        {t('providers.copilot.troubleshoot', 'Troubleshoot')}
                      </Button>
                    ) : showConnectCopilotCta ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={async () => {
                          try {
                            await startCopilotAuth(provider.id);
                            toast.success(
                              t('providers.copilotLinked', 'GitHub Copilot linked')
                            );
                          } catch (error) {
                            const message = getErrorMessage(
                              error,
                              t(
                                'providers.failedConnectCopilot',
                                'Failed to connect with GitHub Copilot'
                              )
                            );
                            if (message !== 'GitHub Copilot login was cancelled.') {
                              toast.error(message);
                            }
                          }
                        }}
                      >
                        {t('providers.connectCopilot', 'Connect GitHub Copilot')}
                      </Button>
                    ) : showChatGptConnectCta ? (
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
                                t('providers.failedConnectChatGpt', 'Failed to connect with ChatGPT')
                              )
                            );
                          }
                        }}
                      >
                        {provider.authStatus === 'authorizing'
                          ? t('providers.connectingChatGpt', 'Connecting…')
                          : t('providers.connectChatGpt', 'Connect with ChatGPT')}
                      </Button>
                    ) : null}

                    {isCopilot && !isRefreshingCopilotStatus && !isCopilotDownloading ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void refreshCopilotProviderStatus(provider.id)}
                      >
                        {t('providers.copilot.recheckStatus', 'Re-check status')}
                      </Button>
                    ) : null}

                    {showDisconnectCta && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={async () => {
                          try {
                            await disconnectProviderAuth(provider.id);
                            toast.success(
                              isCopilot
                                ? t('providers.copilotDisconnected', 'GitHub Copilot disconnected')
                                : t('providers.chatgptDisconnected', 'ChatGPT disconnected')
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
                        disabled={!hasLinkedSession}
                      >
                        {t('providers.disconnect', 'Disconnect')}
                      </Button>
                    )}
                  </div>
                </div>

                {isCopilotDownloading && copilotDownloadState && (
                  <div className="mx-4 mb-4 rounded-lg border border-border/60 bg-muted/20 p-3">
                    <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                      <span>{copilotDownloadState.message}</span>
                      {copilotDownloadState.totalBytes ? (
                        <span className="font-mono">
                          {formatBytes(copilotDownloadState.downloadedBytes)} /{' '}
                          {formatBytes(copilotDownloadState.totalBytes)}
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-primary transition-all"
                        style={{
                          width:
                            copilotDownloadProgressPercent === null
                              ? '20%'
                              : `${copilotDownloadProgressPercent}%`,
                        }}
                      />
                    </div>
                  </div>
                )}

                {isCopilotAuthorizing && copilotAuthState && (
                  <div className="mx-4 mb-4 rounded-lg border border-primary/20 bg-primary/5 p-3 text-sm">
                    <div className="font-medium text-foreground">
                      {t('providers.copilot.finishLoginTitle', 'Finish login in your browser')}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {copilotAuthState.message}
                    </div>
                    <div className="mt-3 grid gap-3 md:grid-cols-2">
                      <div className="rounded-md border border-border/70 bg-background px-3 py-2">
                        <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                          {t('providers.copilot.deviceCode', 'Device code')}
                        </div>
                        <div className="mt-1 font-mono text-lg text-foreground">
                          {copilotAuthState.userCode || '...'}
                        </div>
                      </div>
                      <div className="rounded-md border border-border/70 bg-background px-3 py-2">
                        <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                          {t('providers.copilot.browserUrl', 'Browser URL')}
                        </div>
                        <div className="mt-1 break-all text-xs text-foreground">
                          {copilotDeviceUrl}
                        </div>
                      </div>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() =>
                          void copyToClipboard(
                            copilotAuthState.userCode || '',
                            t('providers.copilot.codeCopied', 'Device code copied')
                          )
                        }
                        disabled={!copilotAuthState.userCode}
                      >
                        <Icon name="copy" size={14} />
                        {t('providers.copilot.copyCode', 'Copy code')}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openExternalDocs(copilotDeviceUrl)}
                      >
                        <Icon name="external-link" size={14} />
                        {t('providers.copilot.openBrowser', 'Open browser')}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void cancelCopilotAuth(provider.id)}
                      >
                        {t('common.cancel', 'Cancel')}
                      </Button>
                    </div>
                  </div>
                )}

                {showAuthError && authError && (
                  <div className="mx-4 mb-4 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                    {translateAuthError(authError.code, authError.message)}
                  </div>
                )}
              </div>
            );
          }

          return (
            <div key={provider.id} className="rounded-xl border border-border bg-card">
              <div className="flex items-center justify-between p-4">
                <div className="flex items-center gap-4">
                  <div
                    className={cn(
                      'flex h-10 w-10 items-center justify-center rounded-lg',
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
                  <div className="flex items-center gap-1.5 rounded-md bg-muted/50 px-2 py-1">
                    <div className={cn('h-2 w-2 rounded-full', status.dot)} />
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
          <div className="py-12 text-center text-muted-foreground">
            <Icon name="search" size={32} className="mx-auto mb-3 opacity-50" />
            <p>{t('providers.noProvidersFound', 'No providers found matching your search.')}</p>
          </div>
        )}
      </div>
    </div>
  );
};
