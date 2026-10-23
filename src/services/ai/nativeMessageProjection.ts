import type { StreamMessage } from './contracts';
import { projectCopilotMessageContent } from './copilotPromptCodec';

/** Shared message projection before the native request DTO, with no transport. */
export const projectNativeMessages = (messages: StreamMessage[], providerType: string) => messages.map((message) => ({
  role: message.role,
  content: providerType === 'copilot' ? projectCopilotMessageContent(message) : message.content,
  ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
  ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
  ...(message.provider_input_items
    ? { provider_input_items: message.provider_input_items }
    : {}),
  ...(providerType === 'chatgpt' && message.provider_turn_state
    ? { provider_turn_state: message.provider_turn_state }
    : {}),
}));
