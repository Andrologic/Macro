import React, { useEffect, useMemo, useState } from 'react';
import { openPath } from '@tauri-apps/plugin-opener';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../../stores/useAppStore';
import {
  selectConfigDiagnostics,
  useConfigStore,
} from '../../../stores/useConfigStore';
import {
  configOpenDirectory,
  isTauriAvailable,
} from '../../../services/tauriIpc';
import { configurationValidateDocument } from '../../../services/configurationClient';
import type {
  ConfigDiagnostic,
  ConfigDocument,
  ConfigDocumentKind,
  ConfigScope,
} from '../../../types/generated/config';
import { Icon } from '../../ui/Icon';
import { notify } from '../../ui/toastService';
import { OrphanSecretsPanel } from './OrphanSecretsPanel';

const USER_DOCUMENTS: ConfigDocumentKind[] = [
  'runtime',
  'settings',
  'agents',
  'providers',
  'tools',
  'skills',
  'git',
];

const PROJECT_DOCUMENTS = new Set<ConfigDocumentKind>(['agents', 'tools', 'skills', 'git']);

const formatJson = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const scopeMatches = (left: ConfigScope, right: ConfigScope): boolean =>
  left.type === right.type &&
  (left.type !== 'project' || (right.type === 'project' && left.projectId === right.projectId));

export const ConfigurationView: React.FC = () => {
  const { t } = useTranslation();
  const standaloneProjects = useAppStore((state) => state.standaloneProjects);
  const projectGroups = useAppStore((state) => state.projectGroups);
  const snapshot = useConfigStore((state) => state.snapshot);
  const pendingChanges = useConfigStore((state) => state.pendingChanges);
  const getDocument = useConfigStore((state) => state.getDocument);
  const patch = useConfigStore((state) => state.patch);
  const reloadDocument = useConfigStore((state) => state.reloadDocument);
  const acceptPendingChange = useConfigStore((state) => state.acceptPendingChange);
  const rejectPendingChange = useConfigStore((state) => state.rejectPendingChange);
  const [kind, setKind] = useState<ConfigDocumentKind>('settings');
  const [projectId, setProjectId] = useState('');
  const [document, setDocument] = useState<ConfigDocument | null>(null);
  const [draft, setDraft] = useState('');
  const [diagnostics, setDiagnostics] = useState<ConfigDiagnostic[]>([]);
  const [busy, setBusy] = useState(false);

  const uniqueProjects = useMemo(
    () => Array.from(new Map([
      ...(standaloneProjects ?? []),
      ...projectGroups.flatMap((group) => group.projects),
    ].filter((project) => project.path).map((project) => [project.id, project])).values()),
    [projectGroups, standaloneProjects],
  );
  const scope = useMemo<ConfigScope>(
    () => projectId ? { type: 'project', projectId } : { type: 'user' },
    [projectId],
  );
  const availableKinds = projectId
    ? USER_DOCUMENTS.filter((candidate) => PROJECT_DOCUMENTS.has(candidate))
    : USER_DOCUMENTS;

  useEffect(() => {
    if (projectId && !PROJECT_DOCUMENTS.has(kind)) setKind('agents');
  }, [kind, projectId]);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    void getDocument(kind, scope)
      .then((nextDocument) => {
        if (cancelled) return;
        setDocument(nextDocument);
        setDraft(formatJson(nextDocument.value));
        setDiagnostics(nextDocument.diagnostics);
      })
      .catch((error) => {
        if (!cancelled) notify.error(t('settings.configuration.loadFailed', 'Could not load configuration'), {
          description: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [getDocument, kind, scope, t]);

  const parseDraft = (): unknown => {
    try {
      return JSON.parse(draft) as unknown;
    } catch (error) {
      throw new Error(t('settings.configuration.invalidJson', 'Invalid JSON: {{message}}', {
        message: error instanceof Error ? error.message : String(error),
      }));
    }
  };

  const handleValidate = async () => {
    try {
      const result = await configurationValidateDocument({ kind, scope, document: parseDraft() });
      setDiagnostics(result.diagnostics);
      if (result.valid) notify.success(t('settings.configuration.valid', 'Configuration is valid'));
      else notify.error(t('settings.configuration.validationFailed', 'Configuration is invalid'));
    } catch (error) {
      notify.error(t('settings.configuration.validationFailed', 'Configuration is invalid'), {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const handleSave = async () => {
    if (!document) return;
    setBusy(true);
    try {
      const result = await patch({
        kind,
        scope,
        expectedEtag: document.etag,
        patch: [{ op: 'replace', path: '', value: parseDraft() }],
      });
      setDocument(result.document);
      setDraft(formatJson(result.document.value));
      setDiagnostics(result.document.diagnostics);
      notify.success(t('settings.configuration.saved', 'Configuration saved'));
    } catch (error) {
      notify.error(t('settings.configuration.saveFailed', 'Could not save configuration'), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  };

  const handleReload = async () => {
    setBusy(true);
    try {
      const nextDocument = await reloadDocument(kind, scope);
      setDocument(nextDocument);
      setDraft(formatJson(nextDocument.value));
      setDiagnostics(nextDocument.diagnostics);
    } finally {
      setBusy(false);
    }
  };

  const handleReset = async () => {
    if (!document) return;
    const minimal = {
      $schema: `./schemas/v1/${kind}.schema.json`,
      schemaVersion: 1,
    };
    setDraft(formatJson(minimal));
    setDiagnostics([]);
  };

  const effectiveDiagnostics = [
    ...selectConfigDiagnostics(snapshot, kind).filter((item) => scopeMatches(item.scope, scope)),
    ...diagnostics,
  ].filter((item, index, values) => values.findIndex((candidate) =>
    candidate.code === item.code && candidate.path === item.path && candidate.message === item.message
  ) === index);
  const provenance = snapshot?.provenance.filter((entry) =>
    entry.jsonPointer.startsWith(`/${kind}/`) &&
    (!projectId || entry.projectId === projectId || entry.projectId === null)
  ) ?? [];
  const relevantPending = pendingChanges.filter((entry) =>
    entry.document === kind && scopeMatches(entry.scope, scope)
  );

  return (
    <div className="space-y-5">
      <div className="rounded-lg border border-border bg-card p-4">
        <p className="text-sm text-foreground">
          {t(
            'settings.configuration.description',
            'These strict JSON files are Macro’s configuration source of truth. Values equal to defaults are removed automatically.',
          )}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {document?.filePath ?? t('settings.configuration.loading', 'Loading configuration…')}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs font-medium text-muted-foreground">
          {t('settings.configuration.scope', 'Scope')}
          <select
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
            className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
          >
            <option value="">{t('settings.configuration.userScope', 'User')}</option>
            {uniqueProjects.map((project) => (
              <option key={project.id} value={project.id}>{project.name}</option>
            ))}
          </select>
        </label>
        <label className="text-xs font-medium text-muted-foreground">
          {t('settings.configuration.document', 'Document')}
          <select
            value={kind}
            onChange={(event) => setKind(event.target.value as ConfigDocumentKind)}
            className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
          >
            {availableKinds.map((candidate) => (
              <option key={candidate} value={candidate}>{candidate}.json</option>
            ))}
          </select>
        </label>
      </div>

      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        spellCheck={false}
        aria-label={t('settings.configuration.editor', 'JSON configuration editor')}
        className="min-h-[320px] w-full resize-y rounded-lg border border-input bg-background p-3 font-mono text-xs leading-5 text-foreground outline-none focus:ring-1 focus:ring-ring"
      />

      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => void handleSave()} disabled={busy || document?.readOnly} className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-50">
          <Icon name="check" size={14} />
          {t('common.save', 'Save')}
        </button>
        <button type="button" onClick={() => void handleValidate()} disabled={busy} className="inline-flex h-9 items-center gap-2 rounded-lg border border-border px-3 text-sm text-muted-foreground hover:bg-accent">
          <Icon name="shield" size={14} />
          {t('settings.configuration.validate', 'Validate')}
        </button>
        <button type="button" onClick={() => void handleReload()} disabled={busy} className="inline-flex h-9 items-center gap-2 rounded-lg border border-border px-3 text-sm text-muted-foreground hover:bg-accent">
          <Icon name="refresh-cw" size={14} />
          {t('settings.configuration.reload', 'Reload')}
        </button>
        <button type="button" onClick={() => void handleReset()} disabled={busy || document?.readOnly} className="inline-flex h-9 items-center gap-2 rounded-lg border border-border px-3 text-sm text-muted-foreground hover:bg-accent">
          <Icon name="rotate-ccw" size={14} />
          {t('settings.configuration.reset', 'Reset')}
        </button>
        <button type="button" onClick={() => document && void openPath(document.filePath)} disabled={!document || !isTauriAvailable()} className="inline-flex h-9 items-center gap-2 rounded-lg border border-border px-3 text-sm text-muted-foreground hover:bg-accent disabled:opacity-50">
          <Icon name="file-code" size={14} />
          {t('settings.configuration.openJson', 'Open JSON')}
        </button>
        <button type="button" onClick={() => void configOpenDirectory({ kind, scope })} disabled={!isTauriAvailable()} className="inline-flex h-9 items-center gap-2 rounded-lg border border-border px-3 text-sm text-muted-foreground hover:bg-accent disabled:opacity-50">
          <Icon name="folder-open" size={14} />
          {t('settings.configuration.openFolder', 'Open folder')}
        </button>
      </div>

      {document?.readOnly && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
          {t('settings.configuration.futureVersion', 'This file uses a newer schema version and is read-only.')}
        </div>
      )}

      {effectiveDiagnostics.length > 0 && (
        <section className="rounded-lg border border-destructive/30 bg-destructive/5 p-3">
          <h4 className="text-sm font-semibold text-foreground">{t('settings.configuration.diagnostics', 'Diagnostics')}</h4>
          <ul className="mt-2 space-y-2 text-xs text-muted-foreground">
            {effectiveDiagnostics.map((item, index) => (
              <li key={`${item.code}-${item.path}-${index}`}>
                <code>{item.path ?? '/'}</code> · {item.code} · {item.message}
              </li>
            ))}
          </ul>
        </section>
      )}

      {relevantPending.map((pending) => (
        <section key={pending.id} className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
          <h4 className="text-sm font-semibold text-foreground">
            {t('settings.configuration.pendingSensitive', 'Sensitive change awaiting review')}
          </h4>
          <p className="mt-1 text-xs text-muted-foreground">{pending.reasons.join(' ')}</p>
          <pre className="mt-2 max-h-48 overflow-auto rounded bg-background/70 p-2 text-[11px] text-foreground">{formatJson(pending.proposedDocument)}</pre>
          <div className="mt-3 flex gap-2">
            <button type="button" onClick={() => void acceptPendingChange(pending.id)} className="h-8 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground">
              {t('common.confirm', 'Confirm')}
            </button>
            <button type="button" onClick={() => void rejectPendingChange(pending.id, true)} className="h-8 rounded-md border border-border px-3 text-xs text-muted-foreground hover:bg-accent">
              {t('settings.configuration.rejectRestore', 'Reject and restore')}
            </button>
          </div>
        </section>
      ))}

      {provenance.length > 0 && (
        <details className="rounded-lg border border-border bg-card p-3">
          <summary className="cursor-pointer text-sm font-semibold text-foreground">
            {t('settings.configuration.provenance', 'Effective value provenance')}
          </summary>
          <div className="mt-2 max-h-56 overflow-auto font-mono text-[11px] text-muted-foreground">
            {provenance.map((entry) => (
              <div key={`${entry.jsonPointer}-${entry.projectId ?? ''}`} className="flex justify-between gap-4 border-b border-border/50 py-1">
                <span>{entry.jsonPointer.replace(`/${kind}`, '') || '/'}</span>
                <span>{entry.origin}{entry.projectId ? ` · ${entry.projectId}` : ''}</span>
              </div>
            ))}
          </div>
        </details>
      )}

      <OrphanSecretsPanel />
    </div>
  );
};
