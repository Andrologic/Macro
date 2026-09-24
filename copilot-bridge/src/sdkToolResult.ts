import { normalizeToolResultBlocks } from '../../src/shared/toolResultContent';
import type { ToolResultObject } from '@github/copilot-sdk';
import type { RelayToolResult } from './protocol';

export const toSdkToolResult = (result: RelayToolResult): string | ToolResultObject => {
  // Preserve the legacy string result when the sender supplied no error metadata.
  if (!result.blocks && result.isError === undefined && result.errorKind === undefined) return result.result;

  // SDK 0.2.2 forwards ToolResultObject unchanged. It has no validation/execution/
  // aborted categories, so retain the original classification in toolTelemetry.
  const blocks = result.blocks ? normalizeToolResultBlocks(result.blocks) : undefined;
  const binary = blocks?.filter(block => block.type === 'image' || block.type === 'audio');
  const isError = result.isError || blocks?.some(block => block.type === 'unavailable');
  return {
    textResultForLlm: blocks ? blocks.map(block => block.type === 'text' ? block.text
      : block.type === 'unavailable' ? `[MCP content unavailable: ${block.reason}]`
      : `[MCP ${block.type} ${block.mimeType} supplied as a binary tool result.]`).join('\n') : result.result,
    ...(binary?.length ? { binaryResultsForLlm: binary } : {}),
    resultType: isError
      ? result.errorKind === 'permission' ? 'denied' : 'failure'
      : 'success',
    ...(isError ? { error: result.result } : {}),
    toolTelemetry: {
      ...(result.isError !== undefined ? { is_error: result.isError } : {}),
      ...(result.errorKind !== undefined ? { error_kind: result.errorKind } : {}),
    },
  };
};
