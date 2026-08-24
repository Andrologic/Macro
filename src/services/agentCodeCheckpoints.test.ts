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
        expectedCurrent: expect.objectContaining({
          exists: true,
          content: "after-1",
        }),
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
        expectedCurrent: expect.objectContaining({
          exists: true,
          content: "after-2",
        }),
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
            unixMode: 0o755,
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
        unixMode: 0o755,
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

  it("preserves an external winner when compensating a failed multi-file restore with revisionless legacy targets", async () => {
    const disk = new Map<string, { content: string; revision: string }>([
      ["/repo/src/a.ts", { content: "after-a", revision: "after-a-rev" }],
      ["/repo/src/b.ts", { content: "after-b", revision: "after-b-rev" }],
    ]);
    const writeAttempts: Array<Record<string, unknown>> = [];
    mock.module("./tauriIpc", () => ({
      isTauriAvailable: () => true,
      fsExists: async () => true,
      fsReadFileWithOptions: async (params: { path: string }) => {
        const entry = disk.get(params.path)!;
        return {
          content: entry.content,
          revision: entry.revision,
          is_binary: false,
          size: entry.content.length,
          encoding: "utf-8",
          language: "text",
        };
      },
      fsWriteFile: async (params: {
        path: string;
        content: string;
        expectedRevision?: string;
      }) => {
        writeAttempts.push(params);
        const entry = disk.get(params.path);
        if (
          params.expectedRevision &&
          (!entry || entry.revision !== params.expectedRevision)
        ) {
          throw new Error(`revision mismatch on ${params.path}`);
        }
        if (params.path.endsWith("b.ts")) {
          throw new Error("b write failed");
        }
        const appliedRevision = "applied-a-rev";
        if (params.path.endsWith("a.ts")) {
          disk.set("/repo/src/a.ts", {
            content: "external-a",
            revision: "external-a-rev",
          });
        }
        return {
          path: params.path,
          bytes_written: params.content.length,
          created: false,
          skipped: false,
          revision: appliedRevision,
        };
      },
      fsDelete: async () => undefined,
    }));
    const modulePath = "./agentCodeCheckpoints.ts?external-winner-test";
    const module = await import(/* @vite-ignore */ modulePath);

    await expect(
      module.restoreAgentCodeReplayPreview({
        conversationId: "conv-1",
        messageId: "user-1",
        targetCheckpointId: "checkpoint-1",
        affectedFiles: [
          {
            path: "src/a.ts",
            realPath: "/repo/src/a.ts",
            action: "modify",
            status: "modified",
            target: {
              exists: true,
              content: "before-a",
              revision: null,
            },
            expectedCurrent: {
              exists: true,
              content: "after-a",
              revision: "after-a-rev",
            },
          },
          {
            path: "src/b.ts",
            realPath: "/repo/src/b.ts",
            action: "modify",
            status: "modified",
            target: {
              exists: true,
              content: "before-b",
              revision: null,
            },
            expectedCurrent: {
              exists: true,
              content: "after-b",
              revision: "after-b-rev",
            },
          },
        ],
      }),
    ).rejects.toThrow(/rollback was incomplete/);

    expect(writeAttempts).toEqual([
      expect.objectContaining({
        path: "/repo/src/a.ts",
        content: "before-a",
        expectedRevision: "after-a-rev",
      }),
      expect.objectContaining({
        path: "/repo/src/b.ts",
      }),
      expect.objectContaining({
        path: "/repo/src/a.ts",
        content: "after-a",
        expectedRevision: "applied-a-rev",
      }),
    ]);
    expect(disk.get("/repo/src/a.ts")).toEqual({
      content: "external-a",
      revision: "external-a-rev",
    });
    mock.restore();
  });

  it("refuses an unguarded compensation when the applied revision is missing", async () => {
    const disk = new Map<string, { content: string; revision: string }>([
      ["/repo/src/a.ts", { content: "after-a", revision: "after-a-rev" }],
      ["/repo/src/b.ts", { content: "after-b", revision: "after-b-rev" }],
    ]);
    const writeAttempts: Array<Record<string, unknown>> = [];
    mock.module("./tauriIpc", () => ({
      isTauriAvailable: () => true,
      fsExists: async () => true,
      fsReadFileWithOptions: async (params: { path: string }) => {
        const entry = disk.get(params.path)!;
        return {
          content: entry.content,
          revision: entry.revision,
          is_binary: false,
          size: entry.content.length,
          encoding: "utf-8",
          language: "text",
        };
      },
      fsWriteFile: async (params: {
        path: string;
        content: string;
        expectedRevision?: string;
      }) => {
        writeAttempts.push(params);
        const entry = disk.get(params.path);
        if (
          params.expectedRevision &&
          (!entry || entry.revision !== params.expectedRevision)
        ) {
          throw new Error(`revision mismatch on ${params.path}`);
        }
        if (params.path.endsWith("b.ts")) {
          throw new Error("b write failed");
        }
        disk.set(params.path, {
          content: params.content,
          revision: "opaque-restored-rev",
        });
        return {
          path: params.path,
          bytes_written: params.content.length,
          created: false,
          skipped: false,
        };
      },
      fsDelete: async () => undefined,
    }));
    const modulePath = "./agentCodeCheckpoints.ts?unguarded-compensation-test";
    const module = await import(/* @vite-ignore */ modulePath);

    await expect(
      module.restoreAgentCodeReplayPreview({
        conversationId: "conv-1",
        messageId: "user-1",
        targetCheckpointId: "checkpoint-1",
        affectedFiles: [
          {
            path: "src/a.ts",
            realPath: "/repo/src/a.ts",
            action: "modify",
            status: "modified",
            target: {
              exists: true,
              content: "before-a",
              revision: null,
            },
            expectedCurrent: {
              exists: true,
              content: "after-a",
              revision: "after-a-rev",
            },
          },
          {
            path: "src/b.ts",
            realPath: "/repo/src/b.ts",
            action: "modify",
            status: "modified",
            target: {
              exists: true,
              content: "before-b",
              revision: null,
            },
            expectedCurrent: {
              exists: true,
              content: "after-b",
              revision: "after-b-rev",
            },
          },
        ],
      }),
    ).rejects.toThrow(/refusing an unguarded rollback/);

    expect(
      writeAttempts.filter((attempt) => attempt.path === "/repo/src/a.ts"),
    ).toEqual([
      expect.objectContaining({
        path: "/repo/src/a.ts",
        content: "before-a",
        expectedRevision: "after-a-rev",
      }),
    ]);
    expect(disk.get("/repo/src/a.ts")).toEqual({
      content: "before-a",
      revision: "opaque-restored-rev",
    });
    mock.restore();
  });

  it("replays a remote checkpoint with guarded revisions and the saved Unix mode", async () => {
    const writes: Array<Record<string, unknown>> = [];
    const originalFetch = globalThis.fetch;
    const originalTransport = process.env.VITE_BACKEND_TRANSPORT;
    const originalBaseUrl = process.env.VITE_REMOTE_API_BASE_URL;
    process.env.VITE_BACKEND_TRANSPORT = "remote";
    process.env.VITE_REMOTE_API_BASE_URL = "http://127.0.0.1:8787";
    mock.module("./tauriIpc", () => ({
      isTauriAvailable: () => false,
    }));
    globalThis.fetch = mock(
      async (url: string | URL | Request, init?: RequestInit) => {
        const requestUrl = String(url);
        if (requestUrl.includes("/mode-policy")) {
          return new Response(
            JSON.stringify({
              allowed_tool_ids: ["read", "write"],
              enforce_macro_only_writes: false,
              capabilities: [
                "content_revisions_v1",
                "recoverable_checkpoints_v1",
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (requestUrl.includes("/checkpoint-snapshot")) {
          return new Response(
            JSON.stringify({
              snapshot: {
                exists: true,
                content: "after",
                revision: "after-revision",
                unixMode: 0o644,
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (requestUrl.includes("/tools/execute")) {
          writes.push(
            JSON.parse(String(init?.body)) as Record<string, unknown>,
          );
          return new Response(
            JSON.stringify({
              result: JSON.stringify({
                files: [{ validation: { revision: "restored-revision" } }],
              }),
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({}), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      },
    ) as unknown as typeof fetch;
    const modulePath = "./agentCodeCheckpoints.ts?remote-replay-test";
    const module = await import(/* @vite-ignore */ modulePath);

    await module.restoreAgentCodeReplayPreview({
      conversationId: "conv-1",
      messageId: "user-1",
      targetCheckpointId: null,
      affectedFiles: [
        {
          path: "bin/run.sh",
          realPath: "bin/run.sh",
          action: "modify",
          status: "modified",
          projectId: "project-1",
          workspacePath: "/srv/project-1",
          target: {
            exists: true,
            content: "#!/bin/sh\necho before\n",
            revision: "before-revision",
            unixMode: 0o755,
          },
          expectedCurrent: {
            exists: true,
            content: "after",
            revision: "after-revision",
            unixMode: 0o644,
          },
        },
      ],
    });

    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      mode: "Implement",
      tool_id: "write",
      args: {
        path: "bin/run.sh",
        expected_revision: "after-revision",
        unix_mode: 0o755,
      },
      focused_project_id: "project-1",
      workspace_path: "/srv/project-1",
    });
    globalThis.fetch = originalFetch;
    if (originalTransport === undefined)
      delete process.env.VITE_BACKEND_TRANSPORT;
    else process.env.VITE_BACKEND_TRANSPORT = originalTransport;
    if (originalBaseUrl === undefined)
      delete process.env.VITE_REMOTE_API_BASE_URL;
    else process.env.VITE_REMOTE_API_BASE_URL = originalBaseUrl;
    mock.restore();
  });

  it("refuses a remote replay when the file changes after prevalidation", async () => {
    const writes: Array<Record<string, unknown>> = [];
    let snapshotReads = 0;
    const originalFetch = globalThis.fetch;
    const originalTransport = process.env.VITE_BACKEND_TRANSPORT;
    const originalBaseUrl = process.env.VITE_REMOTE_API_BASE_URL;
    process.env.VITE_BACKEND_TRANSPORT = "remote";
    process.env.VITE_REMOTE_API_BASE_URL = "http://127.0.0.1:8787";
    mock.module("./tauriIpc", () => ({
      isTauriAvailable: () => false,
    }));
    globalThis.fetch = mock(
      async (url: string | URL | Request, init?: RequestInit) => {
        const requestUrl = String(url);
        if (requestUrl.includes("/mode-policy")) {
          return new Response(
            JSON.stringify({
              allowed_tool_ids: ["read", "write"],
              enforce_macro_only_writes: false,
              capabilities: [
                "content_revisions_v1",
                "recoverable_checkpoints_v1",
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (requestUrl.includes("/checkpoint-snapshot")) {
          snapshotReads += 1;
          const concurrent = snapshotReads > 1;
          return new Response(
            JSON.stringify({
              snapshot: {
                exists: true,
                content: concurrent ? "external change" : "after",
                revision: concurrent
                  ? "external-revision"
                  : "after-revision",
                unixMode: 0o644,
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (requestUrl.includes("/tools/execute")) {
          writes.push(
            JSON.parse(String(init?.body)) as Record<string, unknown>,
          );
          return new Response(JSON.stringify({ result: "{}" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({}), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      },
    ) as unknown as typeof fetch;

    try {
      const modulePath =
        "./agentCodeCheckpoints.ts?remote-replay-concurrent-change-test";
      const module = await import(/* @vite-ignore */ modulePath);
      await expect(
        module.restoreAgentCodeReplayPreview({
          conversationId: "conv-1",
          messageId: "user-1",
          targetCheckpointId: null,
          affectedFiles: [
            {
              path: "src/app.ts",
              realPath: "src/app.ts",
              action: "modify",
              status: "modified",
              projectId: "project-1",
              workspacePath: "/srv/project-1",
              target: {
                exists: true,
                content: "before",
                revision: "before-revision",
              },
              expectedCurrent: {
                exists: true,
                content: "after",
                revision: "after-revision",
                unixMode: 0o644,
              },
            },
          ],
        }),
      ).rejects.toThrow(/changed after its replay state was validated/);
      expect(snapshotReads).toBe(2);
      expect(writes).toHaveLength(0);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalTransport === undefined)
        delete process.env.VITE_BACKEND_TRANSPORT;
      else process.env.VITE_BACKEND_TRANSPORT = originalTransport;
      if (originalBaseUrl === undefined)
        delete process.env.VITE_REMOTE_API_BASE_URL;
      else process.env.VITE_REMOTE_API_BASE_URL = originalBaseUrl;
      mock.restore();
    }
  });

  it("persists a durable compaction frontier across save and reload", async () => {
    const settings = new Map<string, string>();
    const storageKey = "agentCodeCheckpoints:conv-1";
    mock.module("./tauriIpc", () => ({
      isTauriAvailable: () => true,
      dbGetAppSetting: async (key: string) => {
        const valueJson = settings.get(key);
        return valueJson === undefined ? null : { key, value_json: valueJson };
      },
      dbSetAppSetting: async ({
        key,
        valueJson,
      }: {
        key: string;
        valueJson: string;
      }) => {
        settings.set(key, valueJson);
        return { key, value_json: valueJson };
      },
      fsExists: async () => true,
      fsReadFileWithOptions: async () => {
        throw new Error("not used");
      },
      fsWriteFile: async () => {
        throw new Error("not used");
      },
      fsDelete: async () => undefined,
    }));
    const modulePath = "./agentCodeCheckpoints.ts?frontier-test";
    const module = await import(/* @vite-ignore */ modulePath);
    const messages = Array.from({ length: 201 }, (_, index) => {
      const turn = index + 1;
      return [
        message(
          `user-${turn}`,
          "user",
          `2026-05-11T10:00:${String(index).padStart(2, "0")}.000Z`,
        ),
        message(
          `assistant-${turn}`,
          "assistant",
          `2026-05-11T10:00:${String(index).padStart(2, "0")}.500Z`,
        ),
      ];
    }).flat();
    const checkpoints = Array.from({ length: 201 }, (_, index) => {
      const sequence = index + 1;
      if (sequence === 1) {
        return checkpoint(1, "assistant-1", "src/old-created.ts", false, true);
      }
      return checkpoint(
        sequence,
        `assistant-${sequence}`,
        `src/file-${sequence}.ts`,
        true,
        true,
      );
    });

    await module.saveAgentCodeCheckpoints("conv-1", checkpoints);

    const persisted = JSON.parse(settings.get(storageKey)!);
    expect(persisted.version).toBe(2);
    expect(persisted.checkpoints).toHaveLength(200);
    expect(persisted.oldestCompleteSequence).toBe(2);
    expect(persisted.checkpoints[0].sequence).toBe(2);

    const history = await module.loadAgentCodeCheckpointHistory("conv-1");
    expect(history.checkpoints).toHaveLength(200);
    expect(history.oldestCompleteSequence).toBe(2);

    expect(() =>
      module.buildAgentCodeReplayPreview(
        "conv-1",
        "user-1",
        messages,
        history.checkpoints,
        { oldestCompleteSequence: history.oldestCompleteSequence },
      ),
    ).toThrow(/no longer fully recoverable/);

    const covered = module.buildAgentCodeReplayPreview(
      "conv-1",
      "user-150",
      messages,
      history.checkpoints,
      { oldestCompleteSequence: history.oldestCompleteSequence },
    );
    expect(covered.targetCheckpointId).toBe("checkpoint-149");
    expect(covered.affectedFiles).toHaveLength(52);
    const coveredPaths = covered.affectedFiles.map(
      (file: { path: string }) => file.path,
    );
    expect(coveredPaths).toContain("src/file-150.ts");
    expect(coveredPaths).toContain("src/file-201.ts");
    expect(coveredPaths).not.toContain("src/old-created.ts");

    const appended = module.appendAgentCodeCheckpoint(
      history.checkpoints,
      checkpoint(202, "assistant-202", "src/file-202.ts", true, true),
    );
    await module.saveAgentCodeCheckpoints("conv-1", appended);
    const reloaded = await module.loadAgentCodeCheckpointHistory("conv-1");
    expect(reloaded.checkpoints).toHaveLength(200);
    expect(reloaded.oldestCompleteSequence).toBe(3);

    settings.set(storageKey, JSON.stringify(checkpoints.slice(0, 2)));
    const legacy = await module.loadAgentCodeCheckpointHistory("conv-1");
    expect(legacy.checkpoints).toHaveLength(2);
    expect(legacy.oldestCompleteSequence).toBeNull();
    mock.restore();
  });
});
