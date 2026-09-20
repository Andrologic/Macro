import { mock } from "bun:test";
import type { ChatMessage, ConversationRuntimeState } from "../types";
import type { ChatPersistenceIpc } from "../services/chatPersistenceService";
import type { ChatSendPorts, ChatSendSnapshot, SendTask } from "../services/chatSend/contracts";
import { sendMessage } from "../services/chatSend/sendMessage";

export function chatSendFixture(mode: ChatSendSnapshot['mode'] = 'Chat') {
  const events: string[] = [];
  const runtimes = new Map<string, ConversationRuntimeState>();
  const sessions = new Map<string, string>();
  const deleted = new Set<string>();
  const published: ChatMessage[] = [];
  const task: SendTask = { task_source: 'standalone', standalone_kind: 'manual_feature', draft: true };
  let launch: { sessionId: string; taskId: string } | undefined;
  let serial = 0;
  const snapshot: ChatSendSnapshot = {
    mode, agentType: mode === 'Implement' ? 'build' : null,
    conversationTaskId: mode === 'Implement' ? 'task-1' : null, selectedTaskId: '',
    composerContextRefs: [], composerRevision: 3,
    architectPlan: mode === 'Architect' ? { planId: 'plan-1', targetBranch: 'develop' } : undefined,
    executionContext: {
      groupId: null, groupName: null, projectIds: ['project-1'], actionableProjectIds: ['project-1'],
      contextProjectIds: [], projectMounts: [], focusedProjectId: 'project-1', virtualRootEnabled: false,
      workspacePathsByProjectId: {}, defaultWorkspacePath: null, projectId: 'project-1',
      projectName: 'Project', taskId: null, branchName: null, workspacePath: null,
    },
    provider: {
      selectedProviderId: 'provider-1', selectedModelId: 'model-1', selectedReasoningEffort: 'high', isLoading: false,
      providerConfigs: [{ id: 'provider-1', name: 'Provider', providerType: 'openai', baseUrl: 'https://example.invalid', hasStoredApiKey: false, isLocal: true, isEnabled: true }],
    },
  };
  const createMessage = mock<ChatPersistenceIpc['createMessage']>(async (id, role, content, options) => {
    events.push(`save:${role}:${id}`);
    return {
      id: `${role}-${++serial}`, conversation_id: id, turn_id: options?.turnId ?? null,
      role, content, created_at: '2026-01-01T00:00:00Z', token_count: null,
      tool_traces_json: null, hidden_context: options?.hiddenContext ?? null,
      provider_input_items_json: options?.providerInputItems ? JSON.stringify(options.providerInputItems) : null,
      provider_turn_state_json: null,
    };
  });
  const deleteAfter = mock(async () => { events.push('delete-after'); });
  // Other persistence operations are outside this use case; fail if accidentally called.
  const unexpected = async (): Promise<never> => { throw new Error('Unexpected persistence operation'); };
  const ports: ChatSendPorts<SendTask, { taskId: string }, { prepared: true }> = {
    owner: {
      read: (id) => runtimes.get(id) ?? { phase: 'idle', sessionId: null },
      set: (id, runtime) => { if (runtime) runtimes.set(id, runtime); else runtimes.delete(id); },
      update: (id, session, updater) => {
        const runtime = runtimes.get(id);
        if (runtime?.sessionId !== session) return false;
        ports.owner.set(id, updater(runtime)); return true;
      },
      latestSession: (id) => sessions.get(id), rememberSession: (id, session) => { sessions.set(id, session); },
      forgetSession: (id) => { sessions.delete(id); },
      transfer: (previous, next, session) => {
        if (sessions.get(previous) !== session || sessions.has(next) || deleted.has(next)) return false;
        sessions.delete(previous); sessions.set(next, session); return true;
      },
    },
    messages: {
      persistence: { isTauriAvailable: () => true, ipc: {
        createMessage, deleteMessagesAfter: deleteAfter, getChatBootstrapSnapshot: unexpected,
        listConversations: unexpected, listMessages: unexpected, updateMessage: unexpected,
        renameConversation: unexpected, deleteConversation: unexpected, deleteConversations: unexpected,
        deleteConversationTurn: unexpected,
      } },
      ensureLoaded: mock(async () => {}), list: (id) => published.filter((message) => message.conversation_id === id),
      hasInterruptedApproval: () => false, clearApprovalRecovery: mock(async () => {}),
    },
    preparation: {
      assertCanSend: () => { if (runtimes.has('conversation-1')) throw new Error('Already running'); },
      isDeleted: (id) => deleted.has(id), createSessionId: () => 'session-1', createTurnId: () => 'turn-1',
      hasPendingArchitectConversation: () => false, materializeArchitectConversation: mock(async (id) => id),
      bindArchitectConversation: mock(async () => true), syncArchitectMetadata: mock(async () => {}),
      generateMetadata: mock(async () => { events.push('metadata'); }),
    },
    configuration: {
      load: mock(async () => null), selectScoped: () => null, hasAuthSession: () => false,
      resolveApiKey: mock(async () => 'secret'), supportsNativeToolCalling: () => true,
    },
    tasks: {
      read: () => task,
      finalizeDraft: mock(async () => { events.push('finalize'); task.draft = false; return { taskId: 'task-1' }; }),
      assertReady: mock(async () => task), assertExecutionContextReady: () => {},
      rollbackDraft: mock(async () => { events.push('rollback'); task.draft = true; }),
      beginLaunch: mock((params) => { events.push('launch'); launch = params; }),
      setLaunchStep: (_id, _session, step) => { events.push(step); },
      completeLaunch: mock(() => { events.push('complete'); }), readLaunch: () => launch,
      failLaunch: mock(() => { events.push('fail'); }),
    },
    projection: {
      persistSelection: mock(() => {}),
      publishUser: mock((message) => { events.push('publish:user'); published.push(message); }),
      publishAssistant: mock((message) => { events.push('publish:assistant'); published.push(message); }),
      clearSecurity: mock(() => {}), approvalRecoveryError: mock(() => {}),
      launchError: mock(() => ({ applied: true })), sendError: mock(() => {}), timeline: () => {},
    },
    stream: {
      prepare: mock(async () => { events.push('prepare'); return { prepared: true as const }; }),
      start: mock(() => { events.push('start'); }),
    },
  };
  const input = { conversationId: 'conversation-1', content: 'Build the feature' };
  const run = () => sendMessage(input, snapshot, ports);
  const stop = () => runtimes.get('conversation-1')?.abortController?.abort();
  return { input, snapshot, ports, run, stop, events, sessions, runtimes, published, deleted, task, createMessage, deleteAfter };
}
