import type {
  AgentCodeCheckpoint,
  AgentCodeCheckpointFileSnapshot,
  AgentCodeReplayPreview,
  AgentCodeReplayPreviewFile,
  ChatMessage,
} from "../types";
import * as tauriIpc from "./tauriIpc";

const STORAGE_KEY_PREFIX = "agentCodeCheckpoints:";
const MAX_CHECKPOINTS_PER_CONVERSATION = 200;
const checkpointWriteQueues = new Map<string, Promise<void>>();

const getStorageKey = (conversationId: string): string =>
  `${STORAGE_KEY_PREFIX}${conversationId}`;

const cloneCheckpoints = (
  checkpoints: AgentCodeCheckpoint[],
): AgentCodeCheckpoint[] =>
  checkpoints.map((checkpoint) => ({
    ...checkpoint,
    files: checkpoint.files.map((file) => ({
      ...file,
      before: { ...file.before },
      after: { ...file.after },
    })),
  }));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const isOptionalString = (value: unknown): value is string | null | undefined =>
  value === undefined || value === null || typeof value === "string";

const isAgentCodeCheckpointFileStatus = (
  value: unknown,
): value is AgentCodeCheckpoint["files"][number]["status"] =>
  value === "created" || value === "modified" || value === "deleted";

const parseSnapshot = (
  value: unknown,
): AgentCodeCheckpointFileSnapshot | null => {
  if (!isRecord(value) || typeof value.exists !== "boolean") {
    return null;
  }

  if (value.content !== null && typeof value.content !== "string") {
    return null;
  }

  if (
    value.isBinary !== undefined &&
    typeof value.isBinary !== "boolean"
  ) {
    return null;
  }

  if (value.size !== undefined && typeof value.size !== "number") {
    return null;
  }

  if (
    !isOptionalString(value.revision) ||
    !isOptionalString(value.encoding) ||
    !isOptionalString(value.language)
  ) {
    return null;
  }

  return {
    exists: value.exists,
    content: value.content,
    revision: value.revision,
    isBinary: value.isBinary,
    size: value.size,
    encoding: value.encoding,
    language: value.language,
  };
};

const parseCheckpointFile = (
  value: unknown,
): AgentCodeCheckpoint["files"][number] | null => {
  if (
    !isRecord(value) ||
    typeof value.path !== "string" ||
    typeof value.realPath !== "string" ||
    !isAgentCodeCheckpointFileStatus(value.status) ||
    !isOptionalString(value.projectId) ||
    !isOptionalString(value.mountName) ||
    !isOptionalString(value.workspacePath) ||
    !isOptionalString(value.workspaceScope) ||
    (
      value.allowOutsideWorkspace !== undefined &&
      typeof value.allowOutsideWorkspace !== "boolean"
    )
  ) {
    return null;
  }

  const before = parseSnapshot(value.before);
  const after = parseSnapshot(value.after);
  if (!before || !after) {
    return null;
  }

  return {
    path: value.path,
    realPath: value.realPath,
    projectId: value.projectId,
    mountName: value.mountName,
    workspacePath: value.workspacePath,
    workspaceScope: value.workspaceScope,
    allowOutsideWorkspace: value.allowOutsideWorkspace,
    status: value.status,
    before,
    after,
  };
};

const parseCheckpoint = (value: unknown): AgentCodeCheckpoint | null => {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.conversationId !== "string" ||
    !isOptionalString(value.turnId) ||
    typeof value.assistantMessageId !== "string" ||
    typeof value.toolCallId !== "string" ||
    typeof value.toolName !== "string" ||
    typeof value.sequence !== "number" ||
    typeof value.createdAt !== "string" ||
    !Array.isArray(value.files)
  ) {
    return null;
  }

  const files = value.files
    .map(parseCheckpointFile)
    .filter((file): file is AgentCodeCheckpoint["files"][number] => Boolean(file));
  if (files.length !== value.files.length) {
    return null;
  }

  return {
    id: value.id,
    conversationId: value.conversationId,
    turnId: value.turnId ?? null,
    assistantMessageId: value.assistantMessageId,
    toolCallId: value.toolCallId,
    toolName: value.toolName,
    sequence: value.sequence,
    createdAt: value.createdAt,
    files,
  };
};

const parseCheckpoints = (raw: string | null | undefined): AgentCodeCheckpoint[] => {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(parseCheckpoint)
      .filter((checkpoint): checkpoint is AgentCodeCheckpoint =>
        Boolean(checkpoint),
      );
  } catch {
    return [];
  }
};

const readLocalStorage = (conversationId: string): AgentCodeCheckpoint[] => {
  if (typeof window === "undefined" || !window.localStorage) return [];
  return parseCheckpoints(window.localStorage.getItem(getStorageKey(conversationId)));
};

const writeLocalStorage = (
  conversationId: string,
  checkpoints: AgentCodeCheckpoint[],
): void => {
  if (typeof window === "undefined" || !window.localStorage) return;
  window.localStorage.setItem(
    getStorageKey(conversationId),
    JSON.stringify(checkpoints),
  );
};

export const loadAgentCodeCheckpoints = async (
  conversationId: string,
): Promise<AgentCodeCheckpoint[]> => {
  if (tauriIpc.isTauriAvailable()) {
    try {
      const record = await tauriIpc.dbGetAppSetting(getStorageKey(conversationId));
      return parseCheckpoints(record?.value_json ?? null);
    } catch {
      return readLocalStorage(conversationId);
    }
  }

  return readLocalStorage(conversationId);
};

export const saveAgentCodeCheckpoints = async (
  conversationId: string,
  checkpoints: AgentCodeCheckpoint[],
): Promise<void> => {
  const trimmed = checkpoints
    .slice()
    .sort((left, right) => left.sequence - right.sequence)
    .slice(-MAX_CHECKPOINTS_PER_CONVERSATION);

  const previous = checkpointWriteQueues.get(conversationId) ?? Promise.resolve();
  const write = previous.catch(() => undefined).then(async () => {
    if (tauriIpc.isTauriAvailable()) {
      // A desktop checkpoint is part of the durable replay record. Falling back
      // to browser storage here would make a successful replay impossible after
      // a restart, so surface the database failure to the caller instead.
      await tauriIpc.dbSetAppSetting({
        key: getStorageKey(conversationId),
        valueJson: JSON.stringify(trimmed),
      });
      return;
    }

    writeLocalStorage(conversationId, trimmed);
  });
  checkpointWriteQueues.set(conversationId, write);
  try {
    await write;
  } finally {
    if (checkpointWriteQueues.get(conversationId) === write) {
      checkpointWriteQueues.delete(conversationId);
    }
  }
};

export const clearAgentCodeCheckpoints = (conversationId: string): void => {
  if (typeof window === "undefined" || !window.localStorage) return;
  window.localStorage.removeItem(getStorageKey(conversationId));
};

const getConversationMessageIndex = (
  messages: ChatMessage[],
  messageId: string,
): number =>
  messages.findIndex((message) => message.id === messageId);

const copySnapshot = (
  snapshot: AgentCodeCheckpointFileSnapshot,
): AgentCodeCheckpointFileSnapshot => ({ ...snapshot });

const missingCheckpointSnapshot = (): AgentCodeCheckpointFileSnapshot => ({
  exists: false,
  content: null,
  revision: null,
  isBinary: false,
  size: 0,
  encoding: null,
  language: null,
});

const snapshotsEqual = (
  left: AgentCodeCheckpointFileSnapshot,
  right: AgentCodeCheckpointFileSnapshot,
): boolean => {
  if (left.exists !== right.exists) return false;
  if (!left.exists && !right.exists) return true;
  if (Boolean(left.isBinary) !== Boolean(right.isBinary)) return false;
  if (left.revision && right.revision) {
    return left.revision === right.revision;
  }
  if (left.content !== null || right.content !== null) {
    return left.content === right.content;
  }
  return left.size === right.size;
};

const readCurrentSnapshot = async (
  file: AgentCodeReplayPreviewFile,
): Promise<AgentCodeCheckpointFileSnapshot> => {
  if (!tauriIpc.isTauriAvailable()) {
    return file.expectedCurrent
      ? copySnapshot(file.expectedCurrent)
      : copySnapshot(file.target);
  }

  const commonOptions = {
    workspaceScope: (file.workspaceScope || undefined) as
      | tauriIpc.WorkspaceScope
      | undefined,
    workspacePath: file.workspacePath ?? undefined,
  };

  const exists = await tauriIpc.fsExists(file.realPath, commonOptions);
  if (!exists) {
    return missingCheckpointSnapshot();
  }

  const current = await tauriIpc.fsReadFileWithOptions({
    path: file.realPath,
    allowOutsideWorkspace: false,
    ...commonOptions,
  });
  return {
    exists: true,
    content: current.is_binary ? null : current.content,
    revision: current.revision ?? null,
    isBinary: current.is_binary,
    size: current.size,
    encoding: current.encoding,
    language: current.language,
  };
};

export const buildAgentCodeReplayPreview = (
  conversationId: string,
  messageId: string,
  messages: ChatMessage[],
  checkpoints: AgentCodeCheckpoint[],
): AgentCodeReplayPreview => {
  const targetMessageIndex = getConversationMessageIndex(messages, messageId);
  if (targetMessageIndex < 0) {
    return {
      conversationId,
      messageId,
      targetCheckpointId: null,
      affectedFiles: [],
    };
  }

  const sortedCheckpoints = checkpoints
    .filter((checkpoint) => checkpoint.conversationId === conversationId)
    .slice()
    .sort((left, right) => left.sequence - right.sequence);
  const messageIndexById = new Map(
    messages.map((message, index) => [message.id, index]),
  );
  const assistantIndexByTurnId = new Map<string, number>();
  const lastMessageIndexByTurnId = new Map<string, number>();
  messages.forEach((message, index) => {
    if (!message.turn_id) {
      return;
    }
    lastMessageIndexByTurnId.set(message.turn_id, index);
    if (
      message.role === "assistant" &&
      !assistantIndexByTurnId.has(message.turn_id)
    ) {
      assistantIndexByTurnId.set(message.turn_id, index);
    }
  });
  const getCheckpointMessageIndex = (
    checkpoint: AgentCodeCheckpoint,
  ): number | undefined => {
    const assistantIndex = messageIndexById.get(checkpoint.assistantMessageId);
    if (typeof assistantIndex === "number") {
      return assistantIndex;
    }
    if (!checkpoint.turnId) {
      return undefined;
    }
    return (
      assistantIndexByTurnId.get(checkpoint.turnId) ??
      lastMessageIndexByTurnId.get(checkpoint.turnId)
    );
  };

  const keptCheckpoints = sortedCheckpoints.filter((checkpoint) => {
    const assistantIndex = getCheckpointMessageIndex(checkpoint);
    return typeof assistantIndex === "number" && assistantIndex < targetMessageIndex;
  });
  const undoneCheckpoints = sortedCheckpoints.filter((checkpoint) => {
    const assistantIndex = getCheckpointMessageIndex(checkpoint);
    return typeof assistantIndex === "number" && assistantIndex > targetMessageIndex;
  });

  if (undoneCheckpoints.length === 0) {
    return {
      conversationId,
      messageId,
      targetCheckpointId: keptCheckpoints.at(-1)?.id ?? null,
      affectedFiles: [],
    };
  }

  const targetSnapshotByPath = new Map<string, AgentCodeReplayPreviewFile>();
  const affectedRealPaths = new Set<string>();

  for (const checkpoint of keptCheckpoints) {
    for (const file of checkpoint.files) {
      targetSnapshotByPath.set(file.realPath, {
        path: file.path,
        realPath: file.realPath,
        action: file.after.exists ? "modify" : "delete",
        status: file.status,
        projectId: file.projectId,
        mountName: file.mountName,
        workspacePath: file.workspacePath,
        workspaceScope: file.workspaceScope,
        allowOutsideWorkspace: false,
        target: copySnapshot(file.after),
      });
    }
  }

  const baselineByPath = new Map<string, AgentCodeReplayPreviewFile>();
  const expectedCurrentByPath = new Map<
    string,
    AgentCodeCheckpointFileSnapshot
  >();
  const undoneHistoryByPath = new Map<
    string,
    { firstBeforeExists: boolean; deletedAfterTarget: boolean }
  >();
  for (const checkpoint of undoneCheckpoints) {
    for (const file of checkpoint.files) {
      affectedRealPaths.add(file.realPath);
      expectedCurrentByPath.set(file.realPath, copySnapshot(file.after));
      const existingHistory = undoneHistoryByPath.get(file.realPath);
      undoneHistoryByPath.set(file.realPath, {
        firstBeforeExists:
          existingHistory?.firstBeforeExists ?? file.before.exists,
        deletedAfterTarget:
          Boolean(existingHistory?.deletedAfterTarget) || !file.after.exists,
      });
      if (!baselineByPath.has(file.realPath)) {
        baselineByPath.set(file.realPath, {
          path: file.path,
          realPath: file.realPath,
          action: file.before.exists ? "modify" : "delete",
          status: file.status,
          projectId: file.projectId,
          mountName: file.mountName,
          workspacePath: file.workspacePath,
          workspaceScope: file.workspaceScope,
          allowOutsideWorkspace: false,
          target: copySnapshot(file.before),
        });
      }
    }
  }

  const affectedFiles = Array.from(affectedRealPaths).map((realPath) => {
    const target = targetSnapshotByPath.get(realPath) ?? baselineByPath.get(realPath);
    if (!target) {
      throw new Error(`Missing checkpoint target for ${realPath}`);
    }
    const history = undoneHistoryByPath.get(realPath);
    const status = history?.firstBeforeExists === false
      ? "created"
      : history?.deletedAfterTarget && target.target.exists
        ? "deleted"
      : target.target.exists
        ? "modified"
        : "deleted";
    return {
      ...target,
      action: target.target.exists
        ? status === "deleted"
          ? "restore"
          : "modify"
        : "delete",
      status,
      expectedCurrent: expectedCurrentByPath.has(realPath)
        ? copySnapshot(expectedCurrentByPath.get(realPath)!)
        : undefined,
    } satisfies AgentCodeReplayPreviewFile;
  });

  return {
    conversationId,
    messageId,
    targetCheckpointId: keptCheckpoints.at(-1)?.id ?? null,
    affectedFiles,
  };
};

export const hydrateAgentCodeReplayPreviewCurrentState = async (
  preview: AgentCodeReplayPreview,
): Promise<AgentCodeReplayPreview> => {
  if (preview.affectedFiles.length === 0) {
    return preview;
  }

  const affectedFiles = await Promise.all(
    preview.affectedFiles.map(async (file) => {
      const current = await readCurrentSnapshot(file);
      const expectedCurrent = file.expectedCurrent;
      const hasExternalChanges = expectedCurrent
        ? !snapshotsEqual(current, expectedCurrent)
        : false;
      return {
        ...file,
        current,
        hasExternalChanges,
      };
    }),
  );

  return {
    ...preview,
    affectedFiles,
    hasExternalChanges: affectedFiles.some((file) => file.hasExternalChanges),
  };
};

export const restoreAgentCodeReplayPreview = async (
  preview: AgentCodeReplayPreview,
): Promise<() => Promise<void>> => {
  // Re-read immediately before writing: the confirmation dialog may have been
  // open while another process changed the workspace.
  const currentSnapshots = await Promise.all(
    preview.affectedFiles.map(async (file) => ({
      file,
      current: await readCurrentSnapshot(file),
    })),
  );
  const externallyModified = currentSnapshots.find(
    ({ file, current }) =>
      file.expectedCurrent && !snapshotsEqual(current, file.expectedCurrent),
  );
  if (externallyModified) {
    throw new Error(
      `Cannot restore ${externallyModified.file.path}: the file changed after the replay preview was created.`,
    );
  }

  const restoreSnapshot = async (
    file: AgentCodeReplayPreviewFile,
    snapshot: AgentCodeCheckpointFileSnapshot,
    expectedCurrent?: AgentCodeCheckpointFileSnapshot,
  ): Promise<void> => {
    const commonOptions = {
      workspaceScope: (file.workspaceScope || undefined) as
        | tauriIpc.WorkspaceScope
        | undefined,
      workspacePath: file.workspacePath ?? undefined,
    };

    if (!snapshot.exists) {
      const exists = await tauriIpc.fsExists(file.realPath, commonOptions);
      if (exists) {
        await tauriIpc.fsDelete({
          path: file.realPath,
          expectedRevision: expectedCurrent?.revision ?? undefined,
          ...commonOptions,
        });
      }
      return;
    }

    if (snapshot.content === null) {
      throw new Error(`Cannot restore ${file.path}: checkpoint content is missing.`);
    }

    await tauriIpc.fsWriteFile({
      path: file.realPath,
      content: snapshot.content,
      createDirs: true,
      allowOutsideWorkspace: false,
      expectedRevision: expectedCurrent
        ? expectedCurrent.exists
          ? expectedCurrent.revision ?? undefined
          : "absent"
        : undefined,
      ...commonOptions,
    });
  };

  const restored: Array<{
    file: AgentCodeReplayPreviewFile;
    current: AgentCodeCheckpointFileSnapshot;
  }> = [];
  try {
    for (const { file, current } of currentSnapshots) {
      await restoreSnapshot(file, file.target, current);
      restored.push({ file, current });
    }
  } catch (error) {
    const rollbackFailures: string[] = [];
    for (const { file, current } of restored.reverse()) {
      try {
        await restoreSnapshot(file, current, file.target);
      } catch (rollbackError) {
        rollbackFailures.push(`${file.path}: ${String(rollbackError)}`);
      }
    }
    if (rollbackFailures.length > 0) {
      throw new Error(
        `Checkpoint restoration failed and rollback was incomplete: ${String(error)}; ${rollbackFailures.join("; ")}`,
      );
    }
    throw error;
  }

  return async () => {
    const rollbackFailures: string[] = [];
    for (const { file, current } of restored.slice().reverse()) {
      try {
        await restoreSnapshot(file, current, file.target);
      } catch (error) {
        rollbackFailures.push(`${file.path}: ${String(error)}`);
      }
    }
    if (rollbackFailures.length > 0) {
      throw new Error(
        `Unable to roll back the code checkpoint restoration: ${rollbackFailures.join("; ")}`,
      );
    }
  };
};

export const pruneAgentCodeCheckpointsToMessageIds = (
  checkpoints: AgentCodeCheckpoint[],
  conversationId: string,
  keptMessageIds: Set<string>,
): AgentCodeCheckpoint[] =>
  checkpoints.filter(
    (checkpoint) =>
      checkpoint.conversationId !== conversationId ||
      keptMessageIds.has(checkpoint.assistantMessageId),
  );

export const appendAgentCodeCheckpoint = (
  checkpoints: AgentCodeCheckpoint[],
  checkpoint: AgentCodeCheckpoint,
): AgentCodeCheckpoint[] =>
  cloneCheckpoints([...checkpoints, checkpoint]).sort(
    (left, right) => left.sequence - right.sequence,
  );

export const createAgentCodeCheckpoint = (
  existing: AgentCodeCheckpoint[],
  params: {
    conversationId: string;
    turnId?: string | null;
    assistantMessageId: string;
    toolCallId?: string;
    toolName: string;
    files: AgentCodeCheckpoint["files"];
  },
): AgentCodeCheckpoint => {
  const sequence =
    Math.max(0, ...existing.map((checkpoint) => checkpoint.sequence || 0)) + 1;
  return {
    id: `${params.conversationId}:${params.turnId ?? params.assistantMessageId}:${params.toolCallId ?? params.toolName}:${sequence}`,
    conversationId: params.conversationId,
    turnId: params.turnId ?? null,
    assistantMessageId: params.assistantMessageId,
    toolCallId: params.toolCallId ?? `${params.toolName}-${sequence}`,
    toolName: params.toolName,
    sequence,
    createdAt: new Date().toISOString(),
    files: params.files,
  };
};
