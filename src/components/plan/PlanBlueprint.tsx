import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../stores/useAppStore';
import { Icon, IconName } from '../ui/Icon';
import { cn } from '../../utils/cn';
import type { PlanNode, PlanNodeStatus, PlanNodeType } from '../../types';

interface PlanBlueprintProps {
  className?: string;
}

const statusConfig: Record<PlanNodeStatus, { icon: IconName; color: string; label: string }> = {
  'pending': { icon: 'circle', color: 'text-muted-foreground', label: 'Pending' },
  'in-progress': { icon: 'loader', color: 'text-amber-500', label: 'In Progress' },
  'completed': { icon: 'check-circle', color: 'text-emerald-500', label: 'Completed' },
  'blocked': { icon: 'lock', color: 'text-red-400', label: 'Blocked' },
};

const typeConfig: Record<PlanNodeType, { icon: IconName; color: string }> = {
  'spec': { icon: 'file-text', color: 'text-blue-400' },
  'feature': { icon: 'code', color: 'text-purple-400' },
  'task': { icon: 'check-square', color: 'text-primary' },
  'milestone': { icon: 'flag', color: 'text-amber-400' },
};

interface NodeItemProps {
  node: PlanNode;
  isSelected: boolean;
  onSelect: () => void;
}

const NodeItem: React.FC<NodeItemProps> = ({ node, isSelected, onSelect }) => {
  const status = statusConfig[node.status];
  const type = typeConfig[node.type];

  return (
    <button
      onClick={onSelect}
      className={cn(
        'w-full text-left px-3 py-2.5 rounded-lg border transition-all duration-200 group',
        isSelected
          ? 'bg-primary/10 border-primary/30'
          : 'border-transparent hover:bg-accent'
      )}
    >
      <div className="flex items-start gap-3">
        {/* Type Icon */}
        <div className={cn(
          'w-6 h-6 rounded-lg flex items-center justify-center shrink-0 mt-0.5',
          isSelected ? 'bg-primary/20' : 'bg-muted'
        )}>
          <Icon name={type.icon} size={12} className={type.color} />
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-medium text-foreground truncate">
              {node.title}
            </h3>
          </div>

          {/* Status & Branch */}
          <div className="flex items-center gap-2 mt-1">
            <div className="flex items-center gap-1">
              <Icon
                name={status.icon}
                size={10}
                className={cn(status.color, node.status === 'in-progress' && 'animate-spin')}
              />
              <span className={cn('text-xs', status.color)}>{status.label}</span>
            </div>
            {node.assignedBranch && (
              <>
                <span className="text-muted-foreground/50">•</span>
                <span className="text-xs text-muted-foreground truncate">
                  {node.assignedBranch}
                </span>
              </>
            )}
          </div>

          {/* Dependencies indicator */}
          {node.dependencies.length > 0 && (
            <div className="flex items-center gap-1 mt-1.5 text-xs text-muted-foreground">
              <Icon name="git-merge" size={10} />
              <span>{node.dependencies.length} dépendance{node.dependencies.length > 1 ? 's' : ''}</span>
            </div>
          )}
        </div>

        {/* Time estimate */}
        {node.estimatedTime && (
          <span className="text-xs text-muted-foreground shrink-0">
            {node.estimatedTime}
          </span>
        )}
      </div>
    </button>
  );
};

export const PlanBlueprint: React.FC<PlanBlueprintProps> = ({ className }) => {
  const { t } = useTranslation();
  const { selectedGroupId, selectedProjectId, projectGroups, planNodes } = useAppStore();
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [filter, setFilter] = useState<PlanNodeStatus | 'all'>('all');

  const scopedPlanNodes = useMemo(() => {
    if (selectedProjectId) {
      return planNodes.filter((node: PlanNode) => node.projectId === selectedProjectId);
    }

    if (selectedGroupId) {
      const group = projectGroups.find((candidate) => candidate.id === selectedGroupId);
      const groupProjectIds = new Set(group?.projects.map((project) => project.id) ?? []);
      if (groupProjectIds.size === 0) return [];
      return planNodes.filter((node: PlanNode) => node.projectId && groupProjectIds.has(node.projectId));
    }

    return [];
  }, [selectedProjectId, selectedGroupId, projectGroups, planNodes]);

  // Group nodes by type
  const specs = scopedPlanNodes.filter((n: PlanNode) => n.type === 'spec');
  const features = scopedPlanNodes.filter((n: PlanNode) => n.type === 'feature');
  const milestones = scopedPlanNodes.filter((n: PlanNode) => n.type === 'milestone');

  // Filter nodes
  const filterNodes = (nodes: PlanNode[]) =>
    filter === 'all' ? nodes : nodes.filter((n: PlanNode) => n.status === filter);

  // Stats
  const completedCount = scopedPlanNodes.filter((n: PlanNode) => n.status === 'completed').length;
  const totalCount = scopedPlanNodes.length;
  const progress = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

  if (!selectedGroupId) {
    return (
      <aside
        className={cn("h-full w-full bg-card border-r border-border flex items-center justify-center", className)}
      >
        <div className="text-center px-6">
          <Icon name="layers" size={48} className="text-muted-foreground/50 mx-auto mb-4" />
          <p className="text-muted-foreground text-sm">
            {t('architect.selectProject', 'Select a project to view the plan')}
          </p>
        </div>
      </aside>
    );
  }

  return (
    <aside
      className={cn("h-full w-full bg-card border-r border-border flex flex-col", className)}
    >
      {/* Header */}
      <div className="h-12 border-b border-border flex items-center justify-between px-4">
        <h1 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <Icon name="map" size={16} className="text-primary" />
          {t('architect.blueprint', 'Blueprint')}
        </h1>
        <button className="p-1 hover:bg-accent rounded-md transition-colors">
          <Icon name="plus" size={16} className="text-muted-foreground" />
        </button>
      </div>

      {/* Progress Bar */}
      <div className="px-4 py-3 border-b border-border">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-muted-foreground">
            {t('architect.progress', 'Progress')}
          </span>
          <span className="text-xs font-medium text-foreground">
            {completedCount}/{totalCount} ({progress}%)
          </span>
        </div>
        <div className="h-1.5 bg-muted rounded-full overflow-hidden">
          <div
            className="h-full bg-primary rounded-full transition-all duration-500"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      {/* Filter Tabs */}
      <div className="px-3 py-2 border-b border-border flex gap-1">
        {(['all', 'in-progress', 'pending', 'completed', 'blocked'] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={cn(
              'px-2 py-1 rounded text-xs font-medium transition-colors',
              filter === f
                ? 'bg-primary/10 text-primary'
                : 'text-muted-foreground hover:text-foreground hover:bg-accent'
            )}
          >
            {f === 'all' ? 'Tous' : statusConfig[f]?.label || f}
          </button>
        ))}
      </div>

      {/* Node List */}
      <div className="flex-1 overflow-y-auto p-2 space-y-4">
        {/* Specs Section */}
        {filterNodes(specs).length > 0 && (
          <div>
            <div className="flex items-center gap-2 px-2 mb-2">
              <Icon name="file-text" size={12} className="text-blue-400" />
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Specifications
              </span>
            </div>
            <div className="space-y-1">
              {filterNodes(specs).map((node) => (
                <NodeItem
                  key={node.id}
                  node={node}
                  isSelected={selectedNodeId === node.id}
                  onSelect={() => setSelectedNodeId(node.id)}
                />
              ))}
            </div>
          </div>
        )}

        {/* Features Section */}
        {filterNodes(features).length > 0 && (
          <div>
            <div className="flex items-center gap-2 px-2 mb-2">
              <Icon name="code" size={12} className="text-purple-400" />
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Features
              </span>
            </div>
            <div className="space-y-1">
              {filterNodes(features).map((node) => (
                <NodeItem
                  key={node.id}
                  node={node}
                  isSelected={selectedNodeId === node.id}
                  onSelect={() => setSelectedNodeId(node.id)}
                />
              ))}
            </div>
          </div>
        )}

        {/* Milestones Section */}
        {filterNodes(milestones).length > 0 && (
          <div>
            <div className="flex items-center gap-2 px-2 mb-2">
              <Icon name="flag" size={12} className="text-amber-400" />
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Milestones
              </span>
            </div>
            <div className="space-y-1">
              {filterNodes(milestones).map((node) => (
                <NodeItem
                  key={node.id}
                  node={node}
                  isSelected={selectedNodeId === node.id}
                  onSelect={() => setSelectedNodeId(node.id)}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="h-14 border-t border-border flex items-center justify-center px-4 bg-card">
        <button className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors">
          <Icon name="check" size={14} />
          {t('architect.validate', 'Validate Plan')}
        </button>
      </div>
    </aside>
  );
};
