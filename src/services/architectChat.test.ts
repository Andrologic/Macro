import { describe, expect, it } from 'bun:test';
import type { ArchitectPlanRecord } from './architectPlanService';
import {
  ARCHITECT_GENERATE_STRATEGY_BUTTON_PROMPT_SUFFIX,
  ARCHITECT_POST_TOOL_RESPONSE_INSTRUCTION,
  ARCHITECT_POST_TOOL_RETRY_SYSTEM_PROMPT,
  formatArchitectPlanListToolResult,
  formatArchitectStrategyGenerateToolResult,
} from './architectChat';

const createPlan = (overrides: Partial<ArchitectPlanRecord> = {}): ArchitectPlanRecord => ({
  id: 'plan-1',
  slug: 'plan-1',
  title: 'plan-1',
  label: 'Checkout refresh',
  description: 'Refresh checkout flows',
  status: 'draft',
  targetBranch: 'develop',
  conversationId: 'conv-1',
  projectId: 'project-1',
  projectIds: ['project-1'],
  createdAt: '2026-04-06T00:00:00.000Z',
  updatedAt: '2026-04-06T00:00:00.000Z',
  nodes: [],
  predictedBranches: [],
  ...overrides,
});

describe('architectChat', () => {
  it('exposes the architect post-tool recap contract', () => {
    expect(ARCHITECT_POST_TOOL_RESPONSE_INSTRUCTION).toContain('always answer in natural language');
    expect(ARCHITECT_POST_TOOL_RETRY_SYSTEM_PROMPT).toContain('Now answer in natural language');
    expect(ARCHITECT_GENERATE_STRATEGY_BUTTON_PROMPT_SUFFIX).toContain('short summary of the strategy');
  });

  it('formats plan list tool results with a summary before structured context', () => {
    const output = formatArchitectPlanListToolResult({
      targetBranch: 'develop',
      activePlanId: 'plan-1',
      plans: [
        {
          ...createPlan(),
          nodeCount: 4,
        },
      ],
    });

    expect(output.startsWith('Listed 1 plan on develop.')).toBe(true);
    expect(output).toContain('Active plan: Checkout refresh - plan-1.');
    expect(output).toContain('Structured context:');
    expect(output).toContain('"node_count": 4');
    expect(output).toContain('"target_branches_by_project_id"');
    expect(output).toContain('"effective_target_branch": "develop"');
  });

  it('formats generated strategies as recap-first tool outputs', () => {
    const output = formatArchitectStrategyGenerateToolResult({
      planId: 'plan-1',
      planTitle: 'Checkout refresh',
      planDescription: 'Refresh checkout flows',
      resolvedProjectIds: ['project-1', 'project-2'],
      targetBranchesByProjectId: {
        'project-1': 'develop',
        'project-2': 'develop',
      },
      planNodes: [
        {
          id: 'node-1',
          title: 'Inventory sync',
          description: 'Keep stock in sync',
          type: 'feature',
          status: 'pending',
          assignedBranch: 'feature/plan-1/inventory-sync',
          branchType: 'feature',
          branchSlug: 'inventory-sync',
          dependencies: [],
          projectId: 'project-1',
          projectIds: ['project-1'],
        },
      ],
      predictedBranches: [
        {
          id: 'branch-1',
          name: 'feature/plan-1/inventory-sync',
          color: '#3b82f6',
          parentBranch: 'plan/plan-1',
          projectId: 'project-1',
          taskIds: ['node-1'],
          status: 'pending',
          branchType: 'feature',
          branchSlug: 'inventory-sync',
        },
      ],
    });

    expect(output.startsWith('Strategy updated for Checkout refresh: 1 node, 1 branch, 1 root node, across 2 projects.')).toBe(
      true
    );
    expect(output).toContain('Structured context:');
    expect(output).toContain('"plan_id": "plan-1"');
    expect(output).toContain('"predicted_branches"');
  });
});
