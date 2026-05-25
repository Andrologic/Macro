import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../stores/useAppStore';
import { useChatStore } from '../../stores/useChatStore';
import { useSkillsStore } from '../../stores/useSkillsStore';
import type { SkillManifest } from '../../types';
import { cn } from '../../utils/cn';
import { Icon } from '../ui/Icon';

export const SkillDropdown: React.FC = () => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const allSkills = useSkillsStore((state) => state.skills);
  const settingsBySkillId = useSkillsStore((state) => state.settingsBySkillId);
  const isLoading = useSkillsStore((state) => state.isLoading);
  const loadSettings = useSkillsStore((state) => state.loadSettings);
  const refreshSkills = useSkillsStore((state) => state.refreshSkills);
  const composerContextRefs = useChatStore((state) => state.composerContextRefs);

  const composerSkillRefs = useMemo(
    () => composerContextRefs.filter((ref) => ref.kind === 'skill'),
    [composerContextRefs]
  );
  const validSkills = useMemo(
    () => allSkills.filter((skill) => skill.isValid),
    [allSkills]
  );
  const enabledSkills = useMemo(
    () => validSkills.filter((skill) => settingsBySkillId[skill.id]?.enabled === true),
    [settingsBySkillId, validSkills]
  );
  const disabledSkills = useMemo(
    () => validSkills.filter((skill) => settingsBySkillId[skill.id]?.enabled !== true),
    [settingsBySkillId, validSkills]
  );
  const menuSkills = useMemo(
    () => [...enabledSkills, ...disabledSkills],
    [disabledSkills, enabledSkills]
  );
  const selectedSkillIds = useMemo(
    () => new Set(composerSkillRefs.map((ref) => ref.id)),
    [composerSkillRefs]
  );

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  const formatSourceLabel = (skill: SkillManifest): string =>
    skill.source.kind === 'project'
      ? skill.source.projectName || t('skills.projectSource', 'Project')
      : t('skills.globalSource', 'Global');

  const openSkillsSettings = () => {
    useAppStore.getState().openSettings('skills');
    setIsOpen(false);
  };

  const handleToggleOpen = () => {
    setIsOpen((open) => {
      const nextOpen = !open;
      if (nextOpen) {
        void refreshSkills();
      }
      return nextOpen;
    });
  };

  const handleSelect = (skillId: string) => {
    const skill = useSkillsStore.getState().getSkillById(skillId);
    if (!skill || !skill.isValid || settingsBySkillId[skill.id]?.enabled !== true) return;
    useChatStore.getState().addComposerContextRef({
      id: skill.id,
      kind: 'skill',
      title: skill.name,
      subtitle: formatSourceLabel(skill),
      data: skill,
    });
    setIsOpen(false);
  };

  const emptyMessage = isLoading
    ? t('skills.loading', 'Loading skills...')
    : validSkills.length > 0
      ? t('skills.noActiveSkills', 'No enabled skills. Enable one in Settings before using it.')
      : t('skills.noSkillsDiscovered', 'No skills discovered.');

  return (
    <div ref={containerRef} className="relative" data-tour-id="skill-dropdown">
      <button
        type="button"
        onClick={handleToggleOpen}
        className={cn(
          'flex items-center justify-between gap-2 rounded-lg border border-border bg-muted/80 px-2.5 py-1.5 transition-colors',
          'hover:border-primary/50'
        )}
        title={t('skills.addToComposer', 'Add a skill to this message')}
      >
        <div className="flex min-w-0 items-center gap-1.5">
          <Icon
            name={isLoading ? 'loader' : 'sparkles'}
            size={12}
            className={cn('shrink-0 text-muted-foreground', isLoading && 'animate-spin')}
          />
          <span className="text-xs text-muted-foreground">
            {composerSkillRefs.length > 0
              ? t('skills.selectedCount', '{{count}} skills', { count: composerSkillRefs.length })
              : t('skills.menuLabel', 'Skills')}
          </span>
        </div>
        <Icon name="chevron-down" size={10} className="shrink-0 text-muted-foreground" />
      </button>

      {isOpen && (
        <div
          className={cn(
            'absolute bottom-full z-50 mb-1 flex max-h-72 w-72 flex-col overflow-y-auto rounded-lg border border-border bg-card shadow-xl'
          )}
        >
          {enabledSkills.length === 0 && disabledSkills.length > 0 && (
            <div className="border-b border-border px-3 py-2 text-xs text-muted-foreground">
              {t('skills.noActiveSkills', 'No enabled skills. Enable one in Settings before using it.')}
            </div>
          )}

          {menuSkills.map((skill) => {
            const selected = selectedSkillIds.has(skill.id);
            const enabled = settingsBySkillId[skill.id]?.enabled === true;
            const sourceLabel = formatSourceLabel(skill);

            if (!enabled) {
              return (
                <div
                  key={skill.id}
                  className="flex w-full items-start gap-2 px-3 py-2 text-left text-sm text-muted-foreground/70"
                >
                  <Icon name="lock" size={14} className="mt-0.5 shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{skill.name}</span>
                    <span className="block truncate text-xs opacity-75">{sourceLabel}</span>
                    <span className="mt-1 block text-xs opacity-80">
                      {t('skills.enableInSettings', 'Enable this skill in Settings before using it.')}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={openSkillsSettings}
                    className="mt-0.5 shrink-0 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    {t('skills.openSettings', 'Open Settings')}
                  </button>
                </div>
              );
            }

            return (
              <button
                key={skill.id}
                type="button"
                onClick={() => handleSelect(skill.id)}
                className={cn(
                  'flex w-full items-start gap-2 px-3 py-2 text-left text-sm transition-colors',
                  selected
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                )}
              >
                <Icon name="sparkles" size={14} className="mt-0.5 shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{skill.name}</span>
                  <span className="block truncate text-xs opacity-75">{sourceLabel}</span>
                </span>
                {selected && <Icon name="check" size={14} className="mt-0.5 shrink-0" />}
              </button>
            );
          })}

          {menuSkills.length === 0 && (
            <div className="space-y-2 px-3 py-2 text-sm text-muted-foreground">
              <div>{emptyMessage}</div>
              {!isLoading && (
                <button
                  type="button"
                  onClick={openSkillsSettings}
                  className="rounded-md border border-border px-2 py-1 text-xs transition-colors hover:bg-accent hover:text-foreground"
                >
                  {t('skills.openSettings', 'Open Settings')}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
