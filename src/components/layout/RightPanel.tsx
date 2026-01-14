import React from 'react';
import { useAppStore } from '../../stores/useAppStore';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../ui/Tabs';
import { GitTree } from '../git/GitTree';
import { Icon } from '../ui/Icon';

export const RightPanel: React.FC = () => {
  const { currentPlan, projectGroups } = useAppStore();

  if (!currentPlan) {
    return (
      <aside className="w-[320px] h-full bg-zinc-900 border-l border-zinc-800 flex items-center justify-center">
        <div className="text-center">
          <Icon name="git-branch" size={48} className="text-zinc-500 mx-auto mb-4" />
          <p className="text-zinc-500 text-sm">No plan selected</p>
        </div>
      </aside>
    );
  }

  // Get projects involved in current plan
  const activeProjects = projectGroups
    .flatMap((group) => group.projects)
    .filter((project) => currentPlan.project_ids.includes(project.id));

  return (
    <aside className="w-[320px] h-full bg-zinc-900 border-l border-zinc-800 flex flex-col">
      {/* Header */}
      <div className="h-12 border-b border-zinc-800 flex items-center justify-between px-4">
        <h1 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
          <Icon name="git-commit" size={16} className="text-indigo-500" />
          Predicted Changes
        </h1>
      </div>

      {/* Project Tabs */}
      <div className="flex-1 overflow-y-auto">
        <Tabs defaultValue={activeProjects[0]?.id || ''} className="h-full flex flex-col">
          <div className="px-4 pt-4">
            <TabsList className="w-full">
              {activeProjects.map((project) => (
                <TabsTrigger key={project.id} value={project.id} className="flex-1">
                  {project.name}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>

          {activeProjects.map((project) => {
            const gitTree = currentPlan.predicted_git_trees[project.id];
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
      </div>

      {/* Footer */}
      <div className="h-12 border-t border-zinc-800 flex items-center justify-between px-4 bg-zinc-900">
        <div className="flex items-center gap-2">
          <Icon name="git-branch" size={14} className="text-zinc-500" />
          <span className="text-xs text-zinc-500">
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
