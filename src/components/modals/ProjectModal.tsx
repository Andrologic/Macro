import React, { useState } from 'react';
import { useAppStore } from '../../stores/useAppStore';
import { Icon } from '../ui/Icon';
import { Button } from '../ui/Button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../ui/Tabs';
import { GroupCombobox } from '../ui/GroupCombobox';
import { Select } from '../ui/Select';

export const ProjectModal: React.FC = () => {
  const { projectModalOpen, closeProjectModal, projectGroups, createProject, importProject } = useAppStore();

  // New Project form state
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectDescription, setNewProjectDescription] = useState('');
  const [newProjectGroup, setNewProjectGroup] = useState<string | null>(null);
  const [newProjectPath, setNewProjectPath] = useState('');

  // Import Git form state
  const [gitUrl, setGitUrl] = useState('');
  const [gitBranch, setGitBranch] = useState('main');
  const [gitProjectName, setGitProjectName] = useState('');
  const [gitGroup, setGitGroup] = useState<string | null>(null);
  const [gitPath, setGitPath] = useState('');

  // Errors
  const [newProjectError, setNewProjectError] = useState('');
  const [gitError, setGitError] = useState('');

  const isSubmitting = false;

  if (!projectModalOpen) return null;

  // Auto-extract project name from git URL
  const handleGitUrlChange = (url: string) => {
    setGitUrl(url);
    setGitError('');

    // Try to extract project name from URL
    const patterns = [
      /github\.com[:/]([^/]+)\/([^/\.]+)/i,
      /gitlab\.com[:/]([^/]+)\/([^/\.]+)/i,
      /bitbucket\.org[:/]([^/]+)\/([^/\.]+)/i,
      /([^\/]+)\.git$/,
    ];

    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match) {
        const name = match[2] || match[1];
        setGitProjectName(name);
        return;
      }
    }

    setGitProjectName('');
  };

  const handleCreateProject = async () => {
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
      await createProject({
        name: newProjectName.trim(),
        description: newProjectDescription.trim(),
        groupId: newProjectGroup,
        path: newProjectPath.trim() || undefined,
      });

      // Reset form
      setNewProjectName('');
      setNewProjectDescription('');
      setNewProjectGroup(null);
      setNewProjectPath('');
      closeProjectModal();
    } catch (error: any) {
      setNewProjectError(error.message || 'Failed to create project');
    }
  };

  const handleImportGit = async () => {
    setGitError('');

    // Validation
    if (!gitUrl.trim()) {
      setGitError('Git URL is required');
      return;
    }

    if (!gitProjectName.trim()) {
      setGitError('Could not extract project name from URL');
      return;
    }

    // Validate URL format (basic)
    const urlPatterns = [
      /^https?:\/\/.+/i,
      /^git@.+:.+\.git$/i,
      /^[^:]+:.+\.git$/i,
    ];
    const isValidUrl = urlPatterns.some((pattern) => pattern.test(gitUrl));

    if (!isValidUrl) {
      setGitError('Invalid Git URL format');
      return;
    }

    try {
      await importProject({
        gitUrl: gitUrl.trim(),
        projectName: gitProjectName.trim(),
        branch: gitBranch,
        groupId: gitGroup,
        path: gitPath.trim() || undefined,
      });

      // Reset form
      setGitUrl('');
      setGitBranch('main');
      setGitProjectName('');
      setGitGroup(null);
      setGitPath('');
      closeProjectModal();
    } catch (error: any) {
      setGitError(error.message || 'Failed to import project');
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
          <Tabs defaultValue="new" className="p-4">
            <TabsList className="w-full mb-4">
              <TabsTrigger value="new" className="flex-1">
                <Icon name="plus" size={14} className="mr-2" />
                New Project
              </TabsTrigger>
              <TabsTrigger value="import" className="flex-1">
                <Icon name="git-branch" size={14} className="mr-2" />
                Import Git
              </TabsTrigger>
            </TabsList>

            {/* New Project Tab */}
            <TabsContent value="new" className="space-y-4">
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

              {/* Description */}
              <div>
                <label className="block text-sm text-muted-foreground mb-2">Description</label>
                <textarea
                  value={newProjectDescription}
                  onChange={(e) => setNewProjectDescription(e.target.value)}
                  placeholder="Brief description of your project..."
                  rows={3}
                  className="w-full bg-muted border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary resize-none"
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
                    className="absolute right-2 top-1/2 -translate-y-1/2 px-2 py-1 bg-accent rounded text-xs text-muted-foreground hover:bg-accent/80 transition-colors"
                    disabled
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
            </TabsContent>

            {/* Import Git Tab */}
            <TabsContent value="import" className="space-y-4">
              {/* Git URL */}
              <div>
                <label className="block text-sm text-muted-foreground mb-2">
                  Git Repository URL <span className="text-red-400">*</span>
                </label>
                <input
                  type="text"
                  value={gitUrl}
                  onChange={(e) => handleGitUrlChange(e.target.value)}
                  placeholder="https://github.com/owner/repo.git"
                  className="w-full bg-muted border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary font-mono"
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  Supports GitHub, GitLab, and other Git providers
                </p>
              </div>

              {/* Project Name */}
              <div>
                <label className="block text-sm text-muted-foreground mb-2">
                  Project Name <span className="text-red-400">*</span>
                </label>
                <input
                  type="text"
                  value={gitProjectName}
                  onChange={(e) => {
                    setGitProjectName(e.target.value);
                    setGitError('');
                  }}
                  placeholder="Auto-extracted from URL"
                  className="w-full bg-muted border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary"
                />
              </div>

              {/* Branch */}
              <div>
                <Select
                  label="Branch"
                  value={gitBranch}
                  onChange={(e) => setGitBranch(e.target.value)}
                >
                  <option value="main">main</option>
                  <option value="master">master</option>
                  <option value="develop">develop</option>
                  <option value="custom">Custom...</option>
                </Select>
              </div>

              {/* Group */}
              <div>
                <label className="block text-sm text-muted-foreground mb-2">Group</label>
                <GroupCombobox
                  projectGroups={projectGroups}
                  selectedGroupId={gitGroup}
                  onSelect={setGitGroup}
                />
              </div>

              {/* Local Path (Optional) */}
              <div>
                <label className="block text-sm text-muted-foreground mb-2">Clone To (Optional)</label>
                <div className="relative">
                  <input
                    type="text"
                    value={gitPath}
                    onChange={(e) => setGitPath(e.target.value)}
                    placeholder="e.g., /home/user/projects/my-repo"
                    className="w-full bg-muted border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary"
                  />
                  <button
                    type="button"
                    className="absolute right-2 top-1/2 -translate-y-1/2 px-2 py-1 bg-accent rounded text-xs text-muted-foreground hover:bg-accent/80 transition-colors"
                    disabled
                  >
                    Browse
                  </button>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Leave empty to clone to default location
                </p>
              </div>

              {/* Error */}
              {gitError && (
                <div className="flex items-center gap-2 text-red-400 text-sm bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
                  <Icon name="alert-circle" size={14} />
                  <span>{gitError}</span>
                </div>
              )}
            </TabsContent>
          </Tabs>
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
            onClick={async () => {
              const activeTab = document.querySelector('[data-state="active"]')?.textContent?.includes('Import');
              if (activeTab) {
                await handleImportGit();
              } else {
                await handleCreateProject();
              }
            }}
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
