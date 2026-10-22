import type { FlowAgent } from './flowActivation';
import type { ResidentAgentRequest } from './residentAgent';
import type { ExactJsonText, MemoryCheckpoint, Sequence } from './contracts';
import { decode, encode, equal, fail, record, text, type ExactObject } from './exact';
import { sourceDigest } from './compiler';
import { closeRetainedResponses } from './retainedResponses';
import { ExactResponseCollection } from './responses';
import { nativeResidentAgentPorts } from './residentAgent';
import * as ipc from '../ipc/agsdlExecution';

export const CLAUDE_MEMORY_VERSION = 'macro-claude-memory/1';
export interface ClaudeAgentPorts {
  run: typeof ipc.executionHostRunClaude;
  stop: typeof ipc.executionHostEndProvider;
  journal: typeof nativeResidentAgentPorts.journal;
  identity(): string;
}
const nativePorts: ClaudeAgentPorts = { run: ipc.executionHostRunClaude, stop: ipc.executionHostEndProvider,
  journal: nativeResidentAgentPorts.journal, identity: () => crypto.randomUUID() };

/** Native thread continuity is independent of terminal checkpoints. The native
 * journal decides which thread can resume; this checkpoint must agree with it. */
export async function prepareClaudeAgent(request: ResidentAgentRequest, ports = nativePorts): Promise<FlowAgent> {
  const { context, configuration } = request;
  const agent = context.work.agentInstanceId;
  const expanded = record(decode(configuration.configurationJson));
  const engine = record(expanded.nativeEngine);
  if (!agent || request.providerType !== 'claude-native' || configuration.providerId !== 'claude-native'
    || engine.adapter !== 'claude-sdk-v1' || !equal(decode(context.permissionsJson), decode(configuration.permissionsJson))
    || !equal(decode(context.scopeJson), decode(configuration.scopeJson))) fail('CORRELATION', '/engine', 'Claude engine differs from the admitted configuration.');
  const profile = record(decode(text(engine.profileJson)));
  if (profile.format !== 'macro-claude-controlled-profile/1' || profile.version !== '0.3.308' || profile.cliVersion !== '2.1.308' || profile.toolPolicy !== 'macro-controlled') fail('UNSUPPORTED', '/engine', 'Claude native profile is unavailable.');
  new ExactResponseCollection({ ...request.responses, context, providerAttempts: [] });
  const configurationDigest = await sourceDigest(encode(configuration as unknown as ExactObject));
  let revision = '1' as Sequence;
  let sessionId: string | null = null;
  if (request.memory) {
    const previous = request.memory;
    const state = record(decode(previous.stateJson));
    if (previous.formatVersion !== CLAUDE_MEMORY_VERSION || previous.agentInstanceId !== agent
      || !/^(0|[1-9][0-9]*)$/.test(previous.revision) || state.configurationDigest !== configurationDigest
      || state.initialized !== true || Object.keys(state).some(key => !['configurationDigest', 'initialized', 'sessionId'].includes(key))
      || state.sessionId !== null && typeof state.sessionId !== 'string') fail('CORRELATION', '/memory', 'Claude memory belongs to another instance, configuration or format.');
    revision = String(BigInt(previous.revision) + 1n) as Sequence;
    sessionId = state.sessionId as string | null;
  }
  let phase: 'prepared' | 'ready' | 'running' | 'finished' = 'prepared';
  let stopped = false;
  let inputJson: ExactJsonText | null = null;
  let requestId: string | null = null;
  const nativeContext = { ...context, work: { ...context.work, step: context.work.step === null ? null : [...context.work.step] } };
  const checkpoint = (): MemoryCheckpoint => ({ agentInstanceId: agent!, revision, formatVersion: CLAUDE_MEMORY_VERSION,
    stateJson: encode({ configurationDigest, initialized: true, sessionId }) });
  return {
    get stopRequested() { return stopped; }, checkpoint,
    async acceptInput(adapt) {
      if (phase !== 'prepared') fail('CORRELATION', '/input', 'Claude input was already adapted.');
      phase = 'finished';
      inputJson = adapt(); decode(inputJson);
      phase = 'ready';
    },
    requestStop() {
      stopped = true;
      if (requestId) void ports.stop(nativeContext, requestId).catch(() => undefined);
    },
    async executeReady() {
      if (phase !== 'ready' || inputJson === null || stopped) return fail('CORRELATION', '/activation', 'Claude activation is not ready.');
      phase = 'running';
      requestId = ports.identity();
      try {
        const receipt = await ports.run({ context: nativeContext, requestId, inputJson, publicationContractJson: request.responses.publicationContractJson });
        if (!['completed', 'failed', 'stopped'].includes(receipt.kind) || receipt.kind !== 'stopped' && (!receipt.sessionId || !receipt.runId)) fail('CORRELATION', '/receipt', 'Native terminal receipt is invalid.');
        if (sessionId !== null && receipt.sessionId !== sessionId) fail('CORRELATION', '/memory', 'Claude returned a different native session.');
        sessionId = receipt.sessionId;
        if (receipt.kind === 'stopped') stopped = true;
        const closure = await closeRetainedResponses({ ...request.responses, context }, ports.journal);
        return { closure, memory: checkpoint(), stopped: receipt.kind === 'stopped', failed: receipt.kind === 'failed', completionReason: undefined };
      } finally { phase = 'finished'; }
    },
  };
}
