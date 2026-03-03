import React, { useState } from 'react';
import { useAppStore } from '../../stores/useAppStore';
import { Icon } from '../ui/Icon';
import { Button } from '../ui/Button';
import { GroupCombobox } from '../ui/GroupCombobox';
import { open } from '@tauri-apps/plugin-dialog';

export const ProjectModal: React.FC = () => {
  const { projectModalOpen, closeProjectModal, projectGroups, createProject } = useAppStore();

  // New Project form state
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectGroup, setNewProjectGroup] = useState<string | null>(null);
  const [newProjectPath, setNewProjectPath] = useState('');

  // Errors
  const [newProjectError, setNewProjectError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (!projectModalOpen) return null;

  const handleBrowsePath = async () => {
    const selectedPath = await open({
      directory: true,
      multiple: false,
      defaultPath: newProjectPath || undefined,
      title: 'Select Project Folder',
    });

    if (!selectedPath || Array.isArray(selectedPath)) return;
    setNewProjectPath(selectedPath);
  };

  const handleCreateProject = async () => {
    if (isSubmitting) return;
    setNewProjectError('');

    // Validation
    if (!newProjectName.trim()) {
      setNewProjectError('Project name is required');
      return;
    }

    // Check if project name already exists in the selected group
    if (newProjectGroup) {
      const group = projectGroups.find((g) => g.id === newProjectGroup);
      if (group?.projects.some((p) => p.name === newProjectName.trim())) {
        setNewProjectError('A project with this name already exists in this group');
        return;
      }
    }

    try {
      setIsSubmitting(true);
      await createProject({
        name: newProjectName.trim(),
        description: '',
        groupId: newProjectGroup,
        path: newProjectPath.trim() || undefined,
      });

      // Reset form
      setNewProjectName('');
      setNewProjectGroup(null);
      setNewProjectPath('');
      closeProjectModal();
    } catch (error: any) {
      setNewProjectError(error.message || 'Failed to create project');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-[560px] max-h-[85vh] bg-card border border-border rounded-2xl shadow-2xl overflow-hidden flex flex-col">
        {/* Header */}
        <header className="h-12 px-4 border-b border-border flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Icon name="plus" size={16} className="text-primary" />
            <span className="text-sm text-foreground">Add Project</span>
          </div>
          <button
            onClick={closeProjectModal}
            className="p-1.5 rounded-lg hover:bg-accent transition-colors"
          >
            <Icon name="x" size={14} className="text-muted-foreground" />
          </button>
        </header>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          <div className="p-4 space-y-4">
              {/* Project Name */}
              <div>
                <label className="block text-sm text-muted-foreground mb-2">
                  Project Name <span className="text-red-400">*</span>
                </label>
                <input
                  type="text"
                  value={newProjectName}
                  onChange={(e) => {
                    setNewProjectName(e.target.value);
                    setNewProjectError('');
                  }}
                  placeholder="e.g., My Awesome Project"
                  className="w-full bg-muted border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary"
                />
              </div>

              {/* Group */}
              <div>
                <label className="block text-sm text-muted-foreground mb-2">Group</label>
                <GroupCombobox
                  projectGroups={projectGroups}
                  selectedGroupId={newProjectGroup}
                  onSelect={setNewProjectGroup}
                />
              </div>

              {/* Local Path (Optional) */}
              <div>
                <label className="block text-sm text-muted-foreground mb-2">Local Path (Optional)</label>
                <div className="relative">
                  <input
                    type="text"
                    value={newProjectPath}
                    onChange={(e) => setNewProjectPath(e.target.value)}
                    placeholder="e.g., /home/user/projects/my-project"
                    className="w-full bg-muted border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      void handleBrowsePath();
                    }}
                    className="absolute right-2 top-1/2 -translate-y-1/2 px-2 py-1 bg-accent rounded text-xs text-muted-foreground hover:bg-accent/80 transition-colors"
                  >
                    Browse
                  </button>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Leave empty to use default location
                </p>
              </div>

              {/* Error */}
              {newProjectError && (
                <div className="flex items-center gap-2 text-red-400 text-sm bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
                  <Icon name="alert-circle" size={14} />
                  <span>{newProjectError}</span>
                </div>
              )}
          </div>
        </div>

        {/* Footer */}
        <footer className="h-14 px-4 border-t border-border flex items-center justify-end gap-3 bg-card/50">
          <Button
            variant="secondary"
            size="sm"
            onClick={closeProjectModal}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleCreateProject}
            disabled={isSubmitting}
            className="min-w-[100px]"
          >
            {isSubmitting ? (
              <span className="flex items-center gap-2">
                <Icon name="loader" size={14} className="animate-spin" />
                Processing...
              </span>
            ) : (
              'Create Project'
            )}
          </Button>
        </footer>
      </div>
    </div>
  );
};

// Export both named and default for lazy loading compatibility
export default ProjectModal;
