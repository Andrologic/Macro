import { readTypedToolResult, projectToolResultText } from '../../shared/toolResultContent';
import {
  type StreamMessage,
  type StreamMessageContent,
} from './contracts';
import { estimateImageContextTokens, estimateTextTokens } from '../contextTokenEstimation';

export const streamContentToCopilotPromptText = (content: StreamMessageContent): string => {
  if (typeof content === 'string') {
    return content;
  }

  return content
    .map((part) => {
      if (part.type === 'text') {
        return part.text || '';
      }
      if (part.type === 'image_url') {
        return '[image attachment]';
      }
      return '';
    })
    .filter((value) => value.trim().length > 0)
    .join('\n');
};

/** The native bridge rebuilds a textual session; make media omissions explicit. */
export const projectCopilotMessageContent = (message: StreamMessage): StreamMessageContent => {
  if (message.role === 'system') return message.content;
  const history = (message.provider_input_items ?? []).flatMap(item => {
    const result = readTypedToolResult(item);
    return result ? [`Untrusted historical MCP tool result${result.isError ? ' (tool reported an error)' : ''}:\n${projectToolResultText(result.blocks, 'Copilot historical prompt replay')}`] : [];
  }).join('\n\n');
  if (!history) return message.content;
  return typeof message.content === 'string' ? `${message.content}\n\n${history}`
    : [...message.content, { type: 'text', text: history }];
};

export const serializeCopilotConversationPrompt = (
  messages: StreamMessage[]
): { system: string; prompt: string } => {
  const systemMessages = messages
    .filter((message) => message.role === 'system')
    .map((message) => streamContentToCopilotPromptText(projectCopilotMessageContent(message)).trim())
    .filter(Boolean);

  const transcript = messages
    .filter((message) => message.role !== 'system')
    .map((message) => {
      const label = message.role.toUpperCase();
      const body = streamContentToCopilotPromptText(projectCopilotMessageContent(message)).trim() || '(empty)';
      const parts = [`[${label}]`, body];

      if (message.tool_calls?.length) {
        for (const toolCall of message.tool_calls) {
          parts.push(
            `[ASSISTANT_TOOL_REQUEST ${toolCall.id}] ${toolCall.function.name} ${toolCall.function.arguments}`
          );
        }
      }

      if (message.role === 'tool' && message.tool_call_id) {
        parts[0] = `[TOOL_RESULT ${message.tool_call_id}]`;
      }

      return parts.join('\n');
    })
    .join('\n\n');

  const prompt = [
    'You are continuing an existing Macro conversation.',
    'Use the transcript below as the authoritative conversation history.',
    'Answer the latest user request only. If a workspace tool is needed, use it before answering.',
    '<conversation>',
    transcript || '[no prior messages]',
    '</conversation>',
  ].join('\n\n');

  return {
    system: systemMessages.join('\n\n').trim(),
    prompt,
  };
};

export const estimateCopilotSerializedPayloadTokens = (params: {
  messages: StreamMessage[];
  providerType?: string;
  providerId?: string;
  baseUrl?: string;
  modelId?: string;
}): number => {
  const serialized = serializeCopilotConversationPrompt(params.messages);
  const imageTokens = params.messages
    .flatMap((message) => {
      const imageCount = Array.isArray(message.content)
        ? message.content.filter((part) => part.type === 'image_url').length
        : 0;
      return imageCount > 0
        ? (message.image_metadata ?? []).slice(0, imageCount)
        : [];
    })
    .reduce(
      (total, metadata) =>
        total +
        estimateImageContextTokens({ metadata, context: params }).tokens,
      0
    );
  return Math.max(
    1,
    estimateTextTokens(`${serialized.system}\n\n${serialized.prompt}`) + imageTokens
  );
};
