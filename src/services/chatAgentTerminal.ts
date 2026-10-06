import type { TerminalSessionDto } from "./tauriIpc";
import type { ToolResultResolution } from "./ai/contracts";
import { formatToolExecutionError } from "./ai/toolCallResolution";
import type { ChatToolExecutionPorts } from "./chatToolExecutionContracts";

let terminalToolExecutionCounter = 0;
const createTerminalToolExecutionId = (): string => {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  terminalToolExecutionCounter += 1;
  return `terminal-tool-${Date.now()}-${terminalToolExecutionCounter}`;
};

export async function executeChatAgentTerminal(
  terminal: ChatToolExecutionPorts["terminal"],
  normalizedToolName: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
  isCurrent: () => boolean = () => true,
): Promise<ToolResultResolution> {
  const result = (text: string, errorKind?: ToolResultResolution["errorKind"]): ToolResultResolution => ({
    kind: "result", result: text, ...(errorKind ? { isError: true, errorKind } : {}), toString: () => text,
  });
  const abortedResult = result("Tool execution aborted before dispatch", "aborted");
  const uncertain = (reason: string, diagnostic?: string) => result(JSON.stringify({
    outcome: "unknown", toolName: normalizedToolName, reason, diagnostic,
    instruction: "Inspect this terminal execution and its effects before retrying.",
  }), "uncertain");
  const isCurrentOperation = () => !signal.aborted && isCurrent();
  const serializeAgentTerminalSession = <T extends object>(session: T) => {
    const agentSession = { ...session } as Record<string, unknown>;
    delete agentSession.project_id;
    delete agentSession.project_name;
    delete agentSession.mount_name;
    delete agentSession.workspace_path;
    return result(JSON.stringify(agentSession, null, 2));
  };
  const readAgentTerminalSession = async (sessionId: string) => {
    const session =
      terminal.cachedSession(sessionId) ??
      (await terminal.readSession(sessionId));
    if (session.project_id) {
      return {
        session,
        error: "This session belongs to the manual project terminal and is unavailable to the agent terminal tool.",
      };
    }
    return { session, error: null };
  };

  if (!isCurrentOperation()) return abortedResult;

  let effectDispatched = false;
  try {
    if (normalizedToolName === "terminal_create_session") {
      effectDispatched = true;
      const session = await terminal.createSession({
        projectId: null,
        cwd: typeof args.cwd === "string" ? args.cwd : null,
      });
      return isCurrentOperation() ? serializeAgentTerminalSession(session) : uncertain("Stop occurred while terminal creation was pending.");
    }

    const sessionId =
      typeof args.session_id === "string" ? args.session_id.trim() : "";
    if (!sessionId) {
      return result(`Missing session_id argument for ${normalizedToolName}.`, "validation");
    }

    const agentSession = await readAgentTerminalSession(sessionId);
    if (!isCurrentOperation()) return abortedResult;
    if (agentSession.error) {
      return result(`Error executing ${normalizedToolName}: ${agentSession.error}`, "permission");
    }

    if (normalizedToolName === "terminal_run") {
      const command = typeof args.command === "string" ? args.command : "";
      if (!command.trim()) {
        return result("Missing command argument for terminal_run.", "validation");
      }
      if (!isCurrentOperation()) return abortedResult;
      const executionId = createTerminalToolExecutionId();
      let cancellation: Promise<TerminalSessionDto | undefined> | undefined;
      const abortListener = () => {
        cancellation ??= terminal.killSession(sessionId, executionId);
        // Observe immediately; the owner joins and reports this failure below.
        void cancellation.catch(() => undefined);
      };
      signal.addEventListener("abort", abortListener, { once: true });
      if (!isCurrentOperation()) {
        signal.removeEventListener("abort", abortListener);
        return abortedResult;
      }
      effectDispatched = true;
      try {
        const runPromise = terminal.runCommand({
          sessionId,
          command,
          executionId,
          timeoutMs:
            typeof args.timeout_ms === "number"
              ? Math.min(1_800_000, Math.max(1, Math.floor(args.timeout_ms)))
              : null,
        });
        const session = await runPromise;
        await cancellation;
        if (!isCurrentOperation() || session.timed_out || session.status === "killed") {
          return uncertain("Terminal execution was interrupted; earlier command effects may remain.", serializeAgentTerminalSession(session).result);
        }
        // A nonzero exit code is a confirmed command result, not a bridge error.
        if (session.exit_code === null || !["completed", "failed"].includes(session.status)) {
          return uncertain("Terminal did not return a final execution result.", serializeAgentTerminalSession(session).result);
        }
        return serializeAgentTerminalSession(session);
      } finally {
        signal.removeEventListener("abort", abortListener);
        await cancellation;
      }
    }

    if (normalizedToolName === "terminal_read") {
      return serializeAgentTerminalSession(agentSession.session);
    }

    if (!isCurrentOperation()) return abortedResult;
    if (normalizedToolName !== "terminal_kill") {
      return result(`Unknown terminal tool ${normalizedToolName}.`, "validation");
    }
    effectDispatched = true;
    const session = await terminal.killSession(sessionId);
    if (!isCurrentOperation() || session.status === "running") return uncertain("Terminal cancellation did not confirm a final state.", serializeAgentTerminalSession(session).result);
    return serializeAgentTerminalSession(session);
  } catch (error) {
    return effectDispatched
      ? uncertain("The terminal transport did not confirm the dispatched operation.", formatToolExecutionError(error))
      : result(formatToolExecutionError(error), "execution");
  }
}
