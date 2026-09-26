/** terminal IPC wrappers and frontend adapters. */

import { invoke } from "../tauriRuntimeBridge";
import type {
  TerminalPromptContextInput,
  TerminalSessionDto,
  TerminalTabDto,
} from "./terminal.types";

export async function terminalCreateSession(params: {
  projectId?: string | null;
  cwd?: string | null;
}): Promise<TerminalSessionDto> {
  return invoke<TerminalSessionDto>("terminal_create_session", {
    projectId: params.projectId ?? null,
    cwd: params.cwd ?? null,
  });
}

export async function terminalRun(params: {
  sessionId: string;
  command: string;
  timeoutMs?: number | null;
  executionId?: string | null;
}): Promise<TerminalSessionDto> {
  return invoke<TerminalSessionDto>("terminal_run", {
    sessionId: params.sessionId,
    command: params.command,
    timeoutMs: params.timeoutMs ?? null,
    executionId: params.executionId ?? null,
  });
}

export async function terminalRead(
  sessionId: string,
): Promise<TerminalSessionDto> {
  return invoke<TerminalSessionDto>("terminal_read", { sessionId });
}

export async function terminalKill(
  sessionId: string,
  executionId?: string | null,
): Promise<TerminalSessionDto> {
  return invoke<TerminalSessionDto>("terminal_kill", {
    sessionId,
    executionId: executionId ?? null,
  });
}

export async function terminalListTabs(): Promise<TerminalTabDto[]> {
  return invoke<TerminalTabDto[]>("terminal_list_tabs");
}

export async function terminalCreateTab(params: {
  kind: "manual" | "task";
  projectId: string;
  cwd?: string | null;
  title: string;
  taskId?: string | null;
  promptContext?: TerminalPromptContextInput | null;
}): Promise<TerminalTabDto> {
  return invoke<TerminalTabDto>("terminal_create_tab", {
    kind: params.kind,
    projectId: params.projectId,
    cwd: params.cwd ?? null,
    title: params.title,
    taskId: params.taskId ?? null,
    promptContext: params.promptContext ?? null,
  });
}

export async function terminalStartCommandTab(params: {
  kind: "manual" | "task" | "worktree_setup";
  projectId: string;
  cwd?: string | null;
  title: string;
  taskId?: string | null;
  promptContext?: TerminalPromptContextInput | null;
  command: string;
}): Promise<TerminalTabDto> {
  return invoke<TerminalTabDto>("terminal_start_command_tab", {
    kind: params.kind,
    projectId: params.projectId,
    cwd: params.cwd ?? null,
    title: params.title,
    taskId: params.taskId ?? null,
    promptContext: params.promptContext ?? null,
    command: params.command,
  });
}

export async function terminalReconnectTab(
  tabId: string,
): Promise<TerminalTabDto> {
  return invoke<TerminalTabDto>("terminal_reconnect_tab", { tabId });
}

export async function terminalReadTab(tabId: string): Promise<TerminalTabDto> {
  return invoke<TerminalTabDto>("terminal_read_tab", { tabId });
}

export async function terminalUpdateTabMetadata(params: {
  tabId: string;
  title: string;
  promptContext?: TerminalPromptContextInput | null;
}): Promise<TerminalTabDto> {
  return invoke<TerminalTabDto>("terminal_update_tab_metadata", {
    tabId: params.tabId,
    title: params.title,
    promptContext: params.promptContext ?? null,
  });
}

export async function terminalWriteInput(params: {
  tabId: string;
  input: string;
}): Promise<void> {
  return invoke("terminal_write_input", {
    tabId: params.tabId,
    input: params.input,
  });
}

export async function terminalResize(params: {
  tabId: string;
  cols: number;
  rows: number;
}): Promise<void> {
  return invoke("terminal_resize", {
    tabId: params.tabId,
    cols: params.cols,
    rows: params.rows,
  });
}

export async function terminalExecuteCommand(params: {
  tabId: string;
  command: string;
}): Promise<TerminalTabDto> {
  return invoke<TerminalTabDto>("terminal_execute_command", {
    tabId: params.tabId,
    command: params.command,
  });
}

export async function terminalInterrupt(
  tabId: string,
): Promise<TerminalTabDto> {
  return invoke<TerminalTabDto>("terminal_interrupt", { tabId });
}

export async function terminalClearTab(tabId: string): Promise<TerminalTabDto> {
  return invoke<TerminalTabDto>("terminal_clear_tab", { tabId });
}

export async function terminalCloseTab(tabId: string): Promise<void> {
  return invoke("terminal_close_tab", { tabId });
}
