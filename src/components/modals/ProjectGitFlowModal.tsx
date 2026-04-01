import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../stores/useAppStore';
import { Icon } from '../ui/Icon';
import {
  getDefaultProjectGitFlowSettings,
  renderGitFlowBranchName,
  resolveProjectGitFlowSettings,
  validateProjectGitFlowSettings,
} from '../../services/architectGitNaming';
import type { ProjectGitFlowSettings } from '../../types';
import { cn } from '../../utils/cn';
import { toast } from '../ui/Toaster';

const buildTemplatePreview = (settings: ProjectGitFlowSettings) => ({
  baseBranch: settings.baseBranch,
  planBranch: renderGitFlowBranchName({
    branchType: 'plan',
    planSlug: '20260401-checkout-rework',
    settings,
  }),
  featureBranch: renderGitFlowBranchName({
    branchType: 'feature',
    planSlug: '20260401-checkout-rework',
    branchSlug: 'invoice-retry',
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
});

export const ProjectGitFlowModal: React.FC = () => {
  const { t } = useTranslation();
  const projectId = useAppStore((state) => state.projectGitFlowModalProjectId);
  const getProjectById = useAppStore((state) => state.getProjectById);
  const updateProjectGitFlow = useAppStore((state) => state.updateProjectGitFlow);
  const closeProjectGitFlowModal = useAppStore((state) => state.closeProjectGitFlowModal);
  const project = projectId ? getProjectById(projectId) : null;
  const [settings, setSettings] = useState<ProjectGitFlowSettings>(() => getDefaultProjectGitFlowSettings());
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

  useEffect(() => {
    if (!project) {
      return;
    }
    setSettings(resolveProjectGitFlowSettings(project.gitFlowSettings));
    setIsSaving(false);
    setSaveSuccess(false);
  }, [project]);

  const appDefaults = useMemo(() => getDefaultProjectGitFlowSettings(), []);
  const validationErrors = useMemo(() => validateProjectGitFlowSettings(settings), [settings]);
  const previews = useMemo(() => buildTemplatePreview(settings), [settings]);

  if (!project) {
    return null;
  }

  const handleClose = () => {
    if (!isSaving) {
      closeProjectGitFlowModal();
    }
  };

  const handleSave = async () => {
    if (validationErrors.length > 0 || !projectId) {
      return;
    }
    setIsSaving(true);
    setSaveSuccess(false);
    try {
      await updateProjectGitFlow(projectId, resolveProjectGitFlowSettings(settings));
      setSaveSuccess(true);
      toast.success(
        t('projects.gitFlowSaved', 'GitFlow settings updated for {{projectName}}.', {
          projectName: project.name,
        })
      );
      window.setTimeout(() => setSaveSuccess(false), 2500);
    } catch (error) {
      const message = error instanceof Error ? error.message : t('common.error', 'An error occurred');
      toast.error(message);
    } finally {
      setIsSaving(false);
    }
  };

  const renderInput = (
    label: string,
    value: string,
    key: keyof ProjectGitFlowSettings,
    placeholder: string
  ) => (
    <div className="space-y-2">
      <label className="text-sm font-medium text-foreground">{label}</label>
      <input
        value={value}
        onChange={(event) => setSettings((prev) => ({ ...prev, [key]: event.target.value }))}
        className="w-full rounded-lg border border-border/60 bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
        placeholder={placeholder}
      />
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={handleClose} />

      <div className="relative mx-4 w-full max-w-2xl rounded-2xl border border-border bg-card shadow-2xl">
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold text-foreground">
              {t('projects.gitFlowModalTitle', 'GitFlow settings')}
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {t(
                'projects.gitFlowModalSubtitle',
                'Override the branch naming and target branch used by this subproject.'
              )}{' '}
              <span className="text-foreground">{project.name}</span>
            </p>
          </div>
          <button
            type="button"
            onClick={handleClose}
            className="rounded-lg p-1.5 transition-colors hover:bg-accent"
          >
            <Icon name="x" size={16} className="text-muted-foreground" />
          </button>
        </div>

        <div className="space-y-5 px-5 py-5">
          <div className="grid gap-4 md:grid-cols-2">
            {renderInput(
              t('projects.gitFlowBaseBranch', 'Target/base branch'),
              settings.baseBranch,
              'baseBranch',
              'develop'
            )}
            {renderInput(
              t('projects.gitFlowPlanTemplate', 'Plan branch template'),
              settings.planBranchTemplate,
              'planBranchTemplate',
              'plan/{planSlug}'
            )}
            {renderInput(
              t('projects.gitFlowFeatureTemplate', 'Feature branch template'),
              settings.featureBranchTemplate,
              'featureBranchTemplate',
              'feature/{planSlug}/{featureSlug}'
            )}
            {renderInput(
              t('projects.gitFlowReleaseTemplate', 'Release branch template'),
              settings.releaseBranchTemplate,
              'releaseBranchTemplate',
              'release/{releaseSlug}'
            )}
            {renderInput(
              t('projects.gitFlowHotfixTemplate', 'Hotfix branch template'),
              settings.hotfixBranchTemplate,
              'hotfixBranchTemplate',
              'hotfix/{hotfixSlug}'
            )}
            {renderInput(
              t('projects.gitFlowBugfixTemplate', 'Bugfix branch template'),
              settings.bugfixBranchTemplate,
              'bugfixBranchTemplate',
              'bugfix/{bugfixSlug}'
            )}
          </div>

          <section className="rounded-xl border border-border/50 bg-muted/20 p-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-foreground">
              {t('projects.gitFlowPreviewTitle', 'Preview')}
            </div>
            <div className="mt-2 space-y-1 font-mono text-xs text-muted-foreground">
              <div>{t('projects.gitFlowPreviewTarget', 'Target')}: {previews.baseBranch}</div>
              <div>{t('projects.gitFlowPreviewPlan', 'Plan')}: {previews.planBranch}</div>
              <div>{t('projects.gitFlowPreviewFeature', 'Feature')}: {previews.featureBranch}</div>
              <div>{t('projects.gitFlowPreviewRelease', 'Release')}: {previews.releaseBranch}</div>
              <div>{t('projects.gitFlowPreviewHotfix', 'Hotfix')}: {previews.hotfixBranch}</div>
              <div>{t('projects.gitFlowPreviewBugfix', 'Bugfix')}: {previews.bugfixBranch}</div>
            </div>
          </section>

          {validationErrors.length > 0 && (
            <section className="space-y-1 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2">
              {validationErrors.map((error) => (
                <p key={error} className="text-xs text-red-500">{error}</p>
              ))}
            </section>
          )}

          <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
            <button
              type="button"
              onClick={() => {
                setSettings(appDefaults);
                setSaveSuccess(false);
              }}
              className="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              {t('projects.gitFlowResetToDefaults', 'Reset to app defaults')}
            </button>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleClose}
                className="rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                {t('common.cancel', 'Cancel')}
              </button>
              <button
                type="button"
                onClick={() => void handleSave()}
                disabled={isSaving || validationErrors.length > 0}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-md px-4 py-1.5 text-xs font-medium transition-colors',
                  saveSuccess
                    ? 'bg-emerald-500/20 text-emerald-500'
                    : 'bg-primary text-primary-foreground hover:bg-primary/90',
                  (isSaving || validationErrors.length > 0) && 'cursor-not-allowed opacity-50'
                )}
              >
                <Icon
                  name={isSaving ? 'loader' : saveSuccess ? 'check' : 'download'}
                  size={12}
                  className={isSaving ? 'animate-spin' : ''}
                />
                {saveSuccess
                  ? t('common.saved', 'Saved')
                  : t('common.save', 'Save')}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ProjectGitFlowModal;
