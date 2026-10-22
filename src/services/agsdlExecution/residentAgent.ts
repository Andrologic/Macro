import { createResidentToolDispatch } from './nativeToolDispatch';
import type { AppMode } from '../../types';
import type { EngineContext } from '../../types/generated/ipc';
import type { StreamingChatOptions, StreamCompletionReason, ToolCall, ToolCallResolution } from '../ai/contracts';
import { StreamStopUnconfirmedError } from '../ai/streamCancellation';
import { streamChat } from '../streamingChatExecution';
import * as ipc from '../ipc/agsdlExecution';
import { MacroAgentMemory } from './agentMemory';
import type { ExecutionContext, ExactJsonText, FrozenAgentConfiguration, MemoryCheckpoint, ProviderAttemptId, Sequence } from './contracts';
import { toDispatchValue } from './dispatchValues';
import { decode, encode, fail, list, record, text } from './exact';
import { ExactResponseCollection, type ResponseCollectionOptions } from './responses';
import { closeRetainedResponses, type ResponseJournalPort, type RetainedEmission } from './retainedResponses';

export interface ResidentAgentRequest {
  readonly context: ExecutionContext;
  readonly configuration: FrozenAgentConfiguration;
  readonly memory: MemoryCheckpoint | null;
  readonly providerType: 'openai' | 'ollama' | 'lmstudio' | 'codex-native';
  readonly responses: Omit<ResponseCollectionOptions, 'context' | 'providerAttempts'>;
  readonly toolAliases: readonly { readonly name: string; readonly toolId: string }[];
}
/** Only the native invocation adapter may perform Tool effects. Raw arguments and
 * captured aliases arrive here before the shared loop decodes or presents them. */
export type ResidentToolDispatch = (call: ToolCall, attempt: ProviderAttemptId) => Promise<ToolCallResolution>;
export interface ResidentAgentPorts {
  register: typeof ipc.executionHostRegisterProvider;
  dispatch: typeof ipc.executionHostDispatchProvider;
  end: typeof ipc.executionHostEndProvider;
  append: typeof ipc.executionHostAppendResponse;
  journal: ResponseJournalPort;
  stream: typeof streamChat;
}
function wire(context: ExecutionContext): EngineContext {
  return { ...context, work: { ...context.work, step: context.work.step === null ? null : [...context.work.step] } };
}
export const nativeResidentAgentPorts: ResidentAgentPorts = {
  register: ipc.executionHostRegisterProvider, dispatch: ipc.executionHostDispatchProvider,
  end: ipc.executionHostEndProvider, append: ipc.executionHostAppendResponse, stream: streamChat,
  journal: {
    async read(context) {
      const [events, digest] = await ipc.executionHostReadResponses(context.owner, wire(context).work);
      // Native verifies every brand, context and exact-value string on append.
      return { events: events as unknown as readonly RetainedEmission[], digest };
    },
    async close(closure) {
      const receipt = await ipc.executionHostCloseResponses({ ...closure, work: { ...closure.work, step: closure.work.step === null ? null : [...closure.work.step] } });
      return { ...receipt, cursor: receipt.cursor as Sequence, validationJson: receipt.validationJson as ExactJsonText };
    },
  },
};

/** Per-admission Macro execution. Initialization precedes Flow input adaptation;
 * this object owns no conversation, Task, global provider state or durable save. */
export class ResidentAgent {
  private readonly abort = new AbortController();
  private phase: 'prepared' | 'ready' | 'running' | 'finished' = 'prepared';
  private constructor(private readonly request: ResidentAgentRequest, private readonly memory: MacroAgentMemory,
    private readonly ports: ResidentAgentPorts, private readonly invokeTool: ResidentToolDispatch) {}

  static async prepare(request: ResidentAgentRequest, invokeTool: ResidentToolDispatch = createResidentToolDispatch(request), ports = nativeResidentAgentPorts): Promise<ResidentAgent> {
    if (request.providerType === 'codex-native') return fail('CORRELATION', '/engine', 'Native Codex work must use its own adapter.');
    const agent = request.context.work.agentInstanceId;
    if (!agent || request.context.permissionsJson !== request.configuration.permissionsJson || request.context.scopeJson !== request.configuration.scopeJson) {
      return fail('CORRELATION', '', 'Agent configuration does not match admitted work.');
    }
    if (request.responses.stepJson === null && request.responses.agentName !== request.configuration.agentName) {
      return fail('CORRELATION', '', 'Graphless response Agent differs from the captured configuration.');
    }
    // Validate the real collection contract before input adaptation or provider effects.
    new ExactResponseCollection({ ...request.responses, context: request.context, providerAttempts: [] });
    const memory = await MacroAgentMemory.prepare(agent, request.configuration, request.memory);
    return new ResidentAgent(request, memory, ports, invokeTool);
  }
  checkpoint(): MemoryCheckpoint { return this.memory.checkpoint(); }
  async acceptInput(adapt: () => ExactJsonText | Promise<ExactJsonText>): Promise<void> {
    if (this.phase !== 'prepared') fail('CORRELATION', '', 'Agent input was already adapted.');
    // A failed adaptation cannot be retried on this admission, but its initialized
    // checkpoint is available for the native failed-terminal transaction.
    this.phase = 'finished';
    await this.memory.acceptInput(adapt);
    this.phase = 'ready';
  }
  requestStop(): void { this.abort.abort(); }

  async executeReady() {
    if (this.phase !== 'ready') return fail('CORRELATION', '', 'Agent is not ready for execution.');
    this.phase = 'running';
    const { context, configuration, responses } = this.request;
    const nativeContext = wire(context);
    const settings = toDispatchValue(configuration.settingsJson);
    if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) return fail('UNSUPPORTED', '/settings', 'Invalid captured settings.');
    const permissions = record(decode(configuration.permissionsJson));
    const mode = text(permissions.mode);
    if (!['Implement', 'Chat', 'Architect'].includes(mode)) return fail('UNSUPPORTED', '/mode', 'Unqualified execution mode.');
    const maxTurns = settings.maxTurns;
    if (maxTurns !== undefined && (typeof maxTurns !== 'number' || !Number.isSafeInteger(maxTurns) || maxTurns < 1)) return fail('UNSUPPORTED', '/maxTurns', 'Unqualified turn limit.');
    const reasoning = settings.reasoningEffort;
    if (reasoning !== undefined && reasoning !== null && typeof reasoning !== 'string') return fail('UNSUPPORTED', '/reasoningEffort', 'Unqualified reasoning setting.');
    const aliases = this.request.toolAliases;
    let currentAttempt: ProviderAttemptId | null = null;
    let sequence = 0n;
    let observerFailed = false;
    const execution = { failure: null as Error | null };
    let completionReason: StreamCompletionReason | undefined;
    const append = async (attempt: string, identity: string, kind: 'message' | 'publication', bodyJson: ExactJsonText) => {
      if (!currentAttempt || attempt !== currentAttempt) return fail('CORRELATION', '', 'Emission has no current native attempt.');
      try {
        await this.ports.append({ context: nativeContext, providerAttemptId: attempt, sequence: String(sequence + 1n), identity, kind, bodyJson });
        sequence++;
      } catch (error) { observerFailed = true; throw error; }
    };
    const publication = responses.publicationContractJson === null ? undefined : {
      choices: list(record(decode(responses.publicationContractJson)).choices).map(value => text(value)),
    };
    const options: StreamingChatOptions = {
      executionPolicy: 'native-serial', providerType: this.request.providerType as 'openai' | 'ollama' | 'lmstudio',
      providerId: configuration.providerId, modelId: configuration.modelId, baseUrl: '', mode: mode as AppMode,
      messages: this.memory.messages(), signal: this.abort.signal,
      maxTurns: maxTurns as number | undefined, reasoningEffort: reasoning as string | null | undefined,
      allowedToolIds: aliases.map(alias => alias.toolId),
      onToken: () => {}, onComplete: result => { completionReason = result.completionReason; },
      onError: error => { execution.failure = error; },
      onExecutionMessages: messages => { try { this.memory.retain(messages); } catch (error) { observerFailed = true; throw error; } },
      nativeExecution: {
        toolAliases: aliases, publication,
        beforeRequest: async (requestId, request) => {
          if (!request || requestId !== request.requestId) return fail('CORRELATION', '', 'Native attempt envelope is missing.');
          try {
            const registered = await this.ports.register(nativeContext, request);
            if (!registered) { observerFailed = true; return 'duplicate'; }
            currentAttempt = requestId as ProviderAttemptId;
            return 'registered';
          } catch (error) { observerFailed = true; throw error; }
        },
        dispatch: request => this.ports.dispatch(nativeContext, request),
        requestEnded: async requestId => {
          try { await this.ports.end(nativeContext, requestId); }
          catch (error) { observerFailed = true; throw error; }
        },
        visibleMessage: (requestId, value) => append(requestId, `${requestId}:message`, 'message', encode({ textParts: [value] })),
      },
      onRawToolCall: async call => {
        if (!currentAttempt) return fail('CORRELATION', '', 'Tool call has no native provider attempt.');
        if (call.function.name === 'macro_agsdl_publish') {
          if (!publication) return fail('CORRELATION', '', 'Publication is not exposed for this Agent.');
          await append(currentAttempt, `${currentAttempt}:publication:${call.id}`, 'publication', encode({ rawArguments: call.function.arguments }));
          return { kind: 'result', result: 'Publication retained for completion validation.' };
        }
        if (!aliases.some(alias => alias.name === call.function.name)) return fail('PERMISSION', '', 'Tool alias is not captured.');
        return this.invokeTool(call, currentAttempt);
      },
    };
    try {
      await this.ports.stream(options, { reader: null, stream: null, tauriRequestId: null }, {
        // Compatibility belongs to this attempt; never mutate the user provider store.
        disableReasoning: () => {}, disableEffort: () => {},
      });
      if (observerFailed) return fail('CORRELATION', '', 'A native receipt or provisional checkpoint is missing.');
      if (execution.failure instanceof StreamStopUnconfirmedError) throw execution.failure;
      const closure = await closeRetainedResponses({ ...responses, context }, this.ports.journal);
      return { closure, memory: this.memory.checkpoint(), stopped: this.abort.signal.aborted,
        failed: execution.failure !== null || completionReason === 'tool_turn_limit' || completionReason === 'length' || completionReason === 'incomplete',
        completionReason };
    } finally { this.phase = 'finished'; }
  }
}
