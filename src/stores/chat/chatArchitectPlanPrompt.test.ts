import { describe, expect, it } from 'bun:test';
import type { ProjectExecutionContext } from '../../services/projectExecutionContext';
import { buildArchitectPlanInstructions } from './chatArchitectPlanPrompt';

const executionContext = {
  projectIds: [],
  projectMounts: [],
} as unknown as ProjectExecutionContext;
const options = { getProjectGitFlowSettings: () => null };
const activePlan = {
  id: 'plan-1',
  planKind: 'hotfix' as const,
  title: 'Repair startup',
  label: undefined,
  description: '',
  status: 'draft',
  slug: 'repair-startup',
  targetBranch: 'main',
  targetBranchesByProjectId: {},
  executionModesByProjectId: {},
  projectId: undefined,
  projectIds: [],
} satisfies NonNullable<Parameters<typeof buildArchitectPlanInstructions>[0]>;

describe('Architect plan authoring instructions', () => {
  it('builds the AgSDL instructions from an explicit authoring mode', () => {
    const instructions = buildArchitectPlanInstructions(activePlan, [], executionContext, options, {
      kind: 'agsdl',
      instruction: 'Read agsdl_get before agsdl_update.',
    }).join(' ');
    expect(instructions).toContain('Read agsdl_get before agsdl_update.');
    expect(instructions).toContain('id="plan-1"');
    expect(instructions).toContain('storageTargetBranch="main"');
    expect(instructions).toContain('before editing the AgSDL document');
    expect(instructions).toContain('plan_update.slug');
    expect(instructions).not.toContain('strategy_generate');
    expect(instructions).not.toContain('per-node `todos`');
  });

  it('preserves strategy instructions for callers using the default mode', () => {
    const instructions = buildArchitectPlanInstructions(activePlan, [], executionContext, options).join(' ');
    expect(instructions).toContain('strategy_generate');
    expect(instructions).toContain('per-node `todos`');
    expect(instructions).toContain('before strategy generation');
  });
});
