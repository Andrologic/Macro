import { describe, expect, it } from 'bun:test';
import { buildArchitectPlanInstructions } from './chatArchitectPlanPrompt';

describe('Architect authoring instructions', () => {
  it('gives AgSDL tools the system identity and storage branch', () => {
    const instructions = buildArchitectPlanInstructions({
      id: 'system-1', title: 'Order review', description: '', targetBranch: 'main', status: 'draft',
    }).join(' ');
    expect(instructions).toContain('agsdl_get');
    expect(instructions).toContain('agsdl_update');
    expect(instructions).toContain('id="system-1"');
    expect(instructions).toContain('storageTargetBranch="main"');
    expect(instructions).not.toMatch(/plan_update|strategy_generate/);
  });

  it('points to the navigator when no system is selected', () => {
    const instructions = buildArchitectPlanInstructions(null).join(' ');
    expect(instructions).toContain('create or select a system');
    expect(instructions).not.toContain('agsdl_update');
  });
});
