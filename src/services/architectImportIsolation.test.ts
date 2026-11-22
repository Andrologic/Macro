import { describe, expect, it } from 'bun:test';

describe('architect module import isolation', () => {
  it('keeps architect service imports stable after architectChat loads first', async () => {
    const architectChat = await import('./architectChat');
    const architectGitFlowService = await import('./architectGitFlowService');
    const architectPlanService = await import('./architectPlanService');
    const architectStrategyMutationGuard = await import('./architectStrategyMutationGuard');
    const validProjectRegistry = await import('./validProjectRegistry');

    expect(typeof architectChat.formatArchitectPlanListToolResult).toBe('function');
    expect(typeof architectGitFlowService.provisionPlanBranches).toBe('function');
    expect(typeof architectPlanService.createArchitectPlanService).toBe('function');
    expect(typeof architectPlanService.listArchitectPlans).toBe('function');
    expect(typeof architectStrategyMutationGuard.applyStrategyMutationPreview).toBe('function');
    expect(typeof validProjectRegistry.loadValidProjectRegistrySnapshot).toBe('function');
    expect(typeof validProjectRegistry.buildValidProjectRegistrySnapshot).toBe('function');
  });
});
