import { describe, expect, it } from "bun:test";
import type { AgentCodeCheckpoint, ChatMessage } from "../types";
import { buildAgentCodeReplayPreview } from "./agentCodeCheckpoints";

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
});
