import React from 'react';
import { useTranslation } from 'react-i18next';
import type { SkillManifest, SkillSettings } from '../../../types';
import { cn } from '../../../utils/cn';
import { Icon } from '../../ui/Icon';
import { Switch } from '../../ui/Switch';

interface SkillCardProps {
  skill: SkillManifest;
  settings: SkillSettings;
  availabilityReasons: string[];
  sourceLabel: string;
  namespaceLabel: string;
  rootPath: string;
  skillPath: string;
  expanded: boolean;
  onToggleExpanded: () => void;
  onEnabledChange: (enabled: boolean) => void;
  onScriptsEnabledChange: (enabled: boolean) => void;
  onOpenFolder: () => void;
  onCopySkillPath: () => void;
  onRefreshSkill: () => void;
}

export const SkillCard: React.FC<SkillCardProps> = ({
  skill,
  settings,
  availabilityReasons,
  sourceLabel,
  namespaceLabel,
  rootPath,
  skillPath,
  expanded,
  onToggleExpanded,
  onEnabledChange,
  onScriptsEnabledChange,
  onOpenFolder,
  onCopySkillPath,
  onRefreshSkill,
}) => {
  const { t } = useTranslation();
  const diagnostics = skill.diagnostics ?? [];
  const metadataEntries = Object.entries(skill.metadata ?? {});
  const statusLabel = !skill.isValid
    ? t('skills.invalid', 'Invalid')
    : skill.shadowedBySkillId
      ? t('skills.shadowed', 'Shadowed')
      : settings.enabled && availabilityReasons.length > 0
        ? t('skills.unavailableStatus', 'Unavailable')
        : null;
  const statusClassName = !skill.isValid
    ? 'bg-destructive/10 text-destructive'
    : 'bg-muted text-muted-foreground';

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex items-center gap-3 px-3 py-2.5">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Icon name="sparkles" size={18} />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h4 className="truncate text-sm font-medium text-foreground">{skill.name}</h4>
            <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
              {namespaceLabel}
            </span>
            <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
              {sourceLabel}
            </span>
            {statusLabel && (
              <span className={cn('shrink-0 rounded px-1.5 py-0.5 text-[11px]', statusClassName)}>
                {statusLabel}
              </span>
            )}
          </div>
          <p className="truncate text-xs text-muted-foreground">
            {skill.description || t('skills.noDescription', 'No description')}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Switch
            checked={settings.enabled}
            disabled={!skill.isValid}
                aria-label={t('common.enable', 'Enable')}
            onCheckedChange={onEnabledChange}
          />
          <button
            type="button"
            onClick={onToggleExpanded}
            className={cn(
              'inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors',
              expanded ? 'bg-accent text-foreground' : 'hover:bg-accent hover:text-foreground'
            )}
            aria-expanded={expanded}
            aria-label={t('skills.details', 'Details')}
            title={t('skills.details', 'Details')}
          >
            <Icon name="settings" size={15} />
          </button>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-border px-3 pb-3 pt-3">
          <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto]">
            <div className="min-w-0 space-y-3">
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h5 className="text-xs font-medium text-foreground">
                    {t('skills.details', 'Details')}
                  </h5>
                  <button
                    type="button"
                    onClick={onOpenFolder}
                    className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    <Icon name="folder-open" size={12} />
                    {t('skills.openFolder', 'Open folder')}
                  </button>
                  <button
                    type="button"
                    onClick={onCopySkillPath}
                    className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    <Icon name="copy" size={12} />
                    {t('skills.copySkillPath', 'Copy path')}
                  </button>
                  <button
                    type="button"
                    onClick={onRefreshSkill}
                    className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    <Icon name="refresh-cw" size={12} />
                    {t('skills.refreshThisSkill', 'Refresh')}
                  </button>
                </div>
                {(skill.compatibility || skill.allowedTools || skill.license) && (
                  <div className="space-y-0.5 text-xs text-muted-foreground">
                    {skill.compatibility && (
                      <p>{t('skills.compatibility', 'Compatibility')}: {skill.compatibility}</p>
                    )}
                    {skill.allowedTools && (
                      <p>{t('skills.allowedTools', 'Allowed tools')}: {skill.allowedTools}</p>
                    )}
                    {skill.license && (
                      <p>{t('skills.license', 'License')}: {skill.license}</p>
                    )}
                  </div>
                )}
                <p className="truncate text-xs text-muted-foreground/70" title={skillPath}>
                  {t('skills.skillPath', 'SKILL.md')}: {skillPath}
                </p>
                <p className="truncate text-xs text-muted-foreground/60" title={rootPath}>
                  {t('skills.rootPath', 'Root')}: {rootPath}
                </p>
                {skill.location && skill.location.kind !== 'local' && (
                  <p className="truncate text-xs text-muted-foreground/60" title={skill.location.uri}>
                    {skill.location.kind}: {skill.location.uri}
                  </p>
                )}
              </div>

              <div className="flex flex-wrap gap-2 text-xs">
                <span className="rounded bg-muted px-2 py-0.5 text-muted-foreground">
                  {t('skills.resourcesCount', '{{count}} resources', { count: skill.resources.length })}
                </span>
                <span className="rounded bg-muted px-2 py-0.5 text-muted-foreground">
                  {t('skills.scriptsCount', '{{count}} scripts', { count: skill.scripts.length })}
                </span>
                {metadataEntries.length > 0 && (
                  <span className="rounded bg-muted px-2 py-0.5 text-muted-foreground">
                    {t('skills.metadataCount', '{{count}} metadata', { count: metadataEntries.length })}
                  </span>
                )}
              </div>

              {availabilityReasons.length > 0 && (
                <div className="flex flex-wrap gap-1.5 text-xs">
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
                <div className="space-y-1 rounded-lg border border-destructive/20 bg-destructive/5 px-2 py-1.5 text-xs text-destructive">
                  <div className="font-medium">
                    {t('skills.fixSkillMd', 'Fix SKILL.md')}
                  </div>
                  <ul className="space-y-0.5">
                    {skill.validationErrors.map((error) => (
                      <li key={error}>{error}</li>
                    ))}
                  </ul>
                </div>
              )}

              {diagnostics.length > 0 && (
                <div className="space-y-1 rounded-lg border border-border bg-muted/30 px-2 py-1.5 text-xs text-muted-foreground">
                  {diagnostics.slice(0, 6).map((diagnostic) => (
                    <div
                      key={`${diagnostic.code}:${diagnostic.message}`}
                      className={cn(
                        diagnostic.severity === 'error' && 'text-destructive',
                        diagnostic.severity === 'warning' && 'text-amber-700 dark:text-amber-300',
                      )}
                    >
                      {diagnostic.severity}: {diagnostic.message}
                    </div>
                  ))}
                  {diagnostics.length > 6 && (
                    <div>
                      {t('skills.moreDiagnostics', '+{{count}} more diagnostics', {
                        count: diagnostics.length - 6,
                      })}
                    </div>
                  )}
                </div>
              )}

              {metadataEntries.length > 0 && (
                <div className="space-y-1 rounded-lg border border-border bg-muted/20 px-2 py-1.5 text-xs text-muted-foreground">
                  {metadataEntries.map(([key, value]) => (
                    <div key={key} className="grid grid-cols-[120px_minmax(0,1fr)] gap-2">
                      <span className="truncate text-muted-foreground/70">{key}</span>
                      <span className="truncate" title={String(value)}>{String(value)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="grid shrink-0 grid-cols-[auto_auto] items-center gap-x-2 gap-y-2 self-start text-xs text-muted-foreground">
              <span>{t('skills.scripts', 'Scripts')}</span>
              <Switch
                checked={settings.scriptsEnabled}
                disabled={!skill.isValid || skill.scripts.length === 0}
                aria-label={t('skills.scripts', 'Scripts')}
                onCheckedChange={onScriptsEnabledChange}
              />
              <span className="col-span-2 max-w-44 text-[11px] leading-snug text-muted-foreground/70">
                {t(
                  'skills.scriptsHelp',
                  'Scripts can run only when this skill is enabled and script access is on.',
                )}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
