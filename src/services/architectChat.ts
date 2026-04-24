import type { Need, PlanNode, PredictedBranch } from '../types';
import type { ArchitectPlanRecord, ArchitectPlanSummary } from './architectPlanService';
import type {
  FrozenPlanNode,
  StrategyMutationPreview,
} from './architectStrategyMutationGuard';
import {
  getArchitectPlanActionableProjectIds,
  getArchitectPlanVisibleProjectIds,
} from './architectPlanService';
import { getArchitectPlanDisplayName, isCanonicalArchitectPlan } from './architectPlanPresentation';

export const ARCHITECT_POST_TOOL_RESPONSE_INSTRUCTION =
  'After using an Architect tool, always answer in natural language with a concise recap of what changed, what you learned, and the next useful step. Do not stop at tool calls only.';

export const ARCHITECT_POST_TOOL_RETRY_SYSTEM_PROMPT =
  'You completed the requested planning action. Now answer in natural language with a concise recap of what changed, what you learned, and the next useful step. Do not stop at tool calls only.';

export const ARCHITECT_GENERATE_STRATEGY_BUTTON_PROMPT_SUFFIX =
  'After the tool call, answer in natural language with what changed, a short summary of the strategy, and the next useful step.';

type ArchitectPlanListItem = Pick<
  ArchitectPlanSummary,
  | 'id'
  | 'slug'
  | 'title'
  | 'label'
  | 'status'
  | 'description'
  | 'planKind'
  | 'gitFlowPlan'
  | 'targetBranch'
  | 'conversationId'
> & {
  nodeCount?: number;
};

const compactJsonBlock = (value: unknown): string => {
  const serialized = JSON.stringify(value, null, 2);
  if (!serialized || serialized === '{}' || serialized === '[]') {
    return '';
  }

  return `\n\nStructured context:\n${serialized}`;
};

const cleanLine = (value?: string | null): string => {
  if (typeof value !== 'string') {
    return '';
  }

  return value.replace(/\s+/g, ' ').trim();
};

const summarizePlanNode = (node: PlanNode) => ({
  id: node.id,
  title: node.title,
  ...(cleanLine(node.description) ? { description: cleanLine(node.description) } : {}),
  type: node.type,
  status: node.status,
  assigned_branch: node.assignedBranch,
  branch_type: node.branchType,
  branch_slug: node.branchSlug,
  dependencies: node.dependencies,
  project_ids:
    node.projectIds && node.projectIds.length > 0
      ? node.projectIds
      : node.projectId
        ? [node.projectId]
        : [],
});

const summarizePredictedBranch = (branch: PredictedBranch) => ({
  id: branch.id,
  name: branch.name,
  parent_branch: branch.parentBranch,
  project_id: branch.projectId,
  status: branch.status,
  branch_type: branch.branchType,
  branch_slug: branch.branchSlug,
  task_ids: branch.taskIds,
});

const summarizeFrozenPlanNode = (node: FrozenPlanNode) => ({
  id: node.id,
  title: node.title,
  reason: node.reason,
  status: node.status,
  dependencies: node.dependencies,
  project_ids: node.projectIds,
});

const summarizeNeed = (need: Need) => ({
  id: need.id,
  title: need.title,
  description: cleanLine(need.description) || '',
  category: need.category,
  priority: need.priority,
  status: need.status,
  tags: need.tags,
  created_at: need.createdAt,
  updated_at: need.updatedAt,
});

const formatArchitectToolResult = (summary: string, payload?: unknown): string =>
  `${summary.trim()}${payload === undefined ? '' : compactJsonBlock(payload)}`.trim();

const countRootNodes = (nodes: PlanNode[]): number =>
  nodes.filter((node) => node.dependencies.length === 0).length;

const countMaxDependencies = (nodes: PlanNode[]): number =>
  nodes.reduce((max, node) => Math.max(max, node.dependencies.length), 0);

export const buildArchitectPlanToolFollowUpInstruction = (): string =>
  ARCHITECT_POST_TOOL_RESPONSE_INSTRUCTION;

export const formatArchitectNeedAddToolResult = (params: {
  planId: string;
  needId: string;
  title: string;
  category: string;
  priority: string;
  tags: string[];
  totalNeeds: number;
}): string =>
  formatArchitectToolResult(
    `Need added to plan ${params.planId}: "${params.title}" (${params.category}, priority ${params.priority}). The active plan now has ${params.totalNeeds} identified need${params.totalNeeds === 1 ? '' : 's'}.`,
    {
      plan_id: params.planId,
      need_id: params.needId,
      title: params.title,
      category: params.category,
      priority: params.priority,
      tags: params.tags,
      total_needs: params.totalNeeds,
    }
  );

export const formatArchitectNeedListToolResult = (params: {
  planId: string;
  filters: {
    status?: string;
    category?: string;
    priority?: string;
    tag?: string;
  };
  needs: Need[];
}): string =>
  formatArchitectToolResult(
    `Listed ${params.needs.length} need${params.needs.length === 1 ? '' : 's'} for plan ${params.planId}.`,
    {
      plan_id: params.planId,
      filters: params.filters,
      total_needs: params.needs.length,
      needs: params.needs.map(summarizeNeed),
    }
  );

export const formatArchitectNeedGetToolResult = (params: {
  planId: string;
  need: Need;
}): string =>
  formatArchitectToolResult(
    `Loaded need "${params.need.title}" from plan ${params.planId}.`,
    {
      plan_id: params.planId,
      need: summarizeNeed(params.need),
    }
  );

export const formatArchitectNeedUpdateToolResult = (params: {
  planId: string;
  need: Need;
  changedFields: string[];
}): string =>
  formatArchitectToolResult(
    `Updated need "${params.need.title}" on plan ${params.planId}. Changed field${params.changedFields.length === 1 ? '' : 's'}: ${params.changedFields.join(', ') || 'none'}.`,
    {
      plan_id: params.planId,
      changed_fields: params.changedFields,
      need: summarizeNeed(params.need),
    }
  );

export const formatArchitectNeedDeleteToolResult = (params: {
  planId: string;
  needId: string;
  title: string;
  remainingNeeds: number;
}): string =>
  formatArchitectToolResult(
    `Deleted need "${params.title}" from plan ${params.planId}. ${params.remainingNeeds} need${params.remainingNeeds === 1 ? '' : 's'} remain.`,
    {
      plan_id: params.planId,
      need_id: params.needId,
      title: params.title,
      remaining_needs: params.remainingNeeds,
    }
  );

export const formatArchitectPlanListToolResult = (params: {
  targetBranch: string;
  activePlanId?: string | null;
  plans: ArchitectPlanListItem[];
}): string => {
  const activePlan = params.plans.find((plan) => plan.id === params.activePlanId) ?? null;
  const summary = `Listed ${params.plans.length} plan${params.plans.length === 1 ? '' : 's'} on ${params.targetBranch}. Active plan: ${activePlan ? getArchitectPlanDisplayName(activePlan) : 'none'}.`;

  return formatArchitectToolResult(summary, {
    target_branch: params.targetBranch,
    active_plan_id: params.activePlanId ?? null,
    plans: params.plans.map((plan) => ({
      id: plan.id,
      slug: plan.slug,
      title: plan.title,
      label: plan.label ?? null,
      display_name: getArchitectPlanDisplayName(plan),
      status: plan.status,
      plan_kind: plan.planKind || 'feature',
      git_flow: plan.gitFlowPlan ?? null,
      description: cleanLine(plan.description) || '',
      target_branch: plan.targetBranch,
      node_count: plan.nodeCount ?? 0,
      conversation_id: plan.conversationId ?? null,
    })),
  });
};

export const formatArchitectPlanGetToolResult = (plan: ArchitectPlanRecord): string =>
  formatArchitectToolResult(
    `Loaded plan ${getArchitectPlanDisplayName(plan)}: status ${plan.status}, ${plan.nodes.length} node${plan.nodes.length === 1 ? '' : 's'}, ${plan.predictedBranches.length} predicted branch${plan.predictedBranches.length === 1 ? '' : 'es'}.`,
    {
      id: plan.id,
      slug: plan.slug,
      title: plan.title,
      label: plan.label ?? null,
      display_name: getArchitectPlanDisplayName(plan),
      is_canonical: isCanonicalArchitectPlan(plan),
      description: cleanLine(plan.description) || '',
      plan_kind: plan.planKind || 'feature',
      git_flow: plan.gitFlowPlan ?? null,
      status: plan.status,
      target_branch: plan.targetBranch,
      conversation_id: plan.conversationId ?? null,
      project_ids: getArchitectPlanActionableProjectIds(plan),
      actionable_project_ids: getArchitectPlanActionableProjectIds(plan),
      context_project_ids: plan.contextProjectIds || [],
      visible_project_ids: getArchitectPlanVisibleProjectIds(plan),
      node_count: plan.nodes.length,
      branch_count: plan.predictedBranches.length,
      nodes: plan.nodes.map(summarizePlanNode),
      predicted_branches: plan.predictedBranches.map(summarizePredictedBranch),
    }
  );

export const formatArchitectPlanUpdateToolResult = (
  plan: ArchitectPlanRecord,
  activePlanId: string | null
): string =>
  formatArchitectToolResult(
    `Updated plan ${getArchitectPlanDisplayName(plan)}. Description and label metadata are now in sync; active=${plan.id === activePlanId ? 'yes' : 'no'}.`,
    {
      id: plan.id,
      slug: plan.slug,
      title: plan.title,
      label: plan.label ?? null,
      display_name: getArchitectPlanDisplayName(plan),
      description: cleanLine(plan.description) || '',
      plan_kind: plan.planKind || 'feature',
      git_flow: plan.gitFlowPlan ?? null,
      status: plan.status,
      target_branch: plan.targetBranch,
      active: plan.id === activePlanId,
    }
  );

export const formatArchitectStrategyGenerateToolResult = (params: {
  planId: string;
  planTitle: string;
  planDescription: string;
  planNodes: PlanNode[];
  predictedBranches: PredictedBranch[];
  resolvedProjectIds: string[];
  targetBranchesByProjectId: Record<string, string>;
}): string => {
  const nodeCount = params.planNodes.length;
  const branchCount = params.predictedBranches.length;
  const rootCount = countRootNodes(params.planNodes);
  const projectCount = params.resolvedProjectIds.length;

  return formatArchitectToolResult(
    `Strategy updated for ${params.planTitle || params.planId}: ${nodeCount} node${nodeCount === 1 ? '' : 's'}, ${branchCount} branch${branchCount === 1 ? '' : 'es'}, ${rootCount} root node${rootCount === 1 ? '' : 's'}, across ${projectCount} project${projectCount === 1 ? '' : 's'}.`,
    {
      plan_id: params.planId,
      plan_title: params.planTitle,
      plan_description: cleanLine(params.planDescription) || '',
      node_count: nodeCount,
      branch_count: branchCount,
      root_count: rootCount,
      project_ids: params.resolvedProjectIds,
      target_branches_by_project_id: params.targetBranchesByProjectId,
      nodes: params.planNodes.map(summarizePlanNode),
      predicted_branches: params.predictedBranches.map(summarizePredictedBranch),
    }
  );
};

export const formatArchitectStrategyGetToolResult = (plan: ArchitectPlanRecord): string =>
  (() => {
    const rootCount = countRootNodes(plan.nodes);
    return formatArchitectToolResult(
      `Loaded strategy for ${getArchitectPlanDisplayName(plan)}: ${plan.nodes.length} node${plan.nodes.length === 1 ? '' : 's'}, ${plan.predictedBranches.length} branch${plan.predictedBranches.length === 1 ? '' : 'es'}, ${rootCount} root node${rootCount === 1 ? '' : 's'}.`,
      {
        macro_branch: '@macro',
        plan_id: plan.id,
        strategy: {
          node_count: plan.nodes.length,
          branch_count: plan.predictedBranches.length,
          root_count: rootCount,
          max_dependencies_per_node: countMaxDependencies(plan.nodes),
          nodes: plan.nodes.map(summarizePlanNode),
          predicted_branches: plan.predictedBranches.map(summarizePredictedBranch),
        },
      }
    );
  })();

export const formatArchitectStrategyUpdateToolResult = (params: {
  planId: string;
  planNodes: PlanNode[];
  predictedBranches: PredictedBranch[];
}): string => {
  const nodeCount = params.planNodes.length;
  const branchCount = params.predictedBranches.length;
  return formatArchitectToolResult(
    `Updated strategy for plan ${params.planId}: ${nodeCount} node${nodeCount === 1 ? '' : 's'} and ${branchCount} branch${branchCount === 1 ? '' : 'es'}.`,
    {
      plan_id: params.planId,
      node_count: nodeCount,
      branch_count: branchCount,
      nodes: params.planNodes.map(summarizePlanNode),
      predicted_branches: params.predictedBranches.map(summarizePredictedBranch),
    }
  );
};

export const formatArchitectStrategyDeleteToolResult = (params: {
  planId: string;
}): string =>
  formatArchitectToolResult(
    `Deleted strategy for plan ${params.planId}. The active plan now has no strategy nodes or predicted branches.`,
    {
      plan_id: params.planId,
      node_count: 0,
      branch_count: 0,
    }
  );

export const formatArchitectStrategyMutationRepairToolResult = (params: {
  planId: string;
  source: 'strategy_generate' | 'strategy_update';
  conflicts: string[];
  frozenNodes: FrozenPlanNode[];
}): string =>
  formatArchitectToolResult(
    `Strategy mutation for plan ${params.planId} conflicted with frozen work. Call ${params.source} once more with a corrected full strategy that preserves every frozen node exactly.`,
    {
      action: 'repair_requested',
      plan_id: params.planId,
      source_tool: params.source,
      conflicts: params.conflicts,
      frozen_nodes: params.frozenNodes.map(summarizeFrozenPlanNode),
    }
  );

export const formatArchitectStrategyMutationPreviewToolResult = (
  preview: StrategyMutationPreview
): string => {
  const summary =
    preview.status === 'valid'
      ? `Strategy preview staged for ${preview.planTitle}: ${preview.frozenNodes.length} frozen node${preview.frozenNodes.length === 1 ? '' : 's'} preserved, ${preview.rewrittenPendingNodes.length} pending rewrite${preview.rewrittenPendingNodes.length === 1 ? '' : 's'}, ${preview.newNodes.length} new node${preview.newNodes.length === 1 ? '' : 's'}, ${preview.removedPendingNodes.length} pending removal${preview.removedPendingNodes.length === 1 ? '' : 's'}.`
      : `Strategy mutation blocked for ${preview.planTitle}. Review the conflicts before trying again.`;

  return formatArchitectToolResult(summary, {
    action: preview.status === 'valid' ? 'preview_staged' : 'blocked',
    plan_id: preview.planId,
    plan_title: preview.planTitle,
    source_tool: preview.source,
    preview_status: preview.status,
    next_plan_status: preview.nextPlanStatus,
    auto_provision_branches: preview.autoProvisionBranches,
    repair_attempted: preview.repairAttempted,
    requires_preview: preview.requiresPreview,
    frozen_nodes: preview.frozenNodes.map(summarizeFrozenPlanNode),
    rewritten_pending_nodes: preview.rewrittenPendingNodes,
    new_nodes: preview.newNodes,
    removed_pending_nodes: preview.removedPendingNodes,
    conflicts: preview.conflicts,
  });
};
