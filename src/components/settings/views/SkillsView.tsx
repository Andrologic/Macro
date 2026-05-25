import React, { useEffect, useMemo, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { useTranslation } from 'react-i18next';
import { useSkillsStore } from '../../../stores/useSkillsStore';
import { useProviderStore } from '../../../stores/useProviderStore';
import { getServiceRuntimeCapabilities } from '../../../services';
import { loadPreference, PREF_KEYS } from '../../../services/preferences';
import { DEFAULT_TOOL_RISK_LEVEL } from '../../../services/toolSecurityPolicy';
import type { SkillManifest, SkillSettings, ToolRiskLevel } from '../../../types';
import { Icon } from '../../ui/Icon';
import { Input } from '../../ui/Input';
import { Switch } from '../../ui/Switch';
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
    getSkillSettings,
    setSkillEnabled,
    setSkillTrusted,
    setSkillScriptsEnabled,
  } = useSkillsStore();
  const nativeToolsSupported = useProviderStore((state) =>
    state.selectedSupportsNativeToolCalling()
  );
  const runtimeCapabilities = useMemo(() => getServiceRuntimeCapabilities(), []);
  const [searchQuery, setSearchQuery] = useState('');
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
    const query = searchQuery.trim().toLowerCase();
    if (!query) return skills;
    return skills.filter((skill) =>
      [
        skill.name,
        skill.description,
        skill.id,
        skill.source.namespace ?? '',
        skill.source.projectName ?? '',
        skill.rootPath,
        skill.skillFilePath,
        skill.source.skillRootPath ?? '',
      ]
        .join(' ')
        .toLowerCase()
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
          'Skills add reusable agent instructions from Agents, Codex, OpenCode and Claude skill folders. Enable and trust only skills you have reviewed.'
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
          const availabilityReasons = getSkillAvailabilityReasons(skill, settings);
          const sourceLabel = skill.source.kind === 'project'
            ? skill.source.projectName || t('skills.projectSource', 'Project')
            : t('skills.globalSource', 'Global');
          const namespaceLabel = getNamespaceLabel(skill);
          const rootPath = skill.source.skillRootPath ?? skill.rootPath;
          return (
            <div key={skill.id} className="rounded-lg border border-border bg-card p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex gap-4">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <Icon name="sparkles" size={18} />
                  </div>
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h4 className="font-medium text-foreground">{skill.name}</h4>
                      <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                        {namespaceLabel}
                      </span>
                      <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                        {sourceLabel}
                      </span>
                      {!skill.isValid && (
                        <span className="rounded bg-destructive/10 px-2 py-0.5 text-xs text-destructive">
                          {t('skills.invalid', 'Invalid')}
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-muted-foreground">{skill.description || t('skills.noDescription', 'No description')}</p>
                    <p className="truncate text-xs text-muted-foreground/70" title={skill.skillFilePath}>
                      {skill.skillFilePath}
                    </p>
                    <p className="truncate text-xs text-muted-foreground/60" title={rootPath}>
                      {rootPath}
                    </p>
                    <div className="flex flex-wrap gap-2 pt-1 text-xs">
                      <span className="rounded bg-muted px-2 py-0.5 text-muted-foreground">
                        {t('skills.resourcesCount', '{{count}} resources', { count: skill.resources.length })}
                      </span>
                      <span className="rounded bg-muted px-2 py-0.5 text-muted-foreground">
                        {t('skills.scriptsCount', '{{count}} scripts', { count: skill.scripts.length })}
                      </span>
                    </div>
                    {availabilityReasons.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 pt-1 text-xs">
                        {availabilityReasons.map((reason) => (
                          <span
                            key={reason}
                            className="rounded bg-amber-500/10 px-2 py-0.5 text-amber-700 dark:text-amber-300"
                          >
                            {reason}
                          </span>
                        ))}
                      </div>
                    )}
                    {skill.validationErrors.length > 0 && (
                      <div className="mt-2 rounded-lg border border-destructive/20 bg-destructive/5 px-2 py-1 text-xs text-destructive">
                        {skill.validationErrors.join(' ')}
                      </div>
                    )}
                  </div>
                </div>

                <div className="grid shrink-0 grid-cols-[auto_auto] items-center gap-x-2 gap-y-2 text-xs text-muted-foreground">
                  <span>{t('skills.enabled', 'Enabled')}</span>
                  <Switch
                    checked={settings.enabled}
                    disabled={!skill.isValid}
                    onCheckedChange={(enabled) => setSkillEnabled(skill.id, enabled)}
                  />
                  <span>{t('skills.trusted', 'Trusted')}</span>
                  <Switch
                    checked={settings.trusted}
                    disabled={!skill.isValid}
                    onCheckedChange={(trusted) => setSkillTrusted(skill.id, trusted)}
                  />
                  <span>{t('skills.scripts', 'Scripts')}</span>
                  <Switch
                    checked={settings.scriptsEnabled}
                    disabled={!skill.isValid || !settings.trusted || skill.scripts.length === 0}
                    onCheckedChange={(enabled) => setSkillScriptsEnabled(skill.id, enabled)}
                  />
                </div>
              </div>
            </div>
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
