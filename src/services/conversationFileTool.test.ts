import { describe, expect, it } from "bun:test";
import {
  formatConversationFilePage,
  readConversationFileBody,
} from "./conversationFileTool";

describe("conversationFileTool", () => {
  it("preserves the exact conversation file body when selecting full content", () => {
    const body = "\n  first line  \nsecond line\n\n";

    expect(readConversationFileBody({ content: body, snippet: "fallback" })).toBe(body);
    expect(readConversationFileBody({ content: null, snippet: body })).toBe(body);
    expect(readConversationFileBody({ content: " \n\t  \n ", snippet: "fallback" })).toBe(" \n\t  \n ");
    expect(readConversationFileBody({ content: "", snippet: "fallback" })).toBe("");
  });

  it("passes selected bodies unchanged through raw UTF-8 pagination", () => {
    const cases = [
      { content: " \n\t  \n ", snippet: "fallback" },
      { content: "", snippet: "fallback" },
    ];

    for (const input of cases) {
      const body = readConversationFileBody(input);
      const page = formatConversationFilePage({
        label: "notes.md",
        source: "CONTEXT_SNIPPET",
        content: body,
        args: { raw: true, max_bytes: 256_000 },
      });
      const beginMarker = "---BEGIN RAW CONTENT---\n";
      const endMarker = "\n---END RAW CONTENT---";
      const beginIndex = page.indexOf(beginMarker);
      const endIndex = page.indexOf(endMarker, beginIndex + beginMarker.length);

      expect(page).toContain(`TOTAL_BYTES: ${new TextEncoder().encode(body).byteLength}`);
      expect(beginIndex).toBeGreaterThanOrEqual(0);
      expect(endIndex).toBeGreaterThan(beginIndex);
      expect(page.slice(beginIndex + beginMarker.length, endIndex)).toBe(body);
    }
  });

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

  it("keeps raw recovery pages below the shared spill threshold", () => {
    const page = formatConversationFilePage({
      label: "tool-output.txt",
      source: "CONTEXT_SNIPPET",
      content: "x".repeat(100_000),
      args: { raw: true, max_bytes: 256_000 },
    });

    expect(page).toContain("TRUNCATED: true");
    expect(new TextEncoder().encode(page).byteLength).toBeLessThan(50 * 1024);
  });
});
