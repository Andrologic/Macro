import React, { useEffect, useMemo, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { useTranslation } from 'react-i18next';
import { useSkillsStore } from '../../../stores/useSkillsStore';
import { useProviderStore } from '../../../stores/useProviderStore';
import { useAppStore } from '../../../stores/useAppStore';
import { useConfigStore } from '../../../stores/useConfigStore';
import { getServiceRuntimeCapabilities } from '../../../services';
import { loadPreference, PREF_KEYS } from '../../../services/preferences';
import { DEFAULT_TOOL_RISK_LEVEL } from '../../../services/toolSecurityPolicy';
import { isSkillTrustCurrent } from '../../../services/skills/settings';
import type { Project, SkillManifest, SkillSettings, ToolRiskLevel } from '../../../types';
import { SkillCard } from './SkillCard';
import { SkillSourcesPanel } from './SkillSourcesPanel';
import { Icon } from '../../ui/Icon';
import { Input } from '../../ui/Input';
import { Textarea } from '../../ui/Textarea';
import { notify } from '../../ui/toastService';
import { cn } from '../../../utils/cn';
import {
  SettingsCollectionHeader,
  SettingsSearchEmpty,
  useSettingsSearch,
} from '../search/SettingsSearch';

type SkillCreateLocation = {
  id: string;
  destinationKind: 'global' | 'project';
  label: string;
  description: string;
  projectId?: string;
  destinationId?: string;
};

type SkillsConfig = {
  installDestinations?: Record<string, { scope: 'user' | 'project'; path: string }>;
  defaultGlobalDestination?: string | null;
  defaultProjectDestination?: string | null;
};

const DEFAULT_SKILL_NAME = 'new-skill';
const DEFAULT_SKILL_DESCRIPTION = 'Use when Macro needs focused, reusable guidance.';

export const SkillsView: React.FC = () => {
  const { t } = useTranslation();
  const {
    skills,
    isLoading,
    saving,
    lastError,
    loadSettings,
    refreshSkills,
    installSkillFromLocalPath,
    createSkillTemplate,
    openSkillLocation,
    getSkillSettings,
    setSkillEnabled,
    setSkillScriptsEnabled,
  } = useSkillsStore();
  const projectGroups = useAppStore((state) => state.projectGroups);
  const standaloneProjects = useAppStore((state) => state.standaloneProjects);
  const configSnapshot = useConfigStore((state) => state.snapshot);
  const nativeToolsSupported = useProviderStore((state) =>
    state.selectedSupportsNativeToolCalling()
  );
  const runtimeCapabilities = useMemo(() => getServiceRuntimeCapabilities(), []);
  const { matches, query } = useSettingsSearch();
  const [expandedSkillIds, setExpandedSkillIds] = useState<Set<string>>(() => new Set());
  const [toolRiskLevel, setToolRiskLevel] =
    useState<ToolRiskLevel>(DEFAULT_TOOL_RISK_LEVEL);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [createName, setCreateName] = useState(DEFAULT_SKILL_NAME);
  const [createDescription, setCreateDescription] = useState(DEFAULT_SKILL_DESCRIPTION);
  const [createLocationId, setCreateLocationId] = useState('global');

  const projectsWithPaths = useMemo<Project[]>(
    () => [
      ...(standaloneProjects ?? []),
      ...projectGroups.flatMap((group) => group.projects),
    ]
      .filter((project) => project.path.trim().length > 0),
    [projectGroups, standaloneProjects],
  );

  const createLocations = useMemo<SkillCreateLocation[]>(() => {
    const globalConfig = (configSnapshot?.effective.skills ?? {}) as SkillsConfig;
    const globalDestinations = Object.entries(globalConfig.installDestinations ?? {})
      .filter(([, destination]) => destination.scope === 'user');
    const globalDefault = globalConfig.defaultGlobalDestination;
    const locations: SkillCreateLocation[] = globalDestinations.map(([id, destination]) => ({
      id: id === globalDefault ? 'global' : `global:${id}`,
      destinationKind: 'global',
      destinationId: id,
      label: id === globalDefault
        ? t('skills.createGlobalLocation', 'Global skills')
        : `${t('skills.createGlobalLocation', 'Global skills')} · ${id}`,
      description: destination.path,
    }));
    for (const project of projectsWithPaths) {
      const projectConfig = (configSnapshot?.projectEffective[project.id]?.skills ?? globalConfig) as SkillsConfig;
      const projectDefault = projectConfig.defaultProjectDestination;
      for (const [id, destination] of Object.entries(projectConfig.installDestinations ?? {})) {
        if (destination.scope !== 'project') continue;
        locations.push({
          id: id === projectDefault ? `project:${project.id}` : `project:${project.id}:${id}`,
          destinationKind: 'project',
          destinationId: id,
          projectId: project.id,
          label: id === projectDefault ? project.name : `${project.name} · ${id}`,
          description: destination.path,
        });
      }
    }
    return locations;
  }, [configSnapshot, projectsWithPaths, t]);
  const skillCreationSupported = runtimeCapabilities.skills && runtimeCapabilities.skillCreation !== false;

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    let cancelled = false;
    void loadPreference<ToolRiskLevel>(PREF_KEYS.TOOL_RISK_LEVEL).then((level) => {
      if (!cancelled) {
        setToolRiskLevel(level);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const filteredSkills = useMemo(() => {
    return skills.filter((skill) =>
      matches(
        skill.name,
        skill.description,
        skill.id,
        skill.source.namespace ?? '',
        skill.source.projectName ?? '',
        skill.rootPath,
        skill.skillFilePath,
        skill.source.skillRootPath ?? '',
        skill.compatibility ?? '',
        skill.allowedTools ?? '',
        skill.location?.uri ?? '',
        skill.shadowedBySkillId ?? '',
        ...(skill.diagnostics ?? []).map((diagnostic) => `${diagnostic.code} ${diagnostic.message}`)
      )
    );
  }, [matches, skills]);

  const getNamespaceLabel = (skill: SkillManifest): string => {
    switch (skill.source.namespace) {
      case 'codex':
        return t('skills.source.codex', 'Codex');
      case 'opencode':
        return t('skills.source.opencode', 'OpenCode');
      case 'claude':
        return t('skills.source.claude', 'Claude');
      case 'agents':
      default:
        return t('skills.source.agents', 'Agents');
    }
  };

  const handleImport = async () => {
    const selectedPath = await open({
      directory: true,
      multiple: false,
      title: t('skills.importDialogTitle', 'Select a skill folder'),
    });
    if (typeof selectedPath !== 'string') return;
    await installSkillFromLocalPath(selectedPath);
    const error = useSkillsStore.getState().lastError;
    if (error) {
      notify.error(t('skills.importFailed', 'Could not import skill'), { description: error });
    } else {
      notify.success(t('skills.imported', 'Skill imported'));
    }
  };

  const resetCreateDialog = () => {
    setCreateName(DEFAULT_SKILL_NAME);
    setCreateDescription(DEFAULT_SKILL_DESCRIPTION);
    setCreateLocationId('global');
  };

  const handleCreateSkill = async () => {
    const selectedLocation =
      createLocations.find((location) => location.id === createLocationId) ?? null;
    if (!selectedLocation) {
      notify.error(t('skills.createLocationRequired', 'Choose where to create the skill.'));
      return;
    }
    const skill = await createSkillTemplate({
      name: createName,
      description: createDescription,
      destinationKind: selectedLocation.destinationKind,
      destinationId: selectedLocation.destinationId ?? null,
      projectId: selectedLocation.projectId ?? null,
    });
    const error = useSkillsStore.getState().lastError;
    if (!skill || error) {
      notify.error(t('skills.createFailed', 'Could not create skill'), {
        description: error ?? undefined,
      });
      return;
    }
    notify.success(t('skills.created', 'Skill template created'));
    setCreateDialogOpen(false);
    resetCreateDialog();
    const opened = await openSkillLocation(skill.id, 'skillFile');
    const openError = useSkillsStore.getState().lastError;
    if (!opened) {
      notify.error(t('skills.openSkillFileFailed', 'Could not open SKILL.md'), {
        description: openError ?? skill.skillFilePath ?? undefined,
      });
    }
  };

  const handleOpenSkillLocation = async (
    skill: SkillManifest,
    target: 'skillFile' | 'folder',
  ) => {
    const opened = await openSkillLocation(skill.id, target);
    if (!opened) {
      const error = useSkillsStore.getState().lastError;
      notify.error(
        target === 'skillFile'
          ? t('skills.openSkillFileFailed', 'Could not open SKILL.md')
          : t('skills.openFolderFailed', 'Could not open folder'),
        {
          description: error ?? (target === 'skillFile' ? skill.skillFilePath : skill.rootPath) ?? undefined,
        },
      );
    }
  };

  const handleCopySkillPath = async (path: string) => {
    try {
      await navigator.clipboard.writeText(path);
      notify.success(t('skills.pathCopied', 'SKILL.md path copied'));
    } catch (error) {
      notify.error(t('skills.copyPathFailed', 'Could not copy path'), {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const toggleSkillDetails = (skillId: string) => {
    setExpandedSkillIds((current) => {
      const next = new Set(current);
      if (next.has(skillId)) {
        next.delete(skillId);
      } else {
        next.add(skillId);
      }
      return next;
    });
  };

  const getSkillAvailabilityReasons = (
    skill: SkillManifest,
    settings: SkillSettings,
  ): string[] => {
    const reasons: string[] = [];
    if (!runtimeCapabilities.skills) {
      reasons.push(t('skills.unavailable.remoteUnsupported', 'Remote mode does not support skills yet.'));
    }
    if (!skill.isValid) {
      reasons.push(t('skills.unavailable.invalid', 'Invalid skill.'));
    }
    if (skill.shadowedBySkillId) {
      reasons.push(t(
        'skills.unavailable.shadowed',
        'Shadowed by a higher-priority skill. Select this exact source to use it.'
      ));
    }
    if (!settings.enabled) {
      reasons.push(t('skills.unavailable.disabled', 'Disabled.'));
    }
    if (!nativeToolsSupported) {
      reasons.push(t(
        'skills.unavailable.providerUnsupported',
        'Implicit skill loading and skill tools require native tool calling.'
      ));
    }
    if (skill.scripts.length > 0 && toolRiskLevel === 'strict') {
      reasons.push(t('skills.unavailable.strictScripts', 'Strict risk mode blocks skill scripts.'));
    }
    if (skill.scripts.length > 0 && settings.scriptsEnabled && !isSkillTrustCurrent(settings, skill.contentHash)) {
      reasons.push(t(
        'skills.unavailable.trustChanged',
        'The skill content changed. Approve the current version before running scripts.',
      ));
    }
    return Array.from(new Set(reasons));
  };

  return (
    <div className="h-full flex flex-col animate-in fade-in slide-in-from-bottom-2 duration-300">
      <div className="mb-4 rounded-lg border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
        {t(
          'skills.modeHint',
          'Enable reviewed skills here. Use the gear for scripts and technical details.'
        )}
      </div>

      {!runtimeCapabilities.skills && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          <Icon name="triangle-alert" size={14} className="mt-0.5 shrink-0" />
          <span>
            {t(
              'skills.remoteUnsupportedWarning',
              'Skills are not supported in remote mode yet.'
            )}
          </span>
        </div>
      )}

      {runtimeCapabilities.skills && !nativeToolsSupported && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          <Icon name="triangle-alert" size={14} className="mt-0.5 shrink-0" />
          <span>
            {t(
              'skills.nativeToolSupportWarning',
              'The selected provider or model does not support native tool calling. Explicitly selected skills still load as instructions; implicit skill loading, resources and scripts require a compatible model.'
            )}
          </span>
        </div>
      )}

      <SkillSourcesPanel projects={projectsWithPaths} onChanged={refreshSkills} />

      <SettingsCollectionHeader
        title={t('skills.collectionTitle', 'Skills')}
        description={t('skills.collectionDescription', 'Manage discovered skills')}
        searchPlaceholder={skills.length > 0
          ? t('skills.searchPlaceholder', 'Search skills...')
          : undefined}
        className="mb-4"
        action={(
          <div className="flex items-center gap-2">
          <button
            onClick={() => void refreshSkills()}
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            disabled={isLoading}
            aria-label={t('common.refresh', 'Refresh')}
            title={t('common.refresh', 'Refresh')}
          >
            <Icon name={isLoading ? 'loader' : 'refresh-cw'} size={14} className={cn(isLoading && 'animate-spin')} />
          </button>
          <button
            onClick={() => setCreateDialogOpen(true)}
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-60"
            disabled={saving || !skillCreationSupported}
            aria-label={t('skills.newSkill', 'New skill')}
            title={
              skillCreationSupported
                ? t('skills.newSkill', 'New skill')
                : t('skills.createUnavailable', 'Local skill creation is only available in desktop mode.')
            }
          >
            <Icon name="plus" size={14} />
          </button>
          <button
            onClick={() => void handleImport()}
            className="inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
            disabled={saving}
            aria-label={t('skills.import', 'Import')}
            title={t('skills.import', 'Import')}
          >
            <Icon name={saving ? 'loader' : 'upload'} size={14} className={cn(saving && 'animate-spin')} />
            {t('skills.import', 'Import')}
          </button>
          </div>
        )}
      />

      {lastError && (
        <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {lastError}
        </div>
      )}

      <div className="flex-1 space-y-3 overflow-y-auto pr-2">
        {filteredSkills.map((skill) => {
          const settings = getSkillSettings(skill.id);
          const sourceLabel = skill.source.kind === 'project'
            ? skill.source.projectName || t('skills.projectSource', 'Project')
            : t('skills.globalSource', 'Global');
          return (
            <SkillCard
              key={skill.id}
              skill={skill}
              settings={settings}
              availabilityReasons={getSkillAvailabilityReasons(skill, settings)}
              sourceLabel={sourceLabel}
              namespaceLabel={getNamespaceLabel(skill)}
              rootPath={skill.source.skillRootPath ?? skill.rootPath ?? skill.location?.uri ?? skill.id}
              skillPath={skill.skillFilePath ?? skill.location?.uri ?? skill.id}
              expanded={expandedSkillIds.has(skill.id)}
              onToggleExpanded={() => toggleSkillDetails(skill.id)}
              onEnabledChange={(enabled) => setSkillEnabled(skill.id, enabled)}
              onScriptsEnabledChange={(enabled) => setSkillScriptsEnabled(skill.id, enabled)}
              onOpenFolder={() => void handleOpenSkillLocation(skill, 'folder')}
              onCopySkillPath={() => void handleCopySkillPath(skill.skillFilePath ?? skill.id)}
              onRefreshSkill={() => void refreshSkills()}
            />
          );
        })}

        {filteredSkills.length === 0 && (isLoading
          ? <p className="py-8 text-center text-sm text-muted-foreground">{t('skills.loading', 'Loading skills...')}</p>
          : query.trim()
            ? <SettingsSearchEmpty />
            : (
              <div className="rounded-xl border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
                {t('skills.empty', 'No skills discovered')}
              </div>
            ))}
      </div>

      {createDialogOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-xl border border-border bg-card p-4 shadow-2xl">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-foreground">
                  {t('skills.createTitle', 'Create skill')}
                </h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t('skills.createHint', 'Macro will create a minimal SKILL.md in a supported skills folder.')}
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setCreateDialogOpen(false);
                  resetCreateDialog();
                }}
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                title={t('common.cancel', 'Cancel')}
              >
                <Icon name="x" size={16} />
              </button>
            </div>

            <div className="space-y-3">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-muted-foreground">
                  {t('skills.createNameLabel', 'Name')}
                </span>
                <Input
                  value={createName}
                  onChange={(event) => setCreateName(event.target.value)}
                  placeholder={DEFAULT_SKILL_NAME}
                />
              </label>

              <label className="block">
                <span className="mb-1 block text-xs font-medium text-muted-foreground">
                  {t('skills.createDescriptionLabel', 'Description')}
                </span>
                <Textarea
                  value={createDescription}
                  onChange={(event) => setCreateDescription(event.target.value)}
                  rows={3}
                  className="resize-none"
                  placeholder={DEFAULT_SKILL_DESCRIPTION}
                />
              </label>

              <label className="block">
                <span className="mb-1 block text-xs font-medium text-muted-foreground">
                  {t('skills.createLocationLabel', 'Location')}
                </span>
                <select
                  aria-label={t('skills.createLocationLabel', 'Location')}
                  value={createLocationId}
                  onChange={(event) => setCreateLocationId(event.target.value)}
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
                >
                  {createLocations.map((location) => (
                    <option key={location.id} value={location.id}>
                      {location.label} - {location.description}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setCreateDialogOpen(false);
                  resetCreateDialog();
                }}
                className="inline-flex h-9 items-center justify-center rounded-lg border border-border px-3 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                {t('common.cancel', 'Cancel')}
              </button>
              <button
                type="button"
                onClick={() => void handleCreateSkill()}
                className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
                disabled={saving}
              >
                <Icon name={saving ? 'loader' : 'plus'} size={14} className={cn(saving && 'animate-spin')} />
                {t('skills.createAction', 'Create')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
