import React, { useEffect, useState } from 'react';
import { useAppStore } from '../../stores/useAppStore';
import { useGitStore } from '../../stores/useGitStore';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../ui/Tabs';
import { GitTree } from '../git/GitTree';
import { GitGraph } from '../git/GitGraph';
import { Icon } from '../ui/Icon';
import { cn } from '../../utils/cn';

type PanelView = 'tree' | 'graph';

interface RightPanelProps {
  className?: string;
  width?: number;
}

export const RightPanel: React.FC<RightPanelProps> = ({ className, width }) => {
  const { currentPlan, projectGroups } = useAppStore();
  const [panelView, setPanelView] = useState<PanelView>('tree');
  const [selectedCommitId, setSelectedCommitId] = useState<string | null>(null);
  const { trees, commitsByProject, loadTree, loadCommits } = useGitStore();

  useEffect(() => {
    if (!currentPlan) return;
    const activeProjects = projectGroups
      .flatMap((group) => group.projects)
      .filter((project) => currentPlan.project_ids.includes(project.id));

    activeProjects.forEach((project) => {
      void loadTree(project.id);
      void loadCommits(project.id);
    });
  }, [currentPlan, projectGroups, loadTree, loadCommits]);

  if (!currentPlan) {
    return (
      <aside
        className="h-full bg-card border-l border-border flex items-center justify-center"
        style={{ width: width ? `${width}px` : '320px' }}
      >
        <div className="text-center">
          <Icon name="git-branch" size={48} className="text-muted-foreground mx-auto mb-4" />
          <p className="text-muted-foreground text-sm">No plan selected</p>
        </div>
      </aside>
    );
  }

  // Get projects involved in current plan
  const activeProjects = projectGroups
    .flatMap((group) => group.projects)
    .filter((project) => currentPlan.project_ids.includes(project.id));

  return (
    <aside
      className={cn('h-full bg-card border-l border-border flex flex-col', className)}
      style={{ width: width ? `${width}px` : '320px' }}
    >
      {/* Header */}
      <div className="h-12 border-b border-border flex items-center justify-between px-4">
        <h1 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <Icon
            name={panelView === 'tree' ? 'git-branch' : 'git-commit'}
            size={16}
            className="text-primary"
          />
          Repository
        </h1>
      </div>

      {/* View Toggle */}
      <div className="h-10 border-b border-border flex items-center px-4 gap-2">
        <button
          onClick={() => setPanelView('tree')}
          className={cn(
            'flex-1 px-3 py-2 text-sm font-medium rounded-lg transition-all duration-200',
            panelView === 'tree' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground'
          )}
        >
          <Icon name="git-branch" size={14} className="mr-2" />
          Git Tree
        </button>
        <button
          onClick={() => setPanelView('graph')}
          className={cn(
            'flex-1 px-3 py-2 text-sm font-medium rounded-lg transition-all duration-200',
            panelView === 'graph' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground'
          )}
        >
          <Icon name="git-commit" size={14} className="mr-2" />
          Graph
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {panelView === 'tree' && (
          <Tabs defaultValue={activeProjects[0]?.id || ''} className="h-full flex flex-col">
            <div className="px-4 pt-2">
              <TabsList className="w-full">
                {activeProjects.map((project) => (
                  <TabsTrigger key={project.id} value={project.id} className="flex-1">
                    {project.name}
                  </TabsTrigger>
                ))}
              </TabsList>
            </div>

            {activeProjects.map((project) => {
              const gitTree = trees[project.id] ?? currentPlan.predicted_git_trees[project.id];
              if (!gitTree) return null;

              return (
                <TabsContent key={project.id} value={project.id} className="flex-1 mt-0">
                  <GitTree
                    nodes={gitTree.structure}
                    modifiedFilesCount={gitTree.modified_files_count}
                    branch={gitTree.branch}
                  />
                </TabsContent>
              );
            })}
          </Tabs>
        )}

        {panelView === 'graph' && (
          <Tabs defaultValue={activeProjects[0]?.id || ''} className="h-full flex flex-col">
            <div className="px-4 pt-2">
              <TabsList className="w-full">
                {activeProjects.map((project) => (
                  <TabsTrigger key={project.id} value={project.id} className="flex-1">
                    {project.name}
                  </TabsTrigger>
                ))}
              </TabsList>
            </div>

            {activeProjects.map((project) => (
              <TabsContent key={project.id} value={project.id} className="flex-1 mt-0">
                <GitGraph
                  commits={commitsByProject[project.id] ?? []}
                  selectedCommitId={selectedCommitId}
                  onCommitClick={(commit) => setSelectedCommitId(commit.id)}
                />
              </TabsContent>
            ))}
          </Tabs>
        )}
      </div>

      {/* Footer */}
      <div className="h-12 border-t border-border flex items-center justify-between px-4 bg-card">
        <div className="flex items-center gap-2">
          <Icon name="git-branch" size={14} className="text-muted-foreground" />
          <span className="text-xs text-muted-foreground">
            {Object.values(currentPlan.predicted_git_trees).reduce(
              (acc, tree) => acc + tree.modified_files_count,
              0
            )}{' '}
            total changes
          </span>
        </div>
      </div>
    </aside>
  );
};
