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
): Promise<string> {
  const abortedResult = "Tool execution aborted";
  const isCurrentOperation = () => !signal.aborted && isCurrent();
  const serializeAgentTerminalSession = <T extends object>(session: T) => {
    const agentSession = { ...session } as Record<string, unknown>;
    delete agentSession.project_id;
    delete agentSession.project_name;
    delete agentSession.mount_name;
    delete agentSession.workspace_path;
    return JSON.stringify(agentSession, null, 2);
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

  if (normalizedToolName === "terminal_create_session") {
    const session = await terminal.createSession({
      projectId: null,
      cwd: typeof args.cwd === "string" ? args.cwd : null,
    });
    return serializeAgentTerminalSession(session);
  }

  const sessionId =
    typeof args.session_id === "string" ? args.session_id.trim() : "";
  if (!sessionId) {
    return `Missing session_id argument for ${normalizedToolName}.`;
  }

  const agentSession = await readAgentTerminalSession(sessionId);
  if (!isCurrentOperation()) return abortedResult;
  if (agentSession.error) {
    return `Error executing ${normalizedToolName}: ${agentSession.error}`;
  }

  if (normalizedToolName === "terminal_run") {
    const command = typeof args.command === "string" ? args.command : "";
    if (!command.trim()) {
      return "Missing command argument for terminal_run.";
    }
    if (!isCurrentOperation()) return abortedResult;
    const executionId = createTerminalToolExecutionId();
    const runPromise = terminal.runCommand({
      sessionId,
      command,
      executionId,
      timeoutMs:
        typeof args.timeout_ms === "number"
          ? Math.min(1_800_000, Math.max(1, Math.floor(args.timeout_ms)))
          : null,
    });
    const abortListener = () => {
      void terminal
        .killSession(sessionId, executionId)
        .catch(() => undefined);
    };
    signal.addEventListener("abort", abortListener, { once: true });
    if (signal.aborted) abortListener();
    try {
      const session = await runPromise;
      return serializeAgentTerminalSession(session);
    } finally {
      signal.removeEventListener("abort", abortListener);
    }
  }

  if (normalizedToolName === "terminal_read") {
    return serializeAgentTerminalSession(agentSession.session);
  }

  if (!isCurrentOperation()) return abortedResult;
  const session = await terminal.killSession(sessionId);
  return serializeAgentTerminalSession(session);
}
