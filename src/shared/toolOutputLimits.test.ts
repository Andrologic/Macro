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
      new URL("../../src-tauri/src/core/workspace_execution/tool_output.rs", import.meta.url),
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

  it("preserves v1 FNV64 cursor fingerprints against fixed vectors and BigInt Unicode references", () => {
    for (const [scope, fingerprint] of [
      ["", "cbf29ce484222325"], ["a", "af63dc4c8601ec8c"], ["foobar", "85944171f73967e8"],
      ["hello", "a430d84680aabd0b"], ["🔎é\uFEFF\0日本語", "036eab86680cc83d"],
      ["glob\0src/**/*.ts", "b5672fc757fde62a"],
    ]) expect(createToolCursor(scope, 17)).toBe(`v1:${fingerprint}:17`);
    const reference = (scope: string) => {
      let hash = 0xcbf29ce484222325n;
      for (const byte of new TextEncoder().encode(scope)) hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn;
      return `v1:${hash.toString(16).padStart(16, "0")}:17`;
    };
    const scopes = ["🔎é\uFEFF\0日本語", "glob\0src/**/*.ts", "\ud800", "\udfff", "\uFEFF".repeat(8192), "a".repeat(65536)];
    let seed = 0x12345678;
    const symbols = ["\0", "é", "\u0301", "🔎", "\uFEFF", "\ud800", "\udfff", "𐀀", "\r\n", "a"];
    for (let count = 0; count < 64; count += 1) {
      let scope = "";
      for (let index = 0; index < count * 8; index += 1) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        scope += symbols[seed % symbols.length];
      }
      scopes.push(scope);
    }
    for (const scope of scopes) {
      const cursor = reference(scope);
      expect(createToolCursor(scope, 17)).toBe(cursor);
      expect(parseToolCursor(cursor, scope)).toBe(17);
    }
  });

  it("preserves U+FEFF at raw page boundaries and retained truncation boundaries", () => {
    const content = "a".repeat(5) + "\uFEFF" + "b".repeat(8);
    const first = paginateTextBytes(content, { max_bytes: 5 }, "raw\0bom");
    const second = paginateTextBytes(content, { cursor: first.nextCursor, max_bytes: 3 }, "raw\0bom");
    const last = paginateTextBytes(content, { cursor: second.nextCursor }, "raw\0bom");
    expect(second.content).toBe("\uFEFF");
    expect(second.returnedBytes).toBe(new TextEncoder().encode(second.content).byteLength);
    expect(first.content + second.content + last.content).toBe(content);
    expect(paginateTextBytes("\uFEFFfirst", {}, "raw\0initial-bom").content).toBe("\uFEFFfirst");
    const truncated = truncateUtf8Middle("\uFEFFhead-discarded-middle-\uFEFFz", 3, 4);
    expect(truncated.head).toBe("\uFEFF");
    expect(truncated.tail).toBe("\uFEFFz");
    expect(truncated.retainedBytes).toBe(new TextEncoder().encode(truncated.head + truncated.tail).byteLength);
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
