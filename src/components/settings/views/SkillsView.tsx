import React, { useEffect, useMemo, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { openPath } from '@tauri-apps/plugin-opener';
import { useTranslation } from 'react-i18next';
import { useSkillsStore } from '../../../stores/useSkillsStore';
import { useProviderStore } from '../../../stores/useProviderStore';
import { getServiceRuntimeCapabilities } from '../../../services';
import { loadPreference, PREF_KEYS } from '../../../services/preferences';
import { DEFAULT_TOOL_RISK_LEVEL } from '../../../services/toolSecurityPolicy';
import { normalizeSkillLookupName } from '../../../services/skills/identity';
import type { SkillManifest, SkillSettings, ToolRiskLevel } from '../../../types';
import { SkillCard } from './SkillCard';
import { Icon } from '../../ui/Icon';
import { Input } from '../../ui/Input';
import { notify } from '../../ui/toastService';
import { cn } from '../../../utils/cn';

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
    getSkillSettings,
    setSkillEnabled,
    setSkillScriptsEnabled,
  } = useSkillsStore();
  const nativeToolsSupported = useProviderStore((state) =>
    state.selectedSupportsNativeToolCalling()
  );
  const runtimeCapabilities = useMemo(() => getServiceRuntimeCapabilities(), []);
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedSkillIds, setExpandedSkillIds] = useState<Set<string>>(() => new Set());
  const [toolRiskLevel, setToolRiskLevel] =
    useState<ToolRiskLevel>(DEFAULT_TOOL_RISK_LEVEL);

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
    const query = normalizeSkillLookupName(searchQuery);
    if (!query) return skills;
    return skills.filter((skill) =>
      normalizeSkillLookupName([
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
        ...(skill.diagnostics ?? []).map((diagnostic) => `${diagnostic.code} ${diagnostic.message}`),
      ]
        .join(' '))
        .includes(query)
    );
  }, [skills, searchQuery]);

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

  const handleCreateSkill = async () => {
    const skill = await createSkillTemplate();
    const error = useSkillsStore.getState().lastError;
    if (!skill || error) {
      notify.error(t('skills.createFailed', 'Could not create skill'), {
        description: error ?? undefined,
      });
      return;
    }
    notify.success(t('skills.created', 'Skill template created'));
    await handleOpenFolder(skill.rootPath ?? skill.source.rootPath);
  };

  const handleOpenFolder = async (path: string) => {
    try {
      await openPath(path);
    } catch (error) {
      notify.error(t('skills.openFolderFailed', 'Could not open folder'), {
        description: error instanceof Error ? error.message : String(error),
      });
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

      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <Input
          placeholder={t('skills.searchPlaceholder', 'Search skills...')}
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          className="sm:max-w-md"
        />
        <div className="flex items-center gap-2">
          <button
            onClick={() => void refreshSkills()}
            className="inline-flex h-9 items-center gap-2 rounded-lg border border-border px-3 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            disabled={isLoading}
          >
            <Icon name={isLoading ? 'loader' : 'refresh-cw'} size={14} className={cn(isLoading && 'animate-spin')} />
            {t('common.refresh', 'Refresh')}
          </button>
          <button
            onClick={() => void handleCreateSkill()}
            className="inline-flex h-9 items-center gap-2 rounded-lg border border-border px-3 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-60"
            disabled={saving}
          >
            <Icon name={saving ? 'loader' : 'plus'} size={14} className={cn(saving && 'animate-spin')} />
            {t('skills.newSkill', 'New skill')}
          </button>
          <button
            onClick={() => void handleImport()}
            className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
            disabled={saving}
          >
            <Icon name={saving ? 'loader' : 'upload'} size={14} className={cn(saving && 'animate-spin')} />
            {t('skills.import', 'Import')}
          </button>
        </div>
      </div>

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
              onOpenFolder={() => void handleOpenFolder(skill.rootPath ?? skill.source.rootPath)}
              onCopySkillPath={() => void handleCopySkillPath(skill.skillFilePath ?? skill.id)}
              onRefreshSkill={() => void refreshSkills()}
            />
          );
        })}

        {filteredSkills.length === 0 && (
          <div className="rounded-lg border border-dashed border-border py-8 text-center">
            <p className="text-sm text-muted-foreground">
              {isLoading
                ? t('skills.loading', 'Loading skills...')
                : t('skills.noneFound', 'No skills found.')}
            </p>
          </div>
        )}
      </div>
    </div>
  );
};
