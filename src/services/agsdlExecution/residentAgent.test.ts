import { expect, it } from 'bun:test';
import { ResidentAgent, type ResidentAgentPorts, type ResidentAgentRequest } from './residentAgent';
import { compileFixture, contextFixture, documentFixture, json } from './conformanceFixtures';
import { decode, encode, record } from './exact';
import type { RetainedEmission } from './retainedResponses';
import type { Emission } from '../../types/generated/ipc';
import type { AiStreamChatInput } from '../ipc/ai';
import { StreamStopUnconfirmedError } from '../ai/streamCancellation';
import type { Sequence } from './contracts';

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

async function graphlessFixture(stream: ResidentAgentPorts['stream']) {
  const f = await fixture(stream);
  const request: ResidentAgentRequest = { ...f.request, context: { ...f.request.context, work: { ...f.request.context.work, step: null } },
    responses: { agentName: f.request.configuration.agentName, interfaceJson: json('{}'), stepJson: null, publicationContractJson: null } };
  return { ...f, request };
}
it('closes a normal graphless response with the captured Agent identity', async () => {
  const f = await graphlessFixture(async options => {
    const native = options.nativeExecution!;
    await native.beforeRequest('normal', attempt('normal'));
    await native.dispatch!(attempt('normal'));
    await native.requestEnded('normal');
    await native.visibleMessage('normal', 'Retained graphless response');
    options.onExecutionMessages!([...options.messages, { role: 'assistant', content: 'Retained graphless response' }]);
    options.onComplete({ visibleContent: 'Retained graphless response', toolTraces: [] });
  });
  const agent = await ResidentAgent.prepare(f.request, noTool, f.ports);
  await agent.acceptInput(() => json('{"prompt":[{"value":"Go"}]}'));
  const result = await agent.executeReady();
  expect(result.closure.validation).toEqual({ kind: 'success', text: 'Retained graphless response', resultsJson: json('{}'), choice: null });
  expect(String(result.closure.cursor)).toBe('1');
  expect(result.stopped).toBe(false);
  expect(result.memory.stateJson).toContain('Retained graphless response');
  expect(f.order).toEqual(['register:normal', 'dispatch:normal', 'end:normal', 'message', 'close']);
});
it('closes an empty graphless Stop journal only after the provider join', async () => {
  let started!: () => void, stopping!: () => void, releaseJoin!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; });
  const stoppingAtJoin = new Promise<void>(resolve => { stopping = resolve; });
  const joined = new Promise<void>(resolve => { releaseJoin = resolve; });
  const f = await graphlessFixture(async options => {
    const native = options.nativeExecution!;
    await native.beforeRequest('held', attempt('held'));
    await native.dispatch!(attempt('held'));
    const aborted = new Promise<void>(resolve => options.signal!.addEventListener('abort', () => resolve(), { once: true }));
    started();
    await aborted;
    stopping();
    await joined;
    await native.requestEnded('held');
    options.onComplete({ visibleContent: '', toolTraces: [] });
  });
  const digest = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  f.ports.journal.read = async () => ({ events: [], digest });
  const agent = await ResidentAgent.prepare(f.request, noTool, f.ports);
  await agent.acceptInput(() => json('{"prompt":[{"value":"QA-HOLD"}]}'));
  const completion = agent.executeReady();
  await running;
  agent.requestStop();
  await stoppingAtJoin;
  expect(f.order).not.toContain('close');
  releaseJoin();
  const result = await completion;
  expect(result.stopped).toBe(true);
  expect(result.closure).toEqual({ cursor: '0' as Sequence, digest, validation: { kind: 'success', text: '', resultsJson: json('{}'), choice: null } });
  expect(result.memory.stateJson).toContain('QA-HOLD');
  expect(f.order).toEqual(['register:held', 'dispatch:held', 'end:held', 'close']);
});
it('rejects missing or foreign graphless names and malformed collection declarations before dispatch', async () => {
  const f = await graphlessFixture(async () => { throw new Error('Must not dispatch'); });
  for (const responses of [
    { ...f.request.responses, agentName: undefined },
    { ...f.request.responses, agentName: 'another-agent' },
    { ...f.request.responses, interfaceJson: json('[]') },
  ]) {
    await expect(ResidentAgent.prepare({ ...f.request, responses }, noTool, f.ports)).rejects.toMatchObject({ code: 'CORRELATION' });
    expect(f.order).toEqual([]);
  }
});
