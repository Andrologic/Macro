import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../stores/useAppStore';
import { services } from '../../services';
import { toServiceError } from '../../services/contracts/errors';
import { Icon } from '../ui/Icon';
import { ConfirmPromptModal } from '../ui/ConfirmPromptModal';
import {
  getDefaultProjectGitFlowSettings,
  isMainlineGitWorkflow,
  renderGitFlowBranchName,
  renderStandaloneFeatureBranchName,
  resolveProjectGitFlowSettings,
  validateProjectGitFlowSettings,
} from '../../services/architectGitNaming';
import type {
  ProjectAccessChangePreview,
  ProjectGitFlowDetection,
  ProjectGitFlowSettings,
  ProjectGitSetupAction,
  ProjectGitSetupRiskFlag,
} from '../../types';
import { cn } from '../../utils/cn';
import { devLogger } from '../../utils/devLogger';
import { notify } from '../ui/toastService';
import {
  buildProjectSetupPrompts,
  getProjectSetupDevelopExplanation,
  getProjectSetupAction,
  getProjectSetupMainlineExplanation,
  getProjectSetupPromptCancelLabel,
  getProjectSetupPromptConfirmLabel,
  getProjectSetupPromptDescription,
  getProjectSetupPromptTitle,
  hasProjectSetupRisks,
  type ProjectSetupPromptDetails,
} from './projectGitSetup';

interface ProjectSetupFlowState {
  detection: ProjectGitFlowDetection;
  prompts: ProjectSetupPromptDetails[];
  promptIndex: number;
  acceptedActions: ProjectGitSetupAction[];
}

const buildTemplatePreview = (settings: ProjectGitFlowSettings) => ({
  mainBranch: settings.mainBranch,
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
  standaloneFeatureBranch: renderStandaloneFeatureBranchName({
    featureSlug: 'quick-export',
    settings,
  }),
  releaseBranch: renderGitFlowBranchName({
    branchType: 'release',
    branchSlug: '1.5.0',
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
  const updateProjectGitFlowWithSetup = useAppStore((state) => state.updateProjectGitFlowWithSetup);
  const updateProjectAccess = useAppStore((state) => state.updateProjectAccess);
  const closeProjectGitFlowModal = useAppStore((state) => state.closeProjectGitFlowModal);
  const project = projectId ? getProjectById(projectId) : null;
  const [settings, setSettings] = useState<ProjectGitFlowSettings>(() => getDefaultProjectGitFlowSettings());
  const [isSaving, setIsSaving] = useState(false);
  const [isAccessSaving, setIsAccessSaving] = useState(false);
  const [accessPreview, setAccessPreview] = useState<ProjectAccessChangePreview | null>(null);
  const [projectSetupFlow, setProjectSetupFlow] = useState<ProjectSetupFlowState | null>(null);

  useEffect(() => {
    if (!project) {
      return;
    }
    setSettings(resolveProjectGitFlowSettings(project.gitFlowSettings));
    setIsSaving(false);
    setIsAccessSaving(false);
    setAccessPreview(null);
    setProjectSetupFlow(null);
  }, [project]);

  const appDefaults = useMemo(() => getDefaultProjectGitFlowSettings(), []);
  const validationErrors = useMemo(() => validateProjectGitFlowSettings(settings), [settings]);
  const previews = useMemo(() => buildTemplatePreview(settings), [settings]);
  const isMainlineWorkflow = useMemo(() => isMainlineGitWorkflow(settings), [settings]);
  const resolvedProjectPath = project?.path ?? '';
  const projectSetupPrompt = projectSetupFlow?.prompts[projectSetupFlow.promptIndex] ?? null;

  const getRiskFlagLabel = (riskFlag: ProjectGitSetupRiskFlag): string => {
    if (riskFlag === 'env_file') {
      return t('project.gitSetupRiskEnvFile', 'Environment files detected (.env*)');
    }
    if (riskFlag === 'dependency_dir') {
      return t('project.gitSetupRiskDependencyDir', 'Dependency directories detected (node_modules, vendor, .pnpm)');
    }
    return t('project.gitSetupRiskBuildOutput', 'Build artifacts detected (dist, build, coverage)');
  };

  const getBlockingReasonMessage = (reason: string): string => {
    if (reason === 'dirty_worktree') {
      return t(
        'projects.accessBlockDirtyWorktree',
        'This project still has a dirty worktree. Clean it up before switching to read-only.'
      );
    }
    if (reason === 'live_terminal') {
      return t(
        'projects.accessBlockLiveTerminal',
        'A live terminal session is still attached to this project. Close it before switching to read-only.'
      );
    }
    if (reason === 'last_actionable_plan') {
      return t(
        'projects.accessBlockLastActionablePlan',
        'This project is the last editable project in an active plan.'
      );
    }
    if (reason === 'last_actionable_feature') {
      return t(
        'projects.accessBlockLastActionableFeature',
        'This project is the last editable project in a manual feature.'
      );
    }
    if (reason === 'last_actionable_task') {
      return t(
        'projects.accessBlockLastActionableTask',
        'This project is the last editable project in an active task.'
      );
    }
    return t('common.error', 'An error occurred');
  };

  const continueProjectSetupFlow = (detection: ProjectGitFlowDetection) => {
    const prompts = buildProjectSetupPrompts(resolvedProjectPath, detection);
    if (prompts.length === 0) {
      setProjectSetupFlow(null);
      return;
    }

    setProjectSetupFlow({
      detection,
      prompts,
      promptIndex: 0,
      acceptedActions: [],
    });
  };

  const logProjectAccessEvent = (phase: string, payload: Record<string, unknown>) => {
    devLogger.info(
      JSON.stringify({
        event: 'project_access_modal',
        phase,
        at: new Date().toISOString(),
        projectId: project?.id ?? projectId ?? null,
        projectName: project?.name ?? null,
        ...payload,
      })
    );
  };

  if (!project) {
    return null;
  }

  const renderMigrationItem = (label: string, item: ProjectAccessChangePreview['migrationSummary'][keyof ProjectAccessChangePreview['migrationSummary']]) => {
    if (item.count === 0) {
      return null;
    }

    const visibleLabels = item.labels.slice(0, 3);
    const remainingCount = Math.max(0, item.count - visibleLabels.length);
    return (
      <div className="rounded-md border border-border/60 bg-muted/20 px-3 py-2">
        <div className="flex items-center justify-between gap-3">
          <div className="text-xs font-medium text-foreground">{label}</div>
          <div className="text-[11px] text-muted-foreground">{item.count}</div>
        </div>
        {visibleLabels.length > 0 && (
          <div className="mt-1.5 text-[11px] text-muted-foreground">
            {visibleLabels.join(', ')}
            {remainingCount > 0 ? ` +${remainingCount}` : ''}
          </div>
        )}
      </div>
    );
  };

  const accessBadgeLabel = project.isReadOnly
    ? t('projects.accessReadOnly', 'Read-only')
    : t('projects.accessEditable', 'Editable');
  const accessReason = project.readOnlyReason === 'manual'
    ? t('projects.accessManualReadOnly', 'This project is manually forced to read-only.')
    : project.readOnlyReason === 'missing_git'
      ? t('projects.accessMissingGit', 'Git is not initialized yet. This project stays read-only until Git is initialized.')
      : project.readOnlyReason === 'missing_initial_commit'
        ? t(
            'projects.accessMissingInitialCommit',
            'This Git repository has no initial commit yet. Create one to make the project editable.'
          )
        : project.readOnlyReason === 'manual_and_missing_git'
          ? t(
              'projects.accessManualAndMissingGit',
              'This project is manually read-only and Git is not initialized yet.'
            )
          : t(
              'projects.accessEditableHelp',
              'Editable projects can create worktrees, branches, terminal sessions, and implementation tasks.'
            );

  const handleClose = () => {
    if (!isSaving) {
      closeProjectGitFlowModal();
    }
  };

  const handleToggleAccess = async () => {
    if (!projectId || isAccessSaving || project.gitSetupState !== 'ready') {
      return;
    }

    setIsAccessSaving(true);
    try {
      const targetReadOnly = !project.userReadOnly;
      logProjectAccessEvent('toggle_requested', {
        targetReadOnly,
        gitSetupState: project.gitSetupState ?? null,
        isReadOnly: project.isReadOnly ?? false,
        userReadOnly: project.userReadOnly ?? false,
        readOnlyReason: project.readOnlyReason ?? null,
      });
      if (targetReadOnly) {
        const preview = await services.previewProjectAccessChange({
          projectId,
          targetReadOnly: true,
        });
        logProjectAccessEvent('preview_received', {
          canApply: preview.canApply,
          requiresConfirmation: preview.requiresConfirmation,
          blockingReasons: preview.blockingReasons,
          migrationSummary: preview.migrationSummary,
        });
        if (!preview.canApply) {
          notify.error(
            preview.blockingReasons.map(getBlockingReasonMessage).join(' ')
          );
          return;
        }
        if (preview.requiresConfirmation) {
          setAccessPreview(preview);
          return;
        }
      }

      await updateProjectAccess(projectId, targetReadOnly, false);
      logProjectAccessEvent('toggle_applied', {
        targetReadOnly,
        confirmedMigration: false,
      });
      notify.success(
        project.userReadOnly
          ? t('projects.projectNowEditable', '{{projectName}} is editable again.', {
              projectName: project.name,
            })
          : t('projects.projectNowReadOnly', '{{projectName}} is now read-only.', {
              projectName: project.name,
            })
      );
    } catch (error) {
      const normalized = toServiceError(error);
      console.error('[ProjectGitFlowModal] read-only toggle failed', normalized);
      logProjectAccessEvent('toggle_failed', {
        error: normalized.message,
        code: normalized.code,
        details: normalized.details ?? null,
      });
      const message = normalized.message || t('common.error', 'An error occurred');
      notify.error(message);
    } finally {
      setIsAccessSaving(false);
    }
  };

  const handlePrepareProjectGit = async () => {
    if (!projectId || isAccessSaving) {
      return;
    }

    setIsAccessSaving(true);
    try {
      const detection = await services.previewProjectGitSetup({ path: project.path });
      continueProjectSetupFlow(detection);
    } catch (error) {
      const message = error instanceof Error ? error.message : t('common.error', 'An error occurred');
      notify.error(message);
    } finally {
      setIsAccessSaving(false);
    }
  };

  const handleConfirmAccessPreview = async () => {
    if (!projectId || !accessPreview || isAccessSaving) {
      return;
    }

    setIsAccessSaving(true);
    try {
      logProjectAccessEvent('confirmation_apply_requested', {
        targetReadOnly: accessPreview.targetReadOnly,
        blockingReasons: accessPreview.blockingReasons,
        migrationSummary: accessPreview.migrationSummary,
      });
      await updateProjectAccess(projectId, accessPreview.targetReadOnly, true);
      setAccessPreview(null);
      logProjectAccessEvent('confirmation_apply_succeeded', {
        targetReadOnly: true,
        confirmedMigration: true,
      });
      notify.success(
        t('projects.projectNowReadOnly', '{{projectName}} is now read-only.', {
          projectName: project.name,
        })
      );
    } catch (error) {
      const normalized = toServiceError(error);
      console.error('[ProjectGitFlowModal] confirmed read-only toggle failed', normalized);
      logProjectAccessEvent('confirmation_apply_failed', {
        error: normalized.message,
        code: normalized.code,
        details: normalized.details ?? null,
      });
      const message = normalized.message || t('common.error', 'An error occurred');
      notify.error(message);
    } finally {
      setIsAccessSaving(false);
    }
  };

  const handleConfirmProjectSetupPrompt = async () => {
    if (!projectId || !projectSetupPrompt || !projectSetupFlow || isAccessSaving) {
      return;
    }

    setIsAccessSaving(true);
    try {
      const nextAcceptedActions = [
        ...projectSetupFlow.acceptedActions,
        getProjectSetupAction(projectSetupPrompt.kind),
      ];

      if (projectSetupFlow.promptIndex < projectSetupFlow.prompts.length - 1) {
        setProjectSetupFlow((prev) =>
          prev
            ? {
                ...prev,
                acceptedActions: nextAcceptedActions,
                promptIndex: prev.promptIndex + 1,
              }
            : prev
        );
        return;
      }

      const updatedSettings =
        projectSetupPrompt.kind === 'create_develop'
          ? resolveProjectGitFlowSettings({
              ...settings,
              mainBranch: projectSetupPrompt.mainBranch || settings.mainBranch || 'main',
              baseBranch: 'develop',
            })
          : resolveProjectGitFlowSettings(settings);
      setSettings(updatedSettings);
      setProjectSetupFlow(null);

      const result = await updateProjectGitFlowWithSetup(
        projectId,
        updatedSettings,
        nextAcceptedActions,
        projectSetupFlow.detection.resolvedRepoRootPath ?? null,
        projectSetupFlow.detection.setupState,
        projectSetupFlow.detection.recommendedActionSequence
      );

      if (result.detection.setupState === 'ready') {
        notify.success(
          t('projects.projectGitPrepared', 'Git is ready for {{projectName}}.', {
            projectName: project.name,
          })
        );
      }
    } catch (error) {
      const message = toServiceError(error).message || t('common.error', 'An error occurred');
      notify.error(message);
    } finally {
      setIsAccessSaving(false);
    }
  };

  const handleDeclineProjectSetupPrompt = async () => {
    if (!projectId || !projectSetupPrompt || !projectSetupFlow || isAccessSaving) {
      return;
    }

    setIsAccessSaving(true);
    try {
      if (projectSetupPrompt.kind === 'create_develop') {
        const fallbackBranch = projectSetupPrompt.mainBranch || settings.mainBranch || 'main';
        const updatedSettings = resolveProjectGitFlowSettings({
          ...settings,
          mainBranch: fallbackBranch,
          baseBranch: fallbackBranch,
        });
        setSettings(updatedSettings);
        setProjectSetupFlow(null);
        await updateProjectGitFlowWithSetup(
          projectId,
          updatedSettings,
          projectSetupFlow.acceptedActions,
          projectSetupFlow.detection.resolvedRepoRootPath ?? null,
          projectSetupFlow.detection.setupState,
          projectSetupFlow.detection.recommendedActionSequence
        );
      } else {
        setProjectSetupFlow(null);
      }
    } catch (error) {
      const message = toServiceError(error).message || t('common.error', 'An error occurred');
      notify.error(message);
    } finally {
      setIsAccessSaving(false);
    }
  };

  const handleSave = async () => {
    if (validationErrors.length > 0 || !projectId) {
      return;
    }
    setIsSaving(true);
    try {
      await updateProjectGitFlow(projectId, resolveProjectGitFlowSettings(settings));
      notify.success(
        t('projects.gitFlowSaved', 'Git workflow settings updated for {{projectName}}.', {
          projectName: project.name,
        })
      );
      closeProjectGitFlowModal();
    } catch (error) {
      const message = error instanceof Error ? error.message : t('common.error', 'An error occurred');
      notify.error(message);
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

  const renderCompletionMergePolicySelect = () => (
    <div className="space-y-2 md:col-span-2">
      <label className="text-sm font-medium text-foreground">
        {t('projects.gitFlowCompletionMergePolicy', 'Task completion merge policy')}
      </label>
      <select
        value={settings.completionMergePolicy}
        onChange={(event) =>
          setSettings((prev) => ({
            ...prev,
            completionMergePolicy:
              event.target.value === 'fast_forward' ? 'fast_forward' : 'merge_commit',
          }))
        }
        className="w-full rounded-lg border border-border/60 bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
      >
        <option value="merge_commit">
          {t('projects.gitFlowCompletionMergePolicyMergeCommit', 'Merge commit')}
        </option>
        <option value="fast_forward">
          {t('projects.gitFlowCompletionMergePolicyFastForward', 'Fast-forward when possible')}
        </option>
      </select>
      <p className="text-xs text-muted-foreground">
        {t(
          'projects.gitFlowCompletionMergePolicyHelp',
          'Merge commit keeps completed tasks visible in history. Fast-forward advances directly when Git can do so cleanly.'
        )}
      </p>
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={handleClose} />

      <div className="relative flex max-h-[calc(100vh-2rem)] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
        <div className="flex shrink-0 items-center justify-between border-b border-border px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold text-foreground">
              {t('projects.projectSettingsTitle', 'Project settings')}
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {t(
                'projects.projectSettingsSubtitle',
                'Manage access mode and override the branch naming used by this project.'
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

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5">
          <section className="rounded-xl border border-border/50 bg-muted/20 p-4">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-2">
                <div className="text-xs font-semibold uppercase tracking-wide text-foreground">
                  {t('projects.projectAccessTitle', 'Access')}
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      'rounded-full px-2.5 py-1 text-[11px] font-semibold',
                      project.isReadOnly
                        ? 'bg-amber-500/15 text-amber-300'
                        : 'bg-emerald-500/15 text-emerald-300'
                    )}
                  >
                    {accessBadgeLabel}
                  </span>
                  {isMainlineWorkflow && (
                    <span className="rounded-full bg-sky-500/15 px-2.5 py-1 text-[11px] font-semibold text-sky-300">
                      {t('projects.gitWorkflowMainlineBadge', 'Mainline')}
                    </span>
                  )}
                  <span className="text-xs text-muted-foreground">
                    {project.gitSetupState === 'ready'
                      ? t('projects.projectAccessGitReady', 'Git ready')
                      : project.gitSetupState === 'unborn'
                        ? t('projects.projectAccessGitUnborn', 'Initial commit missing')
                        : t('projects.projectAccessGitMissing', 'Git missing')}
                  </span>
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {accessReason}
                </p>
              </div>

              <div className="flex shrink-0 items-center gap-2">
                {project.gitSetupState === 'ready' ? (
                  <button
                    type="button"
                    onClick={() => void handleToggleAccess()}
                    disabled={isAccessSaving}
                    className={cn(
                      'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                      project.userReadOnly
                        ? 'bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/20'
                        : 'bg-amber-500/15 text-amber-300 hover:bg-amber-500/20',
                      isAccessSaving && 'cursor-not-allowed opacity-60'
                    )}
                  >
                    {isAccessSaving
                      ? t('common.saving', 'Saving...')
                      : project.userReadOnly
                        ? t('projects.makeEditable', 'Make editable')
                        : t('projects.makeReadOnly', 'Make read-only')}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void handlePrepareProjectGit()}
                    disabled={isAccessSaving}
                    className={cn(
                      'rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90',
                      isAccessSaving && 'cursor-not-allowed opacity-60'
                    )}
                  >
                    {isAccessSaving
                      ? t('common.saving', 'Saving...')
                      : project.gitSetupState === 'unborn'
                        ? t('projects.createInitialCommitAction', 'Create initial commit')
                        : t('projects.initializeGitAction', 'Initialize Git')}
                  </button>
                )}
              </div>
            </div>
          </section>

          <div className="grid gap-4 md:grid-cols-2">
            {renderInput(
              t('projects.gitFlowMainBranch', 'Main branch'),
              settings.mainBranch,
              'mainBranch',
              'main'
            )}
            {renderInput(
              t('projects.gitFlowBaseBranch', 'Development/target branch'),
              settings.baseBranch,
              'baseBranch',
              'main'
            )}
            {renderCompletionMergePolicySelect()}
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
              t('projects.gitFlowStandaloneFeatureTemplate', 'Independent feature branch template'),
              settings.standaloneFeatureBranchTemplate,
              'standaloneFeatureBranchTemplate',
              'feature/{featureSlug}'
            )}
            {renderInput(
              t('projects.gitFlowReleaseTemplate', 'Release branch template'),
              settings.releaseBranchTemplate,
              'releaseBranchTemplate',
              'release/v{releaseSlug}'
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
              <div className="truncate" title={previews.mainBranch}>{t('projects.gitFlowPreviewMain', 'Main')}: {previews.mainBranch}</div>
              <div className="truncate" title={previews.baseBranch}>{t('projects.gitFlowPreviewTarget', 'Development target')}: {previews.baseBranch}</div>
              <div className="truncate" title={previews.planBranch}>{t('projects.gitFlowPreviewPlan', 'Plan')}: {previews.planBranch}</div>
              <div className="truncate" title={previews.featureBranch}>{t('projects.gitFlowPreviewFeature', 'Feature')}: {previews.featureBranch}</div>
              <div className="truncate" title={previews.standaloneFeatureBranch}>
                {t('projects.gitFlowPreviewStandaloneFeature', 'Independent feature')}:
                {' '}
                {previews.standaloneFeatureBranch}
              </div>
              <div className="truncate" title={previews.releaseBranch}>{t('projects.gitFlowPreviewRelease', 'Release')}: {previews.releaseBranch}</div>
              <div className="truncate" title={previews.hotfixBranch}>{t('projects.gitFlowPreviewHotfix', 'Hotfix')}: {previews.hotfixBranch}</div>
              <div className="truncate" title={previews.bugfixBranch}>{t('projects.gitFlowPreviewBugfix', 'Bugfix')}: {previews.bugfixBranch}</div>
            </div>
          </section>

          {validationErrors.length > 0 && (
            <section className="space-y-1 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2">
              {validationErrors.map((error) => (
                <p key={error} className="text-xs text-red-500">{error}</p>
              ))}
            </section>
          )}

          <div className="flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
            <button
              type="button"
              onClick={() => {
                setSettings(appDefaults);
              }}
              className="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              {t('projects.gitFlowResetToDefaults', 'Reset to app defaults')}
            </button>

            <div className="flex shrink-0 items-center justify-end gap-2">
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
                  'bg-primary text-primary-foreground hover:bg-primary/90',
                  (isSaving || validationErrors.length > 0) && 'cursor-not-allowed opacity-50'
                )}
              >
                <Icon
                  name={isSaving ? 'loader' : 'check'}
                  size={12}
                  className={isSaving ? 'animate-spin' : ''}
                />
                {isSaving ? t('common.saving', 'Saving...') : t('common.validate', 'Validate')}
              </button>
            </div>
          </div>
        </div>
      </div>

      {accessPreview && (
        <ConfirmPromptModal
          isOpen
          title={t('projects.readOnlyImpactTitle', 'Switch to read-only?')}
          description={t(
            'projects.readOnlyImpactDescription',
            'Macro will remove this project from editable plan and task targets, but keep it available for context and read access.'
          )}
          confirmLabel={t('projects.makeReadOnly', 'Make read-only')}
          cancelLabel={t('common.cancel', 'Cancel')}
          isSubmitting={isAccessSaving}
          onCancel={() => {
            if (!isAccessSaving) {
              setAccessPreview(null);
            }
          }}
          onConfirm={() => {
            void handleConfirmAccessPreview();
          }}
        >
          <div className="space-y-2">
            {renderMigrationItem(
              t('projects.readOnlyImpactPlans', 'Plans'),
              accessPreview.migrationSummary.plans
            )}
            {renderMigrationItem(
              t('projects.readOnlyImpactManualFeatures', 'Manual features'),
              accessPreview.migrationSummary.manualFeatures
            )}
            {renderMigrationItem(
              t('projects.readOnlyImpactTasks', 'Tasks'),
              accessPreview.migrationSummary.tasks
            )}
            {renderMigrationItem(
              t('projects.readOnlyImpactWorktrees', 'Worktrees'),
              accessPreview.migrationSummary.worktrees
            )}
            {renderMigrationItem(
              t('projects.readOnlyImpactPredictedBranches', 'Predicted branches'),
              accessPreview.migrationSummary.predictedBranches
            )}
            {renderMigrationItem(
              t('projects.readOnlyImpactPlanNodes', 'Plan nodes'),
              accessPreview.migrationSummary.planNodes
            )}
            {renderMigrationItem(
              t('projects.readOnlyImpactExecutionTargets', 'Execution targets'),
              accessPreview.migrationSummary.executionTargets
            )}
          </div>
        </ConfirmPromptModal>
      )}

      {projectSetupPrompt && (
        <ConfirmPromptModal
          isOpen
          title={getProjectSetupPromptTitle(t, projectSetupPrompt)}
          description={getProjectSetupPromptDescription(t, projectSetupPrompt, 'project_settings')}
          confirmLabel={getProjectSetupPromptConfirmLabel(t, projectSetupPrompt)}
          cancelLabel={getProjectSetupPromptCancelLabel(t, projectSetupPrompt)}
          isSubmitting={isAccessSaving}
          onCancel={() => {
            void handleDeclineProjectSetupPrompt();
          }}
          onConfirm={() => {
            void handleConfirmProjectSetupPrompt();
          }}
        >
          <div className="space-y-3">
            {projectSetupPrompt.kind === 'create_develop' && (
              <div className="space-y-2 text-xs">
                <div className="rounded-lg border border-sky-500/25 bg-sky-500/10 px-3 py-2 text-sky-200">
                  <span className="font-semibold">
                    {t('projects.gitWorkflowMainlineBadge', 'Mainline')}
                  </span>
                  {' - '}
                  {getProjectSetupMainlineExplanation(t, projectSetupPrompt)}
                </div>
                <div className="rounded-lg border border-border bg-muted/20 px-3 py-2 text-muted-foreground">
                  <span className="font-semibold text-foreground">
                    {t('project.developModeLabel', 'Separate develop')}
                  </span>
                  {' - '}
                  {getProjectSetupDevelopExplanation(t, projectSetupPrompt)}
                </div>
              </div>
            )}

            {projectSetupPrompt.resolvedRepoRootPath && (
              <div className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground">
                  {t('project.gitSetupRepoRootLabel', 'Git repository root')}
                </div>
                <div className="mt-1 break-all font-mono text-xs text-muted-foreground">
                  {projectSetupPrompt.resolvedRepoRootPath}
                </div>
              </div>
            )}

            {projectSetupPrompt.kind === 'initial_commit' && (
              <div className="space-y-3 rounded-lg border border-border/60 bg-muted/20 px-3 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-xs font-semibold text-foreground">
                    {t('project.initialCommitPreviewTitle', 'Initial commit preview')}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {t('project.initialCommitPreviewCount', '{{count}} file(s)', {
                      count: projectSetupPrompt.initialCommitPreviewCount,
                    })}
                  </div>
                </div>

                {hasProjectSetupRisks(projectSetupPrompt.initialCommitRiskFlags) && (
                  <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-xs text-amber-200">
                    <div className="font-medium text-amber-100">
                      {t(
                        'project.initialCommitWarningTitle',
                        'Review the repository before creating the first commit.'
                      )}
                    </div>
                    <ul className="mt-1.5 space-y-1 text-[11px]">
                      {projectSetupPrompt.initialCommitRiskFlags.map((riskFlag) => (
                        <li key={riskFlag}>{getRiskFlagLabel(riskFlag)}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {projectSetupPrompt.initialCommitPreviewPaths.length > 0 ? (
                  <div className="max-h-44 overflow-y-auto rounded-md border border-border/50 bg-background/70 px-2.5 py-2">
                    <ul className="space-y-1 font-mono text-[11px] text-muted-foreground">
                      {projectSetupPrompt.initialCommitPreviewPaths.map((path) => (
                        <li key={path} className="break-all">
                          {path}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <p className="text-[11px] text-muted-foreground">
                    {t(
                      'project.initialCommitPreviewEmpty',
                      'No tracked files were previewed. Macro will still create an empty initial commit if needed.'
                    )}
                  </p>
                )}
              </div>
            )}
          </div>
        </ConfirmPromptModal>
      )}
    </div>
  );
};

export default ProjectGitFlowModal;
