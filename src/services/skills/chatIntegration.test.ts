import { describe, expect, it } from 'bun:test';
import type { SkillPermissionSnapshot } from '../../types';
import { handleSkillToolCall } from './chatIntegration';

const deniedSnapshot: SkillPermissionSnapshot = {
  conversationId: 'conversation',
  turnId: 'turn',
  capturedAt: '2026-08-26T00:00:00Z',
  skills: {
    sample: {
      skillId: 'sample',
      enabled: false,
      scriptsEnabled: false,
      hasScripts: true,
    },
  },
};

describe('skill chat integration', () => {
  it('returns structured failures for frozen permission denials', async () => {
    const activation = await handleSkillToolCall(
      'skill_activate',
      { skill_id: 'sample' },
      'conversation',
      deniedSnapshot,
    );
    const script = await handleSkillToolCall(
      'skill_run_script',
      { skill_id: 'sample', script_path: 'run.ts' },
      'conversation',
      deniedSnapshot,
    );

    expect(activation).toMatchObject({ isError: true, errorKind: 'permission' });
    expect(script).toMatchObject({ isError: true, errorKind: 'permission' });
  });
});
