import { beforeEach, expect, it, mock } from 'bun:test';
import type { ChatMessage, Project } from '../types';
import { buildMessageState } from './chat/chatMessageState';
import type { ArchitectPlanRecord } from '../services/architectPlanService';
import { installArchitectPlanRuntimePorts } from '../services/architectPlanRuntimeService';
import { createDeferred } from '../test-utils/deferred';

// Exercise both stores together. Only native reads and provider restoration are replaced.
const ipc = { ...await import('../services/tauriIpc') };
const planService = { ...await import('../services/architectPlanService') };
const readService = { ...await import('../services/architectPlanReadService') };
const localContext = { ...await import('../services/localProjectContext') };
const providerExports = { ...await import('./useProviderStore') };
const providerDefaults = providerExports.useProviderStore.getState();
const plan: ArchitectPlanRecord = {
  id: 'saved-plan', slug: 'saved-plan', title: 'Saved plan', description: '', status: 'draft',
  conversationId: 'saved-conversation', projectId: 'project-a', projectIds: ['project-a', 'project-b'],
  targetBranch: 'main', targetBranchesByProjectId: { 'project-a': 'develop', 'project-b': 'develop' },
  nodes: [], predictedBranches: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
};
const projects: Project[] = ['a', 'b'].map(id => ({
  id: `project-${id}`, name: id, mountName: id, path: `/synthetic/${id}`, gitSetupState: 'ready',
  created_at: '2026-01-01T00:00:00Z', status: 'active',
  metadata: { description: '', tags: [], team_members: [], api_contracts: [], dependencies: [] },
}));
let replicaMessages: Array<{ id: string; role: 'user' | 'assistant'; content: string; createdAt: string }> = [];
const payload = () => ({
  plan, targetBranch: 'main', conversationId: plan.conversationId!, sharedConversation: false,
  resolutionMode: 'full' as const, chatMessages: replicaMessages, chatMessagesLoaded: true,
  chatTranscriptRevision: 'fresh-head', chatMessageCount: replicaMessages.length,
  replicaScopeKey: 'group:group', replicaProjectId: 'project-a',
});
const getHead = mock(async () => payload());
const restoreProvider = mock(async () => ({ status: 'ready', providerId: 'qa-provider', modelId: 'qa-model' }));
mock.module('../services/tauriIpc', () => ({ ...ipc, isTauriAvailable: () => false }));
mock.module('../services/architectPlanService', () => ({
  ...planService, persistActiveArchitectPlan: async () => undefined,
}));
mock.module('../services/architectPlanReadService', () => ({ ...readService, getArchitectPlanActivationPayload: getHead }));
mock.module('../services/localProjectContext', () => ({ ...localContext, upsertLocalProjectContextState: async () => undefined }));
mock.module('../services/architectPlanRuntimeService', () => ({
  installArchitectPlanRuntimePorts, readArchitectPlanRuntime: async () => null,
}));
mock.module('./useProviderStore', () => ({ ...providerExports, useProviderStore: {
  getState: () => ({ ...providerDefaults, commitRestoredSelection: restoreProvider, selectedProviderId: 'qa-provider', selectedModelId: 'qa-model' }),
  subscribe: () => () => undefined,
} }));
const { useAppStore } = await import('./useAppStore');
const { useChatStore } = await import('./useChatStore');

beforeEach(() => {
  replicaMessages = [];
  getHead.mockReset(); getHead.mockImplementation(async () => payload()); restoreProvider.mockClear();
  useAppStore.setState({
    mode: 'Architect', standaloneProjects: [], projectGroups: [{ id: 'group', name: 'Group', isOpen: true, projects }],
    selectedGroupId: 'group', selectedProjectId: 'project-a', activeArchitectPlanId: plan.id,
    activePlanContext: { id: plan.id, title: plan.title, description: plan.description, status: plan.status, targetBranch: 'main' },
    planNodes: [], predictedBranches: [], pendingArchitectPlanActivationPayload: null,
  });
  useChatStore.setState({
    conversations: [{ id: 'saved-conversation', title: 'Saved plan', scope_mode: 'Architect',
      project_id: 'project-a', group_id: 'group', task_id: null, is_pinned: false,
      last_message: '', message_count: 0, is_unread: false, provider_id: 'qa-provider', model_id: 'qa-model', updated_at: '2026-01-01T00:00:00Z' }],
    messages: [], messagesByConversationId: {}, messageIndexById: {},
    messageLoadStatusByConversationId: { 'saved-conversation': 'ready' }, hydrationStatus: 'ready',
    selectedConversationId: null, selectedConversationIdsByMode: {}, restoreStatus: 'error',
    activeContextKey: null, selectedConversationContextKey: null, lastError: 'replica conflict',
  });
});

it('recovers the same plan through activation alone and leaves a healthy reload alone', async () => {
  expect(await useAppStore.getState().activateArchitectPlan(plan.id, { targetBranch: 'main' })).toBe(true);
  expect(useChatStore.getState().selectedConversationId).toBe('saved-conversation');
  expect(useChatStore.getState().restoreStatus).toBe('ready');
  expect(restoreProvider).toHaveBeenCalledTimes(1);
  expect(await useAppStore.getState().activateArchitectPlan(plan.id, { targetBranch: 'main' })).toBe(true);
  expect(restoreProvider).toHaveBeenCalledTimes(1);
});

it('does not recover an activation overtaken by an explicit conversation deselection', async () => {
  const head = createDeferred<ReturnType<typeof payload>>();
  getHead.mockImplementationOnce(() => head.promise);
  const activating = useAppStore.getState().activateArchitectPlan(plan.id, { targetBranch: 'main' });
  useChatStore.getState().clearSelectedConversation();
  head.resolve(payload());
  await activating;
  expect(useChatStore.getState().selectedConversationId).toBeNull();
  expect(restoreProvider).not.toHaveBeenCalled();
});

it('retries a real exact-replica refusal on the same plan once the transcript is synchronized', async () => {
  const messages: ChatMessage[] = [{ id: 'request', conversation_id: 'saved-conversation', task_id: '',
    role: 'user', content: 'Saved request', timestamp: '2026-01-01T00:01:00Z' }];
  useChatStore.setState(buildMessageState(messages));
  await useAppStore.getState().activateArchitectPlan(plan.id, { targetBranch: 'main' });
  expect(useChatStore.getState().selectedConversationId).toBeNull();
  expect(useChatStore.getState().lastError).toContain('plus récent');
  expect(restoreProvider).not.toHaveBeenCalled();
  replicaMessages = messages.map(message => ({ id: message.id, role: message.role, content: message.content, createdAt: message.timestamp }));
  expect(await useAppStore.getState().activateArchitectPlan(plan.id, { targetBranch: 'main' })).toBe(true);
  expect(useChatStore.getState().selectedConversationId).toBe('saved-conversation');
  expect(useChatStore.getState().getConversationMessages('saved-conversation')).toEqual(messages);
  expect(restoreProvider).toHaveBeenCalledTimes(1);
});

it('preserves a divergent transcript during explicit recovery', async () => {
  const messages: ChatMessage[] = [{ id: 'request', conversation_id: 'saved-conversation', task_id: '',
    role: 'user', content: 'Local request', timestamp: '2026-01-01T00:01:00Z' }];
  useChatStore.setState(buildMessageState(messages));
  replicaMessages = [{ id: 'request', role: 'user', content: 'Different replica', createdAt: messages[0].timestamp }];
  await useAppStore.getState().activateArchitectPlan(plan.id, { targetBranch: 'main' });
  expect(useChatStore.getState().lastError).toContain('diverge');
  expect(useChatStore.getState().selectedConversationId).toBeNull();
  expect(useChatStore.getState().getConversationMessages('saved-conversation')).toEqual(messages);
  expect(restoreProvider).not.toHaveBeenCalled();
});

it('retries a failed strategy follow-up even when its conversation remained selected', async () => {
  await useAppStore.getState().activateArchitectPlan(plan.id, { targetBranch: 'main' });
  const message: ChatMessage = { id: 'assistant', conversation_id: 'saved-conversation', task_id: '',
    role: 'assistant', content: 'Completed response', timestamp: '2026-01-01T00:01:00Z' };
  useChatStore.setState(buildMessageState([message]));
  await expect(useChatStore.getState().ensureArchitectConversationForPlan({
    plan, targetBranch: 'main', chatMessagesHint: [], chatMessagesLoaded: true,
    replicaScopeKey: 'group:group', replicaProjectId: 'project-a',
  })).rejects.toThrow('plus récent');
  expect(useChatStore.getState().selectedConversationId).toBe('saved-conversation');
  expect(useChatStore.getState().restoreStatus).toBe('ready');
  replicaMessages = [{ id: message.id, role: message.role, content: message.content, createdAt: message.timestamp }];
  await useAppStore.getState().activateArchitectPlan(plan.id, { targetBranch: 'main' });
  expect(useChatStore.getState().selectedConversationId).toBe('saved-conversation');
  expect(restoreProvider).toHaveBeenCalledTimes(2);
});

it('does not restore a provider from a recovery revoked during its asynchronous restoration', async () => {
  const restoring = createDeferred<void>();
  const finish = createDeferred<void>();
  let stalePublished = false;
  restoreProvider.mockImplementationOnce(async (_selection?: unknown, options?: { isActive: () => boolean }) => {
    restoring.resolve();
    await finish.promise;
    stalePublished = options?.isActive() ?? true;
    return { status: 'ready', providerId: 'qa-provider', modelId: 'qa-model' };
  });
  const recovering = useAppStore.getState().activateArchitectPlan(plan.id, { targetBranch: 'main' });
  await restoring.promise;
  await useAppStore.getState().activateArchitectPlan(plan.id, { targetBranch: 'main', persistActiveSelection: false });
  finish.resolve();
  await recovering;
  expect(stalePublished).toBe(false);
});
