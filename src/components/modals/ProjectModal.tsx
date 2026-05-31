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
  getProjectSetupDevelopExplanation,
  getProjectSetupMainlineExplanation,
  getProjectSetupPromptCancelLabel,
  getProjectSetupPromptConfirmLabel,
  getProjectSetupPromptDescription,
  getProjectSetupPromptTitle,
  hasProjectSetupRisks,
} from './projectGitSetup';
import {
  advanceProjectSetupPrompt,
  buildDeclinedProjectSetupPayload,
  buildPendingGitFlowConfirmation,
  buildPendingProjectCreation,
  buildPendingProjectSetupPrompt,
  buildProjectWithGitSetupPayload,
  findProjectByPath,
  getAcceptedActionsAfterConfirmingPrompt,
  getAcceptedActionsAfterDecliningPrompt,
  getActiveProjectSetupPrompt,
  hasDuplicateSubProjectName,
  inferProjectNameFromPath,
  isValidProjectFolderName,
  joinProjectPath,
  shouldConfirmDetectedGitFlow,
  slugifyProjectFolderName,
  type PendingGitFlowConfirmation,
  type PendingProjectCreation,
  type PendingProjectSetupPrompt,
  type ProjectDestinationMode,
  type ProjectModalSourceMode,
} from './ProjectModal.helpers';
import type {
  Project,
  ProjectGitFlowDetection,
  ProjectGitSetupRiskFlag,
} from '../../types';

export const ProjectModal: React.FC = () => {
  const { t } = useTranslation();
  const {
    projectModalOpen,
    projectModalGroupId,
    closeProjectModal,
    standaloneProjects,
    projectGroups,
    createProject,
    createProjectWithGitSetup,
    createNewProjectRepo,
    createProjectGroup,
  } = useAppStore();

  const [sourceMode, setSourceMode] = useState<ProjectModalSourceMode>('new_repo');
  const [destinationMode, setDestinationMode] = useState<ProjectDestinationMode>('standalone');
  const [targetGroupId, setTargetGroupId] = useState<string | null>(null);
  const [repoName, setRepoName] = useState('');
  const [parentPath, setParentPath] = useState('');
  const [folderName, setFolderName] = useState('');
  const [folderNameTouched, setFolderNameTouched] = useState(false);
  const [subProjectPath, setSubProjectPath] = useState('');
  const [newGroupName, setNewGroupName] = useState('');
  const [selectedNewGroupProjectIds, setSelectedNewGroupProjectIds] = useState<string[]>([]);
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
  const isCreatingNewRepo = sourceMode === 'new_repo';
  const isAttachingToExistingGroup = destinationMode === 'existing_group';
  const isCreatingNewGroup = destinationMode === 'new_group';

  useEffect(() => {
    if (!projectModalOpen) return;

    const defaultDestinationMode: ProjectDestinationMode = preselectedGroup ? 'existing_group' : 'standalone';
    setSourceMode('new_repo');
    setDestinationMode(defaultDestinationMode);
    setTargetGroupId(preselectedGroup?.id ?? null);
    setRepoName('');
    setParentPath('');
    setFolderName('');
    setFolderNameTouched(false);
    setSubProjectPath('');
    setNewGroupName('');
    setSelectedNewGroupProjectIds([]);
    setError('');
    setIsSubmitting(false);
    setPendingGitFlowConfirmation(null);
    setPendingProjectSetupPrompt(null);
  }, [preselectedGroup, projectModalOpen]);

  if (!projectModalOpen) return null;

  const finalNewRepoPath = joinProjectPath(parentPath, folderName);
  const activeProjectPath = isCreatingNewRepo ? finalNewRepoPath : subProjectPath;
  const duplicatePathProject = findProjectByPath(projectGroups, activeProjectPath, standaloneProjects);
  const derivedExistingRepoName = inferProjectNameFromPath(subProjectPath);
  const derivedProjectName = isCreatingNewRepo ? repoName.trim() : derivedExistingRepoName;
  const submitLabel = isSubmitting
    ? t('project.saving', 'Saving...')
    : isCreatingNewGroup
      ? t('project.createProjectGroup', 'Create group')
    : isAttachingToExistingGroup
      ? isCreatingNewRepo
        ? t('project.createRepoInExistingGlobalProject', 'Create project')
        : t('project.addExistingRepoToGlobalProject', 'Add project')
      : isCreatingNewRepo
        ? t('project.createNewRepo', 'Create project')
        : t('project.addExistingRepo', 'Add existing project');
  const destinationSummary = isAttachingToExistingGroup
    ? targetGroup?.name || t('project.chooseGlobalProject', 'Choose a group')
    : isCreatingNewGroup
      ? newGroupName.trim() || t('project.newGlobalProject', 'New group')
    : t('project.noGroup', 'No group');
  const pendingGitFlowValidationError = pendingGitFlowConfirmation
    ? validateProjectGitFlowSettings(
        resolveProjectGitFlowSettings({
          mainBranch: pendingGitFlowConfirmation.mainBranch,
          baseBranch: pendingGitFlowConfirmation.baseBranch,
        })
      )[0] ?? null
    : null;
  const activeProjectSetupPrompt =
    getActiveProjectSetupPrompt(pendingProjectSetupPrompt);
  const setSourceModeAndClearError = (value: string) => {
    setSourceMode(value as ProjectModalSourceMode);
    setError('');
  };

  const setDestinationModeAndClearError = (value: string) => {
    const nextMode = value as ProjectDestinationMode;
    setDestinationMode(nextMode);
    if (nextMode === 'existing_group' && !targetGroupId && preselectedGroup) {
      setTargetGroupId(preselectedGroup.id);
    }
    setError('');
  };

  const toggleNewGroupProject = (projectId: string) => {
    setSelectedNewGroupProjectIds((current) =>
      current.includes(projectId)
        ? current.filter((selectedProjectId) => selectedProjectId !== projectId)
        : [...current, projectId]
    );
    setError('');
  };

  const createSelectedGroupForProject = async (project: Project) => {
    if (!isCreatingNewGroup) {
      return;
    }

    try {
      await createProjectGroup(newGroupName.trim(), [
        project.id,
        ...selectedNewGroupProjectIds,
      ]);
    } catch (groupError: unknown) {
      const message = toServiceError(groupError).message || t('common.error', 'An error occurred');
      throw new Error(
        t(
          'project.createGroupAfterProjectFailed',
          'Project added, but Macro could not create the group: {{message}}',
          { message }
        )
      );
    }
  };

  const persistProject = async (payload: PendingProjectCreation) => {
    const project = await createProject(payload);
    await createSelectedGroupForProject(project);
    closeProjectModal();
    return project;
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
    detectionOverride?: ProjectGitFlowDetection
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

    if (shouldConfirmDetectedGitFlow(detection)) {
      setPendingGitFlowConfirmation(buildPendingGitFlowConfirmation(payload, detection));
      return;
    }

    const projectSetupPrompt = buildPendingProjectSetupPrompt(payload, projectPath, detection);
    if (projectSetupPrompt) {
      setPendingProjectSetupPrompt(projectSetupPrompt);
      return;
    }

    await persistProject(payload);
  };

  const handleBrowsePath = async () => {
    const selectedPath = await open({
      directory: true,
      multiple: false,
      defaultPath: (isCreatingNewRepo ? parentPath : subProjectPath) || undefined,
      title: isCreatingNewRepo
        ? t('project.browseParentFolder', 'Select Parent Folder')
        : t('project.browseExistingRepoFolder', 'Select Existing Repo Folder'),
    });

    if (!selectedPath || Array.isArray(selectedPath)) return;

    if (isCreatingNewRepo) {
      setParentPath(selectedPath);
    } else {
      setSubProjectPath(selectedPath);
    }
    setError('');
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
    if (!pendingProjectSetupPrompt || !activeProjectSetupPrompt || isSubmitting) {
      return;
    }

    setError('');
    const nextPromptState = advanceProjectSetupPrompt(
      pendingProjectSetupPrompt,
      activeProjectSetupPrompt
    );

    if (nextPromptState) {
      setPendingProjectSetupPrompt(nextPromptState);
      return;
    }

    const nextAcceptedActions = getAcceptedActionsAfterConfirmingPrompt(
      pendingProjectSetupPrompt,
      activeProjectSetupPrompt
    );

    setIsSubmitting(true);
    try {
      const finalPayload = pendingProjectSetupPrompt.createPayload;
      const finalPath = activeProjectSetupPrompt.projectPath;
      const detection = pendingProjectSetupPrompt.detection;
      setPendingProjectSetupPrompt(null);

      if (!finalPath.trim()) {
        await persistProject(finalPayload);
        return;
      }

      const result = await createProjectWithGitSetup({
        ...buildProjectWithGitSetupPayload(
          finalPayload,
          finalPath,
          detection,
          nextAcceptedActions
        ),
      });
      await createSelectedGroupForProject(result.project);
      closeProjectModal();
    } catch (submitError: unknown) {
      setError(toServiceError(submitError).message || t('project.saveFailed', 'Failed to save project'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeclineProjectSetupPrompt = async () => {
    if (!pendingProjectSetupPrompt || !activeProjectSetupPrompt || isSubmitting) {
      return;
    }

    setError('');
    setIsSubmitting(true);
    try {
      const payload = buildDeclinedProjectSetupPayload(
        pendingProjectSetupPrompt.createPayload,
        activeProjectSetupPrompt
      );
      const acceptedActions = getAcceptedActionsAfterDecliningPrompt(
        pendingProjectSetupPrompt,
        activeProjectSetupPrompt
      );
      const finalPath = activeProjectSetupPrompt.projectPath;
      const detection = pendingProjectSetupPrompt.detection;
      setPendingProjectSetupPrompt(null);

      if (
        activeProjectSetupPrompt.kind === 'create_develop'
        && finalPath.trim()
      ) {
        const result = await createProjectWithGitSetup({
          ...buildProjectWithGitSetupPayload(
            payload,
            finalPath,
            detection,
            acceptedActions
          ),
        });
        await createSelectedGroupForProject(result.project);
        closeProjectModal();
        return;
      }

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

    const trimmedRepoName = repoName.trim();
    const trimmedParentPath = parentPath.trim();
    const trimmedFolderName = folderName.trim();
    const trimmedSubProjectPath = subProjectPath.trim();
    const trimmedActiveProjectPath = activeProjectPath.trim();

    if (isAttachingToExistingGroup && !targetGroupId) {
      setError(t('project.chooseExistingGlobalProjectFirst', 'Choose an existing group first'));
      return;
    }

    if (isCreatingNewGroup && !newGroupName.trim()) {
      setError(t('project.globalProjectRequired', 'Group name is required'));
      return;
    }

    if (isCreatingNewGroup && selectedNewGroupProjectIds.length === 0) {
      setError(t('project.chooseProjectsForNewGroup', 'Choose at least one project to include in the group'));
      return;
    }

    if (isCreatingNewRepo && !trimmedRepoName) {
      setError(t('project.repoNameRequired', 'Project name is required'));
      return;
    }

    if (isCreatingNewRepo && !trimmedParentPath) {
      setError(t('project.parentFolderRequired', 'Parent folder is required'));
      return;
    }

    if (isCreatingNewRepo && !isValidProjectFolderName(trimmedFolderName)) {
      setError(t('project.folderNameRequired', 'Folder name must be a single folder name'));
      return;
    }

    if (!isCreatingNewRepo && !derivedProjectName) {
      setError(t('project.repoPathRequired', 'Choose an existing project folder first'));
      return;
    }

    if (!trimmedActiveProjectPath) {
      setError(t('project.projectPathRequired', 'Project path is required'));
      return;
    }

    if (isAttachingToExistingGroup && hasDuplicateSubProjectName(targetGroup, derivedProjectName)) {
      setError(
        t(
          'project.duplicateSubprojectName',
          'A project with this name already exists in this group'
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

    if (isCreatingNewRepo) {
      try {
        setIsSubmitting(true);
        const result = await createNewProjectRepo({
          repoName: trimmedRepoName,
          parentPath: trimmedParentPath,
          folderName: trimmedFolderName,
          groupId: isAttachingToExistingGroup ? targetGroupId : null,
          groupName: null,
        });
        await createSelectedGroupForProject(result.project);
        closeProjectModal();
      } catch (submitError: unknown) {
        setError(toServiceError(submitError).message || t('project.saveFailed', 'Failed to save project'));
      } finally {
        setIsSubmitting(false);
      }
      return;
    }

    const createPayload = buildPendingProjectCreation({
      isAttachingToExistingGroup,
      targetGroupId,
      subProjectPath: trimmedSubProjectPath,
      derivedSubProjectName: derivedProjectName,
    });

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="flex max-h-[calc(100vh-2rem)] w-full max-w-[620px] flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl ring-1 ring-white/5">
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Icon name="folder-git-2" size={15} />
            </div>
            <div className="text-sm font-semibold text-foreground">
              {t('project.addProjectTitle', 'Add Project')}
            </div>
          </div>
          <button
            onClick={closeProjectModal}
            className="flex h-7 w-7 items-center justify-center rounded-lg hover:bg-accent transition-colors"
          >
            <Icon name="x" size={14} className="text-muted-foreground" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto">
          <div className="space-y-4 p-5">
            <div className="inline-flex rounded-xl border border-border bg-muted/30 p-1">
              <button
                type="button"
                onClick={() => setSourceModeAndClearError('new_repo')}
                className={cn(
                  'rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                  sourceMode === 'new_repo'
                    ? 'bg-card text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {t('project.newRepo', 'New project')}
              </button>
              <button
                type="button"
                onClick={() => setSourceModeAndClearError('existing_repo')}
                className={cn(
                  'rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                  sourceMode === 'existing_repo'
                    ? 'bg-card text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {t('project.existingRepo', 'Existing project')}
              </button>
            </div>

            <div className="space-y-4 rounded-2xl border border-border bg-card p-4">
              {isCreatingNewRepo ? (
                <>
                  <div className="grid gap-4 min-[520px]:grid-cols-2">
                    <div>
                      <label className="block text-sm text-muted-foreground mb-2">
                        {t('project.repoName', 'Project name')} <span className="text-red-400">*</span>
                      </label>
                      <input
                        type="text"
                        value={repoName}
                        onChange={(event) => {
                          const nextName = event.target.value;
                          setRepoName(nextName);
                          if (!folderNameTouched) {
                            setFolderName(slugifyProjectFolderName(nextName));
                          }
                          setError('');
                        }}
                        placeholder={t('project.repoNamePlaceholder', 'e.g. Backend API')}
                        className="w-full bg-muted border border-border rounded-xl px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary"
                      />
                    </div>

                    <div>
                      <label className="block text-sm text-muted-foreground mb-2">
                        {t('project.folderName', 'Folder name')} <span className="text-red-400">*</span>
                      </label>
                      <input
                        type="text"
                        value={folderName}
                        onChange={(event) => {
                          setFolderName(event.target.value);
                          setFolderNameTouched(true);
                          setError('');
                        }}
                        placeholder={t('project.folderNamePlaceholder', 'backend-api')}
                        className="w-full bg-muted border border-border rounded-xl px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm text-muted-foreground mb-2">
                      {t('project.parentFolder', 'Parent folder')} <span className="text-red-400">*</span>
                    </label>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={parentPath}
                        onChange={(event) => {
                          setParentPath(event.target.value);
                          setError('');
                        }}
                        placeholder={t('project.parentFolderPlaceholder', 'e.g. C:/dev/mobile-suite')}
                        className="min-w-0 flex-1 bg-muted border border-border rounded-xl px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          void handleBrowsePath();
                        }}
                        className="shrink-0 rounded-xl bg-accent px-3 py-2.5 text-sm text-muted-foreground transition-colors hover:bg-accent/80"
                      >
                        {t('common.browse', 'Browse')}
                      </button>
                    </div>
                    {finalNewRepoPath && (
                      <div className="mt-2 truncate font-mono text-xs text-muted-foreground" title={finalNewRepoPath}>
                        {t('project.finalRepoPath', 'Project folder')}: {finalNewRepoPath}
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <div>
                  <label className="block text-sm text-muted-foreground mb-2">
                    {t('project.existingRepoFolder', 'Existing project folder')} <span className="text-red-400">*</span>
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
                      className="min-w-0 flex-1 bg-muted border border-border rounded-xl px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        void handleBrowsePath();
                      }}
                      className="shrink-0 rounded-xl bg-accent px-3 py-2.5 text-sm text-muted-foreground transition-colors hover:bg-accent/80"
                    >
                      {t('common.browse', 'Browse')}
                    </button>
                  </div>
                </div>
              )}

              <div className="border-t border-border pt-4">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
	                  <label className="block text-sm text-muted-foreground">
	                    {t('project.destination', 'Destination')}
	                  </label>
	                  <div className="inline-flex rounded-lg border border-border bg-muted/30 p-0.5">
	                    <button
	                      type="button"
	                      onClick={() => setDestinationModeAndClearError('standalone')}
	                      className={cn(
	                        'rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors',
	                        destinationMode === 'standalone'
	                          ? 'bg-card text-foreground shadow-sm'
	                          : 'text-muted-foreground hover:text-foreground'
	                      )}
	                    >
	                      {t('project.noGroup', 'No group')}
	                    </button>
	                    <button
                      type="button"
                      onClick={() => setDestinationModeAndClearError('existing_group')}
                      className={cn(
                        'rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors',
                        destinationMode === 'existing_group'
                          ? 'bg-card text-foreground shadow-sm'
                          : 'text-muted-foreground hover:text-foreground'
                      )}
                    >
                      {t('project.existingGlobalProject', 'Existing group')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setDestinationModeAndClearError('new_group')}
                      className={cn(
                        'rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors',
                        destinationMode === 'new_group'
                          ? 'bg-card text-foreground shadow-sm'
                          : 'text-muted-foreground hover:text-foreground'
                      )}
                    >
                      {t('project.newGlobalProject', 'New group')}
                    </button>
                  </div>
                </div>

	                {isAttachingToExistingGroup ? (
	                  <div>
                    <GroupCombobox
                      projectGroups={projectGroups.map((group) => ({ id: group.id, name: group.name }))}
                      selectedGroupId={targetGroupId}
                      onSelect={(groupId) => {
                        setTargetGroupId(groupId);
                        setError('');
                      }}
                      placeholder={t('project.chooseGlobalProject', 'Choose a group...')}
                    />
                  </div>
	                ) : null}

                {isCreatingNewGroup ? (
                  <div className="space-y-3">
                    <div>
                      <label className="mb-2 block text-sm text-muted-foreground">
                        {t('project.globalProjectName', 'Group name')} <span className="text-red-400">*</span>
                      </label>
                      <input
                        type="text"
                        value={newGroupName}
                        onChange={(event) => {
                          setNewGroupName(event.target.value);
                          setError('');
                        }}
                        placeholder={t('project.globalProjectPlaceholder', 'e.g. Mobile Suite')}
                        className="w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
                      />
                    </div>

                    <div className="rounded-lg border border-border bg-muted/30 p-3">
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                          {t('project.groupProjects', 'Projects')}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {t('project.selectedProjectCount', '{{count}} selected', {
                            count: selectedNewGroupProjectIds.length + 1,
                          })}
                        </div>
                      </div>
                      <div className="mb-2 flex items-center gap-2 rounded-md bg-card px-2 py-1.5 text-sm text-foreground">
                        <Icon name="folder-git-2" size={14} className="text-primary" />
                        <span className="truncate">
                          {derivedProjectName || t('project.pendingProject', 'Project being added')}
                        </span>
                        <span className="ml-auto text-[11px] text-muted-foreground">
                          {t('project.includedAutomatically', 'Included')}
                        </span>
                      </div>
                      {standaloneProjects.length > 0 ? (
                        <div className="max-h-36 space-y-1 overflow-y-auto">
                          {standaloneProjects.map((project) => {
                            const checked = selectedNewGroupProjectIds.includes(project.id);
                            return (
                              <label
                                key={project.id}
                                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground hover:bg-accent/50"
                              >
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() => toggleNewGroupProject(project.id)}
                                  className="h-3.5 w-3.5 accent-primary"
                                />
                                <Icon name="folder" size={14} className="text-muted-foreground" />
                                <span className="truncate">{project.name}</span>
                              </label>
                            );
                          })}
                        </div>
                      ) : (
                        <div className="rounded-md border border-dashed border-border px-2 py-2 text-xs text-muted-foreground">
                          {t(
                            'project.noStandaloneProjectsForGroup',
                            'Add at least one standalone project before creating a group here.'
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                ) : null}

                {targetGroup && (
                  <div className="mt-2 text-xs text-muted-foreground">
                    {t('project.attachedReposCount', '{{count}} projects in this group', {
                      count: targetGroup.projects.length,
                    })}
                  </div>
                )}
              </div>

              {duplicatePathProject && (
                <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-300">
                  {t('project.folderAlreadyAttached', 'This folder is already attached to {{name}}.', {
                    name: duplicatePathProject.name,
                  })}
                </div>
              )}
            </div>

            {error && (
              <div className="flex items-center gap-2 rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2.5 text-sm text-red-400">
                <Icon name="alert-circle" size={14} />
                <span>{error}</span>
              </div>
            )}
          </div>
        </div>

        <footer className="flex h-14 shrink-0 items-center justify-end gap-3 border-t border-border bg-card/70 px-4">
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
          projectName={derivedProjectName || destinationSummary}
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

      {activeProjectSetupPrompt && (
        <ConfirmPromptModal
          isOpen
          title={getProjectSetupPromptTitle(t, activeProjectSetupPrompt)}
          description={getProjectSetupPromptDescription(t, activeProjectSetupPrompt, 'project_creation')}
          confirmLabel={getProjectSetupPromptConfirmLabel(t, activeProjectSetupPrompt)}
          cancelLabel={getProjectSetupPromptCancelLabel(t, activeProjectSetupPrompt)}
          isSubmitting={isSubmitting}
          onCancel={() => {
            void handleDeclineProjectSetupPrompt();
          }}
          onConfirm={() => {
            void handleConfirmProjectSetupPrompt();
          }}
        >
          <div className="space-y-3">
            {activeProjectSetupPrompt.kind === 'create_develop' && (
              <div className="space-y-2 text-xs">
                <div className="rounded-lg border border-sky-500/25 bg-sky-500/10 px-3 py-2 text-sky-200">
                  <span className="font-semibold">
                    {t('projects.gitWorkflowMainlineBadge', 'Mainline')}
                  </span>
                  {' - '}
                  {getProjectSetupMainlineExplanation(t, activeProjectSetupPrompt)}
                </div>
                <div className="rounded-lg border border-border bg-muted/20 px-3 py-2 text-muted-foreground">
                  <span className="font-semibold text-foreground">
                    {t('project.developModeLabel', 'Separate develop')}
                  </span>
                  {' - '}
                  {getProjectSetupDevelopExplanation(t, activeProjectSetupPrompt)}
                </div>
              </div>
            )}

            {activeProjectSetupPrompt.resolvedRepoRootPath && (
              <div className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground">
                  {t('project.gitSetupRepoRootLabel', 'Git repository root')}
                </div>
                <div className="mt-1 break-all font-mono text-xs text-muted-foreground">
                  {activeProjectSetupPrompt.resolvedRepoRootPath}
                </div>
              </div>
            )}

            {activeProjectSetupPrompt.kind === 'initial_commit' && (
              <div className="space-y-3 rounded-lg border border-border/60 bg-muted/20 px-3 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-xs font-semibold text-foreground">
                    {t('project.initialCommitPreviewTitle', 'Initial commit preview')}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {t('project.initialCommitPreviewCount', '{{count}} file(s)', {
                      count: activeProjectSetupPrompt.initialCommitPreviewCount,
                    })}
                  </div>
                </div>

                {hasProjectSetupRisks(activeProjectSetupPrompt.initialCommitRiskFlags) && (
                  <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-xs text-amber-200">
                    <div className="font-medium text-amber-100">
                      {t(
                        'project.initialCommitWarningTitle',
                        'Review the repository before creating the first commit.'
                      )}
                    </div>
                    <ul className="mt-1.5 space-y-1 text-[11px]">
                      {activeProjectSetupPrompt.initialCommitRiskFlags.map((riskFlag) => (
                        <li key={riskFlag}>{getRiskFlagLabel(riskFlag)}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {activeProjectSetupPrompt.initialCommitPreviewPaths.length > 0 ? (
                  <div className="max-h-44 overflow-y-auto rounded-md border border-border/50 bg-background/70 px-2.5 py-2">
                    <ul className="space-y-1 font-mono text-[11px] text-muted-foreground">
                      {activeProjectSetupPrompt.initialCommitPreviewPaths.map((path) => (
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
