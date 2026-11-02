import { describe, expect, it } from 'bun:test';
import { getArchitectProfileAdjustedToolIds } from './architectToolSurface';

describe('Architect AgSDL authoring surface', () => {
  it('removes retired strategy tools even from saved profiles and keeps document authoring', () => {
    const tools = getArchitectProfileAdjustedToolIds([
      'read', 'strategy_generate', 'strategy_get', 'strategy_update', 'strategy_delete',
      'generate_plan', 'get_strategy', 'update_strategy', 'delete_strategy', 'plan_delete',
    ]);
    expect(tools).toEqual(['read', 'plan_create', 'plan_list', 'plan_get', 'plan_update', 'agsdl_get', 'agsdl_update']);
  });
});
