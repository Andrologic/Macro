import {
  TOOL_OUTPUT_LIMITS,
  truncateUtf8Middle,
} from "../shared/toolOutputLimits";

export interface SpilledToolResultPreview {
  preview: string;
  totalBytes: number;
  retainedBytes: number;
  omittedBytes: number;
}

export const shouldSpillToolResult = (
  _toolName: string,
  result: string,
): boolean =>
  new TextEncoder().encode(result).byteLength >
  TOOL_OUTPUT_LIMITS.toolResult.spillThresholdBytes;

export const buildSpilledToolResultPreview = (params: {
  toolName: string;
  result: string;
  artifactPath?: string | null;
}): SpilledToolResultPreview => {
  const truncated = truncateUtf8Middle(
    params.result,
    TOOL_OUTPUT_LIMITS.toolResult.headBytes,
    TOOL_OUTPUT_LIMITS.toolResult.tailBytes,
  );
  const recoveryLines = params.artifactPath
    ? [
        `Full output: ${params.artifactPath}`,
        `Use read_file with file="${params.artifactPath}", raw=true, and its cursor arguments to recover the complete output safely.`,
      ]
    : [
        "Full output unavailable: Macro could not persist the recoverable artifact.",
      ];
  const marker = [
    "",
    `[tool output truncated: ${truncated.omittedBytes} bytes omitted; beginning and latest output retained]`,
    ...recoveryLines,
    "",
  ].join("\n");

  return {
    preview: `${truncated.head}${marker}${truncated.tail}`,
    totalBytes: truncated.totalBytes,
    retainedBytes: truncated.retainedBytes,
    omittedBytes: truncated.omittedBytes,
  };
};
