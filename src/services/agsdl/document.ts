import { parse, run, stringify } from "../../vendor/agsdl/browser-reader.mjs";
import type { AgsdlChange, AgsdlReport } from "../../types/agsdl";

export const AGSDL_CONTRACT = "agsdl-0.1.0";
export const MAX_AGSDL_BYTES = 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
export const decodeSource = (bytes: ArrayBuffer): string =>
  decoder.decode(bytes);
export const pointerPart = (part: string | number): string =>
  String(part).replaceAll("~", "~0").replaceAll("/", "~1");
export const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
export const list = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];
export const text = (value: unknown): string =>
  typeof value === "string" ? value : "";
export const keyId = (value: unknown): string => {
  const key = object(value);
  return JSON.stringify([key.scope, key.id, key.version]);
};

export function scanSource(source: string) {
  const bytes = encoder.encode(source);
  if (bytes.length > MAX_AGSDL_BYTES)
    throw new Error("AgSDL document exceeds the 1 MiB editor limit.");
  const parsed = parse(bytes);
  if (parsed.error)
    throw new Error(
      `Invalid JSON at byte ${parsed.error.byte}. Duplicate keys are not accepted.`,
    );
  return parsed;
}

export function readDocument(source: string): Record<string, unknown> {
  scanSource(source);
  const doc: unknown = JSON.parse(source);
  if (doc === null || typeof doc !== "object" || Array.isArray(doc))
    throw new Error("An AgSDL document must be a JSON object.");
  return doc as Record<string, unknown>;
}

export function sourceAt(source: string, path: string): string {
  const parsed = scanSource(source);
  const span = parsed.spans.get(path);
  if (!span) throw new Error(`JSON pointer does not exist: ${path}`);
  return decoder.decode(parsed.bytes.subarray(span.start, span.end));
}

function decodePointer(path: string): string[] {
  if (path === "") return [];
  if (!path.startsWith("/") || /~(?![01])/u.test(path))
    throw new Error("Invalid JSON pointer.");
  const parts = path
    .slice(1)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
  if (
    parts.some((part) =>
      ["__proto__", "constructor", "prototype"].includes(part),
    )
  )
    throw new Error("This JSON pointer is not editable.");
  return parts;
}

/** Apply one atomic batch. Existing values are replaced at their exact byte spans. */
export function applyChanges(source: string, changes: AgsdlChange[]): string {
  if (readDocument(source).contract !== AGSDL_CONTRACT)
    throw new Error(
      "Structured editing requires AgSDL 0.1.0. The original source can still be exported.",
    );
  if (changes.length === 0 || changes.length > 100)
    throw new Error("Supply between 1 and 100 changes.");
  let candidate = source;
  for (const change of changes) {
    if (change.op !== "set" && change.op !== "remove")
      throw new Error("Unknown AgSDL edit operation.");
    const parts = decodePointer(change.path);
    const parsed = scanSource(candidate);
    const replacement =
      change.op === "set" ? scanSource(change.valueJson ?? "").tree : undefined;
    const span = parsed.spans.get(change.path);
    if (change.op === "set" && span) {
      candidate =
        decoder.decode(parsed.bytes.subarray(0, span.start)) +
        change.valueJson +
        decoder.decode(parsed.bytes.subarray(span.end));
      continue;
    }
    if (parts.length === 0)
      throw new Error("The document root cannot be removed.");
    const field = parts.pop()!;
    const parentPath = parts.length
      ? "/" + parts.map(pointerPart).join("/")
      : "";
    const parentSpan = parsed.spans.get(parentPath);
    let parent = parsed.tree;
    for (const part of parts) {
      if (
        parent === null ||
        typeof parent !== "object" ||
        !Object.hasOwn(parent, part)
      )
        throw new Error(`JSON pointer does not exist: ${parentPath}`);
      parent = (parent as Record<string, unknown>)[part];
    }
    if (
      !parentSpan ||
      parent === null ||
      typeof parent !== "object" ||
      (!Array.isArray(parent) && Object.getPrototypeOf(parent) !== null)
    )
      throw new Error("Edit parent must be a JSON object or array.");
    if (Array.isArray(parent)) {
      if (field === "-" && change.op === "set") parent.push(replacement);
      else {
        if (!/^(0|[1-9]\d*)$/.test(field) || Number(field) >= parent.length)
          throw new Error("Array index is outside the document.");
        if (change.op === "remove") parent.splice(Number(field), 1);
        else parent[Number(field)] = replacement;
      }
    } else {
      const record = parent as Record<string, unknown>;
      if (change.op === "remove") {
        if (!Object.hasOwn(record, field))
          throw new Error(`JSON pointer does not exist: ${change.path}`);
        delete record[field];
      } else record[field] = replacement;
    }
    candidate =
      decoder.decode(parsed.bytes.subarray(0, parentSpan.start)) +
      stringify(parent) +
      decoder.decode(parsed.bytes.subarray(parentSpan.end));
  }
  readDocument(candidate);
  return candidate;
}

export async function validateDocument(
  source: string,
  annexes: Record<string, string> = {},
): Promise<AgsdlReport[]> {
  const primary = encoder.encode(source);
  const annexBytes = Object.fromEntries(
    Object.entries(annexes).map(([id, value]) => [id, encoder.encode(value)]),
  );
  if (
    primary.length +
      Object.values(annexBytes).reduce((sum, bytes) => sum + bytes.length, 0) >
    MAX_AGSDL_BYTES
  )
    throw new Error("AgSDL inputs exceed the 1 MiB editor limit.");
  const operations = ["validateD", "validateG", "validateR", "resolveG"];
  return Promise.all(
    operations.map(async (operation) => {
      const result = await run({ operation, primary, annexes: annexBytes });
      // This is the vendored reader's report boundary, not a user-supplied object.
      return JSON.parse(stringify(result.report)) as AgsdlReport;
    }),
  );
}
