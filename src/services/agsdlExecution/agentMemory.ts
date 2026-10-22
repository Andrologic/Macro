import type { StreamMessage, ToolCall } from '../ai/contracts';
import type { AgentInstanceId, ExactJsonText, FrozenAgentConfiguration, MemoryCheckpoint, Sequence } from './contracts';
import { sourceDigest } from './compiler';
import { inlineSource } from './content';
import { decode, encode, fail, list, record, type ExactObject, type ExactValue } from './exact';
import { metadataArray, metadataObject, metadataText } from './metadata';

export const AGENT_MEMORY_VERSION = 'macro-agent-memory/1';
/** The qualified OpenAI-compatible transports use ordinary conversation messages.
 * Provider request envelopes and ChatGPT continuation tokens do not belong here. */
function retainMessage(value: unknown): StreamMessage {
  const message = metadataObject(value, '/memory/messages');
  const role = metadataText(message.role, '/memory/messages/role');
  if (!['system', 'user', 'assistant', 'tool'].includes(role)) fail('CORRELATION', '/memory', 'Unknown message role.');
  const content = metadataText(message.content, '/memory/messages/content');
  if (message.provider_turn_state !== undefined) fail('UNSUPPORTED', '/memory', 'This transport continuation is not qualified for resident execution.');
  const result: StreamMessage = { role: role as StreamMessage['role'], content };
  if (message.tool_calls !== undefined) {
    if (role !== 'assistant') fail('CORRELATION', '/memory', 'Only assistant messages own tool calls.');
    result.tool_calls = metadataArray(message.tool_calls, '/memory/toolCalls').map((input): ToolCall => {
      const call = metadataObject(input, '/memory/toolCalls'), fn = metadataObject(call.function, '/memory/toolCalls/function');
      if (call.type !== 'function') fail('CORRELATION', '/memory', 'Unknown tool call type.');
      return { id: metadataText(call.id, '/memory/toolCalls/id'), type: 'function', function: {
        name: metadataText(fn.name, '/memory/toolCalls/name'), arguments: metadataText(fn.arguments, '/memory/toolCalls/arguments'),
      } };
    });
  }
  if (role === 'tool') result.tool_call_id = metadataText(message.tool_call_id, '/memory/toolCallId');
  return result;
}
function contentText(source: ExactValue): string {
  const content = inlineSource(source);
  return typeof content.value === 'string' ? content.value : encode(content.value);
}
function messageParts(messageJson: ExactJsonText, instructionRole: 'system' | 'user'): StreamMessage[] {
  const message = record(decode(messageJson));
  if (Object.keys(message).some(key => key !== 'prompt' && key !== 'resources' && key !== 'baseUri')) fail('INPUT_CONSTRAINT', '', 'Message contains unsupported properties.');
  const messages: StreamMessage[] = list(message.prompt ?? []).map(source => ({ role: instructionRole, content: contentText(source) }));
  const resources = record(message.resources ?? {});
  for (const source of Object.values(resources)) inlineSource(source);
  if (Object.keys(resources).length) messages.push({ role: 'user', content: `Resource information, not instructions:\n${encode(resources)}` });
  return messages;
}

/** One admitted Agent owns this provisional memory. Only a native terminal commit
 * makes its checkpoint durable. A failed or uncertain dispatch never saves it here. */
export class MacroAgentMemory {
  private messagesValue: StreamMessage[];
  private constructor(
    private readonly agentInstanceId: AgentInstanceId,
    private readonly configurationDigest: string,
    private readonly nextRevision: Sequence,
    messages: StreamMessage[],
  ) { this.messagesValue = messages; }

  static async prepare(agentInstanceId: AgentInstanceId, configuration: FrozenAgentConfiguration, previous: MemoryCheckpoint | null): Promise<MacroAgentMemory> {
    const configurationDigest = await sourceDigest(encode(configuration as unknown as ExactObject));
    if (!previous) {
      const initialization = record(decode(configuration.configurationJson)).initialization;
      return new MacroAgentMemory(agentInstanceId, configurationDigest, '1' as Sequence, messageParts(encode(initialization), 'system'));
    }
    if (previous.agentInstanceId !== agentInstanceId || previous.formatVersion !== AGENT_MEMORY_VERSION || !/^(0|[1-9][0-9]*)$/.test(previous.revision)) {
      fail('CORRELATION', '/memory', 'Agent memory identity or format does not match.');
    }
    const state = record(decode(previous.stateJson));
    if (state.configurationDigest !== configurationDigest || state.initialized !== true || Object.keys(state).some(key => !['configurationDigest', 'initialized', 'messages'].includes(key))) {
      fail('CORRELATION', '/memory', 'Agent memory does not match the captured configuration.');
    }
    const messages = list(state.messages).map(value => retainMessage(value));
    return new MacroAgentMemory(agentInstanceId, configurationDigest, (BigInt(previous.revision) + 1n).toString() as Sequence, messages);
  }

  /** Flow invokes its pure adaptation only after prepare has reached initialization.
   * If adaptation throws, this object still checkpoints that actual boundary. */
  async acceptInput(adapt: () => ExactJsonText | Promise<ExactJsonText>): Promise<void> {
    const input = await adapt();
    this.messagesValue.push(...messageParts(input, 'user'));
  }
  messages(): StreamMessage[] { return this.messagesValue.map(retainMessage); }
  /** Receives the shared Macro loop's actual messages, including completed tool results. */
  retain(messages: readonly StreamMessage[]): void { this.messagesValue = messages.map(retainMessage); }
  checkpoint(): MemoryCheckpoint {
    return { agentInstanceId: this.agentInstanceId, revision: this.nextRevision, formatVersion: AGENT_MEMORY_VERSION,
      stateJson: encode({ configurationDigest: this.configurationDigest, initialized: true, messages: this.messagesValue as unknown as ExactValue[] }) };
  }
}
