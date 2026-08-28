import { describe, expect, it } from 'bun:test';
import type { ArchitectPlanSummary } from './architectPlanService';
import type { Conversation, Project, ProjectGroup, Task } from '../types';
import { resolveFooterGitContext, type ResolveFooterGitContextInput } from './footerGitContext';

const project = (id: string): Project => ({
  id,
  name: id.toUpperCase(),
  mountName: id,
  path: `/repo/${id}`,
  created_at: '2026-01-01',
  status: 'active',
  gitSetupState: 'ready',
  directEdit: false,
  isReadOnly: false,
  metadata: { description: '', tags: [], team_members: [], api_contracts: [], dependencies: [] },
});

const group: ProjectGroup = {
  id: 'group',
  name: 'Group',
  isOpen: true,
  projects: [project('api'), project('web')],
};

const task = (id: string, projectIds: string[]): Task => ({
  id,
  plan_id: 'plan',
  project_id: projectIds[0] ?? '',
  project_ids: projectIds,
  title: id,
  description: '',
  status: 'Pending',
  dependencies: [],
  estimated_changes: [],
});

const conversation = (id: string, projectId: string | null, taskId: string | null = null): Conversation => ({
  id,
  title: id,
  scope_mode: 'Chat',
  task_id: taskId,
  project_id: projectId,
  last_message: '',
  message_count: 0,
  updated_at: '2026-01-01',
  is_unread: false,
});

const plan = (id: string, projectIds: string[]): ArchitectPlanSummary => ({
  id,
  slug: id,
  title: id,
  description: '',
  status: 'draft',
  targetBranch: 'develop',
  projectIds,
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
  nodeCount: 0,
});

const baseInput = (): ResolveFooterGitContextInput => ({
  mode: 'Implement',
  standaloneProjects: [],
  projectGroups: [group],
  selectedTaskId: null,
  tasks: [],
  activeArchitectPlanId: null,
  visibleArchitectPlans: [],
  selectedConversationId: null,
  conversations: [],
});

describe('resolveFooterGitContext', () => {
  it('uses the selected Implement task instead of a stale global project selection', () => {
    const result = resolveFooterGitContext({
      ...baseInput(),
      selectedTaskId: 'task-web',
      tasks: [task('task-web', ['web'])],
      durableFocusProjectId: 'api',
    });

    expect(result.project).toMatchObject({ id: 'web', path: '/repo/web' });
  });

  it('resolves a single-project Architect plan and leaves a multi-project plan empty by default', () => {
    const single = resolveFooterGitContext({
      ...baseInput(),
      mode: 'Architect',
      activeArchitectPlanId: 'single',
      visibleArchitectPlans: [plan('single', ['api'])],
      durableFocusProjectId: 'web',
    });
    const multiple = resolveFooterGitContext({
      ...baseInput(),
      mode: 'Architect',
      activeArchitectPlanId: 'multiple',
      visibleArchitectPlans: [plan('multiple', ['api', 'web'])],
    });

    expect(single.project?.id).toBe('api');
    expect(multiple.project).toBeNull();
    expect(multiple.reason).toBe('ambiguous');
  });

  it('bounds a manual multi-project choice to the active plan and invalidates it on context change', () => {
    const selected = resolveFooterGitContext({
      ...baseInput(),
      mode: 'Architect',
      activeArchitectPlanId: 'multiple',
      visibleArchitectPlans: [plan('multiple', ['api', 'web'])],
      manualProjectId: 'web',
    });
    const changed = resolveFooterGitContext({
      ...baseInput(),
      mode: 'Architect',
      activeArchitectPlanId: 'single',
      visibleArchitectPlans: [plan('single', ['api'])],
      manualProjectId: 'web',
    });

    expect(selected.project?.id).toBe('web');
    expect(changed.project?.id).toBe('api');
    expect(changed.contextKey).not.toBe(selected.contextKey);
  });

  it('uses only an unambiguous active Chat context', () => {
    const direct = resolveFooterGitContext({
      ...baseInput(),
      mode: 'Chat',
      selectedConversationId: 'chat-api',
      conversations: [conversation('chat-api', 'api')],
    });
    const linkedAmbiguous = resolveFooterGitContext({
      ...baseInput(),
      mode: 'Chat',
      selectedConversationId: 'chat-task',
      conversations: [conversation('chat-task', null, 'task-both')],
      tasks: [task('task-both', ['api', 'web'])],
    });

    expect(direct.project?.id).toBe('api');
    expect(linkedAmbiguous.project).toBeNull();
    expect(linkedAmbiguous.reason).toBe('ambiguous');
  });

  it('lets an explicit Chat project disambiguate a linked multi-project task', () => {
    const result = resolveFooterGitContext({
      ...baseInput(),
      mode: 'Chat',
      selectedConversationId: 'chat-web',
      conversations: [conversation('chat-web', 'web', 'task-both')],
      tasks: [task('task-both', ['api', 'web'])],
    });

    expect(result.project?.id).toBe('web');
  });

  it('never falls back when the active context is missing, deleted, or references an unknown project', () => {
    const missingTask = resolveFooterGitContext({
      ...baseInput(),
      selectedTaskId: 'deleted-task',
      tasks: [task('other-task', ['api'])],
      manualProjectId: 'api',
      durableFocusProjectId: 'api',
    });
    const unknownProject = resolveFooterGitContext({
      ...baseInput(),
      selectedTaskId: 'task-unknown',
      tasks: [task('task-unknown', ['unknown'])],
    });

    expect(missingTask.project).toBeNull();
    expect(missingTask.candidates).toEqual([]);
    expect(unknownProject.project).toBeNull();
  });

  it('falls back to the selected project when Architect has no plan or Implement has no task', () => {
    const architect = resolveFooterGitContext({
      ...baseInput(),
      mode: 'Architect',
      durableFocusProjectId: 'api',
    });
    const implement = resolveFooterGitContext({
      ...baseInput(),
      durableFocusProjectId: 'web',
    });

    expect(architect.project).toMatchObject({ id: 'api', path: '/repo/api' });
    expect(implement.project).toMatchObject({ id: 'web', path: '/repo/web' });
    expect(architect.contextKey).toContain('Architect:project:api');
    expect(implement.contextKey).toContain('Implement:project:web');
  });

  it('uses an explicitly selected folder only in Architect when no project is registered', () => {
    const selectedFolder = { name: 'Sandbox', path: '/repo/sandbox' };
    const architect = resolveFooterGitContext({
      ...baseInput(),
      mode: 'Architect',
      projectGroups: [],
      selectedFolder,
    });
    const chat = resolveFooterGitContext({
      ...baseInput(),
      mode: 'Chat',
      projectGroups: [],
      selectedFolder,
    });
    const registeredProject = resolveFooterGitContext({
      ...baseInput(),
      mode: 'Architect',
      selectedFolder,
    });

    expect(architect.project).toEqual({
      id: 'folder:/repo/sandbox',
      name: 'Sandbox',
      path: '/repo/sandbox',
      source: 'folder',
    });
    expect(chat.project).toBeNull();
    expect(registeredProject.project).toBeNull();
  });

  it.each([
    ['direct', { gitSetupState: 'not_git' as const, directEdit: true, isReadOnly: false }],
    ['blocked', { gitSetupState: 'not_git' as const, directEdit: false, isReadOnly: true }],
  ])('does not expose %s projects to footer Git polling', (_label, overrides) => {
    const directProject = { ...project('direct'), ...overrides };
    const result = resolveFooterGitContext({
      ...baseInput(),
      standaloneProjects: [directProject],
      projectGroups: [],
      selectedTaskId: 'task-direct',
      tasks: [task('task-direct', ['direct'])],
    });

    expect(result).toMatchObject({ project: null, candidates: [], reason: 'missing_context' });
  });

  it('honors a persisted direct target after the project gains Git', () => {
    const directTask = {
      ...task('task-direct', ['direct']),
      execution_targets: [{
        projectId: 'direct',
        branchName: 'feature/direct',
        worktreeKey: 'direct::feature/direct',
        executionMode: 'direct' as const,
        repoPath: '/repo/direct',
      }],
    };
    const result = resolveFooterGitContext({
      ...baseInput(),
      standaloneProjects: [project('direct')],
      projectGroups: [],
      selectedTaskId: directTask.id,
      tasks: [directTask],
    });

    expect(result.project).toBeNull();
  });
});
