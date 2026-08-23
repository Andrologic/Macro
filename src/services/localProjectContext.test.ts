import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';

interface ProjectRecord {
  project_id: string;
  group_id: string | null;
  focus_project_id: string | null;
  last_plan_id: string | null;
  last_task_id: string | null;
  architect_conversation_id: string | null;
  implement_conversation_id: string | null;
  updated_at: string;
}

interface SessionRecord {
  selected_group_id: string | null;
  selected_project_id: string | null;
  mode: string | null;
  updated_at: string;
}

let tauriAvailable = false;
let projectRead: (projectId: string) => Promise<ProjectRecord | null>;
let projectWrite: (input: Record<string, unknown>) => Promise<ProjectRecord>;
let projectDelete: (projectId: string) => Promise<void>;
let sessionRead: () => Promise<SessionRecord | null>;
let sessionWrite: (input: Record<string, unknown>) => Promise<SessionRecord>;
let registryReconcile: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;

const isTauriAvailable = mock(() => tauriAvailable);
const dbGetProjectContextState = mock((projectId: string) => projectRead(projectId));
const dbUpsertProjectContextState = mock((input: Record<string, unknown>) => projectWrite(input));
const dbDeleteProjectContextState = mock((projectId: string) => projectDelete(projectId));
const dbGetSessionContextState = mock(() => sessionRead());
const dbUpsertSessionContextState = mock((input: Record<string, unknown>) => sessionWrite(input));
const dbReconcileProjectRegistry = mock((input: Record<string, unknown>) => registryReconcile(input));

const loadPreference = mock(async (_key: string) => undefined as unknown);
const savePreference = mock(async (_key: string, _value: unknown) => undefined);

mock.module('./tauriIpc', () => ({
  isTauriAvailable,
  dbGetProjectContextState,
  dbUpsertProjectContextState,
  dbDeleteProjectContextState,
  dbGetSessionContextState,
  dbUpsertSessionContextState,
  dbReconcileProjectRegistry,
}));

mock.module('./preferences', () => ({
  PREF_KEYS: { PROJECT_SWITCH_POLICY: 'projectSwitchPolicy' },
  loadPreference,
  savePreference,
}));

const loadService = () => import('./localProjectContext');

const dbProject = (overrides: Partial<ProjectRecord> = {}): ProjectRecord => ({
  project_id: 'group-a',
  group_id: 'group-a',
  focus_project_id: 'project-a',
  last_plan_id: 'plan-a',
  last_task_id: 'task-a',
  architect_conversation_id: 'architect-a',
  implement_conversation_id: 'implement-a',
  updated_at: '2026-08-23T10:00:00.000Z',
  ...overrides,
});

const dbSession = (overrides: Partial<SessionRecord> = {}): SessionRecord => ({
  selected_group_id: 'group-a',
  selected_project_id: 'project-a',
  mode: 'Implement',
  updated_at: '2026-08-23T10:00:00.000Z',
  ...overrides,
});

const clearPersistenceMocks = () => {
  isTauriAvailable.mockClear();
  dbGetProjectContextState.mockClear();
  dbUpsertProjectContextState.mockClear();
  dbDeleteProjectContextState.mockClear();
  dbGetSessionContextState.mockClear();
  dbUpsertSessionContextState.mockClear();
  dbReconcileProjectRegistry.mockClear();
  loadPreference.mockClear();
  savePreference.mockClear();
};

beforeEach(async () => {
  tauriAvailable = false;
  projectRead = async () => null;
  projectWrite = async () => dbProject();
  projectDelete = async () => undefined;
  sessionRead = async () => null;
  sessionWrite = async () => dbSession();
  registryReconcile = async () => ({});
  clearPersistenceMocks();

  const service = await loadService();
  await service.reconcileLocalProjectRegistryState({
    validGroupIds: [],
    validProjectIds: [],
  });
  await service.upsertLocalSessionContextState({
    selectedGroupId: null,
    selectedProjectId: null,
    mode: null,
  });
  clearPersistenceMocks();
});

afterAll(() => mock.restore());

describe('local project context persistence', () => {
  it('normalizes project identifiers and translates Tauri records in both directions', async () => {
    tauriAvailable = true;
    projectRead = async () => dbProject({ project_id: 'ignored-backend-id' });
    projectWrite = async () => dbProject({ project_id: 'ignored-backend-id' });
    const service = await loadService();

    const read = await service.getLocalProjectContextState('  group-a  ');
    const written = await service.upsertLocalProjectContextState({
      projectId: '  group-a  ',
      groupId: 'group-a',
      focusProjectId: 'project-a',
      lastTaskId: 'task-a',
    });
    await service.deleteLocalProjectContextState('  group-a  ');

    expect(dbGetProjectContextState).toHaveBeenCalledWith('group-a');
    expect(read).toEqual({
      projectId: 'group-a',
      groupId: 'group-a',
      focusProjectId: 'project-a',
      lastPlanId: 'plan-a',
      lastTaskId: 'task-a',
      architectConversationId: 'architect-a',
      implementConversationId: 'implement-a',
      updatedAt: '2026-08-23T10:00:00.000Z',
    });
    expect(dbUpsertProjectContextState).toHaveBeenCalledWith({
      projectId: 'group-a',
      groupId: 'group-a',
      focusProjectId: 'project-a',
      lastPlanId: null,
      lastTaskId: 'task-a',
      architectConversationId: null,
      implementConversationId: null,
    });
    expect(written?.projectId).toBe('group-a');
    expect(dbDeleteProjectContextState).toHaveBeenCalledWith('group-a');
  });

  it('ignores blank project identifiers without calling persistence', async () => {
    tauriAvailable = true;
    const service = await loadService();

    expect(await service.getLocalProjectContextState('   ')).toBeNull();
    expect(await service.upsertLocalProjectContextState({ projectId: '\t' })).toBeNull();
    await service.deleteLocalProjectContextState('  ');

    expect(dbGetProjectContextState).not.toHaveBeenCalled();
    expect(dbUpsertProjectContextState).not.toHaveBeenCalled();
    expect(dbDeleteProjectContextState).not.toHaveBeenCalled();
  });

  it('normalizes invalid session values returned by Tauri', async () => {
    tauriAvailable = true;
    sessionRead = async () => dbSession({ mode: 'Review' });
    sessionWrite = async () => dbSession({
      selected_group_id: null,
      selected_project_id: null,
      mode: 'broken',
    });
    const service = await loadService();

    const read = await service.getLocalSessionContextState();
    const written = await service.upsertLocalSessionContextState({
      selectedGroupId: null,
      selectedProjectId: null,
      mode: null,
    });

    expect(read).toMatchObject({
      globalProjectId: 'group-a',
      selectedGroupId: 'group-a',
      selectedProjectId: 'project-a',
      mode: null,
    });
    expect(dbUpsertSessionContextState).toHaveBeenCalledWith({
      selectedGroupId: null,
      selectedProjectId: null,
      mode: null,
    });
    expect(written).toMatchObject({
      globalProjectId: null,
      selectedGroupId: null,
      selectedProjectId: null,
      mode: null,
    });
  });

  it('falls back to a coherent in-memory project state when every Tauri operation fails', async () => {
    tauriAvailable = true;
    const unavailable = async () => {
      throw new Error('IPC unavailable');
    };
    projectRead = unavailable;
    projectWrite = unavailable;
    projectDelete = unavailable;
    const service = await loadService();

    const written = await service.upsertLocalProjectContextState({
      projectId: ' group-a ',
      groupId: 'group-a',
      focusProjectId: 'project-a',
      architectConversationId: 'architect-a',
    });

    expect(await service.getLocalProjectContextState('  group-a  ')).toEqual(written);
    await service.deleteLocalProjectContextState('group-a');
    expect(await service.getLocalProjectContextState('group-a')).toBeNull();
  });

  it('falls back to a coherent in-memory session when Tauri reads and writes fail', async () => {
    tauriAvailable = true;
    const unavailable = async () => {
      throw new Error('IPC unavailable');
    };
    sessionRead = unavailable;
    sessionWrite = unavailable;
    const service = await loadService();

    const written = await service.upsertLocalSessionContextState({
      selectedGroupId: 'group-a',
      selectedProjectId: 'project-a',
      mode: 'Architect',
    });

    expect(await service.getLocalSessionContextState()).toEqual(written);
  });

  it('normalizes invalid project switch policies before reading or saving them', async () => {
    loadPreference.mockResolvedValueOnce('obsolete-policy');
    const service = await loadService();

    expect(await service.getProjectSwitchPolicy()).toBe('resume_per_project');
    await service.setProjectSwitchPolicy(
      'obsolete-policy' as Parameters<typeof service.setProjectSwitchPolicy>[0],
    );

    expect(savePreference).toHaveBeenCalledWith(
      'projectSwitchPolicy',
      'resume_per_project',
    );
  });

  it('deduplicates registry inputs and clears invalid selections before Tauri reconciliation', async () => {
    tauriAvailable = true;
    const service = await loadService();

    await service.reconcileLocalProjectRegistryState({
      validGroupIds: ['group-a', 'group-a'],
      validProjectIds: ['project-a', 'project-a'],
      selectedGroupId: 'stale-group',
      selectedProjectId: 'stale-project',
    });

    expect(dbReconcileProjectRegistry).toHaveBeenCalledWith({
      validGroupIds: ['group-a'],
      validProjectIds: ['project-a'],
      selectedGroupId: null,
      selectedProjectId: null,
    });
  });

  it('removes stale contexts and references during fallback reconciliation', async () => {
    const service = await loadService();
    await service.upsertLocalProjectContextState({
      projectId: 'group-a',
      groupId: 'removed-group',
      focusProjectId: 'removed-project',
      lastTaskId: 'task-a',
    });
    await service.upsertLocalProjectContextState({
      projectId: 'removed-group',
      groupId: 'removed-group',
      focusProjectId: 'project-a',
    });
    await service.upsertLocalSessionContextState({
      selectedGroupId: 'removed-group',
      selectedProjectId: 'removed-project',
      mode: 'Implement',
    });

    await service.reconcileLocalProjectRegistryState({
      validGroupIds: ['group-a'],
      validProjectIds: ['project-a'],
      selectedGroupId: 'removed-group',
      selectedProjectId: 'removed-project',
    });

    expect(await service.getLocalProjectContextState('group-a')).toMatchObject({
      projectId: 'group-a',
      groupId: null,
      focusProjectId: null,
      lastTaskId: 'task-a',
    });
    expect(await service.getLocalProjectContextState('removed-group')).toBeNull();
    expect(await service.getLocalSessionContextState()).toMatchObject({
      globalProjectId: null,
      selectedGroupId: null,
      selectedProjectId: null,
      mode: 'Implement',
    });
  });
});
