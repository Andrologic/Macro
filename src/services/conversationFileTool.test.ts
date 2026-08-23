import { describe, expect, it } from "bun:test";
import { formatConversationFilePage } from "./conversationFileTool";

describe("conversationFileTool", () => {
  it("returns bounded resumable pages for conversation files", () => {
    const content = Array.from({ length: 620 }, (_, index) => `line ${index + 1}`).join("\n");
    const first = formatConversationFilePage({
      label: "notes.md",
      source: "CONTEXT_SNIPPET",
      content,
      args: { max_lines: 500 },
    });
    const cursor = first.match(/^NEXT_CURSOR: (.+)$/m)?.[1];

    expect(first).toContain("LINES: 1-500");
    expect(first).toContain("TRUNCATED: true");
    expect(cursor).toBeTruthy();

    const second = formatConversationFilePage({
      label: "notes.md",
      source: "CONTEXT_SNIPPET",
      content,
      args: { cursor },
    });
    expect(second).toContain("LINES: 501-620");
    expect(second).toContain("TRUNCATED: false");
    expect(second).toContain("501: line 501");
  });

  it("invalidates a cursor when attached content changes", () => {
    const first = formatConversationFilePage({
      label: "notes.md",
      source: "CONTEXT_SNIPPET",
      content: "one\ntwo\nthree",
      args: { max_lines: 1 },
    });
    const cursor = first.match(/^NEXT_CURSOR: (.+)$/m)?.[1];

    expect(() =>
      formatConversationFilePage({
        label: "notes.md",
        source: "CONTEXT_SNIPPET",
        content: "changed\ntwo\nthree",
        args: { cursor },
      }),
    ).toThrow("does not belong");
  });

  it("recovers an oversized single line through raw byte pages", () => {
    const content = `head-${"x".repeat(4_000)}-tail`;
    const first = formatConversationFilePage({
      label: "tool-output.txt",
      source: "CONTEXT_SNIPPET",
      content,
      args: { raw: true, max_bytes: 1_000 },
    });
    const cursor = first.match(/^NEXT_CURSOR: (.+)$/m)?.[1];
    const rawFirst = first.match(
      /---BEGIN RAW CONTENT---\n([\s\S]*)\n---END RAW CONTENT---/,
    )?.[1];
    const second = formatConversationFilePage({
      label: "tool-output.txt",
      source: "CONTEXT_SNIPPET",
      content,
      args: { raw: true, max_bytes: 256_000, cursor },
    });
    const rawSecond = second.match(
      /---BEGIN RAW CONTENT---\n([\s\S]*)\n---END RAW CONTENT---/,
    )?.[1];

    expect(rawFirst! + rawSecond!).toBe(content);
    expect(second).toContain("TRUNCATED: false");
  });
});
