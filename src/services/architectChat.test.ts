import { describe, expect, it } from 'bun:test';
import type { Need } from '../types';
import type { ArchitectPlanRecord } from './architectPlanService';
import {
  ARCHITECT_GENERATE_STRATEGY_BUTTON_PROMPT_SUFFIX,
  ARCHITECT_POST_TOOL_RESPONSE_INSTRUCTION,
  ARCHITECT_POST_TOOL_RETRY_SYSTEM_PROMPT,
  formatArchitectNeedGetToolResult,
  formatArchitectNeedListToolResult,
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

const createNeed = (overrides: Partial<Need> = {}): Need => ({
  id: 'need-1',
  planId: 'plan-1',
  title: 'Checkout recovery',
  description: 'Recover pending checkout sessions after payment redirects.',
  category: 'functional',
  status: 'refined',
  priority: 'high',
  tags: ['checkout', 'payments'],
  createdAt: '2026-04-06T00:00:00.000Z',
  updatedAt: '2026-04-07T00:00:00.000Z',
  ...overrides,
});

const readStructuredContext = (output: string): Record<string, unknown> => {
  const marker = 'Structured context:\n';
  const markerIndex = output.indexOf(marker);
  expect(markerIndex).toBeGreaterThan(-1);
  return JSON.parse(output.slice(markerIndex + marker.length));
};

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

  it('formats need list results as a compact index only', () => {
    const output = formatArchitectNeedListToolResult({
      planId: 'plan-1',
      filters: {
        priority: 'high',
      },
      needs: [
        createNeed({
          groupId: 'group-1',
          projectId: 'project-1',
          sourceMessageId: 'message-1',
        }),
      ],
    });

    expect(output.startsWith('Listed 1 need for plan plan-1.')).toBe(true);
    const payload = readStructuredContext(output);
    expect(payload).toEqual({
      plan_id: 'plan-1',
      filters: {
        priority: 'high',
      },
      total_needs: 1,
      needs: [
        {
          id: 'need-1',
          title: 'Checkout recovery',
          priority: 'high',
        },
      ],
    });

    const needListItem = (payload.needs as Array<Record<string, unknown>>)[0];
    expect(needListItem).not.toHaveProperty('description');
    expect(needListItem).not.toHaveProperty('category');
    expect(needListItem).not.toHaveProperty('status');
    expect(needListItem).not.toHaveProperty('tags');
    expect(needListItem).not.toHaveProperty('created_at');
    expect(needListItem).not.toHaveProperty('updated_at');
    expect(needListItem).not.toHaveProperty('group_id');
    expect(needListItem).not.toHaveProperty('project_id');
    expect(needListItem).not.toHaveProperty('source_message_id');
  });

  it('formats need get results with full details and present optional fields', () => {
    const output = formatArchitectNeedGetToolResult({
      planId: 'plan-1',
      need: createNeed({
        groupId: 'group-1',
        projectId: 'project-1',
        sourceMessageId: 'message-1',
      }),
    });

    expect(output.startsWith('Loaded need "Checkout recovery" from plan plan-1.')).toBe(true);
    expect(readStructuredContext(output)).toEqual({
      plan_id: 'plan-1',
      need: {
        id: 'need-1',
        title: 'Checkout recovery',
        description: 'Recover pending checkout sessions after payment redirects.',
        category: 'functional',
        priority: 'high',
        status: 'refined',
        tags: ['checkout', 'payments'],
        group_id: 'group-1',
        project_id: 'project-1',
        source_message_id: 'message-1',
        created_at: '2026-04-06T00:00:00.000Z',
        updated_at: '2026-04-07T00:00:00.000Z',
      },
    });
  });

  it('omits absent optional fields from need get details', () => {
    const payload = readStructuredContext(formatArchitectNeedGetToolResult({
      planId: 'plan-1',
      need: createNeed({
        groupId: undefined,
        projectId: undefined,
        sourceMessageId: undefined,
      }),
    }));

    const need = payload.need as Record<string, unknown>;
    expect(need).not.toHaveProperty('group_id');
    expect(need).not.toHaveProperty('project_id');
    expect(need).not.toHaveProperty('source_message_id');
    expect(need).toMatchObject({
      id: 'need-1',
      description: 'Recover pending checkout sessions after payment redirects.',
      category: 'functional',
      priority: 'high',
      status: 'refined',
      tags: ['checkout', 'payments'],
      created_at: '2026-04-06T00:00:00.000Z',
      updated_at: '2026-04-07T00:00:00.000Z',
    });
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
