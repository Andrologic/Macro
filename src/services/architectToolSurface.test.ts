import { describe, expect, it } from 'bun:test';
import { getArchitectProfileAdjustedToolIds } from './architectToolSurface';

describe('Architect AgSDL authoring surface', () => {
  it('removes historical plan and strategy tools even from saved profiles and keeps document authoring', () => {
    const tools = getArchitectProfileAdjustedToolIds([
      'read', 'strategy_generate', 'strategy_get', 'strategy_update', 'strategy_delete',
      'generate_plan', 'get_strategy', 'update_strategy', 'delete_strategy',
      'plan_create', 'plan_list', 'plan_get', 'plan_update', 'plan_delete', 'plan_restore', 'plan_set_active',
      'create_plan', 'list_plans', 'get_plan', 'update_plan', 'delete_plan', 'restore_plan', 'set_active_plan',
    ]);
    expect(tools).toEqual(['read', 'agsdl_get', 'agsdl_update']);
  });
});
