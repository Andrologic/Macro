import type { FrozenToolCallContext } from "./chatStreamContracts";
import type { ToolCallResolution } from "./ai/contracts";
import { normalizeArchitectToolId } from "./architectToolNames";
import { normalizeLegacyToolExecutionResult } from "./toolResultNormalization";

export interface ChatToolDispatchPorts {
  execute(operation: FrozenToolCallContext, name: string, args: Record<string, unknown>, callId?: string, isCurrent?: () => boolean): Promise<ToolCallResolution | string | void>;
  preserve(operation: FrozenToolCallContext, name: string, callId: string | undefined, resolution: ToolCallResolution | string | void): Promise<ToolCallResolution | string | void>;
  boundError(operation: FrozenToolCallContext, name: string, callId: string | undefined, error: unknown): Promise<unknown>;
}

const ABORTED: ToolCallResolution = {
  kind: "result", result: "Tool execution aborted", isError: true,
  errorKind: "aborted", toString: () => "Tool execution aborted",
};

export function createChatToolDispatch(
  operation: FrozenToolCallContext,
  ports: ChatToolDispatchPorts,
  accepts: () => boolean,
  progress: () => void,
) {
  const isCurrent = () => !operation.signal.aborted && accepts();
  return async (toolName: string, args: Record<string, unknown>, toolCallId?: string) => {
    if (!isCurrent()) return ABORTED;
    progress();
    const normalizedName = normalizeArchitectToolId(toolName);
    let resolution: ToolCallResolution | string | void;
    try {
      resolution = await ports.execute(operation, toolName, args, toolCallId, isCurrent);
    } catch (error) {
      if (!isCurrent()) return ABORTED;
      const bounded = await ports.boundError(operation, normalizedName, toolCallId, error);
      if (!isCurrent()) return ABORTED;
      throw bounded;
    }
    if (!isCurrent()) {
      // Preserve explicit denial without starting a new artifact write after Stop.
      return typeof resolution === "object" && resolution?.kind === "result" && resolution.errorKind === "permission"
        ? resolution : ABORTED;
    }
    const preserved = await ports.preserve(operation, normalizedName, toolCallId, resolution);
    if (!isCurrent()) return ABORTED;
    return normalizeLegacyToolExecutionResult(normalizedName, preserved);
  };
}
