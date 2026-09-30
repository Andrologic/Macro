import { describe, expect, it, mock } from 'bun:test';
import { loadQueuedSubmissions, QUEUED_SUBMISSIONS_STORAGE_KEY } from '../chat/chatQueuedSubmissions';
import { useConversationArchiveStore } from '../useConversationArchiveStore';
import { beginAppShutdownGate } from '../../services/appShutdownGate';
import type { ChatMessage } from '../../types';
import type { MergeWorkflowRuntimeState } from '../../services/mergeWorkflow';
import type { UseChatStoreScenarioContext } from '../useChatStore.test';

export function registerQueuedSubmissionRecoveryScenarios(c: UseChatStoreScenarioContext) {
  const prepare = async () => {
    c.tauriAvailable = true;
    c.appState.mode = 'Chat';
    const { useChatStore: store } = await c.loadChatStore();
    store.setState(c.createIdleChatStoreState({
      conversations: [{ ...c.createConversation('queued-conv'), scope_mode: 'Chat', task_id: null }],
      selectedConversationId: 'queued-conv',
      conversationRuntimeById: { 'queued-conv': { phase: 'streaming', sessionId: 'active', turnId: 'active-turn' } },
    }));
    return store;
  };
  const release = (store: Awaited<ReturnType<typeof prepare>>) => {
    store.setState({ conversationRuntimeById: {}, isStreaming: false });
  };

  describe('queued submission recovery through the real send contract', () => {
    it('uses the submitted conversation references for steering even if the composer has changed', async () => {
      c.chatSnapshotConversations = [
        c.createChatSnapshotConversation('queued-conv'),
        c.createChatSnapshotConversation('source-conv'),
      ];
      c.chatSnapshotMessages = [{
        id: 'source-message', conversation_id: 'source-conv', role: 'user',
        content: 'The deployment decision requires review.', created_at: '2026-09-28T10:00:00Z',
      }];
      const store = await prepare();
      store.setState({ composerContextRefs: [{ id: 'foreign', kind: 'file', title: 'Foreign', path: 'foreign.txt' }] });
      await store.getState().submitDuringActiveTurn({
        conversationId: 'queued-conv', content: 'What was the deployment decision?',
        composerContextRefs: [{ id: 'source-conv', kind: 'conversation', title: 'Prior work',
          data: { conversationId: 'source-conv' } }],
      }, 'steer');
      const refs = c.createMessageMock.mock.calls.find(call => call[1] === 'user')?.[3]?.contextRefs;
      expect(refs).toMatchObject([{ id: 'source-conv', conversationId: 'source-conv' }]);
      expect(JSON.stringify(refs)).toContain('message_id=source-message');
      expect(JSON.stringify(refs)).not.toContain('foreign');
    });

    it('selects conversation passages when a queued composer submission actually departs', async () => {
      c.chatSnapshotConversations = [
        c.createChatSnapshotConversation('queued-conv'),
        c.createChatSnapshotConversation('source-conv'),
      ];
      c.chatSnapshotMessages = [{
        id: 'source-message', conversation_id: 'source-conv', role: 'user',
        content: 'Review every deployment.', created_at: '2026-09-28T10:00:00Z',
      }];
      const store = await prepare();
      await store.getState().submitDuringActiveTurn({
        conversationId: 'queued-conv', content: 'What about deployment?',
        composerContextRefs: [{ id: 'source-conv', kind: 'conversation', title: 'Prior work',
          data: { conversationId: 'source-conv' } }],
      }, 'queue');
      expect(loadQueuedSubmissions()[0].input.contextRefs?.[0]).toMatchObject({
        conversationId: 'source-conv',
      });
      expect(loadQueuedSubmissions()[0].input.contextRefs?.[0]?.snippet).toBeUndefined();
      release(store);
      await store.getState().retryQueuedSubmissions('queued-conv');
      const refs = c.createMessageMock.mock.calls.find(call => call[1] === 'user')?.[3]?.contextRefs;
      expect(JSON.stringify(refs)).toContain('message_id=source-message');
      expect(loadQueuedSubmissions()).toEqual([]);
    });

    it('retains a failed pre-persistence send across restart and retries once', async () => {
      const store = await prepare();
      await store.getState().submitDuringActiveTurn({ conversationId: 'queued-conv', content: 'Keep this message' }, 'queue');
      const accepted = loadQueuedSubmissions();
      expect(accepted).toHaveLength(1);
      c.createMessageMock.mockImplementationOnce(async () => { throw new Error('disk unavailable'); });
      release(store);
      await store.getState().retryQueuedSubmissions('queued-conv');
      expect(loadQueuedSubmissions()).toEqual(accepted);
      expect(c.streamChatMock).not.toHaveBeenCalled();
      const { useChatStore: restarted } = await c.loadChatStore();
      restarted.setState(c.createIdleChatStoreState({ conversations: store.getState().conversations }));
      await restarted.getState().retryQueuedSubmissions('queued-conv');
      expect(loadQueuedSubmissions()).toEqual([]);
      expect(c.createMessageMock.mock.calls.filter(call => call[1] === 'user')).toHaveLength(2);
      expect(c.createMessageMock.mock.calls.at(-2)?.[3]?.turnId).toBe(accepted[0].id);
      expect(c.streamChatMock).toHaveBeenCalledTimes(1);
    });

    it('retains original mode, provider and references after navigation', async () => {
      const store = await prepare();
      const ref = { id: 'file:readme', kind: 'file' as const, title: 'README', path: '/synthetic/README.md' };
      await store.getState().submitDuringActiveTurn({ conversationId: 'queued-conv', content: 'Read original', contextRefs: [ref] }, 'queue');
      ref.title = 'Changed';
      c.appState.mode = 'Architect';
      c.appState.activeArchitectPlanId = 'different-plan';
      c.providerState.selectedProviderId = 'different-provider';
      c.providerState.selectedModelId = 'different-model';
      release(store);
      await store.getState().retryQueuedSubmissions('queued-conv');
      expect(loadQueuedSubmissions()).toEqual([]);
      expect(c.createMessageMock.mock.calls[0]?.[3]?.contextRefs).toMatchObject([{ title: 'README' }]);
      expect(c.streamChatMock).toHaveBeenCalledTimes(1);
      expect(c.getLatestStreamOptions()).toMatchObject({ providerId: 'provider-1' });
    });

    it('keeps an empty reference list after DB mapping and navigation to another composer', async () => {
      const store = await prepare();
      const { useSkillsStore } = await import('../useSkillsStore');
      const originalPrepareSkills = useSkillsStore.getState().prepareSkillsForTurn;
      const prepareSkills = mock(originalPrepareSkills);
      useSkillsStore.setState({ prepareSkillsForTurn: prepareSkills });
      try {
        await store.getState().submitDuringActiveTurn({ conversationId: 'queued-conv', content: 'No references here' }, 'queue');
        expect(loadQueuedSubmissions()[0].input.contextRefs).toEqual([]);
        store.setState({ selectedConversationId: 'other-conv', composerContextRefs: [
          { id: 'file:foreign', kind: 'file', title: 'Foreign file', path: '/synthetic/foreign-only.md' },
          { id: 'skill:foreign', kind: 'skill', title: 'Foreign skill', skillId: 'foreign-skill' },
        ] });
        release(store);
        await store.getState().retryQueuedSubmissions('queued-conv');
        // createMessageMock serializes [] and the real DB mapper returns undefined.
        // Preparation must still never consult the other conversation's composer.
        expect(c.createMessageMock.mock.calls[0]?.[3]?.contextRefs).toEqual([]);
        const persisted = store.getState().messagesByConversationId['queued-conv'].find((message: ChatMessage) => message.role === 'user');
        expect(persisted).toBeDefined();
        expect(persisted!.context_refs).toBeUndefined();
        expect(prepareSkills).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'queued-conv', contextRefs: [] }));
        expect(c.streamChatMock).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(c.getLatestStreamOptions().messages)).not.toContain('foreign-only');
        expect(JSON.stringify(c.getLatestStreamOptions().messages)).not.toContain('foreign-skill');
      } finally {
        useSkillsStore.setState({ prepareSkillsForTurn: originalPrepareSkills });
      }
    });

    it('keeps the Architect plan after selecting a different plan and mode', async () => {
      const store = await prepare();
      c.appState.mode = 'Architect';
      c.appState.activeArchitectPlanId = 'original-plan';
      c.appState.activePlanContext = { id: 'original-plan', targetBranch: 'develop' };
      const plan = c.createPlan({ id: 'original-plan', conversationId: 'queued-conv',
        planKind: 'bugfix', executionModesByProjectId: { 'project-1': 'direct' },
      });
      c.architectPlans.set(plan.id, plan);
      store.setState({ conversations: [{ ...c.createConversation('queued-conv'), scope_mode: 'Architect', task_id: null }] });
      await store.getState().submitDuringActiveTurn({ conversationId: 'queued-conv', content: 'Original plan discussion' }, 'queue');
      c.appState.mode = 'Architect';
      c.appState.activeArchitectPlanId = 'different-plan';
      c.appState.activePlanContext = { id: 'different-plan', targetBranch: 'main', executionModesByProjectId: { 'project-1': 'git' } };
      c.appState.planNodes = [];
      release(store);
      await store.getState().retryQueuedSubmissions('queued-conv');
      expect(loadQueuedSubmissions()).toEqual([]);
      expect(c.streamChatMock).toHaveBeenCalledTimes(1);
      expect(c.getArchitectPlanMock).toHaveBeenCalledWith('develop', 'original-plan');
      expect(c.getArchitectPlanMock).not.toHaveBeenCalledWith(expect.anything(), 'different-plan');
      const options = c.getLatestStreamOptions<{ messages: unknown[]; allowedToolIds: string[] }>();
      const sent = JSON.stringify(options.messages);
      expect(sent).toContain('[Active Plan] id=\\"original-plan\\"');
      expect(sent).not.toContain('different-plan');
      expect(sent).toContain('This is a Bugfix plan.');
      expect(sent).toContain('direct-only plan');
      expect(options.allowedToolIds).not.toContain('git_status');
    });

    it('publishes recovery during full hydration without depending on notifications', async () => {
      const store = await prepare();
      await store.getState().submitDuringActiveTurn({ conversationId: 'queued-conv', content: 'Recover after restart' }, 'queue');
      c.chatSnapshotConversations = [c.createChatSnapshotConversation('queued-conv', { scope_mode: 'Chat' })];
      const { useChatStore: restarted } = await c.loadChatStore();
      await restarted.getState().initializeCritical();
      expect(restarted.getState().queuedSubmissionRecoveryByConversationId['queued-conv']).toEqual({ count: 1, error: undefined });
      expect(restarted.getState().queuedSubmissionPreviews).toEqual([{
        id: loadQueuedSubmissions()[0].id,
        conversationId: 'queued-conv',
        content: 'Recover after restart',
      }]);
      await restarted.getState().retryQueuedSubmissions('queued-conv');
      expect(restarted.getState().queuedSubmissionRecoveryByConversationId).toEqual({});
      expect(restarted.getState().queuedSubmissionPreviews).toEqual([]);
      expect(c.streamChatMock).toHaveBeenCalledTimes(1);
    });

    it('edits a recovered instruction before sending it in its original conversation', async () => {
      const store = await prepare();
      await store.getState().submitDuringActiveTurn({ conversationId: 'queued-conv', content: 'Original instruction' }, 'queue');
      const [accepted] = loadQueuedSubmissions();
      const { useChatStore: restarted } = await c.loadChatStore();
      restarted.setState(c.createIdleChatStoreState({ conversations: store.getState().conversations }));

      await restarted.getState().editQueuedSubmission(accepted.id, 'Revised instruction');
      expect(loadQueuedSubmissions()[0].input.content).toBe('Revised instruction');
      await restarted.getState().retryQueuedSubmissions('queued-conv');
      expect(c.createMessageMock.mock.calls[0]?.[2]).toBe('Revised instruction');
      expect(c.createMessageMock.mock.calls[0]?.[3]?.turnId).toBe(accepted.id);
      expect(loadQueuedSubmissions()).toEqual([]);
    });

    it('removes a recovered instruction without sending it', async () => {
      const store = await prepare();
      await store.getState().submitDuringActiveTurn({ conversationId: 'queued-conv', content: 'Discard this instruction' }, 'queue');
      const [accepted] = loadQueuedSubmissions();
      const { useChatStore: restarted } = await c.loadChatStore();
      restarted.setState(c.createIdleChatStoreState({ conversations: store.getState().conversations }));

      await restarted.getState().removeQueuedSubmission(accepted.id);
      expect(loadQueuedSubmissions()).toEqual([]);
      await restarted.getState().retryQueuedSubmissions('queued-conv');
      expect(c.createMessageMock).not.toHaveBeenCalled();
      expect(c.streamChatMock).not.toHaveBeenCalled();
    });

    it('does not edit a queued entry whose user message was already saved', async () => {
      const store = await prepare();
      await store.getState().submitDuringActiveTurn({ conversationId: 'queued-conv', content: 'Already saved' }, 'queue');
      const [accepted] = loadQueuedSubmissions();
      const { useChatStore: restarted } = await c.loadChatStore();
      restarted.setState(c.createIdleChatStoreState({ conversations: store.getState().conversations }));
      c.listMessagesMock.mockImplementationOnce(async () => [{
        id: 'saved-user', conversation_id: 'queued-conv', role: 'user', content: 'Already saved',
        turn_id: accepted.id, created_at: '2026-09-22T00:00:00Z',
      }]);

      await expect(restarted.getState().editQueuedSubmission(accepted.id, 'Too late')).rejects.toThrow('already saved');
      expect(loadQueuedSubmissions()[0].input.content).toBe('Already saved');
    });

    for (const restart of [false, true]) it(`resolves the original task merge workspace after navigation, restart=${restart}`, async () => {
      let store = await prepare();
      await c.enableRealProjectExecutionContext();
      c.appState.mode = 'Implement';
      c.appState.selectedTaskId = 'merge-task';
      c.taskStoreState.tasks = [c.createImplementTask({ id: 'merge-task', status: 'InProgress' })];
      const taskState = c.taskStoreState as typeof c.taskStoreState & {
        activeWorkspacePathOverridesByProjectId?: Record<string, string>;
        activeRepositoryPath?: string;
        getMergeWorkflowRuntime?: (id: string) => MergeWorkflowRuntimeState | null;
      };
      taskState.activeWorkspacePathOverridesByProjectId = { 'project-1': '/synthetic/merge-repo' };
      taskState.activeRepositoryPath = '/synthetic/merge-repo';
      taskState.getMergeWorkflowRuntime = id => id === 'merge-task' ? {
        taskId: id, kind: 'task_completion', phase: 'blocked', taskStatus: 'InProgress', review: null,
        repositories: [{
          id: 'repo-1', projectId: 'project-1', repoPath: '/synthetic/merge-repo',
          repositoryRootPath: '/repos/web', integrationWorktreePath: '/synthetic/merge-repo',
          sourceBranchName: 'feature/merge-task', targetBranchName: 'develop',
          progressState: 'blocked', hadChangesAtStart: true, mergeAppliedAt: null,
          isClean: false, hasChanges: true, ahead: 1, behind: 1, mergeable: false,
          conflictFiles: ['file.ts'], dirtyFiles: [], mergeInProgress: true, diff: '',
          checkStatus: 'not_run', blockingKind: 'merge_conflict', nextAction: 'resolve_conflicts',
          blockingReason: 'Resolve conflict', isSourcePublished: false, mergeStrategy: 'file_conflict',
          recommendedAction: 'assistant', availableActions: ['assistant'],
        }],
        blockedRepositories: [], message: null, lastLoadedAt: null,
      } : null;
      try {
        store.setState({ conversations: [{ ...c.createConversation('queued-conv'), scope_mode: 'Implement', task_id: 'merge-task' }] });
        await store.getState().submitDuringActiveTurn({ conversationId: 'queued-conv', taskId: 'merge-task', content: 'Inspect merge' }, 'queue');
        c.appState.selectedTaskId = 'different-task';
        taskState.activeWorkspacePathOverridesByProjectId = { 'project-1': '/synthetic/different-task' };
        taskState.activeRepositoryPath = '/synthetic/different-task';
        if (restart) {
          const conversations = store.getState().conversations;
          ({ useChatStore: store } = await c.loadChatStore());
          store.setState(c.createIdleChatStoreState({ conversations }));
        }
        release(store);
        await store.getState().retryQueuedSubmissions('queued-conv');
        expect(loadQueuedSubmissions()).toEqual([]);
        expect(c.streamChatMock).toHaveBeenCalledTimes(1);
        expect(c.repositoryInstructionsLoadMock).toHaveBeenCalledWith(expect.objectContaining({ projects: expect.arrayContaining([expect.objectContaining({ rootPath: '/synthetic/merge-repo' })]) }));
        expect(JSON.stringify(c.getLatestStreamOptions().messages)).not.toContain('/synthetic/different-task');
      } finally {
        delete taskState.activeWorkspacePathOverridesByProjectId;
        delete taskState.activeRepositoryPath;
        delete taskState.getMergeWorkflowRuntime;
        c.useRealProjectExecutionContext = false;
      }
    });

    it('reconciles an already saved turn without another user message or stream', async () => {
      const store = await prepare();
      await store.getState().submitDuringActiveTurn({ conversationId: 'queued-conv', content: 'Already saved' }, 'queue');
      const [entry] = loadQueuedSubmissions();
      c.listMessagesMock.mockImplementationOnce(async () => [{
        id: 'saved-user', conversation_id: 'queued-conv', role: 'user', content: 'Already saved',
        turn_id: entry.id, created_at: '2026-09-22T00:00:00Z',
      }]);
      release(store);
      await Promise.all([store.getState().retryQueuedSubmissions('queued-conv'), store.getState().retryQueuedSubmissions('queued-conv')]);
      expect(loadQueuedSubmissions()).toEqual([]);
      expect(c.createMessageMock).not.toHaveBeenCalled();
      expect(c.streamChatMock).not.toHaveBeenCalled();
      expect(store.getState().getConversationMessages('queued-conv')).toMatchObject([{ id: 'saved-user' }]);
    });

    it('rejects acceptance on storage failure so the caller can retain its draft', async () => {
      const store = await prepare();
      const storage = window.localStorage;
      const setItem = storage.setItem;
      storage.setItem = (key, value) => {
        if (key === QUEUED_SUBMISSIONS_STORAGE_KEY) throw new Error('quota');
        setItem.call(storage, key, value);
      };
      try {
        await expect(store.getState().submitDuringActiveTurn({ conversationId: 'queued-conv', content: 'Unsaved' }, 'queue')).rejects.toThrow('could not be saved');
        expect(loadQueuedSubmissions()).toEqual([]);
      } finally { storage.setItem = setItem; }
    });

    it('does not send a queued message through a provider disabled since acceptance', async () => {
      const store = await prepare();
      await store.getState().submitDuringActiveTurn({ conversationId: 'queued-conv', content: 'Retained' }, 'queue');
      const configs = c.providerState.providerConfigs;
      c.providerState.providerConfigs = configs.map(config => ({ ...config, isEnabled: false }));
      try {
        release(store);
        await store.getState().retryQueuedSubmissions('queued-conv');
        expect(loadQueuedSubmissions()).toHaveLength(1);
        expect(c.createMessageMock).not.toHaveBeenCalled();
        expect(c.streamChatMock).not.toHaveBeenCalled();
      } finally { c.providerState.providerConfigs = configs; }
    });

    it('keeps accepted messages on shutdown without starting another turn', async () => {
      const store = await prepare();
      await store.getState().submitDuringActiveTurn({ conversationId: 'queued-conv', content: 'After restart' }, 'queue');
      const releaseShutdown = beginAppShutdownGate();
      release(store);
      try {
        await store.getState().retryQueuedSubmissions('queued-conv');
        expect(loadQueuedSubmissions()).toHaveLength(1);
        expect(c.createMessageMock).not.toHaveBeenCalled();
      } finally { releaseShutdown(); }
    });

    it('pauses archived conversations and removes the queue on conversation deletion', async () => {
      const store = await prepare();
      await store.getState().submitDuringActiveTurn({ conversationId: 'queued-conv', content: 'Retained' }, 'queue');
      release(store);
      useConversationArchiveStore.setState({ archivedConversationIds: new Set(['queued-conv']) });
      try {
        await store.getState().retryQueuedSubmissions('queued-conv');
        expect(loadQueuedSubmissions()).toHaveLength(1);
        expect(c.createMessageMock).not.toHaveBeenCalled();
      } finally { useConversationArchiveStore.setState({ archivedConversationIds: new Set() }); }
      await store.getState().deleteConversation('queued-conv');
      expect(loadQueuedSubmissions()).toEqual([]);
      expect(c.streamChatMock).not.toHaveBeenCalled();
    });

    it('retains attachments when the user message is saved but image storage fails', async () => {
      const store = await prepare();
      const images = [{ id: 'image', mimeType: 'image/png', dataUrl: 'data:image/png;base64,AQID', createdAt: '2026-09-22T00:00:00Z' }];
      await store.getState().submitDuringActiveTurn({ conversationId: 'queued-conv', content: 'Image', images }, 'queue');
      const storage = window.localStorage;
      const setItem = storage.setItem;
      storage.setItem = (key, value) => {
        if (key === 'macro_chat_message_images') throw new Error('quota');
        setItem.call(storage, key, value);
      };
      release(store);
      try { await store.getState().retryQueuedSubmissions('queued-conv'); }
      finally { storage.setItem = setItem; }
      const [entry] = loadQueuedSubmissions();
      expect(entry.input.images).toEqual(images);
      expect(c.streamChatMock).not.toHaveBeenCalled();
      c.listMessagesMock.mockImplementationOnce(async () => [{
        id: 'saved-image-user', conversation_id: 'queued-conv', role: 'user', content: 'Image',
        turn_id: entry.id, created_at: '2026-09-22T00:00:00Z',
      }]);
      release(store);
      await store.getState().retryQueuedSubmissions('queued-conv');
      expect(loadQueuedSubmissions()).toEqual([]);
      expect(store.getState().getMessageImages('saved-image-user')).toEqual(images);
      expect(c.createMessageMock.mock.calls.filter(call => call[1] === 'user')).toHaveLength(1);
    });
  });
}
