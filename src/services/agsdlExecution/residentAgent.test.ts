import { expect, it } from 'bun:test';
import { ResidentAgent, type ResidentAgentPorts, type ResidentAgentRequest } from './residentAgent';
import { compileFixture, contextFixture, documentFixture, json } from './conformanceFixtures';
import { decode, encode, record } from './exact';
import type { RetainedEmission } from './retainedResponses';
import type { Emission } from '../../types/generated/ipc';
import type { AiStreamChatInput } from '../ipc/ai';
import { StreamStopUnconfirmedError } from '../ai/streamCancellation';

async function fixture(stream: ResidentAgentPorts['stream']) {
  const compiled = await compileFixture(documentFixture());
  const configuration = { ...compiled.plan!.agents[0], settingsJson: json('{}'), permissionsJson: json('{"mode":"Implement","allowedToolIds":[]}') };
  const context = { ...contextFixture(), permissionsJson: configuration.permissionsJson, scopeJson: configuration.scopeJson };
  const request: ResidentAgentRequest = { context, configuration, memory: null, providerType: 'openai', toolAliases: [], responses: {
    interfaceJson: json('{"results":{"record":{"mediaTypes":["application/json"],"valueSchema":{"type":"integer"}}}}'), stepJson: json('{"type":"agent","agent":"worker"}'),
    publicationContractJson: encode({ protocol: 'macro-agsdl-publication/1', registryVersion: context.registryVersion, agent: 'worker', step: ['work'], interface: { results: { record: { mediaTypes: ['application/json'], valueSchema: { type: 'integer' } } } }, choices: [], decisionBinding: null }),
  } };
  const events: Emission[] = [], order: string[] = [];
  const ports: ResidentAgentPorts = {
    stream, register: async (_context, request) => { order.push(`register:${request.requestId}`); return true; },
    dispatch: async (_context, request) => { order.push(`dispatch:${request.requestId}`); },
    end: async (_context, id) => { order.push(`end:${id}`); },
    append: async emission => { events.push(emission); order.push(emission.kind); return true; },
    journal: { read: async () => ({ events: events as unknown as RetainedEmission[], digest: 'native-digest' }),
      close: async closure => { order.push('close'); return closure; } },
  };
  return { request, events, ports, order };
}
function attempt(id: string): AiStreamChatInput {
  return { requestId: id, providerId: 'synthetic-provider', modelId: 'synthetic-model', messages: [] };
}
const noTool = async () => { throw new Error('Unexpected Tool'); };

it('initializes before adaptation, without dispatch, and refuses reusing an admission', async () => {
  let ran = false;
  const f = await fixture(async () => { ran = true; });
  const agent = await ResidentAgent.prepare(f.request, noTool, f.ports);
  await expect(agent.acceptInput(() => { expect(agent.checkpoint().stateJson).toContain('Review.'); throw new Error('INPUT_CONSTRAINT'); })).rejects.toThrow('INPUT_CONSTRAINT');
  await expect(agent.executeReady()).rejects.toMatchObject({ code: 'CORRELATION' });
  expect(ran).toBe(false);
});
it('retains exact publication arguments and each retry before closing the actual journal', async () => {
  const raw = '{"results": {"record": {"value": 9007199254740993, "mediaType":"application/json"}}}';
  const f = await fixture(async options => {
    const native = options.nativeExecution!;
    for (const id of ['first', 'retry']) {
      expect(await native.beforeRequest(id, attempt(id))).toBe('registered');
      await native.dispatch!(attempt(id));
      await native.requestEnded(id);
    }
    await native.visibleMessage('retry', 'Original');
    await options.onRawToolCall!({ id: 'publish', type: 'function', function: { name: 'macro_agsdl_publish', arguments: raw } });
    options.onExecutionMessages!([...options.messages, { role: 'assistant', content: 'Original' }]);
    options.onComplete({ visibleContent: 'presentation differs', toolTraces: [] });
  });
  const agent = await ResidentAgent.prepare(f.request, noTool, f.ports);
  await agent.acceptInput(() => json('{"prompt":[{"value":"Go"}]}'));
  const result = await agent.executeReady();
  expect(record(decode(f.events[1].bodyJson)).rawArguments).toBe(raw);
  expect(f.events.map(event => [event.providerAttemptId, event.sequence])).toEqual([['retry', '1'], ['retry', '2']]);
  expect(f.order).toEqual(['register:first', 'dispatch:first', 'end:first', 'register:retry', 'dispatch:retry', 'end:retry', 'message', 'publication', 'close']);
  expect(result.closure.validation.kind).toBe('success');
  expect(result.memory.stateJson).toContain('Original');
  expect(result.memory.stateJson).not.toContain('presentation differs');
  await expect(agent.executeReady()).rejects.toMatchObject({ code: 'CORRELATION' });
});
it('does not close after an ambiguous append or duplicate registration', async () => {
  for (const failure of ['append', 'duplicate']) {
    const f = await fixture(async options => {
      try {
        await options.nativeExecution!.beforeRequest('first', attempt('first'));
        if (failure === 'append') await options.nativeExecution!.visibleMessage('first', 'Original');
      } catch (error) { options.onError(error as Error); }
    });
    if (failure === 'append') f.ports.append = async () => { throw new Error('ack lost'); };
    else f.ports.register = async () => false;
    const agent = await ResidentAgent.prepare(f.request, noTool, f.ports);
    await agent.acceptInput(() => json('{}'));
    await expect(agent.executeReady()).rejects.toMatchObject({ code: 'CORRELATION' });
    expect(f.order).not.toContain('close');
  }
});
it('keeps unconfirmed physical ownership and treats turn exhaustion as failed', async () => {
  const f = await fixture(async options => { options.onError(new StreamStopUnconfirmedError('pending')); });
  const agent = await ResidentAgent.prepare(f.request, noTool, f.ports);
  await agent.acceptInput(() => json('{}'));
  await expect(agent.executeReady()).rejects.toBeInstanceOf(StreamStopUnconfirmedError);
  expect(f.order).not.toContain('close');
  f.ports.stream = async options => { options.onComplete({ visibleContent: '', toolTraces: [], completionReason: 'tool_turn_limit' }); };
  const second = await ResidentAgent.prepare(f.request, noTool, f.ports);
  await second.acceptInput(() => json('{}'));
  expect((await second.executeReady()).failed).toBe(true);
});
