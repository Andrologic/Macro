import { expect, test } from 'bun:test';
import { desktopConversationInteractions } from './desktopConversationInteractions';
import type { DesktopStorePorts } from './desktopStorePorts';
import type { ConversationCaptures } from './conversationCaptures';
const ref = { instance_id: 'instance', kind: 'conversation' as const, conversation_id: 'chat' };
const policy = { revision: 'visible-1', secrets: [], repoPaths: [] };
function fixture() {
  const conversation = { id: 'chat', scope_mode: 'Chat', task_id: null, provider_id: 'provider', model_id: 'model' };
  let runtime = { phase: 'streaming', sessionId: 'session', turnId: 'turn', assistantMessageId: 'assistant' };
  let question: unknown = null;
  let stopped = 0, submitted = 0;
  const recorded: string[] = [];
  const chat = {
    conversations: [conversation], ensureMessagesLoaded: async () => undefined,
    getConversationRuntime: () => runtime, getActiveQuestionnaire: () => question,
    stopConversationStream: () => { stopped++; runtime = { ...runtime, phase: 'idle' }; },
    setActiveQuestionnaireStep: () => undefined,
    recordActiveQuestionnaireAnswer: (_id: string, answer: string) => { recorded.push(answer); return { completed: true }; },
    submitActiveQuestionnaire: async (_id: string, options: { beforeEffect(): Promise<void> }) => { await options.beforeEffect(); submitted++; question = null; return { status: 'sent' }; },
  };
  const ports = { chat: () => chat, tasks: () => ({}), app: () => ({}), taskLifecycle: () => ({}), taskCommandTargets: () => [] } as unknown as DesktopStorePorts;
  const captures = { refreshCatalogMetadata: async () => ({ refs: [ref] }) } as unknown as ConversationCaptures;
  const source = desktopConversationInteractions('instance', captures, ports, new AbortController().signal);
  return { source, chat, recorded, count: () => ({ stopped, submitted }), runtime: (r: typeof runtime) => { runtime = r; }, currentRuntime: () => runtime,
    question: () => { runtime = { ...runtime, phase: 'idle' }; question = { mode: 'pending_reply', assistantMessageId: 'question', totalSteps: 1, answersByStepId: {}, questionnaire: { questions: [{ id: 'choice', prompt: 'Choisir un format', choices: ['PDF'] }] } }; } };
}
test('native stop is fenced to its generation even when a later turn starts during authorization', async () => {
  const f = fixture(); const initial = await f.source.load(ref, policy);
  expect(initial.state.actions).toEqual(['stop']);
  const body = { ref, snapshot_id: 'capture', expected_revision: 1, idempotency_key: 'stop', action: 'stop' as const, generation_id: initial.state.generation_id! };
  await expect(f.source.execute(body, async () => { f.runtime({ ...f.currentRuntime(), turnId: 'later' }); })).rejects.toThrow('stale_revision');
  expect(f.count().stopped).toBe(0);
  const fresh = await f.source.load(ref, policy);
  await f.source.execute({ ...body, generation_id: fresh.state.generation_id! }, async () => undefined);
  expect(f.count().stopped).toBe(1);
});
test('standalone Chat questionnaire uses native answer actions without a task or selected chat', async () => {
  const f = fixture(); f.question(); const initial = await f.source.load(ref, policy);
  expect(initial.state.question?.assistant_message_id).toBe('question'); expect(initial.state.actions).toEqual(['answer']);
  await f.source.execute({ ref, snapshot_id: 'capture', expected_revision: 1, idempotency_key: 'answer', action: 'answer', assistant_message_id: 'question', answers: [{ step_id: 'choice', answer: 'PDF' }] }, async () => undefined);
  expect(f.recorded).toEqual(['PDF']); expect(f.count().submitted).toBe(1); expect(f.chat.conversations[0].scope_mode).toBe('Chat');
});
