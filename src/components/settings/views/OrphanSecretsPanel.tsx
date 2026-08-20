import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  configurationDeleteOrphanSecret,
  configurationListOrphanSecrets,
  type OrphanSecretDto,
} from '../../../services/configurationClient';
import { notify } from '../../ui/toastService';

export const OrphanSecretsPanel: React.FC = () => {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<OrphanSecretDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setEntries(await configurationListOrphanSecrets());
    } catch (error) {
      notify.error(t('settings.configuration.orphanSecretsLoadFailed', 'Could not inspect orphaned secrets'), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const remove = async (entry: OrphanSecretDto) => {
    setDeleting(`${entry.secretType}:${entry.id}`);
    try {
      await configurationDeleteOrphanSecret({ id: entry.id, secretType: entry.secretType });
      setEntries((current) => current.filter((candidate) => candidate !== entry));
      notify.success(t('settings.configuration.orphanSecretDeleted', 'Orphaned secret deleted'));
    } catch (error) {
      notify.error(t('settings.configuration.orphanSecretDeleteFailed', 'Could not delete orphaned secret'), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setDeleting(null);
    }
  };

  return (
    <details className="rounded-lg border border-border bg-card p-3">
      <summary className="cursor-pointer text-sm font-semibold text-foreground">
        {t('settings.configuration.orphanSecrets', 'Orphaned secrets')} ({entries.length})
      </summary>
      <p className="mt-2 text-xs text-muted-foreground">
        {t(
          'settings.configuration.orphanSecretsDescription',
          'Secrets are preserved when a provider or integration is removed. Delete them here only when they are no longer needed.',
        )}
      </p>
      {loading ? (
        <p className="mt-3 text-xs text-muted-foreground">{t('common.loading', 'Loading…')}</p>
      ) : entries.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">
          {t('settings.configuration.noOrphanSecrets', 'No orphaned secrets.')}
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {entries.map((entry) => {
            const key = `${entry.secretType}:${entry.id}`;
            return (
              <li key={key} className="flex items-center justify-between gap-3 rounded-md border border-border p-2">
                <div className="min-w-0">
                  <p className="truncate font-mono text-xs text-foreground">{entry.secretRef}</p>
                  <p className="text-[11px] text-muted-foreground">{entry.namespace} · {entry.secretType}</p>
                </div>
                <button
                  type="button"
                  disabled={deleting === key}
                  onClick={() => void remove(entry)}
                  className="h-8 shrink-0 rounded-md border border-destructive/40 px-3 text-xs text-destructive hover:bg-destructive/10 disabled:opacity-50"
                >
                  {t('common.delete', 'Delete')}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </details>
  );
};
