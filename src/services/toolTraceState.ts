import type { ToolTrace, ToolTraceStatus } from "../types";

export const TOOL_TRACE_STATUSES = [
  "running",
  "pending_approval",
  "denied",
  "done",
] as const satisfies readonly ToolTraceStatus[];

const TOOL_TRACE_STATUS_SET = new Set<string>(TOOL_TRACE_STATUSES);

export const isToolTraceStatus = (value: unknown): value is ToolTraceStatus =>
  typeof value === "string" && TOOL_TRACE_STATUS_SET.has(value);

export const isToolTrace = (value: unknown): value is ToolTrace =>
  !!value &&
  typeof value === "object" &&
  typeof (value as ToolTrace).tool_call_id === "string" &&
  typeof (value as ToolTrace).tool_name === "string" &&
  isToolTraceStatus((value as ToolTrace).status);

export const parseToolTracesJson = (
  raw: string | null,
): ToolTrace[] | undefined => {
  if (!raw) return undefined;

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return undefined;
    const traces = parsed.filter(isToolTrace);
    return traces.length > 0 ? traces : undefined;
  } catch {
    return undefined;
  }
};

export const mergeToolTracesPreservingDeniedStatus = (
  incoming: ToolTrace[],
  existing: ToolTrace[] = [],
): ToolTrace[] => {
  const existingByToolCallId = new Map(
    existing.map((trace) => [trace.tool_call_id, trace]),
  );

  return incoming.map((trace) => {
    const existingTrace = existingByToolCallId.get(trace.tool_call_id);
    if (!existingTrace) return trace;

    if (
      existingTrace.status === "denied" ||
      existingTrace.status === "pending_approval" ||
      (existingTrace.status === "done" && trace.status === "running")
    ) {
      return {
        ...trace,
        status: existingTrace.status,
        completed_at_ms: existingTrace.completed_at_ms ?? trace.completed_at_ms,
      };
    }

    return trace;
  });
};
