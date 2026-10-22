// Invoked only by the native profile, never by Bun's frontend test discovery.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';

const [root, scenario, phase] = process.argv.slice(2);
const emit = (value: unknown) => console.log(`MACRO_WORKER:${JSON.stringify(value)}`);
let sequence = 0;
const pending = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void }>();
const input = createInterface({ input: process.stdin });
input.on('line', line => {
  const response = JSON.parse(line);
  const request = pending.get(response.id);
  assert(request, `Unexpected native response ${line}`);
  pending.delete(response.id);
  if ('error' in response) request.reject(response.error);
  else request.resolve(response.value);
});
const rawInvoke = <T>(command: string, args: unknown = {}): Promise<T> => new Promise((resolve, reject) => {
  const id = ++sequence;
  pending.set(id, { resolve: value => resolve(value as T), reject });
  emit({ command, args, id });
});
const boundary = async (point: string): Promise<never> => {
  emit({ boundary: point });
  return new Promise(() => {});
};
let armed = false;
const invoke = async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
  if (command === 'plugin:event|listen') return 0 as T;
  if (command === 'plugin:event|unlisten') return undefined as T;
  const value = await rawInvoke<T>(command, args);
  if (armed && phase === 'crash') {
    if (scenario === 'file' && command === 'fs_write_file' && args.path === 'effect.txt') await boundary('file-effect-before-receipt');
    if (scenario === 'merge' && command === 'git_merge') await boundary('first-merge-before-checkpoint');
    if (scenario === 'metadata' && command === 'db_compare_and_swap_app_setting' &&
      args.key === 'pendingPlanLifecycles:v1' && JSON.parse(String(args.valueJson)).some(
        (saga: { operation: string; phase: string }) => saga.operation === 'finalize' && saga.phase === 'metadata_written',
      )) await boundary('metadata-before-journal-close');
  }
  return value;
};

// The DOM storage adapter models infrastructure only. Production serializers own
// the recovery format. Each successful set/remove survives the worker's death.
const storagePath = path.join(root, 'local-storage.json');
const storage = {
  values: existsSync(storagePath) ? JSON.parse(readFileSync(storagePath, 'utf8')) as Record<string, string> : {},
  getItem(key: string) { return this.values[key] ?? null; },
  setItem(key: string, value: string) { this.values[key] = value; this.flush(); },
  removeItem(key: string) { delete this.values[key]; this.flush(); },
  key(index: number) { return Object.keys(this.values)[index] ?? null; },
  get length() { return Object.keys(this.values).length; },
  flush() { writeFileSync(`${storagePath}.tmp`, JSON.stringify(this.values)); renameSync(`${storagePath}.tmp`, storagePath); },
};
Object.assign(globalThis, { window: Object.assign(new EventTarget(), { localStorage: storage,
  __TAURI_INTERNALS__: { invoke, transformCallback: () => 0, unregisterCallback() {} } }), localStorage: storage });
globalThis.fetch = Object.assign(async () => { throw new Error('External HTTP is forbidden in process recovery tests'); }, { preconnect() {} });
const ipc = await import('../../../src/services/tauriIpc');
const fixturePath = path.join(root, 'fixture.json');
const readFixture = () => JSON.parse(readFileSync(fixturePath, 'utf8')) as { conversationId: string; messageId: string };

async function chatFixture() {
  if (phase !== 'crash') return readFixture();
  const conversation = await ipc.createConversation({ title: 'Process recovery fixture' });
  const message = await ipc.createMessage(conversation.id, 'assistant', '', { id: 'assistant-recovery', turnId: 'turn-recovery' });
  const fixture = { conversationId: conversation.id, messageId: message.id };
  writeFileSync(fixturePath, JSON.stringify(fixture));
  return fixture;
}

async function fileScenario() {
  const fixture = await chatFixture();
  const { createChatToolDispatch } = await import('../../../src/services/chatToolDispatch');
  const { chatToolInvocationJournal } = await import('../../../src/services/chatToolInvocationJournal');
  const operation = { conversationId: fixture.conversationId, turnId: 'turn-recovery', assistantMessageId: fixture.messageId,
    signal: new AbortController().signal, allowedToolIds: ['write'] };
  let executions = 0;
  const dispatch = createChatToolDispatch(operation as unknown as Parameters<typeof createChatToolDispatch>[0], {
    journal: chatToolInvocationJournal,
    execute: async () => {
      executions++;
      const previous = existsSync(path.join(root, 'effect.txt')) ? readFileSync(path.join(root, 'effect.txt'), 'utf8') : '';
      await ipc.fsWriteFile({ path: 'effect.txt', content: `${previous}effect\n` });
      return 'saved';
    },
    preserve: async (_operation, _name, _id, result) => result,
    boundError: async (_operation, _name, _id, error) => error,
  }, () => true, () => {});
  armed = true;
  const result = await dispatch('write', { path: 'effect.txt', content: 'effect\n' }, 'call-recovery');
  assert.notEqual(phase, 'crash', 'File boundary was not reached');
  assert.equal(executions, 0, 'Recovery replayed the file effect');
  assert.match(String((result as { result: string }).result), /already recorded/);
  const unresolved = await rawInvoke<Array<{ status: string; receipt_id: string | null }>>('db_list_unresolved_tool_invocations', { conversationId: fixture.conversationId });
  assert.equal(unresolved.length, 1);
  assert.equal(unresolved[0].status, 'unknown');
  assert.equal(unresolved[0].receipt_id, null);
}

async function planScenario() {
  const { installArchitectPlanPorts } = await import('../../../src/services/architectPlanReadContext');
  const { buildValidProjectRegistrySnapshot } = await import('../../../src/services/validProjectRegistry');
  const { createArchitectPlanService } = await import('../../../src/services/architectPlanService');
  const { createArchitectGitFlowService } = await import('../../../src/services/architectGitFlowService');
  const { getDefaultProjectGitFlowSettings } = await import('../../../src/services/architectGitNaming');
  const projects: import('../../../src/types').Project[] = ['a', 'b'].map(id => ({ id, name: id, mountName: id, path: path.join(root, id),
    gitSetupState: 'ready', directEdit: false, created_at: '2026-01-01', status: 'active',
    metadata: { description: '', tags: [], team_members: [], api_contracts: [], dependencies: [] },
    gitFlowSettings: { ...getDefaultProjectGitFlowSettings(), baseBranch: 'develop', mainBranch: 'main' } }));
  const app = { selectedGroupId: 'recovery', selectedProjectId: null, metadataAutoPush: false,
    projectGroups: [{ id: 'recovery', name: 'Recovery', isOpen: true, projects }],
    getProjectById: (id: string) => projects.find(project => project.id === id) };
  const registry = buildValidProjectRegistrySnapshot(app);
  const stop = installArchitectPlanPorts({ getAppState: () => app, loadRegistrySnapshot: async () => registry });
  const plans = createArchitectPlanService();
  const git = createArchitectGitFlowService({ getAppState: () => app, ...plans });
  if (phase === 'crash') {
    await plans.createArchitectPlan({ branchName: 'develop', planId: 'recovery-plan', slug: 'recovery',
      title: 'Recovery', status: 'validated', projectIds: ['a', 'b'], nodes: [], predictedBranches: [] });
    armed = true;
    await git.finalizePlanIntoBaseBranch({ branchName: 'develop', planId: 'recovery-plan' });
    throw new Error(`Missing ${scenario} boundary`);
  }
  await git.resumePlanLifecycleSagas();
  const plan = await plans.getArchitectPlan('develop', 'recovery-plan');
  assert.equal(plan?.status, 'archived');
  const { loadPlanLifecycleSagas } = await import('../../../src/services/planLifecycleSaga');
  assert.deepEqual(await loadPlanLifecycleSagas(), []);
  stop();
}

async function responseScenario() {
  const { mock } = await import('bun:test');
  const streaming = await import('../../../src/services/streamingChat');
  let providerCalls = 0;
  let metadataProviderCalls = 0;
  mock.module('../../../src/services/streamingChatExecution', () => ({
    streamChat: async (options: Parameters<typeof streaming.streamChat>[0]) => {
      providerCalls++;
      assert.equal(phase, 'crash', 'Recovery called the provider again');
      await rawInvoke('test_message_write_failure', { enabled: true });
      options.onComplete?.({ visibleContent: 'Response retained across process death.', hiddenContext: 'Synthetic hidden context',
        providerInputItems: [{ role: 'assistant', content: 'Synthetic provider state' }],
        toolTraces: [], completionReason: 'completed', generationAttempts: [{ id: 'attempt-recovery', status: 'completed',
          rawText: 'Synthetic raw text', acceptedText: 'Response retained across process death.', costUsd: null }] });
    },
    sendChatNonStreaming: async () => {
      metadataProviderCalls++;
      assert.equal(phase, 'crash', 'Recovery requested fresh provider metadata');
      return JSON.stringify({ title: 'Synthetic recovery', description: 'Synthetic conversation metadata' });
    },
  }));
  const { useAppStore } = await import('../../../src/stores/useAppStore');
  const { useProviderStore } = await import('../../../src/stores/useProviderStore');
  const { useChatStore } = await import('../../../src/stores/useChatStore');
  const { loadUnsavedAssistantResponsesFromStorage } = await import('../../../src/stores/chat/chatLocalSessionState');
  useAppStore.setState({ mode: 'Chat', selectedGroupId: null, selectedProjectId: null, selectedTaskId: null,
    projectGroups: [], standaloneProjects: [] });
  useProviderStore.setState({ isLoading: false, selectedProviderId: 'recovery-provider', selectedModelId: 'recovery-model',
    providerConfigs: [{ id: 'recovery-provider', name: 'Synthetic', providerType: 'openai', baseUrl: 'http://127.0.0.1:9',
      isEnabled: true, isLocal: true, hasStoredApiKey: false, apiKeyLoaded: true }],
    modelsByProvider: { 'recovery-provider': [{ id: 'recovery-model', provider_id: 'recovery-provider', name: 'Synthetic',
      isEnabled: true, contextWindowTokens: 128000, inputLimitTokens: 120000, outputLimitTokens: 8000,
      contextWindowSource: 'user_override' }] },
  });
  if (phase === 'crash') {
    const conversation = await ipc.createConversation({ title: 'Recovery fixture with fixed title' });
    writeFileSync(fixturePath, JSON.stringify({ conversationId: conversation.id }));
  }
  const { conversationId } = readFixture();
  await useChatStore.getState().initializeCritical();
  assert.equal(useChatStore.getState().hydrationStatus, 'ready', useChatStore.getState().lastError ?? 'Chat hydration failed');
  await useChatStore.getState().ensureMessagesLoaded(conversationId);
  if (phase === 'crash') {
    const failed = new Promise<void>(resolve => {
      const unsubscribe = useChatStore.subscribe(state => {
        if (state.getConversationMessages(conversationId).some(message => message.persistence_state === 'failed') &&
          state.getConversationRuntime(conversationId).phase === 'error') { unsubscribe(); resolve(); }
      });
    });
    await useChatStore.getState().sendMessage({ conversationId, content: 'Keep the synthetic response.' });
    await failed;
    assert.equal(providerCalls, 1);
    const response = useChatStore.getState().getConversationMessages(conversationId).find(message => message.role === 'assistant')!;
    assert.equal(response.persistence_state, 'failed');
    assert.match(response.persistence_error!, /^Failed to save assistant response: Database error:.*recovery injected message write failure/);
    assert.match(useChatStore.getState().getConversationRuntime(conversationId).lastError!, /Failed to save assistant response/);
    assert.equal(loadUnsavedAssistantResponsesFromStorage()[0]?.content, response.content);
    await assert.rejects(useChatStore.getState().sendMessage({ conversationId, content: 'Blocked until saved.' }), { message: /Save or delete the unsaved assistant response/ });
    writeFileSync(fixturePath, JSON.stringify({ conversationId, messageId: response.id }));
    await boundary('failed-response-retained');
  }
  const fixture = readFixture();
  const response = useChatStore.getState().getConversationMessages(conversationId).find(message => message.id === fixture.messageId)!;
  assert(response, 'Chat hydration lost the response');
  assert.equal(response.content, 'Response retained across process death.');
  if (phase === 'resume') {
    assert.equal(response.persistence_state, 'failed');
    await assert.rejects(useChatStore.getState().sendMessage({ conversationId, content: 'Still blocked after restart.' }), { message: /Save or delete the unsaved assistant response/ });
    await rawInvoke('test_message_write_failure', { enabled: false });
    await useChatStore.getState().retryAssistantPersistence(response.id);
    assert.equal(useChatStore.getState().getConversationMessages(conversationId).find(message => message.id === response.id)?.persistence_state, undefined);
    assert.equal(useChatStore.getState().getConversationRuntime(conversationId).phase, 'idle');
  } else {
    assert.equal(response.persistence_state, undefined);
    await assert.rejects(useChatStore.getState().retryAssistantPersistence(response.id), /not waiting to be saved/);
  }
  assert.equal(providerCalls, 0);
  assert.equal(metadataProviderCalls, 0);
  assert.deepEqual(loadUnsavedAssistantResponsesFromStorage(), []);
  const saved = await ipc.listMessages(conversationId);
  assert.equal(saved.filter(message => message.role === 'assistant').length, 1);
  const assistant = saved.find(message => message.role === 'assistant')!;
  assert.equal(assistant.content, response.content);
  assert.equal(assistant.hidden_context, 'Synthetic hidden context');
  assert.match(assistant.generation_attempts_json!, /attempt-recovery/);
}

try {
  if (scenario === 'file') await fileScenario();
  else if (scenario === 'response') await responseScenario();
  else await planScenario();
  emit({ complete: phase });
} finally {
  input.close();
}
