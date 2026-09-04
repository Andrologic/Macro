import type { ChatMessage, PendingToolApproval } from '../types';
import * as tauriIpc from './tauriIpc';

export const TOOL_APPROVAL_RECOVERY_KEY = 'toolApprovalRecovery:v1';
const RECOVERY_FORMAT_ERROR = 'Saved tool approvals could not be restored: unsupported or invalid recovery data.';

type RecoveryMarker = { version: 1; conversationId: string; assistantMessageId: string; toolCallId: string };
type RecoveryRegistry = {
  key: string;
  document: Record<string, unknown>;
  requests: Record<string, unknown>;
  supported: boolean;
};

const readMarker = (value: unknown, conversationId: string): RecoveryMarker | null => {
  if (!value || typeof value !== 'object') return null;
  const marker = value as Partial<RecoveryMarker>;
  return marker.version === 1 && marker.conversationId === conversationId &&
    typeof marker.assistantMessageId === 'string' && marker.assistantMessageId.length > 0 &&
    typeof marker.toolCallId === 'string' && marker.toolCallId.length > 0
    ? marker as RecoveryMarker : null;
};

const readRegistry = async (key: string): Promise<RecoveryRegistry> => {
  const setting = await tauriIpc.dbGetAppSetting(key);
  if (!setting) return { key, document: { version: 1 }, requests: {}, supported: true };
  try {
    const document = JSON.parse(setting.value_json);
    if (document?.version === 1 && document.requests && typeof document.requests === 'object' && !Array.isArray(document.requests)) {
      return { key, document, requests: document.requests, supported: true };
    }
  } catch { /* Keep the original bytes until a new request needs to be saved. */ }
  return { key, document: { version: 1, preservedData: [{ valueJson: setting.value_json }] }, requests: {}, supported: false };
};

export const loadToolApprovalRecoveryMarkers = async (): Promise<{ markers: Record<string, string>; warning: string | null }> => {
  if (!tauriIpc.isTauriAvailable()) return { markers: {}, warning: null };
  const registry = await readRegistry(TOOL_APPROVAL_RECOVERY_KEY);
  const markers: Record<string, string> = {};
  let warning: string | null = null;
  if (!registry.supported || Object.hasOwn(registry.document, 'preservedData')) warning = RECOVERY_FORMAT_ERROR;
  for (const [conversationId, value] of Object.entries(registry.requests)) {
    const marker = readMarker(value, conversationId);
    if (marker) markers[conversationId] = JSON.stringify(marker);
    else warning = RECOVERY_FORMAT_ERROR;
  }
  return { markers, warning };
};

const writeRegistry = async (registry: RecoveryRegistry) => {
  if (Object.keys(registry.requests).length === 0 && Object.keys(registry.document).every((key) => key === 'version' || key === 'requests')) await tauriIpc.dbDeleteAppSetting(registry.key);
  else await tauriIpc.dbSetAppSetting({
    key: registry.key,
    valueJson: JSON.stringify({ ...registry.document, requests: registry.requests }),
  });
};

const preserveRequestExtensions = (registry: RecoveryRegistry, conversationId: string) => {
  if (!Object.hasOwn(registry.requests, conversationId)) return;
  const value = registry.requests[conversationId];
  if (!readMarker(value, conversationId) || Object.keys(value as object).some((key) => !['version', 'conversationId', 'assistantMessageId', 'toolCallId'].includes(key))) {
    const previous = registry.document.preservedData;
    registry.document.preservedData = [
      ...(Array.isArray(previous) ? previous : previous === undefined ? [] : [previous]),
      { conversationId, value },
    ];
  }
};

// One writer prevents lost updates between conversations in this webview.
let writes: Promise<void> = Promise.resolve();
export const persistToolApprovalRecovery = (
  conversationId: string,
  approval: Pick<PendingToolApproval, 'assistantMessageId' | 'toolCallId'> | null,
): Promise<void> => {
  if (!tauriIpc.isTauriAvailable()) return Promise.resolve();
  const write = writes.catch(() => undefined).then(async () => {
    if (approval) {
      const registry = await readRegistry(TOOL_APPROVAL_RECOVERY_KEY);
      preserveRequestExtensions(registry, conversationId);
      registry.requests[conversationId] = { version: 1, conversationId, assistantMessageId: approval.assistantMessageId, toolCallId: approval.toolCallId };
      await writeRegistry(registry);
    } else {
      const registry = await readRegistry(TOOL_APPROVAL_RECOVERY_KEY);
      if (!registry.supported || !readMarker(registry.requests[conversationId], conversationId)) return;
      preserveRequestExtensions(registry, conversationId);
      delete registry.requests[conversationId];
      await writeRegistry(registry);
    }
  });
  writes = write;
  return write;
};

export const restoreToolApprovalRecovery = (
  valueJson: string,
  conversationId: string,
  messages: ChatMessage[],
): PendingToolApproval | null => {
  try {
    const marker = readMarker(JSON.parse(valueJson), conversationId);
    if (!marker) return null;
    const messageIndex = messages.findIndex((message) =>
      message.id === marker.assistantMessageId && message.conversation_id === conversationId && message.role === 'assistant');
    if (messageIndex < 0 || messages.slice(messageIndex + 1).some((message) => message.role === 'user')) return null;
    const trace = messages[messageIndex].tool_traces?.find((candidate) =>
      candidate.tool_call_id === marker.toolCallId && (candidate.status === 'pending_approval' || candidate.status === 'denied'));
    if (!trace) return null;
    return {
      conversationId, assistantMessageId: marker.assistantMessageId,
      toolCallId: marker.toolCallId, toolId: trace.tool_name,
      recoveryState: 'interrupted', actionGroup: 'escape', riskLevel: 'strict',
      summary: trace.tool_name, detail: trace.detail,
      rememberKey: '', canApproveForConversation: false,
    };
  } catch {
    return null;
  }
};

// Names and display labels do not affect permission. Paths, mounts and targets do.
export const sameApprovalExecutionScope = (
  left: import('./projectExecutionContext').ProjectExecutionContext,
  right: import('./projectExecutionContext').ProjectExecutionContext,
): boolean => {
  const scope = (context: typeof left) => ({
    taskId: context.taskId, groupId: context.groupId, projectId: context.projectId,
    focusedProjectId: context.focusedProjectId, branchName: context.branchName,
    workspacePath: context.workspacePath, defaultWorkspacePath: context.defaultWorkspacePath,
    virtualRootEnabled: context.virtualRootEnabled,
    actionableProjectIds: [...context.actionableProjectIds].sort(),
    contextProjectIds: [...context.contextProjectIds].sort(),
    workspacePaths: Object.entries(context.workspacePathsByProjectId).sort(([a], [b]) => a.localeCompare(b)),
    mounts: context.projectMounts,
  });
  return JSON.stringify(scope(left)) === JSON.stringify(scope(right));
};
