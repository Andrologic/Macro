export const TOOL_OUTPUT_LIMITS = {
  read: {
    defaultLines: 500,
    maxLines: 3_000,
    maxBytes: 256 * 1024,
    maxColumns: 2_000,
    timeoutMs: 5_000,
  },
  list: { defaultResults: 200, maxResults: 1_000, timeoutMs: 5_000 },
  glob: { defaultResults: 200, maxResults: 1_000, timeoutMs: 5_000 },
  grep: {
    defaultResults: 50,
    maxResults: 200,
    maxFileBytes: 4 * 1024 * 1024,
    maxColumns: 512,
    timeoutMs: 30_000,
  },
  git: {
    statusDefaultResults: 200,
    statusMaxResults: 1_000,
    logDefaultResults: 50,
    logMaxResults: 200,
    diffMaxBytes: 256 * 1024,
    diffMaxContextLines: 64,
  },
} as const;

export type BoundedToolName = "list" | "glob" | "grep";

export interface ToolPage {
  limit: number;
  offset: number;
}

export interface PaginatedItems<T> extends ToolPage {
  items: T[];
  truncated: boolean;
  nextCursor: string | null;
}

export interface ReadContentPage {
  lines: string[];
  startLine: number;
  endLine: number;
  totalLines: number;
  returnedLines: number;
  truncated: boolean;
  nextCursor: string | null;
  maxLines: number;
  maxBytes: number;
  columnTruncatedLines: number;
}

const CURSOR_VERSION = "v1";
const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const FNV_MASK = 0xffffffffffffffffn;

const utf8Encoder = new TextEncoder();

export const compareToolPaths = (left: string, right: string): number => {
  const leftBytes = utf8Encoder.encode(left);
  const rightBytes = utf8Encoder.encode(right);
  const sharedLength = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < sharedLength; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) {
      return leftBytes[index] < rightBytes[index] ? -1 : 1;
    }
  }
  return leftBytes.length - rightBytes.length;
};

const fingerprintScope = (scope: string): string => {
  let hash = FNV_OFFSET_BASIS;
  for (const byte of utf8Encoder.encode(scope)) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & FNV_MASK;
  }
  return hash.toString(16).padStart(16, "0");
};

export const createToolCursor = (scope: string, offset: number): string =>
  `${CURSOR_VERSION}:${fingerprintScope(scope)}:${Math.max(0, Math.floor(offset))}`;

export const parseToolCursor = (
  cursor: unknown,
  scope: string,
): number => {
  if (cursor == null || cursor === "") return 0;
  if (typeof cursor !== "string") {
    throw new Error("cursor must be a string returned by the previous tool page.");
  }

  const match = /^v1:([0-9a-f]{16}):(0|[1-9][0-9]*)$/.exec(cursor.trim());
  if (!match) {
    throw new Error("cursor is malformed or uses an unsupported version.");
  }
  if (match[1] !== fingerprintScope(scope)) {
    throw new Error("cursor does not belong to this tool request. Restart without cursor.");
  }

  const offset = Number(match[2]);
  if (!Number.isSafeInteger(offset)) {
    throw new Error("cursor offset exceeds the supported range.");
  }
  return offset;
};

export const resolveToolLimit = (
  value: unknown,
  defaultValue: number,
  maxValue: number,
): number => {
  if (value == null) return defaultValue;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error("limit must be a positive finite number.");
  }
  return Math.min(maxValue, Math.max(1, Math.floor(value)));
};

export const resolveToolPage = (
  args: Record<string, unknown>,
  scope: string,
  defaults: { defaultResults: number; maxResults: number },
): ToolPage => ({
  limit: resolveToolLimit(args.limit ?? args.max_results, defaults.defaultResults, defaults.maxResults),
  offset: parseToolCursor(args.cursor, scope),
});

export const paginateToolItems = <T>(
  items: readonly T[],
  args: Record<string, unknown>,
  scope: string,
  defaults: { defaultResults: number; maxResults: number },
): PaginatedItems<T> => {
  const page = resolveToolPage(args, scope, defaults);
  const window = items.slice(page.offset, page.offset + page.limit + 1);
  const truncated = window.length > page.limit;
  const pageItems = truncated ? window.slice(0, page.limit) : window;
  return {
    ...page,
    items: pageItems,
    truncated,
    nextCursor: truncated
      ? createToolCursor(scope, page.offset + pageItems.length)
      : null,
  };
};

const truncateColumns = (
  value: string,
  maxColumns: number,
): { value: string; truncated: boolean } => {
  const columns = Array.from(value);
  if (columns.length <= maxColumns) return { value, truncated: false };
  return {
    value: `${columns.slice(0, Math.max(1, maxColumns - 1)).join("")}…`,
    truncated: true,
  };
};

export const paginateReadContent = (
  content: string,
  args: Record<string, unknown>,
  scope: string,
): ReadContentPage => {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const allLines = normalized.split("\n");
  const totalLines = allLines.length;
  const hasCursor = args.cursor != null && args.cursor !== "";
  if (hasCursor && args.start_line != null) {
    throw new Error("cursor cannot be combined with start_line.");
  }

  const requestedStart =
    typeof args.start_line === "number" && Number.isFinite(args.start_line)
      ? Math.max(1, Math.floor(args.start_line))
      : 1;
  const offset = hasCursor
    ? parseToolCursor(args.cursor, scope)
    : requestedStart - 1;
  if (offset >= totalLines) {
    throw new Error(`read offset ${offset + 1} exceeds the file length of ${totalLines} lines.`);
  }

  const requestedEnd =
    typeof args.end_line === "number" && Number.isFinite(args.end_line)
      ? Math.max(offset + 1, Math.min(totalLines, Math.floor(args.end_line)))
      : totalLines;
  const maxLines = resolveToolLimit(
    args.max_lines,
    TOOL_OUTPUT_LIMITS.read.defaultLines,
    TOOL_OUTPUT_LIMITS.read.maxLines,
  );
  const maximumEnd = Math.min(requestedEnd, offset + maxLines);
  const lines: string[] = [];
  let outputBytes = 0;
  let columnTruncatedLines = 0;
  let nextOffset = offset;

  while (nextOffset < maximumEnd) {
    const sourceLine = allLines[nextOffset] ?? "";
    const capped = truncateColumns(sourceLine, TOOL_OUTPUT_LIMITS.read.maxColumns);
    const lineBytes = utf8Encoder.encode(capped.value).byteLength + (lines.length > 0 ? 1 : 0);
    if (lines.length > 0 && outputBytes + lineBytes > TOOL_OUTPUT_LIMITS.read.maxBytes) {
      break;
    }
    lines.push(capped.value);
    outputBytes += lineBytes;
    if (capped.truncated) columnTruncatedLines += 1;
    nextOffset += 1;
  }

  const truncated = nextOffset < requestedEnd;
  return {
    lines,
    startLine: offset + 1,
    endLine: offset + lines.length,
    totalLines,
    returnedLines: lines.length,
    truncated,
    nextCursor: truncated ? createToolCursor(scope, nextOffset) : null,
    maxLines,
    maxBytes: TOOL_OUTPUT_LIMITS.read.maxBytes,
    columnTruncatedLines,
  };
};

export const truncateGrepLine = (
  line: string,
): { text: string; truncated: boolean } => {
  const result = truncateColumns(line, TOOL_OUTPUT_LIMITS.grep.maxColumns);
  return { text: result.value, truncated: result.truncated };
};
