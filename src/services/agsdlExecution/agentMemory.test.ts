import { describe, expect, it } from 'bun:test';
import { MacroAgentMemory } from './agentMemory';
import { compileFixture, documentFixture, id, json } from './conformanceFixtures';
import { decode, encode, record } from './exact';
import { runToolCallingLoop } from '../ai/toolCallingLoop';
import { createStreamAccumulator } from '../ai/streamAccumulator';
import { StreamStopUnconfirmedError } from '../ai/streamCancellation';
import type { StreamingChatOptions } from '../ai/contracts';

async function configuration() {
  const result = await compileFixture(documentFixture());
  if (!result.plan) throw new Error('Fixture must compile');
  return result.plan.agents[0];
}
describe('Macro Agent memory', () => {
  it('initializes before failed adaptation and reuses the same Agent across steps', async () => {
    const config = await configuration();
    const memory = await MacroAgentMemory.prepare(id('agent'), config, null);
    let initialized = false;
    await expect(memory.acceptInput(() => { initialized = memory.messages()[0]?.content === 'Review.'; throw new Error('INPUT_CONSTRAINT'); })).rejects.toThrow('INPUT_CONSTRAINT');
    expect(initialized).toBe(true);
    const recovered = await MacroAgentMemory.prepare(id('agent'), config, memory.checkpoint());
    expect(recovered.messages()).toEqual([{ role: 'system', content: 'Review.' }]);
    await recovered.acceptInput(() => json('{"prompt":[{"value":"Second step"}],"resources":{"record":{"value":9007199254740993,"mediaType":"application/json"}}}'));
    expect(recovered.messages()[1]).toEqual({ role: 'user', content: 'Second step' });
    expect(recovered.messages()[2].content).toContain('9007199254740993');
    expect(recovered.checkpoint().revision).toBe(id<'sequence'>('2'));
    expect(recovered.checkpoint().stateJson).not.toContain('conversationId');
  });
  it('rejects another Agent or changed configuration and preserves exact tool strings', async () => {
    const config = await configuration();
    const memory = await MacroAgentMemory.prepare(id('agent'), config, null);
    memory.retain([{ role: 'assistant', content: '', tool_calls: [{ id: 'tool', type: 'function', function: { name: 'publication', arguments: '{"value":9007199254740993}' } }] }, { role: 'tool', tool_call_id: 'tool', content: '9007199254740993' }]);
    const checkpoint = memory.checkpoint();
    await expect(MacroAgentMemory.prepare(id('other'), config, checkpoint)).rejects.toMatchObject({ code: 'CORRELATION' });
    await expect(MacroAgentMemory.prepare(id('agent'), { ...config, modelId: 'changed' }, checkpoint)).rejects.toMatchObject({ code: 'CORRELATION' });
    const restored = await MacroAgentMemory.prepare(id('agent'), config, checkpoint);
    expect(restored.messages()[0].tool_calls?.[0].function.arguments).toBe('{"value":9007199254740993}');
    const view = restored.messages(); view[0].content = 'changed';
    expect(restored.messages()[0].content).toBe('');
  });
  it('checkpoints the actual shared loop and retains unconfirmed executor ownership if the checkpoint fails', async () => {
    const memory = await MacroAgentMemory.prepare(id('agent'), await configuration(), null);
    await memory.acceptInput(() => json('{"prompt":[{"value":"Run"}]}'));
    const options: StreamingChatOptions = { providerId: 'synthetic', providerType: 'openai', baseUrl: '', modelId: 'synthetic', messages: memory.messages(), executionPolicy: 'native-serial', allowedToolIds: [], onToken: () => {}, onComplete: () => {}, onError: () => {}, onExecutionMessages: messages => memory.retain(messages) };
    await runToolCallingLoop(options, { kind: 'native', streamTurn: async () => ({ result: { content: 'Actual response', toolCalls: [] }, projectAssistant: () => ({ items: [] }) }), projectTool: () => null, afterToolResults: () => {} }, createStreamAccumulator(options));
    expect(memory.messages().at(-1)).toEqual({ role: 'assistant', content: 'Actual response' });
    const owner = new StreamStopUnconfirmedError('Still active');
    const broken = { ...options, onExecutionMessages: () => { throw new Error('checkpoint unavailable'); } };
    await expect(runToolCallingLoop(broken, { kind: 'native', streamTurn: async () => { throw owner; }, projectTool: () => null, afterToolResults: () => {} }, createStreamAccumulator(broken))).rejects.toBe(owner);
    expect(owner.secondaryErrors.some(error => error.message === 'checkpoint unavailable')).toBe(true);
    const state = record(decode(memory.checkpoint().stateJson));
    expect(encode(state)).toContain('Actual response');
  });
});
