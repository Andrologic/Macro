import { expect, it } from 'bun:test';
import { prepareClaudeAgent, CLAUDE_MEMORY_VERSION, type ClaudeAgentPorts } from './claudeAgent';
import { contextFixture, id, json } from './conformanceFixtures';
import { decode, encode, record } from './exact';
import { ResidentAgent, type ResidentAgentRequest } from './residentAgent';
import { prepareFlowAgent } from './flowActivation';

function fixture() {
  const context = contextFixture();
  const request: ResidentAgentRequest = { context, providerType: 'claude-native', toolAliases: [], memory: null,
    configuration: { agentName: 'worker', configurationName: 'native', providerId: 'claude-native', modelId: 'synthetic-model',
      configurationJson: json('{"initialization":{"prompt":[{"value":"Review."}]},"nativeEngine":{"adapter":"claude-sdk-v1","profileJson":"{\\"format\\":\\"macro-claude-controlled-profile/1\\",\\"version\\":\\"0.3.308\\",\\"cliVersion\\":\\"2.1.308\\",\\"toolPolicy\\":\\"macro-controlled\\"}"}}'),
      settingsJson: json('{}'), permissionsJson: context.permissionsJson, scopeJson: context.scopeJson },
    responses: { agentName: 'worker', interfaceJson: json('{}'), stepJson: json('{"type":"agent","agent":"worker"}'), publicationContractJson: null } };
  const calls: string[] = [];
  const ports: ClaudeAgentPorts = { identity: () => 'native-attempt',
    run: async () => { calls.push('physical end'); return { kind: 'completed', sessionId: 'native-thread', runId: 'native-turn' }; },
    stop: async () => { calls.push('stop requested'); },
    journal: { read: async () => { calls.push('read responses'); return { events: [], digest: 'native-digest' }; },
      close: async closure => { calls.push('close responses'); return closure; } } };
  return { request, calls, ports };
}
it('keeps Claude memory distinct and closes retained responses only after physical end', async () => {
  const f = fixture();
  const agent = await prepareClaudeAgent(f.request, f.ports);
  expect(agent.checkpoint().formatVersion).toBe(CLAUDE_MEMORY_VERSION);
  expect(f.calls).toEqual([]);
  await agent.acceptInput(() => json('{"prompt":[{"value":"Continue"}],"resources":{"n":{"value":9007199254740993}}}'));
  let input = '';
  const run = f.ports.run;
  f.ports.run = async request => { input = request.inputJson; return run(request); };
  const result = await agent.executeReady();
  expect(input).toContain('9007199254740993');
  expect(f.calls).toEqual(['physical end', 'read responses', 'close responses']);
  expect(record(decode(result.memory.stateJson)).sessionId).toBe('native-thread');
  const next = await prepareClaudeAgent({ ...f.request, memory: result.memory }, f.ports);
  expect(next.checkpoint().revision).toBe(id<'sequence'>('2'));
  await expect(prepareClaudeAgent({ ...f.request, memory: { ...result.memory, agentInstanceId: id('foreign') } }, f.ports)).rejects.toMatchObject({ code: 'CORRELATION' });
  await expect(prepareClaudeAgent({ ...f.request, memory: { ...result.memory, formatVersion: 'macro-agent-memory/1' } }, f.ports)).rejects.toMatchObject({ code: 'CORRELATION' });
  await expect(prepareClaudeAgent({ ...f.request, configuration: { ...f.request.configuration, modelId: 'changed' }, memory: result.memory }, f.ports)).rejects.toMatchObject({ code: 'CORRELATION' });
  expect(encode(record(decode(result.memory.stateJson)))).not.toContain('messages');
});
it('does not retry or close a boundary after an ambiguous native acknowledgement', async () => {
  const f = fixture();
  f.ports.run = async () => { f.calls.push('possibly sent'); throw new Error('lost native receipt'); };
  const agent = await prepareClaudeAgent(f.request, f.ports);
  await agent.acceptInput(() => json('{}'));
  await expect(agent.executeReady()).rejects.toThrow('lost native receipt');
  expect(f.calls).toEqual(['possibly sent']);
  await expect(agent.executeReady()).rejects.toMatchObject({ code: 'CORRELATION' });
});
it('initializes before rejecting input and treats stop as a request', async () => {
  const f = fixture();
  const agent = await prepareClaudeAgent(f.request, f.ports);
  let initialized = false;
  await expect(agent.acceptInput(() => { initialized = record(decode(agent.checkpoint().stateJson)).initialized === true; throw new Error('input rejected'); })).rejects.toThrow('input rejected');
  expect(initialized).toBe(true);
  expect(f.calls).toEqual([]);
  const active = await prepareClaudeAgent(f.request, f.ports);
  let release!: (value: Awaited<ReturnType<ClaudeAgentPorts['run']>>) => void;
  f.ports.run = () => new Promise(resolve => { release = resolve; });
  await active.acceptInput(() => json('{}'));
  const running = active.executeReady();
  active.requestStop();
  expect(active.stopRequested).toBe(true);
  expect(f.calls).toEqual(['stop requested']);
  release({ kind: 'stopped', sessionId: 'native-thread', runId: 'native-turn' });
  expect((await running).stopped).toBe(true);
});

it('keeps a correlated failed native turn conclusive after physical end', async () => {
  const f = fixture();
  f.ports.run = async () => ({ kind: 'failed', sessionId: 'native-thread', runId: 'native-turn' });
  const agent = await prepareClaudeAgent(f.request, f.ports);
  await agent.acceptInput(() => json('{}'));
  const result = await agent.executeReady();
  expect(result.failed).toBe(true);
  expect(result.stopped).toBe(false);
  expect(f.calls).toEqual(['read responses', 'close responses']);
});
it('accepts only a native stopped receipt and preserves an observed thread', async () => {
  const f = fixture();
  f.ports.run = async () => ({ kind: 'stopped', sessionId: 'native-thread', runId: null });
  const agent = await prepareClaudeAgent(f.request, f.ports);
  await agent.acceptInput(() => json('{}'));
  const result = await agent.executeReady();
  expect(result.stopped).toBe(true);
  expect(record(decode(result.memory.stateJson)).sessionId).toBe('native-thread');
  expect(f.calls).toEqual(['read responses', 'close responses']);
});
it('does not turn a rejected stop IPC into a terminal receipt', async () => {
  const f = fixture();
  let reject!: (error: Error) => void;
  f.ports.run = () => new Promise((_, fail) => { reject = fail; });
  const agent = await prepareClaudeAgent(f.request, f.ports);
  await agent.acceptInput(() => json('{}'));
  const running = agent.executeReady();
  agent.requestStop();
  reject(new Error('STOP_PENDING'));
  await expect(running).rejects.toThrow('STOP_PENDING');
  expect(f.calls).toEqual(['stop requested']);
});

it('rejects crossed providers and captured adapters at both preparation boundaries', async () => {
  const f = fixture();
  const http = { ...f.request, providerType: 'openai' as const, configuration: { ...f.request.configuration, providerId: 'http-provider' } };
  await expect(prepareFlowAgent(http)).rejects.toMatchObject({ code: 'CORRELATION' });
  await expect(ResidentAgent.prepare(http)).rejects.toMatchObject({ code: 'CORRELATION' });
  const macro = { ...f.request, configuration: { ...f.request.configuration, configurationJson: json('{"initialization":{}}') } };
  await expect(prepareFlowAgent(macro)).rejects.toMatchObject({ code: 'CORRELATION' });
  await expect(ResidentAgent.prepare(macro)).rejects.toMatchObject({ code: 'CORRELATION' });
});

it('does not promote a local stop flag over a conclusive native receipt', async () => {
  const f=fixture();
  let release!: (value:Awaited<ReturnType<ClaudeAgentPorts['run']>>) => void;
  f.ports.run=()=>new Promise(resolve=>{release=resolve;});
  const agent=await prepareClaudeAgent(f.request,f.ports);
  await agent.acceptInput(()=>json('{}'));
  const running=agent.executeReady();agent.requestStop();
  release({kind:'completed',sessionId:'native-thread',runId:'native-turn'});
  expect((await running).stopped).toBe(false);
});
