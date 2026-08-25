import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useConfigStore } from '../../../stores/useConfigStore';
import type { ConfigScope } from '../../../types/generated/config';
import type { Project } from '../../../types';
import { Icon } from '../../ui/Icon';
import { Input } from '../../ui/Input';
import { notify } from '../../ui/toastService';

type SkillRoot = {
  sourceType?: 'local';
  path: string;
  enabled?: boolean;
  priority?: number;
};

type SkillDestination = {
  scope: 'user' | 'project';
  path: string;
};

type SkillsConfig = {
  conventionalRoots?: Record<'agents' | 'codex' | 'opencode' | 'claude', boolean>;
  roots?: Record<string, SkillRoot>;
  installDestinations?: Record<string, SkillDestination>;
  defaultGlobalDestination?: string | null;
  defaultProjectDestination?: string | null;
};

const CONVENTIONAL_ROOTS = ['agents', 'codex', 'opencode', 'claude'] as const;

export const SkillSourcesPanel: React.FC<{
  projects: Project[];
  onChanged: () => Promise<void>;
}> = ({ projects, onChanged }) => {
  const { t } = useTranslation();
  const snapshot = useConfigStore((state) => state.snapshot);
  const getDocument = useConfigStore((state) => state.getDocument);
  const patch = useConfigStore((state) => state.patch);
  const [projectId, setProjectId] = useState('');
  const [newRootId, setNewRootId] = useState('');
  const [newRootPath, setNewRootPath] = useState('');
  const [newDestinationId, setNewDestinationId] = useState('');
  const [newDestinationPath, setNewDestinationPath] = useState('');
  const [busy, setBusy] = useState(false);

  const scope: ConfigScope = projectId
    ? { type: 'project', projectId }
    : { type: 'user' };
  const config = useMemo<SkillsConfig>(() => {
    const value = projectId
      ? snapshot?.projectEffective[projectId]?.skills
      : snapshot?.effective.skills;
    return (value && typeof value === 'object' ? value : {}) as SkillsConfig;
  }, [projectId, snapshot]);

  const updateTopLevel = async (key: keyof SkillsConfig, value: unknown) => {
    setBusy(true);
    try {
      const document = await getDocument('skills', scope);
      await patch({
        kind: 'skills',
        scope,
        expectedEtag: document.etag,
        patch: [{ op: 'add', path: `/${key}`, value }],
      });
      await onChanged();
    } catch (error) {
      notify.error(t('skills.sources.saveFailed', 'Could not update skill sources'), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  };

  const roots = config.roots ?? {};
  const destinations = config.installDestinations ?? {};

  return (
    <details className="mb-4 rounded-lg border border-border bg-card p-3">
      <summary className="cursor-pointer text-sm font-semibold text-foreground">
        {t('skills.sources.title', 'Discovery roots and installation destinations')}
      </summary>
      <div className="mt-3 space-y-5">
        <label className="block text-xs font-medium text-muted-foreground">
          {t('skills.sources.scope', 'Configuration scope')}
          <select
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
            className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
          >
            <option value="">{t('skills.sources.userScope', 'User')}</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>{project.name}</option>
            ))}
          </select>
        </label>

        <section>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('skills.sources.conventional', 'Conventional roots')}
          </h4>
          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {CONVENTIONAL_ROOTS.map((root) => (
              <label key={root} className="flex items-center gap-2 rounded-md border border-border px-2 py-2 text-xs text-foreground">
                <input
                  type="checkbox"
                  checked={config.conventionalRoots?.[root] !== false}
                  disabled={busy}
                  onChange={(event) => void updateTopLevel('conventionalRoots', {
                    agents: config.conventionalRoots?.agents !== false,
                    codex: config.conventionalRoots?.codex !== false,
                    opencode: config.conventionalRoots?.opencode !== false,
                    claude: config.conventionalRoots?.claude !== false,
                    [root]: event.target.checked,
                  })}
                />
                {root}
              </label>
            ))}
          </div>
        </section>

        <section>
          <div className="flex items-center justify-between gap-3">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('skills.sources.customRoots', 'Custom local roots')}
            </h4>
            <span className="text-[11px] text-muted-foreground">${'{home}'} · ${'{projectRoot}'} · ${'{configDir}'}</span>
          </div>
          <div className="mt-2 space-y-2">
            {Object.entries(roots).map(([id, root]) => (
              <div key={id} className="grid gap-2 rounded-md border border-border p-2 sm:grid-cols-[minmax(0,1fr)_96px_auto]">
                <Input
                  defaultValue={root.path}
                  aria-label={`${id} path`}
                  onBlur={(event) => {
                    if (event.target.value !== root.path) void updateTopLevel('roots', {
                      ...roots,
                      [id]: { ...root, path: event.target.value },
                    });
                  }}
                />
                <Input
                  type="number"
                  defaultValue={root.priority ?? 0}
                  aria-label={`${id} priority`}
                  onBlur={(event) => void updateTopLevel('roots', {
                    ...roots,
                    [id]: { ...root, priority: Number(event.target.value) || 0 },
                  })}
                />
                <button type="button" title={t('common.delete', 'Delete')} onClick={() => {
                  const next = { ...roots };
                  delete next[id];
                  void updateTopLevel('roots', next);
                }} className="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive">
                  <Icon name="trash" size={14} />
                </button>
                <div className="text-[11px] text-muted-foreground sm:col-span-3">{id}</div>
              </div>
            ))}
            <div className="grid gap-2 sm:grid-cols-[160px_minmax(0,1fr)_auto]">
              <Input value={newRootId} onChange={(event) => setNewRootId(event.target.value)} placeholder="team-skills" />
              <Input value={newRootPath} onChange={(event) => setNewRootPath(event.target.value)} placeholder={projectId ? '${projectRoot}/.team/skills' : '${home}/.team/skills'} />
              <button type="button" disabled={busy || !newRootId.trim() || !newRootPath.trim()} onClick={() => {
                void updateTopLevel('roots', {
                  ...roots,
                  [newRootId.trim()]: {
                    sourceType: 'local',
                    path: newRootPath.trim(),
                    enabled: true,
                    priority: 0,
                  },
                }).then(() => {
                  setNewRootId('');
                  setNewRootPath('');
                });
              }} className="inline-flex h-9 items-center gap-1 rounded-md border border-border px-3 text-xs text-muted-foreground hover:bg-accent disabled:opacity-50">
                <Icon name="plus" size={13} /> {t('common.add', 'Add')}
              </button>
            </div>
          </div>
        </section>

        <section>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('skills.sources.destinations', 'Installation destinations')}
          </h4>
          <div className="mt-2 space-y-2">
            {Object.entries(destinations).map(([id, destination]) => (
              <div key={id} className="grid gap-2 rounded-md border border-border p-2 sm:grid-cols-[110px_minmax(0,1fr)_auto]">
                <select
                  value={destination.scope}
                  disabled={projectId.length > 0}
                  onChange={(event) => void updateTopLevel('installDestinations', {
                    ...destinations,
                    [id]: { ...destination, scope: event.target.value as 'user' | 'project' },
                  })}
                  className="h-9 rounded-md border border-input bg-background px-2 text-xs text-foreground"
                >
                  {!projectId && <option value="user">user</option>}
                  <option value="project">project</option>
                </select>
                <Input
                  defaultValue={destination.path}
                  aria-label={`${id} destination path`}
                  onBlur={(event) => {
                    if (event.target.value !== destination.path) void updateTopLevel('installDestinations', {
                      ...destinations,
                      [id]: { ...destination, path: event.target.value },
                    });
                  }}
                />
                <button type="button" title={t('common.delete', 'Delete')} onClick={() => {
                  const next = { ...destinations };
                  delete next[id];
                  void updateTopLevel('installDestinations', next);
                }} className="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive">
                  <Icon name="trash" size={14} />
                </button>
                <div className="text-[11px] text-muted-foreground sm:col-span-3">{id}</div>
              </div>
            ))}
            <div className="grid gap-2 sm:grid-cols-[160px_minmax(0,1fr)_auto]">
              <Input value={newDestinationId} onChange={(event) => setNewDestinationId(event.target.value)} placeholder="team-default" />
              <Input value={newDestinationPath} onChange={(event) => setNewDestinationPath(event.target.value)} placeholder={projectId ? '.agents/skills' : '${home}/.agents/skills'} />
              <button type="button" disabled={busy || !newDestinationId.trim() || !newDestinationPath.trim()} onClick={() => {
                void updateTopLevel('installDestinations', {
                  ...destinations,
                  [newDestinationId.trim()]: {
                    scope: projectId ? 'project' : 'user',
                    path: newDestinationPath.trim(),
                  },
                }).then(() => {
                  setNewDestinationId('');
                  setNewDestinationPath('');
                });
              }} className="inline-flex h-9 items-center gap-1 rounded-md border border-border px-3 text-xs text-muted-foreground hover:bg-accent disabled:opacity-50">
                <Icon name="plus" size={13} /> {t('common.add', 'Add')}
              </button>
            </div>
          </div>

          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {!projectId && (
              <label className="text-xs text-muted-foreground">
                {t('skills.sources.defaultGlobal', 'Default global destination')}
                <select value={config.defaultGlobalDestination ?? ''} onChange={(event) => void updateTopLevel('defaultGlobalDestination', event.target.value || null)} className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground">
                  <option value="">—</option>
                  {Object.entries(destinations).filter(([, value]) => value.scope === 'user').map(([id]) => <option key={id} value={id}>{id}</option>)}
                </select>
              </label>
            )}
            <label className="text-xs text-muted-foreground">
              {t('skills.sources.defaultProject', 'Default project destination')}
              <select value={config.defaultProjectDestination ?? ''} onChange={(event) => void updateTopLevel('defaultProjectDestination', event.target.value || null)} className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground">
                <option value="">—</option>
                {Object.entries(destinations).filter(([, value]) => value.scope === 'project').map(([id]) => <option key={id} value={id}>{id}</option>)}
              </select>
            </label>
          </div>
        </section>
      </div>
    </details>
  );
};
