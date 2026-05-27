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
  onEnabledChange: (enabled: boolean) => void;
  onTrustedChange: (trusted: boolean) => void;
  onScriptsEnabledChange: (enabled: boolean) => void;
}

export const SkillCard: React.FC<SkillCardProps> = ({
  skill,
  settings,
  availabilityReasons,
  sourceLabel,
  namespaceLabel,
  rootPath,
  skillPath,
  onEnabledChange,
  onTrustedChange,
  onScriptsEnabledChange,
}) => {
  const { t } = useTranslation();
  const diagnostics = skill.diagnostics ?? [];
  const metadataEntries = Object.entries(skill.metadata ?? {});

  return (
    <div className="rounded-lg border border-border bg-card p-4">
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
              {skill.specCompliant === false && (
                <span className="rounded bg-amber-500/10 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-300">
                  {t('skills.specWarning', 'Spec warning')}
                </span>
              )}
              {skill.shadowedBySkillId && (
                <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                  {t('skills.shadowed', 'Shadowed')}
                </span>
              )}
            </div>
            <p className="text-sm text-muted-foreground">
              {skill.description || t('skills.noDescription', 'No description')}
            </p>
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
              {skillPath}
            </p>
            <p className="truncate text-xs text-muted-foreground/60" title={rootPath}>
              {rootPath}
            </p>
            {skill.location && skill.location.kind !== 'local' && (
              <p className="truncate text-xs text-muted-foreground/60" title={skill.location.uri}>
                {skill.location.kind}: {skill.location.uri}
              </p>
            )}
            <div className="flex flex-wrap gap-2 pt-1 text-xs">
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
            {diagnostics.length > 0 && (
              <div className="mt-2 space-y-1 rounded-lg border border-border bg-muted/30 px-2 py-1.5 text-xs text-muted-foreground">
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
          </div>
        </div>

        <div className="grid shrink-0 grid-cols-[auto_auto] items-center gap-x-2 gap-y-2 text-xs text-muted-foreground">
          <span>{t('skills.enabled', 'Enabled')}</span>
          <Switch
            checked={settings.enabled}
            disabled={!skill.isValid}
            onCheckedChange={onEnabledChange}
          />
          <span>{t('skills.trusted', 'Trusted')}</span>
          <Switch
            checked={settings.trusted}
            disabled={!skill.isValid}
            onCheckedChange={onTrustedChange}
          />
          <span>{t('skills.scripts', 'Scripts')}</span>
          <Switch
            checked={settings.scriptsEnabled}
            disabled={!skill.isValid || !settings.trusted || skill.scripts.length === 0}
            onCheckedChange={onScriptsEnabledChange}
          />
        </div>
      </div>
    </div>
  );
};
