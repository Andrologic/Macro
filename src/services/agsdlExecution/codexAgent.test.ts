import { expect, it } from 'bun:test';
import { prepareCodexAgent, CODEX_MEMORY_VERSION, type CodexAgentPorts } from './codexAgent';
import { contextFixture, id, json } from './conformanceFixtures';
import { decode, encode, record } from './exact';
import type { ResidentAgentRequest } from './residentAgent';

function fixture() {
  const context = contextFixture();
  const request: ResidentAgentRequest = { context, providerType: 'codex-native', toolAliases: [], memory: null,
    configuration: { agentName: 'worker', configurationName: 'native', providerId: 'codex-native', modelId: 'synthetic-model',
      configurationJson: json('{"initialization":{"prompt":[{"value":"Review."}]},"nativeEngine":{"adapter":"codex-app-server-v1","profileJson":"{\\"format\\":\\"macro-codex-native-profile/1\\",\\"version\\":\\"0.163.0\\",\\"toolPolicy\\":\\"codex-native\\"}"}}'),
      settingsJson: json('{}'), permissionsJson: context.permissionsJson, scopeJson: context.scopeJson },
    responses: { agentName: 'worker', interfaceJson: json('{}'), stepJson: json('{"type":"agent","agent":"worker"}'), publicationContractJson: null } };
  const calls: string[] = [];
  const ports: CodexAgentPorts = { identity: () => 'native-attempt',
    run: async () => { calls.push('physical end'); return { threadId: 'native-thread', turnId: 'native-turn' }; },
    stop: async () => { calls.push('stop requested'); },
    journal: { read: async () => { calls.push('read responses'); return { events: [], digest: 'native-digest' }; },
      close: async closure => { calls.push('close responses'); return closure; } } };
  return { request, calls, ports };
}
it('keeps Codex memory distinct and closes retained responses only after physical end', async () => {
  const f = fixture();
  const agent = await prepareCodexAgent(f.request, f.ports);
  expect(agent.checkpoint().formatVersion).toBe(CODEX_MEMORY_VERSION);
  expect(f.calls).toEqual([]);
  await agent.acceptInput(() => json('{"prompt":[{"value":"Continue"}],"resources":{"n":{"value":9007199254740993}}}'));
  let input = '';
  const run = f.ports.run;
  f.ports.run = async request => { input = request.inputJson; return run(request); };
  const result = await agent.executeReady();
  expect(input).toContain('9007199254740993');
  expect(f.calls).toEqual(['physical end', 'read responses', 'close responses']);
  expect(record(decode(result.memory.stateJson)).threadId).toBe('native-thread');
  const next = await prepareCodexAgent({ ...f.request, memory: result.memory }, f.ports);
  expect(next.checkpoint().revision).toBe(id<'sequence'>('2'));
  await expect(prepareCodexAgent({ ...f.request, memory: { ...result.memory, agentInstanceId: id('foreign') } }, f.ports)).rejects.toMatchObject({ code: 'CORRELATION' });
  await expect(prepareCodexAgent({ ...f.request, memory: { ...result.memory, formatVersion: 'macro-agent-memory/1' } }, f.ports)).rejects.toMatchObject({ code: 'CORRELATION' });
  await expect(prepareCodexAgent({ ...f.request, configuration: { ...f.request.configuration, modelId: 'changed' }, memory: result.memory }, f.ports)).rejects.toMatchObject({ code: 'CORRELATION' });
  expect(encode(record(decode(result.memory.stateJson)))).not.toContain('messages');
});
it('does not retry or close a boundary after an ambiguous native acknowledgement', async () => {
  const f = fixture();
  f.ports.run = async () => { f.calls.push('possibly sent'); throw new Error('lost native receipt'); };
  const agent = await prepareCodexAgent(f.request, f.ports);
  await agent.acceptInput(() => json('{}'));
  await expect(agent.executeReady()).rejects.toThrow('lost native receipt');
  expect(f.calls).toEqual(['possibly sent']);
  await expect(agent.executeReady()).rejects.toMatchObject({ code: 'CORRELATION' });
});
it('initializes before rejecting input and treats stop as a request', async () => {
  const f = fixture();
  const agent = await prepareCodexAgent(f.request, f.ports);
  let initialized = false;
  await expect(agent.acceptInput(() => { initialized = record(decode(agent.checkpoint().stateJson)).initialized === true; throw new Error('input rejected'); })).rejects.toThrow('input rejected');
  expect(initialized).toBe(true);
  expect(f.calls).toEqual([]);
  const active = await prepareCodexAgent(f.request, f.ports);
  let release!: (value: { threadId: string; turnId: string }) => void;
  f.ports.run = () => new Promise(resolve => { release = resolve; });
  await active.acceptInput(() => json('{}'));
  const running = active.executeReady();
  active.requestStop();
  expect(active.stopRequested).toBe(true);
  expect(f.calls).toEqual(['stop requested']);
  release({ threadId: 'native-thread', turnId: 'native-turn' });
  expect((await running).stopped).toBe(true);
});
