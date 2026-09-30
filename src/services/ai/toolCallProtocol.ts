import {
  type ToolCall,
} from './contracts';

export const getValidToolCalls = (toolCalls: ToolCall[]): ToolCall[] =>
  toolCalls.filter((toolCall) => toolCall.id && toolCall.function.name);

export const hasCompleteToolCallBatch = (toolCalls: ToolCall[]): boolean => {
  const validToolCalls = getValidToolCalls(toolCalls);
  if (validToolCalls.length === 0 || validToolCalls.length !== toolCalls.length) {
    return false;
  }
  return validToolCalls.every((toolCall) => {
    try {
      JSON.parse(toolCall.function.arguments);
      return true;
    } catch {
      return false;
    }
  });
};
