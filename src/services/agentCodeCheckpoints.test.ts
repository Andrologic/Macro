import { describe, expect, it, mock } from "bun:test";
import type { AgentCodeCheckpoint, ChatMessage } from "../types";
import {
  buildAgentCodeReplayPreview,
  buildAgentCodeReplayRollbackPreview,
} from "./agentCodeCheckpoints";

const message = (
  id: string,
  role: "user" | "assistant",
  timestamp: string,
): ChatMessage => ({
  id,
  role,
  content: id,
  conversation_id: "conv-1",
  task_id: "",
  timestamp,
});

const checkpoint = (
  sequence: number,
  assistantMessageId: string,
  path: string,
  beforeExists: boolean,
  afterExists: boolean,
): AgentCodeCheckpoint => ({
  id: `checkpoint-${sequence}`,
  conversationId: "conv-1",
  assistantMessageId,
  toolCallId: `call-${sequence}`,
  toolName: "write",
  sequence,
  createdAt: `2026-05-11T10:00:0${sequence}.000Z`,
  files: [
    {
      path,
      realPath: `/repo/${path}`,
      status: !beforeExists ? "created" : !afterExists ? "deleted" : "modified",
      before: {
        exists: beforeExists,
        content: beforeExists ? `before-${sequence}` : null,
      },
      after: {
        exists: afterExists,
        content: afterExists ? `after-${sequence}` : null,
      },
    },
  ],
});

describe("agentCodeCheckpoints", () => {
  it("lists created untracked files for deletion when replaying before them", () => {
    const messages = [
      message("user-1", "user", "2026-05-11T10:00:00.000Z"),
      message("assistant-1", "assistant", "2026-05-11T10:00:01.000Z"),
    ];

    const preview = buildAgentCodeReplayPreview("conv-1", "user-1", messages, [
      checkpoint(1, "assistant-1", "src/new.ts", false, true),
    ]);

    expect(preview.affectedFiles).toEqual([
      expect.objectContaining({
        path: "src/new.ts",
        action: "delete",
        status: "created",
        target: expect.objectContaining({ exists: false, content: null }),
        expectedCurrent: expect.objectContaining({ exists: true, content: "after-1" }),
      }),
    ]);
  });

  it("keeps prior checkpoints and reverts only later agent edits", () => {
    const messages = [
      message("user-1", "user", "2026-05-11T10:00:00.000Z"),
      message("assistant-1", "assistant", "2026-05-11T10:00:01.000Z"),
      message("user-2", "user", "2026-05-11T10:00:02.000Z"),
      message("assistant-2", "assistant", "2026-05-11T10:00:03.000Z"),
    ];

    const preview = buildAgentCodeReplayPreview("conv-1", "user-2", messages, [
      checkpoint(1, "assistant-1", "src/file.ts", true, true),
      checkpoint(2, "assistant-2", "src/file.ts", true, true),
    ]);

    expect(preview.targetCheckpointId).toBe("checkpoint-1");
    expect(preview.affectedFiles).toEqual([
      expect.objectContaining({
        path: "src/file.ts",
        action: "modify",
        status: "modified",
        target: expect.objectContaining({ exists: true, content: "after-1" }),
        expectedCurrent: expect.objectContaining({ exists: true, content: "after-2" }),
      }),
    ]);
  });

  it("marks files deleted after the replay target for restoration", () => {
    const messages = [
      message("user-1", "user", "2026-05-11T10:00:00.000Z"),
      message("assistant-1", "assistant", "2026-05-11T10:00:01.000Z"),
    ];

    const preview = buildAgentCodeReplayPreview("conv-1", "user-1", messages, [
      checkpoint(1, "assistant-1", "src/removed.ts", true, false),
    ]);

    expect(preview.affectedFiles).toEqual([
      expect.objectContaining({
        path: "src/removed.ts",
        action: "restore",
        status: "deleted",
        target: expect.objectContaining({ exists: true, content: "before-1" }),
      }),
    ]);
  });

  it("builds a durable inverse preview from the confirmed current snapshots", () => {
    const rollback = buildAgentCodeReplayRollbackPreview({
      conversationId: "conv-1",
      messageId: "user-1",
      targetCheckpointId: null,
      affectedFiles: [
        {
          path: "src/file.ts",
          realPath: "/repo/src/file.ts",
          action: "modify",
          status: "modified",
          target: {
            exists: true,
            content: "rewound",
            revision: "rewound-revision",
          },
          current: {
            exists: true,
            content: "original",
            revision: "original-revision",
          },
        },
      ],
    });

    expect(rollback.affectedFiles).toEqual([
      expect.objectContaining({
        target: expect.objectContaining({
          content: "original",
          revision: "original-revision",
        }),
        expectedCurrent: expect.objectContaining({
          content: "rewound",
          revision: "rewound-revision",
        }),
        allowOutsideWorkspace: false,
      }),
    ]);
  });

  it("ignores a legacy outside-workspace flag when restoring a checkpoint", async () => {
    const reads: Array<Record<string, unknown>> = [];
    const writes: Array<Record<string, unknown>> = [];
    mock.module("./tauriIpc", () => ({
      isTauriAvailable: () => true,
      fsExists: async () => true,
      fsReadFileWithOptions: async (params: Record<string, unknown>) => {
        reads.push(params);
        return {
          content: "after",
          revision: "after-revision",
          is_binary: false,
          size: 5,
          encoding: "utf-8",
          language: "text",
        };
      },
      fsWriteFile: async (params: Record<string, unknown>) => {
        writes.push(params);
        return {
          path: params.path,
          bytes_written: 6,
          created: false,
          revision: "before-revision",
        };
      },
      fsDelete: async () => undefined,
    }));
    const modulePath = "./agentCodeCheckpoints.ts?confined-restore-test";
    const module = await import(/* @vite-ignore */ modulePath);

    await module.restoreAgentCodeReplayPreview({
      conversationId: "conv-1",
      messageId: "user-1",
      targetCheckpointId: null,
      affectedFiles: [
        {
          path: "src/file.ts",
          realPath: "/repo/src/file.ts",
          action: "modify",
          status: "modified",
          workspacePath: "/repo",
          allowOutsideWorkspace: true,
          target: {
            exists: true,
            content: "before",
            revision: "before-revision",
          },
          expectedCurrent: {
            exists: true,
            content: "after",
            revision: "after-revision",
          },
        },
      ],
    });

    expect(reads).toEqual([
      expect.objectContaining({
        path: "/repo/src/file.ts",
        allowOutsideWorkspace: false,
        workspacePath: "/repo",
      }),
    ]);
    expect(writes).toEqual([
      expect.objectContaining({
        path: "/repo/src/file.ts",
        allowOutsideWorkspace: false,
        workspacePath: "/repo",
        expectedRevision: "after-revision",
      }),
    ]);
    mock.restore();
  });

  it("recovers only files still matching the rewound snapshot after a restart", async () => {
    const writes: Array<Record<string, unknown>> = [];
    mock.module("./tauriIpc", () => ({
      isTauriAvailable: () => true,
      fsExists: async () => true,
      fsReadFileWithOptions: async (params: { path: string }) => {
        const alreadyRecovered = params.path.endsWith("already.ts");
        return {
          content: alreadyRecovered ? "original" : "rewound",
          revision: alreadyRecovered ? "original-revision" : "rewound-revision",
          is_binary: false,
          size: 8,
          encoding: "utf-8",
          language: "text",
        };
      },
      fsWriteFile: async (params: Record<string, unknown>) => {
        writes.push(params);
        return {
          path: params.path,
          bytes_written: 8,
          created: false,
          revision: "original-revision",
        };
      },
      fsDelete: async () => undefined,
    }));
    const modulePath = "./agentCodeCheckpoints.ts?durable-recovery-test";
    const module = await import(/* @vite-ignore */ modulePath);
    const file = (path: string) => ({
      path,
      realPath: `/repo/${path}`,
      action: "modify" as const,
      status: "modified" as const,
      target: {
        exists: true,
        content: "original",
        revision: "original-revision",
      },
      expectedCurrent: {
        exists: true,
        content: "rewound",
        revision: "rewound-revision",
      },
    });

    await module.recoverAgentCodeReplayPreview({
      conversationId: "conv-1",
      messageId: "user-1",
      targetCheckpointId: null,
      affectedFiles: [file("already.ts"), file("pending.ts")],
    });

    expect(writes).toEqual([
      expect.objectContaining({
        path: "/repo/pending.ts",
        content: "original",
        expectedRevision: "rewound-revision",
      }),
    ]);
    mock.restore();
  });
});
