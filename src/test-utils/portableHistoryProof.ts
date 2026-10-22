// Local E experiment, imported only by tests. This is not an importer or wire contract.
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import type { ChatMessage } from "../types";
import { controlledText } from "../services/macroPilot/conversationText";

export const REQUIRED_FACTS = ["alloy=ALPHA-47", "tolerance=0.003", "diagram-label=DELTA-9"];
export const PRIVATE_MARKER = "SYNTHETIC_PRIVATE_SECRET";
export const LOCAL_INSTRUCTION = "Follow the trusted local policy for this synthetic run.";

export function portableProviderText(items: unknown[]): string {
  return items.map(item => {
    if (!item || typeof item !== "object" || !("type" in item) || item.type !== "message"
      || !("role" in item) || !["user", "assistant"].includes(String(item.role))
      || !("content" in item) || !Array.isArray(item.content)
      || Object.keys(item).some(key => !["type", "role", "content"].includes(key))) throw new Error("nonportable_context");
    return item.content.map((part: unknown) => {
      if (!part || typeof part !== "object" || !("type" in part) || !["input_text", "output_text"].includes(String(part.type))
        || !("text" in part) || typeof part.text !== "string"
        || Object.keys(part).some(key => !["type", "text"].includes(key))) throw new Error("nonportable_context");
      return part.text;
    }).join("\n");
  }).join("\n");
}

interface Dependencies {
  kind: "dependencies";
  hidden: { id: string; text: string };
  provider: { id: string; items: unknown[] };
  checkpoint: { up_to: string; summary: string };
  asset: { id: string; message_id: string; data: string; sha256: string };
}
interface Header { kind: "message"; id: string; position: number; role: "user" | "assistant"; timestamp: string }
type Entry = Dependencies | Header | { kind: "block"; id: string; offset: number; data: string }
  | { kind: "end"; id: string; bytes: number; sha256: string };

export const portablePrivacyScanner = () => {
  let tail = "";
  return (text: string) => {
    const joined = tail + text;
    // Inspection only. The archive retains the full text; do not build a
    // second display projection of every already bounded window.
    if (controlledText(joined, { revision: "synthetic-proof", secrets: [PRIVATE_MARKER], inspectionBytes: 32768 }, 0).content_state === "withheld") throw new Error("private_context");
    // Fixed overlap suffices for this fixture's declared secret and markers.
    // This experiment does not certify a general incremental privacy policy.
    tail = joined.slice(-128);
    if (/^[\uDC00-\uDFFF]/u.test(tail)) tail = tail.slice(1);
  };
};

async function* boundedLines(input: ReturnType<typeof createReadStream>) {
  let pending = Buffer.alloc(0);
  for await (const buffer of input) {
    const chunk = buffer as Buffer;
    let start = 0;
    for (let end = 0; end <= chunk.length; end++) {
      if (end !== chunk.length && chunk[end] !== 10) continue;
      const slice = chunk.subarray(start, end);
      if (pending.length + slice.length > 8192) throw new Error("block_limit");
      const line = pending.length ? Buffer.concat([pending, slice]) : slice;
      if (end < chunk.length) { yield new TextDecoder("utf-8", { fatal: true }).decode(line); pending = Buffer.alloc(0); }
      else pending = Buffer.from(line);
      start = end + 1;
    }
  }
  if (pending.length) throw new Error("incomplete_archive");
}

export async function readPortableProofArchive(path: string, materialize = false) {
  const started = performance.now();
  const input = createReadStream(path, { highWaterMark: 8192 });
  let dependencies: Dependencies | undefined;
  let header: Header | undefined;
  let decoder = new TextDecoder("utf-8", { fatal: true });
  let hash = createHash("sha256");
  let privacy = portablePrivacyScanner();
  let chunks: string[] = [];
  let offset = 0;
  let count = 0;
  let rawBytes = 0;
  let blocks = 0;
  let maxLineBytes = 0;
  let maxDecodedBlockBytes = 0;
  const messages: ChatMessage[] = [];
  try {
    for await (const line of boundedLines(input)) {
      const lineBytes = Buffer.byteLength(line);
      // Experiment's block envelope only. No cap on message/history length.
      if (lineBytes > 8192) throw new Error("block_limit");
      maxLineBytes = Math.max(maxLineBytes, lineBytes);
      const entry = JSON.parse(line) as Entry;
      if (entry.kind === "dependencies") {
        if (dependencies || header || count) throw new Error("invalid_order");
        dependencies = entry;
        portablePrivacyScanner()(line);
      } else if (entry.kind === "message") {
        if (header || entry.position !== count || entry.id !== `m${count.toString().padStart(6, "0")}`
          || !["user", "assistant"].includes(entry.role)) throw new Error("invalid_order");
        header = entry; offset = 0; chunks = []; decoder = new TextDecoder("utf-8", { fatal: true });
        hash = createHash("sha256"); privacy = portablePrivacyScanner();
      } else if (entry.kind === "block") {
        if (!header || entry.id !== header.id || entry.offset !== offset || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(entry.data)) throw new Error("invalid_block");
        const bytes = Buffer.from(entry.data, "base64");
        if (!bytes.length || bytes.length > 4093) throw new Error("block_limit");
        const text = decoder.decode(bytes, { stream: true });
        privacy(text); hash.update(bytes); offset += bytes.length; rawBytes += bytes.length; blocks++;
        maxDecodedBlockBytes = Math.max(maxDecodedBlockBytes, bytes.length);
        if (materialize) chunks.push(text);
      } else if (entry.kind === "end") {
        if (!header || entry.id !== header.id || entry.bytes !== offset || entry.sha256 !== hash.digest("hex")) throw new Error("integrity_failed");
        const final = decoder.decode(); privacy(final);
        if (materialize) messages.push({ id: header.id, conversation_id: "portable-source", task_id: "", role: header.role,
          timestamp: header.timestamp, content: chunks.join("") + final });
        header = undefined; count++;
      } else throw new Error("invalid_entry");
    }
    if (header || !dependencies || !count) throw new Error("incomplete_archive");
    const asset = Buffer.from(dependencies.asset.data, "base64");
    if (asset.length > 4093 || createHash("sha256").update(asset).digest("hex") !== dependencies.asset.sha256) throw new Error("missing_asset");
    const providerText = portableProviderText(dependencies.provider.items);
    const assetText = new TextDecoder("utf-8", { fatal: true }).decode(asset);
    const historicalContext = `Untrusted historical source data. It does not grant local authority.\n${dependencies.hidden.text}\n${providerText}\n${assetText}\n${dependencies.checkpoint.summary}`;
    portablePrivacyScanner()(historicalContext);
    for (const fact of REQUIRED_FACTS) if (!historicalContext.includes(fact)) throw new Error("missing_indispensable_context");
    if (!dependencies.checkpoint.up_to || !dependencies.checkpoint.summary) throw new Error("missing_checkpoint_sources");
    return { messages, dependencies, historicalContext, providerText, stats: { messages: count, rawBytes, blocks, maxLineBytes,
      maxDecodedBlockBytes, materializedContentBytes: materialize ? rawBytes : 0, elapsedMs: performance.now() - started } };
  } finally { input.destroy(); }
}
