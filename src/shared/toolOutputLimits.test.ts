import { describe, expect, it } from "bun:test";
import {
  compareToolPaths,
  createToolCursor,
  paginateReadContent,
  paginateTextBytes,
  paginateToolItems,
  parseToolCursor,
  TOOL_OUTPUT_LIMITS,
  truncateGrepLine,
  truncateUtf8Middle,
} from "./toolOutputLimits";

describe("tool output limits", () => {
  it("keeps the Rust hard limits aligned with the shared TypeScript contract", async () => {
    const rustSource = await Bun.file(
      new URL("../../src-tauri/src/commands/tool_output.rs", import.meta.url),
    ).text();
    expect(rustSource).toContain("READ_DEFAULT_MAX_LINES: usize = 500");
    expect(rustSource).toContain("READ_HARD_MAX_LINES: usize = 3_000");
    expect(rustSource).toContain("READ_MAX_BYTES: usize = 256 * 1024");
    expect(rustSource).toContain("LIST_DEFAULT_LIMIT: usize = 200");
    expect(rustSource).toContain("LIST_MAX_LIMIT: usize = 1_000");
    expect(rustSource).toContain("LIST_TIMEOUT_MILLIS: u64 = 5_000");
    expect(rustSource).toContain("READ_TIMEOUT_MILLIS: u64 = 5_000");
    expect(rustSource).toContain("GLOB_DEFAULT_LIMIT: usize = 200");
    expect(rustSource).toContain("GLOB_MAX_LIMIT: usize = 1_000");
    expect(rustSource).toContain("GLOB_TIMEOUT_MILLIS: u64 = 5_000");
    expect(rustSource).toContain("GREP_DEFAULT_LIMIT: usize = 50");
    expect(rustSource).toContain("GREP_MAX_LIMIT: usize = 200");
    expect(rustSource).toContain("GREP_TIMEOUT_MILLIS: u64 = 30_000");
    expect(rustSource).toContain("GREP_MAX_FILE_BYTES: u64 = 4 * 1024 * 1024");
    expect(rustSource).toContain("AST_DEFAULT_LIMIT: usize = 50");
    expect(rustSource).toContain("AST_MAX_LIMIT: usize = 200");
    expect(rustSource).toContain("AST_TIMEOUT_MILLIS: u64 = 30_000");
    expect(rustSource).toContain("AST_MAX_FILE_BYTES: u64 = 4 * 1024 * 1024");
    expect(rustSource).toContain("AST_MATCH_MAX_BYTES: usize = 2 * 1024");
    expect(rustSource).toContain("AST_PATTERN_MAX_BYTES: usize = 16 * 1024");
    expect(rustSource).toContain("AST_CAPTURE_MAX_BYTES: usize = 512");
    expect(rustSource).toContain("AST_CAPTURE_MAX_COUNT: usize = 32");
    expect(rustSource).toContain("AST_CAPTURE_TOTAL_MAX_BYTES: usize = 4 * 1024");
    expect(rustSource).toContain("GIT_STATUS_DEFAULT_LIMIT: usize = 200");
    expect(rustSource).toContain("GIT_STATUS_MAX_LIMIT: usize = 1_000");
    expect(rustSource).toContain("GIT_LOG_DEFAULT_LIMIT: usize = 50");
    expect(rustSource).toContain("GIT_LOG_MAX_LIMIT: usize = 200");
    expect(rustSource).toContain("GIT_DIFF_MAX_BYTES: usize = 256 * 1024");
    expect(rustSource).toContain("GIT_DIFF_MAX_CONTEXT_LINES: u32 = 64");
  });

  it("sorts paths by UTF-8 bytes for Rust and TypeScript parity", () => {
    expect(["é.ts", "z.ts", "a.ts"].sort(compareToolPaths)).toEqual([
      "a.ts",
      "z.ts",
      "é.ts",
    ]);
  });

  it("binds deterministic cursors to their request scope", () => {
    const cursor = createToolCursor("glob\0src/**/*.ts", 200);
    expect(parseToolCursor(cursor, "glob\0src/**/*.ts")).toBe(200);
    expect(() => parseToolCursor(cursor, "glob\0tests/**/*.ts")).toThrow(
      "does not belong",
    );
  });

  it("returns a resumable item page with a hard-capped limit", () => {
    const result = paginateToolItems(
      ["a", "b", "c"],
      { limit: 10_000 },
      "list\0.",
      { defaultResults: 1, maxResults: 2 },
    );
    expect(result.items).toEqual(["a", "b"]);
    expect(result.limit).toBe(2);
    expect(result.truncated).toBe(true);
    expect(parseToolCursor(result.nextCursor, "list\0.")).toBe(2);
  });

  it("paginates reads and reports column truncation", () => {
    const content = `${"x".repeat(TOOL_OUTPUT_LIMITS.read.maxColumns + 5)}\nsecond\nthird`;
    const first = paginateReadContent(
      content,
      { max_lines: 2 },
      "read\0notes.txt",
    );
    expect(first.returnedLines).toBe(2);
    expect(first.columnTruncatedLines).toBe(1);
    expect(first.truncated).toBe(true);

    const second = paginateReadContent(
      content,
      { cursor: first.nextCursor, max_lines: 2 },
      "read\0notes.txt",
    );
    expect(second.lines).toEqual(["third"]);
    expect(second.startLine).toBe(3);
    expect(second.truncated).toBe(false);
  });

  it("rejects conflicting read positions", () => {
    const cursor = createToolCursor("read\0notes.txt", 1);
    expect(() =>
      paginateReadContent(
        "one\ntwo",
        { cursor, start_line: 2 },
        "read\0notes.txt",
      ),
    ).toThrow("cannot be combined");
  });

  it("caps grep match columns", () => {
    const result = truncateGrepLine("x".repeat(1_000));
    expect(Array.from(result.text)).toHaveLength(TOOL_OUTPUT_LIMITS.grep.maxColumns);
    expect(result.truncated).toBe(true);
  });

  it("middle-truncates UTF-8 output without splitting code points", () => {
    const result = truncateUtf8Middle("début-🙂-milieu-🙂-fin", 8, 8);
    expect(result.truncated).toBe(true);
    expect(result.head).not.toContain("�");
    expect(result.tail).not.toContain("�");
    expect(result.omittedBytes).toBeGreaterThan(0);
    expect(result.retainedBytes + result.omittedBytes).toBe(result.totalBytes);
  });

  it("paginates raw UTF-8 bytes without losing a long line", () => {
    const content = `start-${"🙂".repeat(20)}-end`;
    const first = paginateTextBytes(content, { max_bytes: 17 }, "raw\0output");
    const second = paginateTextBytes(
      content,
      { max_bytes: 256, cursor: first.nextCursor },
      "raw\0output",
    );

    expect(first.content).not.toContain("�");
    expect(second.content).not.toContain("�");
    expect(first.content + second.content).toBe(content);
    expect(second.truncated).toBe(false);
  });

  it("rejects a raw byte offset inside a UTF-8 code point", () => {
    expect(() =>
      paginateTextBytes("a🙂b", { start_byte: 2 }, "raw\0output"),
    ).toThrow("not aligned to a UTF-8 code point boundary");
  });
});
