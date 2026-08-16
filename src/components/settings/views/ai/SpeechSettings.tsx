import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SpeechProviderConfig } from '../../../../types';
import { useSpeechToTextStore } from '../../../../stores/useSpeechToTextStore';
import { Icon } from '../../../ui/Icon';
import { notify } from '../../../ui/toastService';
import { cn } from '../../../../utils/cn';
import { ConfirmPromptModal } from '../../../ui/ConfirmPromptModal';
import { AndrologicProviderIcon } from '../../../ai/AndrologicProviderIcon';
import { MACRO_AI_SPEECH_PROVIDER_ID } from '../../../../config/macroAi';

interface ProviderDraft {
  id: string | null;
  name: string;
  providerType: 'openai-compatible' | 'deepgram';
  baseUrl: string;
  model: string;
  apiKey: string;
  removeApiKey: boolean;
  isLocal: boolean;
  isEnabled: boolean;
}

const EMPTY_DRAFT: ProviderDraft = {
  id: null,
  name: '',
  providerType: 'openai-compatible',
  baseUrl: '',
  model: 'whisper-1',
  apiKey: '',
  removeApiKey: false,
  isLocal: false,
  isEnabled: true,
};

const draftFromProvider = (provider: SpeechProviderConfig): ProviderDraft => ({
  id: provider.id,
  name: provider.name,
  providerType: provider.providerType === 'deepgram' ? 'deepgram' : 'openai-compatible',
  baseUrl: provider.baseUrl,
  model: provider.model,
  apiKey: '',
  removeApiKey: false,
  isLocal: provider.isLocal,
  isEnabled: provider.isEnabled,
});

export const SpeechSettings: React.FC = () => {
  const { t } = useTranslation();
  const {
    providers,
    selectedProviderId,
    language,
    maxDurationSeconds,
    isLoading,
    error,
    initialize,
    selectProvider,
    setLanguage,
    setMaxDurationSeconds,
    createProvider,
    updateProvider,
    deleteProvider,
  } = useSpeechToTextStore();
  const [draft, setDraft] = useState<ProviderDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [providerToDelete, setProviderToDelete] = useState<SpeechProviderConfig | null>(null);
  const [deleting, setDeleting] = useState(false);
  const selectedProvider = useMemo(
    () => providers.find((provider) => provider.id === selectedProviderId) ?? null,
    [providers, selectedProviderId],
  );
  const isManagedProvider = (provider: SpeechProviderConfig) =>
    provider.id === MACRO_AI_SPEECH_PROVIDER_ID;

  useEffect(() => {
    void initialize();
  }, [initialize]);

  const saveDraft = async () => {
    if (!draft || !draft.name.trim() || !draft.baseUrl.trim() || !draft.model.trim()) {
      notify.error(t('speech.settings.validation', 'Name, endpoint and model are required.'));
      return;
    }
    setSaving(true);
    try {
      const input = {
        name: draft.name.trim(),
        providerType: draft.providerType,
        baseUrl: draft.baseUrl.trim().replace(/\/+$/, ''),
        model: draft.model.trim(),
        ...(draft.removeApiKey ? { apiKey: '' } : draft.apiKey ? { apiKey: draft.apiKey } : {}),
        isLocal: draft.isLocal,
        isEnabled: draft.isEnabled,
      };
      if (draft.id) await updateProvider(draft.id, input);
      else await createProvider(input);
      setDraft(null);
      notify.success(t('speech.settings.saved', 'Speech provider saved.'));
    } catch (error) {
      notify.error(t('speech.settings.saveFailed', 'Unable to save the speech provider.'), {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setSaving(false);
    }
  };

  const deleteSelectedProvider = async () => {
    if (!providerToDelete) return;
    setDeleting(true);
    try {
      await deleteProvider(providerToDelete.id);
      setProviderToDelete(null);
      notify.success(t('speech.settings.deleted', 'Speech provider deleted.'));
    } catch (deleteError) {
      notify.error(t('speech.settings.deleteFailed', 'Unable to delete the speech provider.'), {
        description: deleteError instanceof Error ? deleteError.message : undefined,
      });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-border bg-card/60 p-4">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h4 className="font-semibold text-foreground">
              {t('speech.settings.title', 'Microphone dictation')}
            </h4>
            <p className="mt-1 text-sm text-muted-foreground">
              {t(
                'speech.settings.description',
                'Record from the composer, transcribe with the selected provider, then review the text before sending.',
              )}
            </p>
          </div>
          <Icon name="mic" size={20} className="text-primary" />
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <label className="space-y-1.5 text-sm">
            <span className="text-muted-foreground">{t('speech.settings.activeProvider', 'Active provider')}</span>
            <select
              value={selectedProviderId ?? ''}
              onChange={(event) => void selectProvider(event.target.value || null)}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-foreground"
            >
              <option value="">{t('speech.settings.noProvider', 'No provider')}</option>
              {providers.filter((provider) => provider.isEnabled).map((provider) => (
                <option key={provider.id} value={provider.id}>{provider.name}</option>
              ))}
            </select>
          </label>
          <label className="space-y-1.5 text-sm">
            <span className="text-muted-foreground">{t('speech.settings.language', 'Language')}</span>
            <select
              value={language}
              onChange={(event) => void setLanguage(event.target.value)}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-foreground"
            >
              <option value="auto">{t('speech.settings.autoLanguage', 'Automatic')}</option>
              <option value="fr">Français</option>
              <option value="en">English</option>
              <option value="de">Deutsch</option>
              <option value="es">Español</option>
              <option value="ja">日本語</option>
              <option value="ko">한국어</option>
            </select>
          </label>
          <label className="space-y-1.5 text-sm">
            <span className="text-muted-foreground">
              {t('speech.settings.maxDuration', 'Maximum recording duration')}
            </span>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={10}
                max={selectedProviderId === MACRO_AI_SPEECH_PROVIDER_ID ? 120 : 600}
                value={maxDurationSeconds}
                onChange={(event) => void setMaxDurationSeconds(Number(event.target.value))}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-foreground"
              />
              <span className="text-muted-foreground">s</span>
            </div>
          </label>
          <div className="rounded-lg border border-border bg-background/50 p-3 text-xs text-muted-foreground">
            {!selectedProvider
              ? t(
                  'speech.settings.noProviderPrivacy',
                  'Select a provider to see where recorded audio will be sent.',
                )
              : selectedProvider.isLocal
              ? t(
                  'speech.settings.localPrivacy',
                  'Local or keyless provider: audio is sent to the configured endpoint without requiring an API key.',
                )
              : t('speech.settings.remotePrivacy', 'Remote provider: recorded audio is sent to its configured endpoint.')}
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h4 className="font-semibold text-foreground">{t('speech.settings.providers', 'Speech providers')}</h4>
            <p className="text-sm text-muted-foreground">
              {t('speech.settings.compatibility', 'Supports OpenAI-compatible and Deepgram transcription endpoints.')}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setDraft({ ...EMPTY_DRAFT })}
            className="flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground"
          >
            <Icon name="plus" size={14} />
            {t('speech.settings.addProvider', 'Add provider')}
          </button>
        </div>
        {error && !isLoading ? (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            <span>{error}</span>
            <button
              type="button"
              onClick={() => void initialize()}
              className="shrink-0 rounded-md border border-destructive/30 px-2.5 py-1.5 hover:bg-destructive/10"
            >
              {t('common.retry', 'Retry')}
            </button>
          </div>
        ) : isLoading ? (
          <div className="py-8 text-center text-sm text-muted-foreground">{t('common.loading', 'Loading...')}</div>
        ) : providers.map((provider) => (
          <div key={provider.id} className="flex items-center gap-3 rounded-xl border border-border bg-card/60 p-4">
            <div className={cn('rounded-lg p-2', provider.isLocal ? 'bg-emerald-500/10 text-emerald-500' : 'bg-primary/10 text-primary')}>
              {isManagedProvider(provider)
                ? <AndrologicProviderIcon className="h-[18px] w-[18px]" />
                : <Icon name={provider.isLocal ? 'hard-drive' : 'cloud'} size={18} />}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-medium text-foreground">{provider.name}</span>
                {!provider.isEnabled && <span className="text-xs text-muted-foreground">{t('common.disabled', 'Disabled')}</span>}
              </div>
              <p className="truncate text-xs text-muted-foreground">{provider.model} · {provider.baseUrl}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {isManagedProvider(provider)
                  ? t('speech.settings.included', 'Transcription included with the beta')
                  : provider.hasStoredApiKey
                  ? t('speech.settings.keyStored', 'API key stored locally')
                  : provider.isLocal
                    ? t('speech.settings.noKeyRequired', 'No API key required')
                    : t('speech.settings.keyMissing', 'API key required')}
              </p>
            </div>
            {!isManagedProvider(provider) && (
              <button type="button" onClick={() => setDraft(draftFromProvider(provider))} className="rounded-lg p-2 hover:bg-muted" title={t('common.edit', 'Edit')}>
                <Icon name="edit" size={15} />
              </button>
            )}
            {provider.id !== 'openai-speech' && !isManagedProvider(provider) && (
              <button
                type="button"
                onClick={() => setProviderToDelete(provider)}
                className="rounded-lg p-2 text-destructive hover:bg-destructive/10"
                title={t('common.delete', 'Delete')}
              >
                <Icon name="trash" size={15} />
              </button>
            )}
          </div>
        ))}
      </section>

      {draft && (
        <section className="space-y-4 rounded-xl border border-primary/30 bg-card p-4">
          <div className="flex items-center justify-between">
            <h4 className="font-semibold text-foreground">
              {draft.id ? t('speech.settings.editProvider', 'Edit provider') : t('speech.settings.newProvider', 'New provider')}
            </h4>
            <button type="button" onClick={() => setDraft(null)} className="rounded-lg p-1.5 hover:bg-muted">
              <Icon name="x" size={16} />
            </button>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <label className="space-y-1 text-sm">
              <span>{t('common.name', 'Name')}</span>
              <input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} className="w-full rounded-lg border border-border bg-background px-3 py-2" />
            </label>
            <label className="space-y-1 text-sm">
              <span>{t('speech.settings.protocol', 'Protocol')}</span>
              <select
                value={draft.providerType}
                onChange={(event) => {
                  const providerType = event.target.value as ProviderDraft['providerType'];
                  setDraft({
                    ...draft,
                    providerType,
                    ...(!draft.id
                      ? providerType === 'deepgram'
                        ? { baseUrl: 'https://api.deepgram.com', model: 'nova-3' }
                        : { baseUrl: '', model: 'whisper-1' }
                      : {}),
                  });
                }}
                className="w-full rounded-lg border border-border bg-background px-3 py-2"
              >
                <option value="openai-compatible">OpenAI-compatible</option>
                <option value="deepgram">Deepgram</option>
              </select>
            </label>
            <label className="space-y-1 text-sm">
              <span>{t('speech.settings.model', 'Transcription model')}</span>
              <input value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })} className="w-full rounded-lg border border-border bg-background px-3 py-2" />
            </label>
            <label className="space-y-1 text-sm md:col-span-2">
              <span>{t('speech.settings.endpoint', 'Base URL')}</span>
              <input value={draft.baseUrl} onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} placeholder="https://api.example.com/v1" className="w-full rounded-lg border border-border bg-background px-3 py-2" />
            </label>
            <label className="space-y-1 text-sm md:col-span-2">
              <span>{t('speech.settings.apiKey', 'API key')}</span>
              <input type="password" value={draft.apiKey} onChange={(event) => setDraft({ ...draft, apiKey: event.target.value, removeApiKey: false })} placeholder={draft.id ? t('speech.settings.keepKey', 'Leave empty to keep the stored key') : ''} className="w-full rounded-lg border border-border bg-background px-3 py-2" />
            </label>
          </div>
          <div className="flex flex-wrap gap-5 text-sm">
            <label className="flex items-center gap-2"><input type="checkbox" checked={draft.isLocal} onChange={(event) => setDraft({ ...draft, isLocal: event.target.checked })} />{t('speech.settings.localProvider', 'Local or keyless provider')}</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={draft.isEnabled} onChange={(event) => setDraft({ ...draft, isEnabled: event.target.checked })} />{t('common.enabled', 'Enabled')}</label>
            {draft.id && providers.find((provider) => provider.id === draft.id)?.hasStoredApiKey && (
              <label className="flex items-center gap-2 text-destructive"><input type="checkbox" checked={draft.removeApiKey} onChange={(event) => setDraft({ ...draft, removeApiKey: event.target.checked, apiKey: '' })} />{t('speech.settings.removeKey', 'Remove stored API key')}</label>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setDraft(null)} className="rounded-lg bg-muted px-3 py-2 text-sm">{t('common.cancel', 'Cancel')}</button>
            <button type="button" disabled={saving} onClick={() => void saveDraft()} className="rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50">{saving ? t('common.saving', 'Saving...') : t('common.save', 'Save')}</button>
          </div>
        </section>
      )}

      <ConfirmPromptModal
        isOpen={providerToDelete !== null}
        title={t('speech.settings.deleteTitle', 'Delete speech provider')}
        description={t(
          'speech.settings.deleteConfirm',
          'Delete {{name}} and its locally stored API key?',
          { name: providerToDelete?.name ?? '' },
        )}
        confirmLabel={t('common.delete', 'Delete')}
        cancelLabel={t('common.cancel', 'Cancel')}
        confirmVariant="error"
        isSubmitting={deleting}
        onCancel={() => {
          if (!deleting) setProviderToDelete(null);
        }}
        onConfirm={() => void deleteSelectedProvider()}
      />
    </div>
  );
};
