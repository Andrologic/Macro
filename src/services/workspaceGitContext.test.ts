import { describe, expect, it } from 'bun:test';
import type { Conversation, Project, Task } from '../types';
import { createWorkspaceSession, workspaceDefinitions } from '../domains/shell/workspace';
import { resolveWorkspaceGitContext, type WorkspaceGitContextInput } from './workspaceGitContext';

const projects: Project[] = ['api', 'web'].map((id) => ({
  id, name: id, path: `/repo/${id}`, created_at: '2026-01-01', status: 'active',
  gitSetupState: 'ready', directEdit: false, isReadOnly: false,
  metadata: { description: '', tags: [], team_members: [], api_contracts: [], dependencies: [] },
}));
const task: Task = {
  id: 'task-a', plan_id: 'plan-a', project_id: 'api', title: 'Task', description: '',
  status: 'Pending', dependencies: [], estimated_changes: [],
  execution_targets: [{ projectId: 'api', branchName: 'feature/task-a', worktreeKey: 'api::feature/task-a', repoPath: '/repo/api', executionKind: 'worktree' }],
};
const conversation: Conversation = {
  id: 'chat-a', title: 'Chat', scope_mode: 'Chat', task_id: null, project_id: 'web',
  last_message: '', message_count: 0, updated_at: '2026-01-01', is_unread: false,
};
const input: WorkspaceGitContextInput = {
  standaloneProjects: projects, projectGroups: [], tasks: [task], conversations: [conversation],
  visibleArchitectPlans: [], durableFocusProjectId: 'web',
};
const selection = { agentType: 'build' as const, planId: null, taskId: 'task-a', conversationId: 'chat-a', groupId: null, projectId: 'web' };

describe('workspace target to Git domain', () => {
  it('uses the task reference instead of global focus and leaves its worktree identity untouched', () => {
    const before = JSON.stringify(task);
    const session = createWorkspaceSession(workspaceDefinitions.Implement, selection);
    expect(resolveWorkspaceGitContext(session, input).project?.id).toBe('api');
    expect(resolveWorkspaceGitContext(session, input).project?.path).toBe('/repo/api');
    expect(JSON.stringify(task)).toBe(before);
    // A missing durable task must not silently target the selected project.
    expect(resolveWorkspaceGitContext({ ...session, executionTarget: { kind: 'local', scope: { kind: 'task', id: 'missing' } } }, input).project).toBeNull();
  });

  it('resolves conversation and selection targets without deriving permissions from a view', () => {
    const chat = createWorkspaceSession(workspaceDefinitions.Chat, selection);
    expect(resolveWorkspaceGitContext(chat, { ...input, durableFocusProjectId: 'api' }).project?.id).toBe('web');
    const freeChat = createWorkspaceSession(workspaceDefinitions.Chat, { ...selection, conversationId: null });
    expect(resolveWorkspaceGitContext(freeChat, input).project).toBeNull();
    const architect = createWorkspaceSession(workspaceDefinitions.Architect, { ...selection, projectId: 'api' });
    expect(resolveWorkspaceGitContext(architect, input).project?.id).toBe('api');
    expect(resolveWorkspaceGitContext({ ...architect, agentProfile: { ...architect.agentProfile, agentType: 'plan' } }, input).project?.id).toBe('api');
  });

  it('refuses remote or incompatible references without falling back to local folders', () => {
    const session = createWorkspaceSession(workspaceDefinitions.Architect, selection);
    const withFolder = { ...input, standaloneProjects: [], selectedFolder: { name: 'Chosen folder', path: '/chosen' } };
    expect(resolveWorkspaceGitContext({ ...session, executionTarget: { kind: 'remote-reference', targetId: 'future' } }, withFolder)).toMatchObject({ project: null, candidates: [], reason: 'missing_context' });
    expect(resolveWorkspaceGitContext({ ...session, executionTarget: { kind: 'local', scope: { kind: 'task', id: 'task-a' } } }, input).project).toBeNull();
  });
});
