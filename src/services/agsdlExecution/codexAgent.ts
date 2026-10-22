import type { FlowAgent } from './flowActivation';
import type { ResidentAgentRequest } from './residentAgent';
import type { ExactJsonText, MemoryCheckpoint, Sequence } from './contracts';
import { decode, encode, equal, fail, record, text, type ExactObject } from './exact';
import { sourceDigest } from './compiler';
import { closeRetainedResponses } from './retainedResponses';
import { ExactResponseCollection } from './responses';
import { nativeResidentAgentPorts } from './residentAgent';
import * as ipc from '../ipc/agsdlExecution';

export const CODEX_MEMORY_VERSION = 'macro-codex-memory/1';
export interface CodexAgentPorts {
  run: typeof ipc.executionHostRunCodex;
  stop: typeof ipc.executionHostEndProvider;
  journal: typeof nativeResidentAgentPorts.journal;
  identity(): string;
}
const nativePorts: CodexAgentPorts = { run: ipc.executionHostRunCodex, stop: ipc.executionHostEndProvider,
  journal: nativeResidentAgentPorts.journal, identity: () => crypto.randomUUID() };

/** Native thread continuity is independent of terminal checkpoints. The native
 * journal decides which thread can resume; this checkpoint must agree with it. */
export async function prepareCodexAgent(request: ResidentAgentRequest, ports = nativePorts): Promise<FlowAgent> {
  const { context, configuration } = request;
  const agent = context.work.agentInstanceId;
  const expanded = record(decode(configuration.configurationJson));
  const engine = record(expanded.nativeEngine);
  if (!agent || request.providerType !== 'codex-native' || configuration.providerId !== 'codex-native'
    || engine.adapter !== 'codex-app-server-v1' || !equal(decode(context.permissionsJson), decode(configuration.permissionsJson))
    || !equal(decode(context.scopeJson), decode(configuration.scopeJson))) fail('CORRELATION', '/engine', 'Codex engine differs from the admitted configuration.');
  const profile = record(decode(text(engine.profileJson)));
  if (profile.format !== 'macro-codex-native-profile/1' || profile.version !== '0.163.0' || profile.toolPolicy !== 'codex-native') fail('UNSUPPORTED', '/engine', 'Codex native profile is unavailable.');
  new ExactResponseCollection({ ...request.responses, context, providerAttempts: [] });
  const configurationDigest = await sourceDigest(encode(configuration as unknown as ExactObject));
  let revision = '1' as Sequence;
  let threadId: string | null = null;
  if (request.memory) {
    const previous = request.memory;
    const state = record(decode(previous.stateJson));
    if (previous.formatVersion !== CODEX_MEMORY_VERSION || previous.agentInstanceId !== agent
      || !/^(0|[1-9][0-9]*)$/.test(previous.revision) || state.configurationDigest !== configurationDigest
      || state.initialized !== true || Object.keys(state).some(key => !['configurationDigest', 'initialized', 'threadId'].includes(key))
      || state.threadId !== null && typeof state.threadId !== 'string') fail('CORRELATION', '/memory', 'Codex memory belongs to another instance, configuration or format.');
    revision = String(BigInt(previous.revision) + 1n) as Sequence;
    threadId = state.threadId as string | null;
  }
  let phase: 'prepared' | 'ready' | 'running' | 'finished' = 'prepared';
  let stopped = false;
  let inputJson: ExactJsonText | null = null;
  let requestId: string | null = null;
  const nativeContext = { ...context, work: { ...context.work, step: context.work.step === null ? null : [...context.work.step] } };
  const checkpoint = (): MemoryCheckpoint => ({ agentInstanceId: agent!, revision, formatVersion: CODEX_MEMORY_VERSION,
    stateJson: encode({ configurationDigest, initialized: true, threadId }) });
  return {
    get stopRequested() { return stopped; }, checkpoint,
    async acceptInput(adapt) {
      if (phase !== 'prepared') fail('CORRELATION', '/input', 'Codex input was already adapted.');
      phase = 'finished';
      inputJson = adapt(); decode(inputJson);
      phase = 'ready';
    },
    requestStop() {
      stopped = true;
      if (requestId) void ports.stop(nativeContext, requestId).catch(() => undefined);
    },
    async executeReady() {
      if (phase !== 'ready' || inputJson === null || stopped) return fail('CORRELATION', '/activation', 'Codex activation is not ready.');
      phase = 'running';
      requestId = ports.identity();
      try {
        const receipt = await ports.run({ context: nativeContext, requestId, inputJson, publicationContractJson: request.responses.publicationContractJson });
        if (threadId !== null && receipt.threadId !== threadId) fail('CORRELATION', '/memory', 'Codex returned a different native thread.');
        threadId = receipt.threadId;
        const closure = await closeRetainedResponses({ ...request.responses, context }, ports.journal);
        return { closure, memory: checkpoint(), stopped, failed: false, completionReason: undefined };
      } finally { phase = 'finished'; }
    },
  };
}
