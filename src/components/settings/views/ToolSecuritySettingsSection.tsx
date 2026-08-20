import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../ui/Icon';
import { ConfirmPromptModal } from '../../ui/ConfirmPromptModal';
import { cn } from '../../../utils/cn';
import {
  loadPreference,
  PREF_KEYS,
  savePreference,
} from '../../../services/preferences';
import { getToolRiskLevelPresentation } from '../../../services/toolApprovalPresentation';
import { DEFAULT_TOOL_RISK_LEVEL } from '../../../services/toolSecurityPolicy';
import type { ToolRiskLevel } from '../../../types';
import { notify } from '../../ui/toastService';

type ToolSecuritySettingsSectionProps = {
  className?: string;
};

export const ToolSecuritySettingsSection: React.FC<
  ToolSecuritySettingsSectionProps
> = ({ className }) => {
  const { t } = useTranslation();
  const [toolRiskLevel, setToolRiskLevel] =
    useState<ToolRiskLevel>(DEFAULT_TOOL_RISK_LEVEL);
  const riskTouchedRef = useRef(false);
  const riskSaveRevisionRef = useRef(0);
  const [isYoloConfirmOpen, setIsYoloConfirmOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void loadPreference<ToolRiskLevel>(PREF_KEYS.TOOL_RISK_LEVEL).then(
      (riskLevel) => {
        if (!cancelled && !riskTouchedRef.current) {
          setToolRiskLevel(riskLevel);
        }
      }
    );

    return () => {
      cancelled = true;
    };
  }, []);

  const persistToolRiskLevel = async (
    level: ToolRiskLevel,
    previousLevel: ToolRiskLevel,
  ) => {
    const revision = ++riskSaveRevisionRef.current;
    riskTouchedRef.current = true;
    setToolRiskLevel(level);
    try {
      await savePreference(PREF_KEYS.TOOL_RISK_LEVEL, level);
    } catch (error) {
      if (riskSaveRevisionRef.current === revision) {
        setToolRiskLevel(previousLevel);
      }
      notify.error(t('settings.configuration.saveFailed', 'Could not save configuration'), {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const updateToolRiskLevel = (level: ToolRiskLevel) => {
    if (level === 'yolo' && toolRiskLevel !== 'yolo') {
      setIsYoloConfirmOpen(true);
      return;
    }

    void persistToolRiskLevel(level, toolRiskLevel);
  };

  return (
    <>
      <div
        className={cn(
          'rounded-xl border border-border bg-card p-4',
          className
        )}
      >
        <div className="space-y-1">
          <h4 className="font-medium text-foreground">
            {t('tools.security.title', 'Security & approvals')}
          </h4>
          <p className="text-sm text-muted-foreground">
            {t(
              'tools.security.description',
              'Choose how much freedom Macro has before it pauses for approval.'
            )}
          </p>
        </div>

        <div className="mt-4 grid gap-2 md:grid-cols-3">
          {([
            ['strict', t('tools.security.strict', 'Strict')],
            ['balanced', t('tools.security.balanced', 'Balanced')],
            ['yolo', t('tools.security.yolo', 'YOLO')],
          ] as const).map(([level, label]) => {
            const riskPresentation = getToolRiskLevelPresentation(
              level,
              (key, fallback) => t(key, fallback)
            );

            return (
              <button
                key={level}
                type="button"
                onClick={() => updateToolRiskLevel(level)}
                className={cn(
                  'rounded-xl border px-4 py-3 text-left transition-colors',
                  toolRiskLevel === level
                    ? level === 'yolo'
                      ? 'border-red-500/40 bg-red-500/10 text-foreground'
                      : 'border-primary bg-primary/10 text-foreground'
                    : 'border-border bg-background/45 text-muted-foreground hover:bg-accent'
                )}
              >
                <div className="flex items-center gap-3">
                  <span
                    className={cn(
                      'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl',
                      riskPresentation.riskIconContainerClassName
                    )}
                    aria-label={riskPresentation.riskIconLabel}
                    title={riskPresentation.riskIconLabel}
                  >
                    <Icon
                      name={riskPresentation.riskIcon}
                      size={16}
                      className={riskPresentation.riskIconClassName}
                    />
                  </span>
                  <div className="min-w-0">
                    <div className="text-sm font-medium">{label}</div>
                    <div className="mt-1 text-xs">
                      {level === 'strict'
                        ? t(
                            'tools.security.strictHint',
                            'Observe only by default, ask for changes, block escape actions.'
                          )
                        : level === 'balanced'
                          ? t(
                              'tools.security.balancedHint',
                              'Allow most work, but ask before web, terminal, or destructive actions.'
                            )
                          : t(
                              'tools.security.yoloHint',
                              'No extra Macro prompts. Tool-native confirmations still apply.'
                            )}
                    </div>
                  </div>
                </div>
              </button>
            );
          })}
        </div>

        <div className="mt-4 overflow-hidden rounded-xl border border-border/70">
          <div className="grid grid-cols-4 bg-background/50 text-xs font-medium text-muted-foreground">
            <div className="px-3 py-2">{t('tools.security.group', 'Group')}</div>
            <div className="px-3 py-2">{t('tools.security.strict', 'Strict')}</div>
            <div className="px-3 py-2">{t('tools.security.balanced', 'Balanced')}</div>
            <div className="px-3 py-2">{t('tools.security.yolo', 'YOLO')}</div>
          </div>
          {[
            {
              group: t('tools.security.observeGroup', 'Observe'),
              strict: t('tools.security.observeStrict', 'Auto in workspace'),
              balanced: t('tools.security.observeBalanced', 'Auto in workspace'),
              yolo: t('tools.security.observeYolo', 'Auto'),
            },
            {
              group: t('tools.security.changeGroup', 'Change'),
              strict: t('tools.security.changeStrict', 'Ask every time'),
              balanced: t(
                'tools.security.changeBalanced',
                'Auto unless destructive'
              ),
              yolo: t('tools.security.changeYolo', 'Auto'),
            },
            {
              group: t('tools.security.escapeGroup', 'Escape'),
              strict: t('tools.security.escapeStrict', 'Blocked'),
              balanced: t(
                'tools.security.escapeBalanced',
                'Ask in workspace, block outside'
              ),
              yolo: t('tools.security.escapeYolo', 'Auto'),
            },
          ].map((row) => (
            <div
              key={row.group}
              className="grid grid-cols-4 border-t border-border/70 text-xs text-foreground"
            >
              <div className="px-3 py-2 font-medium">{row.group}</div>
              <div className="px-3 py-2 text-muted-foreground">{row.strict}</div>
              <div className="px-3 py-2 text-muted-foreground">
                {row.balanced}
              </div>
              <div className="px-3 py-2 text-muted-foreground">{row.yolo}</div>
            </div>
          ))}
        </div>

        <p className="mt-3 text-xs text-muted-foreground">
          {t(
            'tools.security.sessionOnly',
            'Approvals remembered from the chat footer last only for the current conversation. This is a UX authorization layer, not an OS sandbox.'
          )}
        </p>

        {toolRiskLevel === 'yolo' && (
          <div className="mt-3 rounded-xl border border-red-500/25 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-300">
            {t(
              'tools.security.yoloWarning',
              'YOLO disables extra Macro approval prompts for tools in chat.'
            )}
          </div>
        )}
      </div>

      <ConfirmPromptModal
        isOpen={isYoloConfirmOpen}
        title={t('tools.security.yoloConfirmTitle', 'Enable YOLO mode?')}
        description={t(
          'tools.security.yoloConfirmDescription',
          'Macro will stop asking for extra tool approvals in chat. Tool-native safeguards still apply when a tool requires them.'
        )}
        confirmLabel={t('tools.security.yoloConfirmCta', 'Enable YOLO')}
        cancelLabel={t('common.cancel', 'Cancel')}
        onCancel={() => setIsYoloConfirmOpen(false)}
        onConfirm={() => {
          setIsYoloConfirmOpen(false);
          void persistToolRiskLevel('yolo', toolRiskLevel);
        }}
      />
    </>
  );
};
