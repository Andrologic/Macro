import React, { useEffect, useMemo, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../stores/useAppStore';
import { services } from '../../services';
import { Icon } from '../ui/Icon';
import { Button } from '../ui/Button';
import { GroupCombobox } from '../ui/GroupCombobox';
import { ConfirmPromptModal } from '../ui/ConfirmPromptModal';
import { toServiceError } from '../../services/contracts/errors';
import {
  resolveProjectGitFlowSettings,
  validateProjectGitFlowSettings,
} from '../../services/architectGitNaming';
import { cn } from '../../utils/cn';
import { ProjectGitFlowConfirmationModal } from './ProjectGitFlowConfirmationModal';
import {
  buildProjectSetupPromptDetails,
  getProjectSetupAction,
  hasProjectSetupRisks,
  shouldPromptToCreateDevelop,
  type ProjectSetupPromptDetails,
} from './projectGitSetup';
import type { ProjectGitSetupRiskFlag } from '../../types';

type ProjectModalMode = 'new_group' | 'existing_group';

interface PendingProjectCreation {
  name: string;
  description: string;
  groupId: string | null;
  groupName?: string | null;
  path?: string;
  gitFlowSettings?: ReturnType<typeof resolveProjectGitFlowSettings>;
}

interface PendingGitFlowConfirmation {
  createPayload: PendingProjectCreation;
  branches: string[];
  currentBranch: string | null;
  mainBranch: string;
  baseBranch: string;
}

interface PendingProjectSetupPrompt {
  createPayload: PendingProjectCreation;
  details: ProjectSetupPromptDetails;
}

const normalizeProjectPath = (value: string): string =>
  value.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

const inferProjectNameFromPath = (value: string): string => {
  const parts = value.trim().replace(/\\/g, '/').replace(/\/+$/, '').split('/').filter(Boolean);
  return parts[parts.length - 1] || '';
};

export const ProjectModal: React.FC = () => {
  const { t } = useTranslation();
  const {
    projectModalOpen,
    projectModalGroupId,
    closeProjectModal,
    projectGroups,
    createProject,
  } = useAppStore();

  const [modalMode, setModalMode] = useState<ProjectModalMode>('new_group');
  const [targetGroupId, setTargetGroupId] = useState<string | null>(null);
  const [globalProjectName, setGlobalProjectName] = useState('');
  const [subProjectName, setSubProjectName] = useState('');
  const [subProjectPath, setSubProjectPath] = useState('');
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [pendingGitFlowConfirmation, setPendingGitFlowConfirmation] =
    useState<PendingGitFlowConfirmation | null>(null);
  const [pendingProjectSetupPrompt, setPendingProjectSetupPrompt] =
    useState<PendingProjectSetupPrompt | null>(null);

  const preselectedGroup = useMemo(
    () => projectGroups.find((group) => group.id === projectModalGroupId) ?? null,
    [projectGroups, projectModalGroupId]
  );
  const targetGroup = useMemo(
    () => projectGroups.find((group) => group.id === targetGroupId) ?? null,
    [projectGroups, targetGroupId]
  );
  const isAttachingToExistingGroup = modalMode === 'existing_group';

  useEffect(() => {
    if (!projectModalOpen) return;

    const defaultMode: ProjectModalMode = preselectedGroup ? 'existing_group' : 'new_group';
    setModalMode(defaultMode);
    setTargetGroupId(preselectedGroup?.id ?? null);
    setGlobalProjectName(preselectedGroup?.name ?? '');
    setSubProjectName('');
    setSubProjectPath('');
    setError('');
    setIsSubmitting(false);
    setPendingGitFlowConfirmation(null);
    setPendingProjectSetupPrompt(null);
  }, [preselectedGroup, projectModalOpen]);

  if (!projectModalOpen) return null;

  const allProjects = projectGroups.flatMap((group) => group.projects);
  const normalizedRequestedPath = normalizeProjectPath(subProjectPath);
  const duplicatePathProject =
    normalizedRequestedPath.length > 0
      ? allProjects.find((project) => normalizeProjectPath(project.path) === normalizedRequestedPath) ?? null
      : null;
  const submitLabel = isSubmitting
    ? t('project.saving', 'Saving...')
    : isAttachingToExistingGroup
      ? t('project.addSubproject', 'Add subproject')
      : t('project.createProject', 'Create project');
  const destinationSummary = isAttachingToExistingGroup
    ? targetGroup?.name || t('project.chooseGlobalProject', 'Choose a global project')
    : globalProjectName.trim() || t('project.newGlobalProject', 'New global project');
  const pendingGitFlowValidationError = pendingGitFlowConfirmation
    ? pendingGitFlowConfirmation.branches.length > 1 &&
      pendingGitFlowConfirmation.mainBranch === pendingGitFlowConfirmation.baseBranch
      ? t(
          'projects.gitFlowConfirmDistinctBranches',
          'Choose two different branches for main and development.'
        )
      : validateProjectGitFlowSettings(
          resolveProjectGitFlowSettings({
            mainBranch: pendingGitFlowConfirmation.mainBranch,
            baseBranch: pendingGitFlowConfirmation.baseBranch,
          })
        )[0] ?? null
    : null;

  const persistProject = async (payload: PendingProjectCreation) => {
    await createProject(payload);
    closeProjectModal();
  };

  const getRiskFlagLabel = (riskFlag: ProjectGitSetupRiskFlag): string => {
    if (riskFlag === 'env_file') {
      return t('project.gitSetupRiskEnvFile', 'Environment files detected (.env*)');
    }
    if (riskFlag === 'dependency_dir') {
      return t('project.gitSetupRiskDependencyDir', 'Dependency directories detected (node_modules, vendor, .pnpm)');
    }
    return t('project.gitSetupRiskBuildOutput', 'Build artifacts detected (dist, build, coverage)');
  };

  const continueProjectCreation = async (
    payload: PendingProjectCreation,
    projectPath?: string,
    detectionOverride?: Awaited<ReturnType<typeof services.previewProjectGitSetup>>
  ) => {
    if (!projectPath?.trim()) {
      await persistProject(payload);
      return;
    }

    const detection =
      detectionOverride ||
      await services.previewProjectGitSetup({
        path: projectPath,
      });
    const setupState = detection.setupState || (detection.repoDetected ? 'ready' : 'not_git');

    if (!detection.repoDetected || setupState === 'not_git') {
      setPendingProjectSetupPrompt({
        createPayload: payload,
        details: buildProjectSetupPromptDetails('init_git', projectPath, detection),
      });
      return;
    }

    if (setupState === 'unborn') {
      setPendingProjectSetupPrompt({
        createPayload: payload,
        details: buildProjectSetupPromptDetails('initial_commit', projectPath, detection),
      });
      return;
    }

    if (detection.repoDetected && (detection.requiresConfirmation || setupState === 'needs_branch_confirmation')) {
      const branches = Array.from(
        new Set(
          [
            ...detection.branches,
            detection.currentBranch ?? null,
            detection.suggestedMainBranch ?? null,
            detection.suggestedBaseBranch ?? null,
          ].filter((branch): branch is string => Boolean(branch?.trim()))
        )
      );
      const defaultBranch = branches[0] || '';
      setPendingGitFlowConfirmation({
        createPayload: payload,
        branches,
        currentBranch: detection.currentBranch ?? null,
        mainBranch: detection.suggestedMainBranch ?? detection.currentBranch ?? defaultBranch,
        baseBranch:
          detection.suggestedBaseBranch ??
          detection.currentBranch ??
          detection.suggestedMainBranch ??
          defaultBranch,
      });
      return;
    }

    if (
      shouldPromptToCreateDevelop(
        setupState,
        detection.suggestedMainBranch ?? detection.suggestedCommitBranch ?? detection.currentBranch
      )
    ) {
      setPendingProjectSetupPrompt({
        createPayload: payload,
        details: buildProjectSetupPromptDetails('create_develop', projectPath, detection),
      });
      return;
    }

    await persistProject(payload);
  };

  const handleBrowsePath = async () => {
    const selectedPath = await open({
      directory: true,
      multiple: false,
      defaultPath: subProjectPath || undefined,
      title: isAttachingToExistingGroup
        ? t('project.browseSubprojectFolder', 'Select Subproject Folder')
        : t('project.browseProjectFolder', 'Select Project Folder'),
    });

    if (!selectedPath || Array.isArray(selectedPath)) return;

    setSubProjectPath(selectedPath);
    setError('');

    if (!subProjectName.trim()) {
      const inferredName = inferProjectNameFromPath(selectedPath);
      if (inferredName) {
        setSubProjectName(inferredName);
      }
    }
  };

  const handleConfirmRareGitFlow = async () => {
    if (
      !pendingGitFlowConfirmation ||
      isSubmitting ||
      pendingGitFlowValidationError
    ) {
      return;
    }

    setError('');
    setIsSubmitting(true);
    try {
      await persistProject({
        ...pendingGitFlowConfirmation.createPayload,
        gitFlowSettings: resolveProjectGitFlowSettings({
          mainBranch: pendingGitFlowConfirmation.mainBranch,
          baseBranch: pendingGitFlowConfirmation.baseBranch,
        }),
      });
    } catch (submitError: unknown) {
      setError(toServiceError(submitError).message || t('project.saveFailed', 'Failed to save project'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleConfirmProjectSetupPrompt = async () => {
    if (!pendingProjectSetupPrompt || isSubmitting) {
      return;
    }

    setError('');
    setIsSubmitting(true);
    try {
      const { details } = pendingProjectSetupPrompt;
      const detection = await services.applyProjectGitSetup({
        path: details.projectPath,
        action: getProjectSetupAction(details.kind),
        expectedRepoRootPath: details.resolvedRepoRootPath ?? null,
      });
      setPendingProjectSetupPrompt(null);
      await continueProjectCreation(
        pendingProjectSetupPrompt.createPayload,
        details.projectPath,
        detection
      );
    } catch (submitError: unknown) {
      setError(toServiceError(submitError).message || t('project.saveFailed', 'Failed to save project'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeclineProjectSetupPrompt = async () => {
    if (!pendingProjectSetupPrompt || isSubmitting) {
      return;
    }

    setError('');
    setIsSubmitting(true);
    try {
      const payload =
        pendingProjectSetupPrompt.details.kind === 'create_develop'
          ? {
              ...pendingProjectSetupPrompt.createPayload,
              gitFlowSettings: resolveProjectGitFlowSettings({
                mainBranch: pendingProjectSetupPrompt.details.mainBranch || 'main',
                baseBranch: pendingProjectSetupPrompt.details.mainBranch || 'main',
              }),
            }
          : pendingProjectSetupPrompt.createPayload;
      setPendingProjectSetupPrompt(null);
      await persistProject(payload);
    } catch (submitError: unknown) {
      setError(toServiceError(submitError).message || t('project.saveFailed', 'Failed to save project'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSubmit = async () => {
    if (isSubmitting) return;
    setError('');

    const trimmedGlobalProjectName = globalProjectName.trim();
    const trimmedSubProjectName = subProjectName.trim();
    const trimmedSubProjectPath = subProjectPath.trim();

    if (isAttachingToExistingGroup && !targetGroupId) {
      setError(t('project.chooseExistingGlobalProjectFirst', 'Choose an existing global project first'));
      return;
    }

    if (!isAttachingToExistingGroup && !trimmedGlobalProjectName) {
      setError(t('project.globalProjectRequired', 'Global project name is required'));
      return;
    }

    if (!trimmedSubProjectName) {
      setError(t('project.subprojectRequired', 'Subproject name is required'));
      return;
    }

    if (
      isAttachingToExistingGroup &&
      targetGroup?.projects.some(
        (project) => project.name.trim().toLowerCase() === trimmedSubProjectName.toLowerCase()
      )
    ) {
      setError(
        t(
          'project.duplicateSubprojectName',
          'A subproject with this name already exists in this global project'
        )
      );
      return;
    }

    if (duplicatePathProject) {
      setError(
        t('project.folderAlreadyAttachedNamed', 'This folder is already attached to "{{name}}"', {
          name: duplicatePathProject.name,
        })
      );
      return;
    }

    const createPayload: PendingProjectCreation = {
      name: trimmedSubProjectName,
      description: '',
      groupId: isAttachingToExistingGroup ? targetGroupId : null,
      groupName: isAttachingToExistingGroup ? null : trimmedGlobalProjectName,
      path: trimmedSubProjectPath || undefined,
    };

    try {
      setIsSubmitting(true);
      await continueProjectCreation(createPayload, trimmedSubProjectPath || undefined);
    } catch (submitError: unknown) {
      setError(toServiceError(submitError).message || t('project.saveFailed', 'Failed to save project'));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-[560px] max-h-[88vh] bg-card border border-border rounded-2xl shadow-2xl overflow-hidden flex flex-col">
        <header className="h-14 px-5 border-b border-border flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-xl bg-primary/10 flex items-center justify-center">
              <Icon name="layers" size={16} className="text-primary" />
            </div>
            <div>
              <div className="text-sm font-semibold text-foreground">
                {t('project.addProjectTitle', 'Add Project')}
              </div>
              <div className="text-xs text-muted-foreground">
                {t(
                  'project.addProjectDescription',
                  'Create a global project or add a subproject to one that already exists.'
                )}
              </div>
            </div>
          </div>
          <button
            onClick={closeProjectModal}
            className="p-1.5 rounded-lg hover:bg-accent transition-colors"
          >
            <Icon name="x" size={14} className="text-muted-foreground" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto">
          <div className="p-5 space-y-4">
            <div className="inline-flex rounded-xl border border-border bg-muted/30 p-1">
              <button
                type="button"
                onClick={() => {
                  setModalMode('new_group');
                  setError('');
                }}
                className={cn(
                  'rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                  modalMode === 'new_group'
                    ? 'bg-card text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {t('project.newGlobalProject', 'New global project')}
              </button>
              <button
                type="button"
                onClick={() => {
                  setModalMode('existing_group');
                  if (!targetGroupId && preselectedGroup) {
                    setTargetGroupId(preselectedGroup.id);
                  }
                  setError('');
                }}
                className={cn(
                  'rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                  modalMode === 'existing_group'
                    ? 'bg-card text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {t('project.existingProject', 'Existing project')}
              </button>
            </div>

            <div className="space-y-4 rounded-2xl border border-border bg-card p-4">
              {isAttachingToExistingGroup ? (
                <div>
                  <label className="block text-sm text-muted-foreground mb-2">
                    {t('project.globalProject', 'Global project')} <span className="text-red-400">*</span>
                  </label>
                  <GroupCombobox
                    projectGroups={projectGroups.map((group) => ({ id: group.id, name: group.name }))}
                    selectedGroupId={targetGroupId}
                    onSelect={(groupId) => {
                      setTargetGroupId(groupId);
                      setError('');
                    }}
                    placeholder={t('project.chooseGlobalProject', 'Choose a global project...')}
                  />
                </div>
              ) : (
                <div>
                  <label className="block text-sm text-muted-foreground mb-2">
                    {t('project.globalProjectName', 'Global project name')} <span className="text-red-400">*</span>
                  </label>
                  <input
                    type="text"
                    value={globalProjectName}
                    onChange={(event) => {
                      setGlobalProjectName(event.target.value);
                      setError('');
                    }}
                    placeholder={t('project.globalProjectPlaceholder', 'e.g. Mobile App Suite')}
                    className="w-full bg-muted border border-border rounded-xl px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary"
                  />
                </div>
              )}

              <div>
                <label className="block text-sm text-muted-foreground mb-2">
                  {isAttachingToExistingGroup
                    ? t('project.subprojectName', 'Subproject name')
                    : t('project.firstSubprojectName', 'First subproject name')}{' '}
                  <span className="text-red-400">*</span>
                </label>
                <input
                  type="text"
                  value={subProjectName}
                  onChange={(event) => {
                    setSubProjectName(event.target.value);
                    setError('');
                  }}
                  placeholder={
                    isAttachingToExistingGroup
                      ? t('project.subprojectPlaceholder', 'e.g. iOS App')
                      : t('project.firstSubprojectPlaceholder', 'e.g. Backend API')
                  }
                  className="w-full bg-muted border border-border rounded-xl px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary"
                />
              </div>

              <div>
                <label className="block text-sm text-muted-foreground mb-2">
                  {t('project.localFolder', 'Local folder')}
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={subProjectPath}
                    onChange={(event) => {
                      setSubProjectPath(event.target.value);
                      setError('');
                    }}
                    placeholder={t('project.localFolderPlaceholder', 'e.g. C:/dev/mobile-suite/backend')}
                    className="flex-1 bg-muted border border-border rounded-xl px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      void handleBrowsePath();
                    }}
                    className="shrink-0 px-3 py-2.5 bg-accent rounded-xl text-sm text-muted-foreground hover:bg-accent/80 transition-colors"
                  >
                    {t('common.browse', 'Browse')}
                  </button>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span>
                    {t('project.targetSummary', 'Target')}: {destinationSummary}
                  </span>
                  {targetGroup && isAttachingToExistingGroup && (
                    <span>
                      |{' '}
                      {t('project.attachedReposCount', {
                        count: targetGroup.projects.length,
                        defaultValue: '{{count}} repos already attached',
                      })}
                    </span>
                  )}
                </div>
                {duplicatePathProject && (
                  <div className="mt-3 rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-300">
                    {t('project.folderAlreadyAttached', 'This folder is already attached to {{name}}.', {
                      name: duplicatePathProject.name,
                    })}
                  </div>
                )}
              </div>
            </div>

            {error && (
              <div className="flex items-center gap-2 text-red-400 text-sm bg-red-500/10 border border-red-500/20 rounded-xl px-3 py-2.5">
                <Icon name="alert-circle" size={14} />
                <span>{error}</span>
              </div>
            )}
          </div>
        </div>

        <footer className="h-16 px-5 border-t border-border flex items-center justify-end gap-3 bg-card/70">
          <Button
            variant="secondary"
            size="sm"
            onClick={closeProjectModal}
          >
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button
            size="sm"
            onClick={handleSubmit}
            disabled={isSubmitting}
            className="min-w-[160px]"
          >
            {isSubmitting ? (
              <span className="flex items-center gap-2">
                <Icon name="loader" size={14} className="animate-spin" />
                {submitLabel}
              </span>
            ) : (
              submitLabel
            )}
          </Button>
        </footer>
      </div>

      {pendingGitFlowConfirmation && (
        <ProjectGitFlowConfirmationModal
          projectName={subProjectName.trim() || inferProjectNameFromPath(subProjectPath) || destinationSummary}
          branches={pendingGitFlowConfirmation.branches}
          currentBranch={pendingGitFlowConfirmation.currentBranch}
          mainBranch={pendingGitFlowConfirmation.mainBranch}
          baseBranch={pendingGitFlowConfirmation.baseBranch}
          isSubmitting={isSubmitting}
          validationMessage={pendingGitFlowValidationError}
          errorMessage={pendingGitFlowValidationError ? null : error}
          onChangeMainBranch={(mainBranch) => {
            setError('');
            setPendingGitFlowConfirmation((prev) =>
              prev ? { ...prev, mainBranch } : prev
            );
          }}
          onChangeBaseBranch={(baseBranch) => {
            setError('');
            setPendingGitFlowConfirmation((prev) =>
              prev ? { ...prev, baseBranch } : prev
            );
          }}
          onClose={() => {
            if (isSubmitting) {
              return;
            }
            setPendingGitFlowConfirmation(null);
          }}
          onConfirm={() => void handleConfirmRareGitFlow()}
        />
      )}

      {pendingProjectSetupPrompt && (
        <ConfirmPromptModal
          isOpen
          title={
            pendingProjectSetupPrompt.details.kind === 'init_git'
              ? t('project.initGitTitle', 'Initialize Git?')
              : pendingProjectSetupPrompt.details.kind === 'initial_commit'
                ? t('project.initialCommitTitle', 'Create the initial commit?')
                : t('project.createDevelopTitle', 'Create develop?')
          }
          description={
            pendingProjectSetupPrompt.details.kind === 'init_git'
              ? t(
                  'project.initGitDescription',
                  'This folder is not a Git repository yet. Initialize Git now to enable worktrees and editable workflows. If you skip this step, the subproject will be added as read-only.'
                )
              : pendingProjectSetupPrompt.details.kind === 'initial_commit'
                ? t(
                    'project.initialCommitDescription',
                    'This repository has no initial commit yet. Create it now to enable branches, worktrees, and editable workflows. If you skip this step, the subproject will be added as read-only.'
                  )
                : t(
                    'project.createDevelopDescription',
                    'This repository only has a main branch. Create develop from {{mainBranch}} now? If you skip this step, future features will merge directly into {{mainBranch}}.',
                    {
                      mainBranch: pendingProjectSetupPrompt.details.mainBranch || 'main',
                      branchName: pendingProjectSetupPrompt.details.mainBranch || 'main',
                    }
                  )
          }
          confirmLabel={
            pendingProjectSetupPrompt.details.kind === 'create_develop'
              ? t('project.createDevelopConfirm', 'Create develop')
              : pendingProjectSetupPrompt.details.kind === 'initial_commit'
                ? t('project.createInitialCommitConfirm', 'Create commit')
                : t('project.initGitConfirm', 'Initialize Git')
          }
          cancelLabel={
            pendingProjectSetupPrompt.details.kind === 'create_develop'
              ? t('project.createDevelopDecline', 'Keep {{branchName}} only', {
                  branchName: pendingProjectSetupPrompt.details.mainBranch || 'main',
                })
              : t('project.keepReadOnly', 'Keep read-only')
          }
          isSubmitting={isSubmitting}
          onCancel={() => {
            void handleDeclineProjectSetupPrompt();
          }}
          onConfirm={() => {
            void handleConfirmProjectSetupPrompt();
          }}
        >
          <div className="space-y-3">
            {pendingProjectSetupPrompt.details.resolvedRepoRootPath && (
              <div className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground">
                  {t('project.gitSetupRepoRootLabel', 'Git repository root')}
                </div>
                <div className="mt-1 break-all font-mono text-xs text-muted-foreground">
                  {pendingProjectSetupPrompt.details.resolvedRepoRootPath}
                </div>
              </div>
            )}

            {pendingProjectSetupPrompt.details.kind === 'initial_commit' && (
              <div className="space-y-3 rounded-lg border border-border/60 bg-muted/20 px-3 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-xs font-semibold text-foreground">
                    {t('project.initialCommitPreviewTitle', 'Initial commit preview')}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {t('project.initialCommitPreviewCount', '{{count}} file(s)', {
                      count: pendingProjectSetupPrompt.details.initialCommitPreviewCount,
                    })}
                  </div>
                </div>

                {hasProjectSetupRisks(pendingProjectSetupPrompt.details.initialCommitRiskFlags) && (
                  <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-xs text-amber-200">
                    <div className="font-medium text-amber-100">
                      {t(
                        'project.initialCommitWarningTitle',
                        'Review the repository before creating the first commit.'
                      )}
                    </div>
                    <ul className="mt-1.5 space-y-1 text-[11px]">
                      {pendingProjectSetupPrompt.details.initialCommitRiskFlags.map((riskFlag) => (
                        <li key={riskFlag}>{getRiskFlagLabel(riskFlag)}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {pendingProjectSetupPrompt.details.initialCommitPreviewPaths.length > 0 ? (
                  <div className="max-h-44 overflow-y-auto rounded-md border border-border/50 bg-background/70 px-2.5 py-2">
                    <ul className="space-y-1 font-mono text-[11px] text-muted-foreground">
                      {pendingProjectSetupPrompt.details.initialCommitPreviewPaths.map((path) => (
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

export default ProjectModal;
