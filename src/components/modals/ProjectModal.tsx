import React, { useEffect, useMemo, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { useAppStore } from '../../stores/useAppStore';
import { Icon } from '../ui/Icon';
import { Button } from '../ui/Button';
import { GroupCombobox } from '../ui/GroupCombobox';
import { toServiceError } from '../../services/contracts/errors';
import { cn } from '../../utils/cn';

type ProjectModalMode = 'new_group' | 'existing_group';

const normalizeProjectPath = (value: string): string =>
  value.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

const inferProjectNameFromPath = (value: string): string => {
  const parts = value.trim().replace(/\\/g, '/').replace(/\/+$/, '').split('/').filter(Boolean);
  return parts[parts.length - 1] || '';
};

export const ProjectModal: React.FC = () => {
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
  }, [preselectedGroup, projectModalOpen]);

  if (!projectModalOpen) return null;

  const allProjects = projectGroups.flatMap((group) => group.projects);
  const normalizedRequestedPath = normalizeProjectPath(subProjectPath);
  const duplicatePathProject =
    normalizedRequestedPath.length > 0
      ? allProjects.find((project) => normalizeProjectPath(project.path) === normalizedRequestedPath) ?? null
      : null;
  const submitLabel = isSubmitting
    ? 'Saving...'
    : isAttachingToExistingGroup
      ? 'Add subproject'
      : 'Create project';
  const destinationSummary = isAttachingToExistingGroup
    ? targetGroup?.name || 'Choose a global project'
    : globalProjectName.trim() || 'New global project';

  const handleBrowsePath = async () => {
    const selectedPath = await open({
      directory: true,
      multiple: false,
      defaultPath: subProjectPath || undefined,
      title: isAttachingToExistingGroup ? 'Select Subproject Folder' : 'Select Project Folder',
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

  const handleSubmit = async () => {
    if (isSubmitting) return;
    setError('');

    const trimmedGlobalProjectName = globalProjectName.trim();
    const trimmedSubProjectName = subProjectName.trim();
    const trimmedSubProjectPath = subProjectPath.trim();

    if (isAttachingToExistingGroup && !targetGroupId) {
      setError('Choose an existing global project first');
      return;
    }

    if (!isAttachingToExistingGroup && !trimmedGlobalProjectName) {
      setError('Global project name is required');
      return;
    }

    if (!trimmedSubProjectName) {
      setError('Subproject name is required');
      return;
    }

    if (
      isAttachingToExistingGroup &&
      targetGroup?.projects.some(
        (project) => project.name.trim().toLowerCase() === trimmedSubProjectName.toLowerCase()
      )
    ) {
      setError('A subproject with this name already exists in this global project');
      return;
    }

    if (duplicatePathProject) {
      setError(`This folder is already attached to "${duplicatePathProject.name}"`);
      return;
    }

    try {
      setIsSubmitting(true);
      await createProject({
        name: trimmedSubProjectName,
        description: '',
        groupId: isAttachingToExistingGroup ? targetGroupId : null,
        groupName: isAttachingToExistingGroup ? null : trimmedGlobalProjectName,
        path: trimmedSubProjectPath || undefined,
      });
      closeProjectModal();
    } catch (submitError: unknown) {
      setError(toServiceError(submitError).message || 'Failed to save project');
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
              <div className="text-sm font-semibold text-foreground">Add Project</div>
              <div className="text-xs text-muted-foreground">
                Create a global project or add a subproject to one that already exists.
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
                New global project
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
                Existing project
              </button>
            </div>

            <div className="space-y-4 rounded-2xl border border-border bg-card p-4">
              {isAttachingToExistingGroup ? (
                <div>
                  <label className="block text-sm text-muted-foreground mb-2">
                    Global project <span className="text-red-400">*</span>
                  </label>
                  <GroupCombobox
                    projectGroups={projectGroups.map((group) => ({ id: group.id, name: group.name }))}
                    selectedGroupId={targetGroupId}
                    onSelect={(groupId) => {
                      setTargetGroupId(groupId);
                      setError('');
                    }}
                    placeholder="Choose a global project..."
                  />
                </div>
              ) : (
                <div>
                  <label className="block text-sm text-muted-foreground mb-2">
                    Global project name <span className="text-red-400">*</span>
                  </label>
                  <input
                    type="text"
                    value={globalProjectName}
                    onChange={(event) => {
                      setGlobalProjectName(event.target.value);
                      setError('');
                    }}
                    placeholder="e.g. Mobile App Suite"
                    className="w-full bg-muted border border-border rounded-xl px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary"
                  />
                </div>
              )}

              <div>
                <label className="block text-sm text-muted-foreground mb-2">
                  {isAttachingToExistingGroup ? 'Subproject name' : 'First subproject name'}{' '}
                  <span className="text-red-400">*</span>
                </label>
                <input
                  type="text"
                  value={subProjectName}
                  onChange={(event) => {
                    setSubProjectName(event.target.value);
                    setError('');
                  }}
                  placeholder={isAttachingToExistingGroup ? 'e.g. iOS App' : 'e.g. Backend API'}
                  className="w-full bg-muted border border-border rounded-xl px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary"
                />
              </div>

              <div>
                <label className="block text-sm text-muted-foreground mb-2">Local folder</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={subProjectPath}
                    onChange={(event) => {
                      setSubProjectPath(event.target.value);
                      setError('');
                    }}
                    placeholder="e.g. C:/dev/mobile-suite/backend"
                    className="flex-1 bg-muted border border-border rounded-xl px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      void handleBrowsePath();
                    }}
                    className="shrink-0 px-3 py-2.5 bg-accent rounded-xl text-sm text-muted-foreground hover:bg-accent/80 transition-colors"
                  >
                    Browse
                  </button>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span>Target: {destinationSummary}</span>
                  {targetGroup && isAttachingToExistingGroup && (
                    <span>| {targetGroup.projects.length} repo{targetGroup.projects.length > 1 ? 's' : ''} already attached</span>
                  )}
                </div>
                {duplicatePathProject && (
                  <div className="mt-3 rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-300">
                    This folder is already attached to {duplicatePathProject.name}.
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
            Cancel
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
    </div>
  );
};

export default ProjectModal;
