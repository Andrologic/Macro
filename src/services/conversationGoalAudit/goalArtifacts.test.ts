import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { useAppStore } from '../../stores/useAppStore';
import { useChatStore } from '../../stores/useChatStore';
import { installTauriRuntimeMock, removeTauriRuntimeMock } from '../../test-utils/tauriRuntime';
import type { ConversationGoalAudit } from '../../types/generated/ipc';
import { listConversationGoalAuditArtifacts, readGoalAuditArtifact, saveGoalAuditArtifact } from './goalArtifacts';

const environment = {
  getAppState: () => useAppStore.getState(),
  readMessages: (id: string) => useChatStore.getState().getConversationMessages(id),
};

const workspacePath = '/synthetic/project';
const files = new Map<string, string>();
const settings = new Map<string, string>();
let audits: ConversationGoalAudit[] = [];
let failWrite = false;
const verdict = {
  verdict: 'achieved' as const, summary: 'Objective verified',
  criteria: [{ criterion: 'Objective verified', status: 'met' as const, evidence: [{ source: 'test', finding: 'Result exists' }] }],
  feedback: '', questionForUser: null, confidence: 0.9,
};
const audit = (auditId: string, goalId: string): ConversationGoalAudit => ({
  auditId, conversationId: 'conversation', goalId, goalRevision: 2, executorTurnId: `turn-${auditId}`,
  currentRunId: `run-${auditId}`, status: 'applied', verdict,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
});

beforeEach(() => {
  files.clear(); settings.clear(); audits = []; failWrite = false;
  useAppStore.setState({ standaloneProjects: [{
    id: 'project', name: 'Synthetic', path: workspacePath, mountName: 'synthetic',
    created_at: '', status: 'active', gitSetupState: 'ready', directEdit: false,
    metadata: { description: '', tags: [], team_members: [], api_contracts: [], dependencies: [] },
  }], projectGroups: [], selectedProjectId: 'project', selectedGroupId: null });
  installTauriRuntimeMock(mock(async (command, payload) => {
    const p = payload as Record<string, unknown>;
    const key = `${String(p?.workspacePath)}::${String(p?.path)}`;
    if (command === 'workspace_get_active_root') return workspacePath;
    if (command === 'db_list_conversation_goal_audits') return audits;
    if (command === 'db_get_app_setting') {
      const value = settings.get(String(p.key));
      return value === undefined ? null : { value_json: value };
    }
    if (command === 'db_compare_and_swap_app_setting') {
      if ((settings.get(String(p.key)) ?? null) !== p.expectedValueJson) return { applied: false };
      settings.set(String(p.key), String(p.valueJson));
      return { applied: true };
    }
    if (command === 'fs_exists') return files.has(key);
    if (command === 'fs_read_file') {
      if (!files.has(key)) throw new Error('missing');
      return { content: files.get(key), revision: files.get(key) };
    }
    if (command === 'fs_write_file' || command === 'fs_delete') {
      if (failWrite) { failWrite = false; throw new Error('disk unavailable'); }
      if (p.expectedRevision !== (files.get(key) ?? 'absent')) throw new Error('revision conflict');
      if (command === 'fs_write_file') files.set(key, String(p.content));
      else files.delete(key);
      return {};
    }
    return undefined;
  }));
});
afterEach(() => {
  removeTauriRuntimeMock();
  useAppStore.setState({ standaloneProjects: [], projectGroups: [], selectedProjectId: null, selectedGroupId: null });
});

describe('Goal artifacts in the shared metadata transaction system', () => {
  it('keeps both old and replacement goal results navigable after Stop', async () => {
    audits = [audit('audit-one', 'goal-one'), audit('audit-two', 'goal-two')];
    const items = await listConversationGoalAuditArtifacts('project', 'conversation', null, environment);
    expect(items.map((item) => [item.goalId, item.id, item.runId])).toEqual([
      ['goal-one', 'audit-one', 'run-audit-one'], ['goal-two', 'audit-two', 'run-audit-two'],
    ]);
    expect(JSON.parse(await readGoalAuditArtifact(items[0], environment)).result.verdict.verdict).toBe('achieved');
    expect(files.size).toBe(4);
    expect(JSON.parse(settings.get('pendingArchitectPlanReplicaMutations:v1') ?? '[]')).toEqual([]);
  });

  it('recreates an artifact from an applied native verdict after a failed write', async () => {
    const applied = audit('audit-one', 'goal-one');
    failWrite = true;
    await expect(saveGoalAuditArtifact({ projectId: 'project', conversationId: 'conversation', goalId: applied.goalId,
      goalRevision: applied.goalRevision, executorTurnId: applied.executorTurnId, runId: applied.currentRunId,
      auditId: applied.auditId, messageId: '', result: { status: 'applied', runId: applied.currentRunId, verdict },
    }, environment)).rejects.toThrow('disk unavailable');
    audits = [applied];
    const [item] = await listConversationGoalAuditArtifacts('project', 'conversation', null, environment);
    expect(item.review).toEqual({ status: 'applied', verdict: 'achieved' });
    expect(await readGoalAuditArtifact(item, environment)).toContain('Objective verified');
  });

  it('recreates a missing result file when its index survived', async () => {
    const applied = audit('audit-one', 'goal-one');
    audits = [applied];
    const [before] = await listConversationGoalAuditArtifacts('project', 'conversation', null, environment);
    files.delete(`${workspacePath}::${before.path}`);
    const [recovered] = await listConversationGoalAuditArtifacts('project', 'conversation', null, environment);
    expect(recovered.id).toBe(before.id);
    expect(await readGoalAuditArtifact(recovered, environment)).toContain('Objective verified');
  });
});
