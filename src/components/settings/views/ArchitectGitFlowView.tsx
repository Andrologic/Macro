import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../ui/Icon';
import { loadPreference, PREF_KEYS, savePreference } from '../../../services/preferences';
import {
  type ArchitectGitNamingSettings,
  renderGitFlowBranchName,
  renderStandaloneFeatureBranchName,
  validateArchitectGitNamingSettings,
} from '../../../services/architectGitNaming';
import { cn } from '../../../utils/cn';

const defaultSettings: ArchitectGitNamingSettings = {
  mainBranch: 'main',
  baseBranch: 'develop',
  planBranchTemplate: 'plan/{planSlug}',
  featureBranchTemplate: 'feature/{planSlug}/{featureSlug}',
  standaloneFeatureBranchTemplate: 'feature/{featureSlug}',
  releaseBranchTemplate: 'release/{releaseSlug}',
  hotfixBranchTemplate: 'hotfix/{hotfixSlug}',
  bugfixBranchTemplate: 'bugfix/{bugfixSlug}',
  syncTargetBeforeFinish: true,
};

export const ArchitectGitFlowView: React.FC = () => {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<ArchitectGitNamingSettings>(defaultSettings);
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

  useEffect(() => {
    const loadSettings = async () => {
      const [
        mainBranch,
        baseBranch,
        planTemplate,
        featureTemplate,
        standaloneFeatureTemplate,
        releaseTemplate,
        hotfixTemplate,
        bugfixTemplate,
        syncTargetBeforeFinish,
      ] = await Promise.all([
        loadPreference<string>(PREF_KEYS.ARCHITECT_GIT_MAIN_BRANCH),
        loadPreference<string>(PREF_KEYS.ARCHITECT_GIT_BASE_BRANCH),
        loadPreference<string>(PREF_KEYS.ARCHITECT_PLAN_BRANCH_TEMPLATE),
        loadPreference<string>(PREF_KEYS.ARCHITECT_FEATURE_BRANCH_TEMPLATE),
        loadPreference<string>(PREF_KEYS.ARCHITECT_STANDALONE_FEATURE_BRANCH_TEMPLATE),
        loadPreference<string>(PREF_KEYS.ARCHITECT_RELEASE_BRANCH_TEMPLATE),
        loadPreference<string>(PREF_KEYS.ARCHITECT_HOTFIX_BRANCH_TEMPLATE),
        loadPreference<string>(PREF_KEYS.ARCHITECT_BUGFIX_BRANCH_TEMPLATE),
        loadPreference<boolean>(PREF_KEYS.ARCHITECT_SYNC_TARGET_BEFORE_FINISH),
      ]);

      setSettings({
        mainBranch: mainBranch || defaultSettings.mainBranch,
        baseBranch: baseBranch || defaultSettings.baseBranch,
        planBranchTemplate: planTemplate || defaultSettings.planBranchTemplate,
        featureBranchTemplate: featureTemplate || defaultSettings.featureBranchTemplate,
        standaloneFeatureBranchTemplate:
          standaloneFeatureTemplate || defaultSettings.standaloneFeatureBranchTemplate,
        releaseBranchTemplate: releaseTemplate || defaultSettings.releaseBranchTemplate,
        hotfixBranchTemplate: hotfixTemplate || defaultSettings.hotfixBranchTemplate,
        bugfixBranchTemplate: bugfixTemplate || defaultSettings.bugfixBranchTemplate,
        syncTargetBeforeFinish: syncTargetBeforeFinish ?? defaultSettings.syncTargetBeforeFinish,
      });
    };

    void loadSettings();
  }, []);

  const validationErrors = useMemo(() => validateArchitectGitNamingSettings(settings), [settings]);

  const previews = useMemo(
    () => ({
      targetBranch: settings.baseBranch.trim() || defaultSettings.baseBranch,
      mainBranch: settings.mainBranch.trim() || defaultSettings.mainBranch,
      planBranch: renderGitFlowBranchName({
        branchType: 'plan',
        planSlug: 'checkout-rework',
        settings,
      }),
      featureBranch: renderGitFlowBranchName({
        branchType: 'feature',
        planSlug: 'checkout-rework',
        branchSlug: 'invoice-retry',
        settings,
      }),
      standaloneFeatureBranch: renderStandaloneFeatureBranchName({
        featureSlug: 'quick-export',
        settings,
      }),
      releaseBranch: renderGitFlowBranchName({
        branchType: 'release',
        branchSlug: 'v1.5.0',
        settings,
      }),
      hotfixBranch: renderGitFlowBranchName({
        branchType: 'hotfix',
        branchSlug: 'auth-timeout',
        settings,
      }),
      bugfixBranch: renderGitFlowBranchName({
        branchType: 'bugfix',
        branchSlug: 'checkout-tax-rounding',
        settings,
      }),
    }),
    [settings]
  );

  const handleSave = async () => {
    if (validationErrors.length > 0) return;
    setIsSaving(true);
    setSaveSuccess(false);
    await Promise.all([
      savePreference(PREF_KEYS.ARCHITECT_GIT_MAIN_BRANCH, settings.mainBranch.trim() || defaultSettings.mainBranch),
      savePreference(PREF_KEYS.ARCHITECT_GIT_BASE_BRANCH, settings.baseBranch.trim() || defaultSettings.baseBranch),
      savePreference(
        PREF_KEYS.ARCHITECT_PLAN_BRANCH_TEMPLATE,
        settings.planBranchTemplate.trim() || defaultSettings.planBranchTemplate
      ),
      savePreference(
        PREF_KEYS.ARCHITECT_FEATURE_BRANCH_TEMPLATE,
        settings.featureBranchTemplate.trim() || defaultSettings.featureBranchTemplate
      ),
      savePreference(
        PREF_KEYS.ARCHITECT_STANDALONE_FEATURE_BRANCH_TEMPLATE,
        settings.standaloneFeatureBranchTemplate.trim() || defaultSettings.standaloneFeatureBranchTemplate
      ),
      savePreference(
        PREF_KEYS.ARCHITECT_RELEASE_BRANCH_TEMPLATE,
        settings.releaseBranchTemplate.trim() || defaultSettings.releaseBranchTemplate
      ),
      savePreference(
        PREF_KEYS.ARCHITECT_HOTFIX_BRANCH_TEMPLATE,
        settings.hotfixBranchTemplate.trim() || defaultSettings.hotfixBranchTemplate
      ),
      savePreference(
        PREF_KEYS.ARCHITECT_BUGFIX_BRANCH_TEMPLATE,
        settings.bugfixBranchTemplate.trim() || defaultSettings.bugfixBranchTemplate
      ),
      savePreference(PREF_KEYS.ARCHITECT_SYNC_TARGET_BEFORE_FINISH, settings.syncTargetBeforeFinish),
    ]);
    setIsSaving(false);
    setSaveSuccess(true);
    setTimeout(() => setSaveSuccess(false), 2500);
  };

  const handleReset = () => {
    setSettings(defaultSettings);
    setSaveSuccess(false);
  };

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-300">
      <section className="space-y-4">
        <h4 className="text-sm font-medium text-primary uppercase tracking-wider">
          {t('settings.architectGitFlow.title', 'Architect Git Flow')}
        </h4>
        <p className="text-xs text-muted-foreground">
          {t(
            'settings.architectGitFlow.subtitle',
            'Configure the default Git Flow profile applied to new subprojects, including planned and independent feature branches. Existing subprojects can override these values individually.'
          )}
        </p>
      </section>

      <section className="space-y-4 bg-card/40 p-4 rounded-xl border border-border/50">
        <div className="space-y-2">
          <label className="text-sm font-medium text-foreground">
            {t('settings.architectGitFlow.mainBranchLabel', 'Main branch')}
          </label>
          <input
            value={settings.mainBranch}
            onChange={(event) => setSettings((prev) => ({ ...prev, mainBranch: event.target.value }))}
            className="w-full px-3 py-2 rounded-lg bg-background border border-border/60 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
            placeholder="main"
          />
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium text-foreground">
            {t('settings.architectGitFlow.baseBranchLabel', 'Default development/target branch')}
          </label>
          <input
            value={settings.baseBranch}
            onChange={(event) => setSettings((prev) => ({ ...prev, baseBranch: event.target.value }))}
            className="w-full px-3 py-2 rounded-lg bg-background border border-border/60 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
            placeholder="develop"
          />
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium text-foreground">
            {t('settings.architectGitFlow.planTemplateLabel', 'Plan branch template')}
          </label>
          <input
            value={settings.planBranchTemplate}
            onChange={(event) => setSettings((prev) => ({ ...prev, planBranchTemplate: event.target.value }))}
            className="w-full px-3 py-2 rounded-lg bg-background border border-border/60 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
            placeholder="plan/{planSlug}"
          />
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium text-foreground">
            {t('settings.architectGitFlow.featureTemplateLabel', 'Feature branch template')}
          </label>
          <input
            value={settings.featureBranchTemplate}
            onChange={(event) => setSettings((prev) => ({ ...prev, featureBranchTemplate: event.target.value }))}
            className="w-full px-3 py-2 rounded-lg bg-background border border-border/60 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
            placeholder="feature/{planSlug}/{featureSlug}"
          />
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium text-foreground">
            {t(
              'settings.architectGitFlow.standaloneFeatureTemplateLabel',
              'Independent feature branch template'
            )}
          </label>
          <input
            value={settings.standaloneFeatureBranchTemplate}
            onChange={(event) =>
              setSettings((prev) => ({ ...prev, standaloneFeatureBranchTemplate: event.target.value }))
            }
            className="w-full px-3 py-2 rounded-lg bg-background border border-border/60 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
            placeholder="feature/{featureSlug}"
          />
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium text-foreground">
            {t('settings.architectGitFlow.releaseTemplateLabel', 'Release branch template')}
          </label>
          <input
            value={settings.releaseBranchTemplate}
            onChange={(event) => setSettings((prev) => ({ ...prev, releaseBranchTemplate: event.target.value }))}
            className="w-full px-3 py-2 rounded-lg bg-background border border-border/60 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
            placeholder="release/{releaseSlug}"
          />
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium text-foreground">
            {t('settings.architectGitFlow.hotfixTemplateLabel', 'Hotfix branch template')}
          </label>
          <input
            value={settings.hotfixBranchTemplate}
            onChange={(event) => setSettings((prev) => ({ ...prev, hotfixBranchTemplate: event.target.value }))}
            className="w-full px-3 py-2 rounded-lg bg-background border border-border/60 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
            placeholder="hotfix/{hotfixSlug}"
          />
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium text-foreground">
            {t('settings.architectGitFlow.bugfixTemplateLabel', 'Bugfix branch template')}
          </label>
          <input
            value={settings.bugfixBranchTemplate}
            onChange={(event) => setSettings((prev) => ({ ...prev, bugfixBranchTemplate: event.target.value }))}
            className="w-full px-3 py-2 rounded-lg bg-background border border-border/60 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
            placeholder="bugfix/{bugfixSlug}"
          />
        </div>

        <label className="flex items-start gap-3 rounded-lg border border-border/50 bg-muted/10 px-3 py-3">
          <input
            type="checkbox"
            checked={settings.syncTargetBeforeFinish}
            onChange={(event) =>
              setSettings((prev) => ({ ...prev, syncTargetBeforeFinish: event.target.checked }))
            }
            className="mt-0.5 h-4 w-4 rounded border-border bg-background"
          />
          <div className="space-y-1">
            <div className="text-sm font-medium text-foreground">
              {t(
                'settings.architectGitFlow.syncTargetBeforeFinishLabel',
                'Sync target branch before finishing'
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {t(
                'settings.architectGitFlow.syncTargetBeforeFinishHelp',
                'Pull the latest target branch before finishing a task or finalizing a plan.'
              )}
            </p>
          </div>
        </label>
      </section>

      <section className="space-y-2 bg-muted/20 border border-border/50 rounded-xl p-3">
        <div className="text-xs font-semibold text-foreground uppercase tracking-wide">
          {t('settings.architectGitFlow.previewTitle', 'Preview')}
        </div>
        <div className="text-xs text-muted-foreground font-mono">
          <div>{t('settings.architectGitFlow.previewMain', 'Main')}: {previews.mainBranch}</div>
          <div>{t('settings.architectGitFlow.previewTarget', 'Development target')}: {previews.targetBranch}</div>
          <div>{t('settings.architectGitFlow.previewPlan', 'Plan')}: {previews.planBranch}</div>
          <div>{t('settings.architectGitFlow.previewFeature', 'Feature')}: {previews.featureBranch}</div>
          <div>
            {t('settings.architectGitFlow.previewStandaloneFeature', 'Independent feature')}:
            {' '}
            {previews.standaloneFeatureBranch}
          </div>
          <div>{t('settings.architectGitFlow.previewRelease', 'Release')}: {previews.releaseBranch}</div>
          <div>{t('settings.architectGitFlow.previewHotfix', 'Hotfix')}: {previews.hotfixBranch}</div>
          <div>{t('settings.architectGitFlow.previewBugfix', 'Bugfix')}: {previews.bugfixBranch}</div>
        </div>
      </section>

      {validationErrors.length > 0 && (
        <section className="space-y-1 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2">
          {validationErrors.map((error) => (
            <p key={error} className="text-xs text-red-500">{error}</p>
          ))}
        </section>
      )}

      <section className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={handleReset}
          className="px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          {t('settings.architectGitFlow.reset', 'Reset defaults')}
        </button>
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={isSaving || validationErrors.length > 0}
          className={cn(
            'px-4 py-1.5 rounded-md text-xs font-medium transition-colors inline-flex items-center gap-1.5',
            saveSuccess
              ? 'bg-emerald-500/20 text-emerald-500'
              : 'bg-primary text-primary-foreground hover:bg-primary/90',
            (isSaving || validationErrors.length > 0) && 'opacity-50 cursor-not-allowed'
          )}
        >
          <Icon name={isSaving ? 'loader' : saveSuccess ? 'check' : 'download'} size={12} className={isSaving ? 'animate-spin' : ''} />
          {saveSuccess
            ? t('settings.architectGitFlow.saved', 'Saved')
            : t('settings.architectGitFlow.save', 'Save changes')}
        </button>
      </section>
    </div>
  );
};
