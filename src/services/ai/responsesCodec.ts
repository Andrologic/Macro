import { typedToolResult, type ToolResultBlock } from '../../shared/toolResultContent';
import {
  type ToolCall,
} from './contracts';
import type { ProviderTurnState } from '../../types';

export const buildChatGptProviderTurnState = (
  responseId?: string | null,
  outputItems?: unknown[] | null
): ProviderTurnState | undefined => {
  const normalizedOutputItems = Array.isArray(outputItems) ? outputItems : [];
  const normalizedResponseId = typeof responseId === 'string' ? responseId.trim() : '';

  if (!normalizedResponseId && normalizedOutputItems.length === 0) {
    return undefined;
  }

  return {
    provider: 'chatgpt',
    ...(normalizedResponseId ? { response_id: normalizedResponseId } : {}),
    output_items: normalizedOutputItems,
  };
};

export const buildFunctionCallOutputProviderInputItem = (
  toolCallId: string,
  output: string,
  blocks?: ToolResultBlock[],
  isError = false,
): unknown => ({
  type: 'function_call_output',
  call_id: toolCallId,
  output,
  ...(blocks ? { macro_tool_result: typedToolResult(blocks, isError) } : {}),
});

export const extractTextValue = (value: unknown): string => {
  if (typeof value === 'string') {
    return value;
  }

  if (value && typeof value === 'object' && 'value' in value) {
    const nested = (value as { value?: unknown }).value;
    return typeof nested === 'string' ? nested : '';
  }

  return '';
};

export const extractVisibleTextFromProviderInputItems = (items?: unknown[] | null): string => {
  if (!Array.isArray(items) || items.length === 0) {
    return '';
  }

  return items
    .flatMap((item) => {
      if (!item || typeof item !== 'object') {
        return [];
      }

      const typedItem = item as {
        type?: unknown;
        role?: unknown;
        text?: unknown;
        content?: unknown;
      };

      if (typedItem.type === 'output_text') {
        const text = extractTextValue(typedItem.text);
        return text ? [text] : [];
      }

      if (typedItem.type !== 'message' || typedItem.role !== 'assistant') {
        return [];
      }

      if (!Array.isArray(typedItem.content)) {
        return [];
      }

      return typedItem.content.flatMap((part) => {
        if (!part || typeof part !== 'object') {
          return [];
        }

        const typedPart = part as { type?: unknown; text?: unknown; value?: unknown };
        if (typedPart.type !== 'output_text' && typedPart.type !== 'text') {
          return [];
        }

        const text = extractTextValue(
          typedPart.text !== undefined ? typedPart.text : typedPart.value
        );
        return text ? [text] : [];
      });
    })
    .join('');
};

export const buildAssistantProviderInputItemsFromTurn = (
  content: string,
  toolCalls: ToolCall[]
): unknown[] => {
  const items: unknown[] = [];
  if (content.trim()) {
    items.push({
      type: 'message',
      role: 'assistant',
      content: [
        {
          type: 'output_text',
          text: content,
        },
      ],
    });
  }

  for (const toolCall of toolCalls) {
    items.push({
      type: 'function_call',
      call_id: toolCall.id,
      name: toolCall.function.name,
      arguments: toolCall.function.arguments,
    });
  }

  return items;
};

export const buildChatGptVisibleTurnContent = (
  content: string,
  reasoningSummary?: string | null
): string => {
  const trimmedContent = content.trim();
  const trimmedSummary = (reasoningSummary || '').trim();

  if (!trimmedSummary) {
    return content;
  }

  return trimmedContent
    ? `<think>${trimmedSummary}</think>\n${trimmedContent}`
    : `<think>${trimmedSummary}</think>`;
};

export const buildNativeReasoningVisibleTurnContent = (
  content: string,
  reasoningSummary?: string | null
): string => {
  if (content.trim().startsWith('<think>')) {
    return content;
  }
  return buildChatGptVisibleTurnContent(content, reasoningSummary);
};

export const getMissingChatGptVisibleTurnSuffix = (
  streamedTurnContent: string,
  turnContent: string
): string | null => {
  const trimmedTurnContent = turnContent.trim();
  if (!trimmedTurnContent) {
    return null;
  }

  const trimmedStreamedContent = streamedTurnContent.trim();
  if (!trimmedStreamedContent) {
    return turnContent;
  }

  if (turnContent === streamedTurnContent) {
    return null;
  }

  if (turnContent.startsWith(streamedTurnContent)) {
    const suffix = turnContent.slice(streamedTurnContent.length);
    return suffix.length > 0 ? suffix : null;
  }

  return null;
};

export const isEmptyTerminalChatGptTurn = (content: string, toolCalls: ToolCall[]): boolean =>
  toolCalls.length === 0 && content.trim().length === 0;

export const truncateMiddle = (value: string, maxChars: number): string => {
  if (value.length <= maxChars) {
    return value;
  }

  if (maxChars <= 64) {
    return `${value.slice(0, Math.max(0, maxChars - 16))}...[truncated]`;
  }

  const marker = '\n\n[... truncated for model context ...]\n\n';
  const tailChars = Math.min(800, Math.max(160, Math.floor(maxChars * 0.25)));
  const headChars = Math.max(0, maxChars - marker.length - tailChars);
  return `${value.slice(0, headChars)}${marker}${value.slice(-tailChars)}`;
};

export const compactToolResultForChatGptModelContext = (
  toolName: string,
  result: string,
  maxChars: number
): string => {
  const normalizedMaxChars = Math.max(400, maxChars);
  if (result.length <= normalizedMaxChars) {
    return result;
  }

  const truncationNotice = `\n\n[Tool output truncated for model context. Tool=${toolName}; original_length=${result.length} chars.]`;
  const contentBudget = Math.max(0, normalizedMaxChars - truncationNotice.length);
  if (contentBudget === 0) {
    return `[Tool output truncated for model context. Tool=${toolName}; original_length=${result.length} chars.]`;
  }

  const fileMatch = result.match(/^(FILE:\s*[^\n]+(?:\n[^\n]+)*)\n\n([\s\S]*)$/m);
  if (fileMatch) {
    const header = fileMatch[1];
    const body = fileMatch[2];
    const headerBudget = Math.min(header.length, Math.max(80, Math.floor(contentBudget * 0.2)));
    const safeHeader = header.slice(0, headerBudget);
    const remainingBudget = Math.max(0, contentBudget - safeHeader.length - 2);
    const compactBody = truncateMiddle(body, remainingBudget);
    return `${safeHeader}\n\n${compactBody}${truncationNotice}`;
  }

  return `${truncateMiddle(result, contentBudget)}${truncationNotice}`;
};
