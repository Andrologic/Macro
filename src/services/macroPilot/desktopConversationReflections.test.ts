import { expect, test } from 'bun:test';
import { desktopConversationReflections } from './desktopConversationReflections';
import type { DesktopStorePorts } from './desktopStorePorts';
import type { PilotReflectionMessageRead } from '../tauriIpc';
import type { ContentConversationRef } from './contentProtocol';
import { pilotTaskId } from './taskIdentity';
function harness(implement=false) {
  const taskId='task:v1:develop:plan%3Ademo:child';
  const conversation={ id: 'conversation-demo',scope_mode: implement ? 'Implement' : 'Chat',task_id: implement ? taskId : null };
  const message={ id: 'assistant-demo',conversation_id: conversation.id,role: 'assistant',turn_id: 'turn-demo',content: '<think>Une réflexion visible</think>Réponse finale',hidden_context: 'hidden-private',provider_turn_state: { private: 'provider-private' },tool_traces: [] };
  let runtime: Record<string,unknown> = { phase: 'idle' };let nativeReads=0;
  let native: PilotReflectionMessageRead = { state: 'ready',message: { id: message.id,conversation_id: conversation.id,turn_id: message.turn_id,role: 'assistant',content: message.content,has_hidden_context: false,tool_traces: [],conversation_scope_mode: conversation.scope_mode,conversation_task_id: conversation.task_id } } as PilotReflectionMessageRead;
  const ref: ContentConversationRef=implement ? { instance_id: 'instance-demo',workspace_id: 'workspace-demo',kind: 'implement',task_id: pilotTaskId(taskId),conversation_id: conversation.id } : { instance_id: 'instance-demo',kind: 'conversation',conversation_id: conversation.id };
  const ports={ chat: () => ({ conversations: [conversation],messages: [message],messageIndexById: { [message.id]: 0 },messagesByConversationId: { [conversation.id]: [message] },conversationRuntimeById: { [conversation.id]: runtime } }),tasks: () => ({ tasks: [{ id: taskId,conversation_id: conversation.id }] }) } as unknown as DesktopStorePorts;
  const source=desktopConversationReflections({ instanceId: ref.instance_id,workspaceId: 'workspace-demo',ports,signal: new AbortController().signal,readMessage: async () => { nativeReads++;return structuredClone(native); } });
  return { source,ref,message,conversation,live: () => { runtime={ phase: 'streaming',sessionId: 'session-demo',turnId: message.turn_id,assistantMessageId: message.id }; },runtime: (value: Record<string,unknown>) => { runtime=value; },native: (value: PilotReflectionMessageRead) => { native=value; },reads: () => nativeReads };
}
test('reads history by exact native identity and projects only visible thinking with no provider or hidden fields',async () => {
  for (const implement of [false,true]) {
    const h=harness(implement);const result=await h.source.observe(h.ref,h.message.id);
    expect(result.source).toBe('history');expect(result.blocks.map(b => b.content)).toEqual(['Une réflexion visible']);expect(result.turnId).toBe('turn-demo');
    expect(JSON.stringify(result)).not.toContain('provider-private');expect(JSON.stringify(result)).not.toContain('hidden-private');expect(h.reads()).toBe(1);
  }
});
test('reads the actual active message and owner after confirming durable identity without hydrating the transcript',async () => {
  const h=harness();h.live();h.message.content='<think>Flux visible';
  const result=await h.source.observe(h.ref,h.message.id);
  expect(result.source).toBe('active');expect(result.blocks[0]).toMatchObject({ content: 'Flux visible',partial: true });expect(result.generationId).toMatch(/^[a-f0-9]{64}$/);expect(h.reads()).toBe(1);
  h.message.turn_id='different-turn';expect((await h.source.observe(h.ref,h.message.id)).state).toBe('unavailable');
});
test('rejects foreign references and an active message belonging to another conversation',async () => {
  const h=harness();await expect(h.source.observe({ ...h.ref,instance_id: 'foreign' },h.message.id)).rejects.toThrow('not_found');expect(h.reads()).toBe(0);
  h.live();h.message.conversation_id='foreign';expect((await h.source.observe(h.ref,h.message.id)).state).toBe('unavailable');expect(h.reads()).toBe(1);
  h.conversation.scope_mode='Architect';await expect(h.source.validateTarget(h.ref)).rejects.toThrow('not_found');
});
test('keeps withheld native sources text-free and never reconstructs reflections from hidden JSON',async () => {
  const h=harness();h.native({ state: 'withheld',message: null });const result=await h.source.observe(h.ref,h.message.id);
  expect(result).toMatchObject({ state: 'withheld',content: '',blocks: [],turnId: null });
});
