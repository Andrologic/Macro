import { describe, expect, it } from 'bun:test';
import { createWorkspaceSession, workspaceDefinitions, type WorkspaceSessionInput } from './workspace';
import { useWorkspaceSessionsStore } from '../../stores/useWorkspaceSessionsStore';

const input: WorkspaceSessionInput = {
  agentType: 'build', planId: 'plan-a', taskId: 'task-a', conversationId: 'chat-a', groupId: 'group-a', projectId: 'project-a',
};

describe('workspace session identity', () => {
  it('isolates selected views across sessions and retains them when returning', () => {
    useWorkspaceSessionsStore.setState({ sessions: {} });
    const a = createWorkspaceSession(workspaceDefinitions.Implement, input);
    const b = createWorkspaceSession(workspaceDefinitions.Implement, { ...input, taskId: 'task-b' });
    useWorkspaceSessionsStore.getState().selectView(a, 'view.inspection');
    useWorkspaceSessionsStore.getState().selectView(b, 'view.implement');
    const restored = createWorkspaceSession(workspaceDefinitions.Implement, input);
    expect(useWorkspaceSessionsStore.getState().sessions[restored.id].selectedViewId).toBe('view.inspection');
    expect(useWorkspaceSessionsStore.getState().sessions[b.id].selectedViewId).toBe('view.implement');
  });

  it('shares a task session across views and project focus while keeping domain references intact', () => {
    const a = createWorkspaceSession(workspaceDefinitions.Implement, input);
    const b = createWorkspaceSession(workspaceDefinitions.Implement, { ...input, projectId: 'another-focus', agentType: 'plan' });
    expect(a.id).toBe(b.id);
    expect(a.executionTarget).toEqual({ kind: 'local', scope: { kind: 'task', id: 'task-a' } });
    expect(b.agentProfile).toEqual({ mode: 'Implement', agentType: 'plan' });
    expect(a.agentProfile.agentType).toBe('build');
    expect(createWorkspaceSession(workspaceDefinitions.Architect, input).id).not.toBe(a.id);
  });

  it('keeps exact fallback project/group IDs and does not attach free Chat to project selection', () => {
    const empty = { ...input, taskId: null, conversationId: null };
    const a = createWorkspaceSession(workspaceDefinitions.Implement, empty);
    const b = createWorkspaceSession(workspaceDefinitions.Implement, { ...empty, projectId: 'different' });
    expect(a.id).not.toBe(b.id);
    expect(a.scope).toEqual({ kind: 'selection', groupId: input.groupId, projectId: input.projectId });
    expect(createWorkspaceSession(workspaceDefinitions.Chat, empty).id).toBe(
      createWorkspaceSession(workspaceDefinitions.Chat, { ...empty, projectId: 'different' }).id);
  });
});
