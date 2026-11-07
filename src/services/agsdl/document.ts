import { run, stringify as stringifyLegacy } from "../../vendor/agsdl/browser-reader.mjs";
import { parse, read as read030, NumberToken, stringify, ModuleError } from "../../vendor/agsdl/v0.3/reader.mjs";
import type { ExactObject, ReaderOptions030, Report030 } from "../../vendor/agsdl/v0.3/reader.mjs";
import { read as read020 } from "../../vendor/agsdl/v0.2/reader.mjs";
import { stringify as stringify020 } from "../../vendor/agsdl/v0.2/values.mjs";
import type { AgsdlChange, AgsdlReport } from "../../types/agsdl";
import { workerRequest } from "./reader030WorkerProtocol";
import type { WorkerResponse } from "./reader030WorkerProtocol";

export const AGSDL_CONTRACT = "agsdl-0.3.0";
export const AGSDL_020_CONTRACT = "agsdl-0.2.0";
export const LEGACY_AGSDL_CONTRACT = "agsdl-0.1.0";
export const isSupportedContract = (contract: unknown): boolean =>
  contract === AGSDL_CONTRACT || contract === AGSDL_020_CONTRACT || contract === LEGACY_AGSDL_CONTRACT;
export const MAX_AGSDL_BYTES = 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
export const decodeSource = (bytes: ArrayBuffer): string =>
  decoder.decode(bytes);
export const pointerPart = (part: string | number): string =>
  String(part).replaceAll("~", "~0").replaceAll("/", "~1");
export const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof NumberToken)
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

/** TextEncoder replaces lone UTF-16 surrogates; reject them before encoding. */
function encodeSource(source: string): Uint8Array {
  for (let i = 0; i < source.length; i++) {
    const unit = source.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = source.charCodeAt(++i);
      if (!(low >= 0xdc00 && low <= 0xdfff)) throw new Error("Invalid JSON: unpaired UTF-16 surrogate.");
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new Error("Invalid JSON: unpaired UTF-16 surrogate.");
    }
  }
  return encoder.encode(source);
}

export function scanSource(source: string) {
  const bytes = encodeSource(source);
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
  const parsed = scanSource(source);
  const doc: unknown = object(parsed.tree).contract === AGSDL_CONTRACT ? parsed.tree : JSON.parse(source);
  if (doc === null || typeof doc !== "object" || Array.isArray(doc))
    throw new Error("An AgSDL document must be a JSON object.");
  return doc as Record<string, unknown>;
}

/** Normative exact input, without the editor's document-size limit. */
export function readExactDocument(source: string | Uint8Array): ExactObject {
  const parsed = parse(typeof source === "string" ? encodeSource(source) : source);
  if (parsed.error) throw new Error(`Invalid JSON at byte ${parsed.error.byte}.`);
  if (parsed.tree === null || typeof parsed.tree !== "object" || Array.isArray(parsed.tree) || parsed.tree instanceof NumberToken)
    throw new Error("An AgSDL document must be a JSON object.");
  return parsed.tree as ExactObject;
}

export function validateDocumentBytes(bytes: Uint8Array, options?: ReaderOptions030): Report030 {
  return read030(bytes, options);
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
  const contract = readDocument(source).contract;
  if (!isSupportedContract(contract))
    throw new Error(
      "Structured editing requires a supported AgSDL edition. The original source can still be exported.",
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
    let parent: unknown = parsed.tree;
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
  if (readDocument(candidate).contract !== contract)
    throw new Error("An edition change requires an explicit complete document replacement.");
  return candidate;
}

export async function validateDocument(
  source: string,
  annexes: Record<string, string> = {},
  options?: ReaderOptions030,
): Promise<AgsdlReport[]> {
  let primary: Uint8Array;
  try { primary = encodeSource(source); } catch (error) {
    return [{ operation: "readDocument", scope: "parse", executionSupport: "not-assessed",
      results: [{ input: "primary", unit: "document", verdict: "fail", findings: [{
        rule: "PARSE", outcome: "fail", severity: "error", location: { pointer: "" },
        details: error instanceof Error ? error.message : "Invalid Unicode input.",
      }] }],
    }];
  }
  const annexBytes = Object.fromEntries(
    Object.entries(annexes).map(([id, value]) => [id, encoder.encode(value)]),
  );
  if (
    primary.length +
      Object.values(annexBytes).reduce((sum, bytes) => sum + bytes.length, 0) >
    MAX_AGSDL_BYTES
  )
    throw new Error("AgSDL inputs exceed the 1 MiB editor limit.");
  let contract: unknown;
  try { contract = readDocument(source).contract; } catch {
    // The official 0.2 parser supplies a scoped report for malformed byte input.
  }
  if (contract === AGSDL_CONTRACT) {
    const request = workerRequest(primary, options);
    if (typeof Worker === "undefined") throw new Error("AgSDL 0.3 validation requires Web Worker support in this host.");
    return new Promise<AgsdlReport[]>((resolve, reject) => {
      let worker: Worker;
      try { worker = new Worker(new URL("./reader030.worker.ts", import.meta.url), { type: "module" }); }
      catch (error) { reject(new Error("AgSDL 0.3 validation could not start a Web Worker.", { cause: error })); return; }
      const finish = () => { worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null; worker.terminate(); };
      worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        finish();
        if (!event.data || typeof event.data !== "object" || !("error" in event.data || "report" in event.data)) {
          reject(new Error("AgSDL 0.3 Web Worker returned an invalid message."));
        } else if ("error" in event.data) {
          const error = event.data.error;
          if (!error || typeof error !== "object" || typeof error.name !== "string" || typeof error.message !== "string") {
            reject(new Error("AgSDL 0.3 Web Worker returned an invalid error."));
          } else {
            reject(error.name === "ModuleError" ? new ModuleError(error.message) : Object.assign(new Error(error.message), { name: error.name }));
          }
        } else if (!event.data.report || typeof event.data.report !== "object" || !Array.isArray(event.data.report.results)) {
          reject(new Error("AgSDL 0.3 Web Worker returned an invalid report."));
        } else resolve([event.data.report]);
      };
      worker.onerror = (event) => { finish(); reject(new Error(`AgSDL 0.3 Web Worker failed: ${event.message}`)); };
      worker.onmessageerror = () => { finish(); reject(new Error("AgSDL 0.3 Web Worker returned an unreadable message.")); };
      try { worker.postMessage(request); } catch (error) { finish(); reject(error); }
    });
  }
  if (contract === AGSDL_020_CONTRACT || contract === undefined) {
    const report = read020(primary);
    const documentReportJson = stringify020(report);
    return [{
      operation: "readDocument",
      contract: report.contract,
      scope: report.scope,
      executionSupport: report.executionSupport,
      // Preserve the original lossless report for agent-facing evidence.
      documentReportJson,
      annexesAssessment: "not-used-by-contract",
      results: [{
        input: "primary", unit: "document", verdict: report.valid ? "pass" : "fail",
        findings: report.findings.map(finding => ({
          rule: finding.code, outcome: "fail",
          details: finding.message ?? `AgSDL 0.2.0 ${finding.code} check at ${finding.path || "document root"}.`,
          location: { pointer: finding.path },
          ...(finding.invocation === undefined ? {} : { invocation: finding.invocation }),
        })),
      }],
    }];
  }
  if (contract !== LEGACY_AGSDL_CONTRACT) return [{
    operation: "readDocument", contract,
    scope: "unsupported-contract", executionSupport: "not-assessed",
    results: [{ input: "primary", unit: "document", verdict: "fail", findings: [{
      rule: "UNSUPPORTED_CONTRACT", outcome: "fail",
      details: "This AgSDL edition is not supported. Preserve the original source.",
      location: { pointer: "/contract" },
    }] }],
  }];
  const operations = ["validateD", "validateG", "validateR", "resolveG"];
  return Promise.all(
    operations.map(async (operation) => {
      const result = await run({ operation, primary, annexes: annexBytes });
      // This is the vendored reader's report boundary, not a user-supplied object.
      return JSON.parse(stringifyLegacy(result.report)) as AgsdlReport;
    }),
  );
}
