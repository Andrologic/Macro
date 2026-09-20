import type { ToolResultObject } from '@github/copilot-sdk';
import type { RelayToolResult } from './protocol';

export const toSdkToolResult = (result: RelayToolResult): string | ToolResultObject => {
  // Preserve the legacy string result when the sender supplied no error metadata.
  if (result.isError === undefined && result.errorKind === undefined) return result.result;

  // SDK 0.2.2 forwards ToolResultObject unchanged. It has no validation/execution/
  // aborted categories, so retain the original classification in toolTelemetry.
  return {
    textResultForLlm: result.result,
    resultType: result.isError
      ? result.errorKind === 'permission' ? 'denied' : 'failure'
      : 'success',
    ...(result.isError ? { error: result.result } : {}),
    toolTelemetry: {
      ...(result.isError !== undefined ? { is_error: result.isError } : {}),
      ...(result.errorKind !== undefined ? { error_kind: result.errorKind } : {}),
    },
  };
};
