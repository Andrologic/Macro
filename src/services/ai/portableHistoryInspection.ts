import { assertPortableUnicode } from '../../../contracts/macro-pilot/v2/portable-chat-history/validate.mjs';
import { inspectWholeText, type TextPolicy } from '../macroPilot/conversationText';
import { parseStoredJsonStrict } from './jsonValues';

/** Declared working units, never a JS heap/RSS measurement or a product limit. */
export class PortableWorkBudget {
  used = 0;
  peak = 0;
  admissions = 0;
  constructor(readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('resource_limit');
  }
  reserve(bytes: number): () => void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || this.used + bytes > this.limit) throw new Error('resource_limit');
    this.used += bytes; this.peak = Math.max(this.peak, this.used); this.admissions++;
    let live = true;
    return () => { if (live) { live = false; this.used -= bytes; } };
  }
}

export function inspectPortableDecodedValue(value: unknown, policy: TextPolicy): void {
  assertPortableUnicode(value);
  const pending = [value];
  while (pending.length) {
    const entry = pending.pop();
    if (typeof entry === 'string') {
      if (!inspectWholeText(entry, { ...policy, inspectionBytes: new TextEncoder().encode(entry).length })) throw new Error('unsafe_content');
    } else if (entry && typeof entry === 'object') {
      for (const [key, nested] of Object.entries(entry)) {
        if (!inspectWholeText(key, { ...policy, inspectionBytes: new TextEncoder().encode(key).length })) throw new Error('unsafe_content');
        pending.push(nested);
      }
    }
  }
}

/** The consumer must finish writing/consuming its copies before returning.
 * Only control/scalars may outlive this scope; no whole field is returned. */
export async function withAdmittedPortableText(
  bytes: number,
  load: () => Promise<Uint8Array>,
  budget: PortableWorkBudget,
  json: boolean,
  consume: (text: string) => Promise<void>,
): Promise<void> {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('resource_limit');
  // Raw bytes, UTF-16, inspection encodings and derivation scratch. JSON also
  // admits a conservative per-input-byte share for nodes, keys and key sets.
  const release = budget.reserve(256 + bytes * (json ? 256 : 8));
  try {
    const raw = await load();
    if (raw.byteLength !== bytes) throw new Error('integrity_failed');
    await consume(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw));
  } finally { release(); }
}

export async function withInspectedPortableText(
  bytes: number,
  load: () => Promise<Uint8Array>,
  policy: TextPolicy,
  budget: PortableWorkBudget,
  json: boolean,
  consume: (text: string, decoded: unknown) => Promise<void>,
): Promise<void> {
  await withAdmittedPortableText(bytes, load, budget, json, async text => {
    const full = { ...policy, inspectionBytes: bytes };
    if (!inspectWholeText(text, full)) throw new Error('unsafe_content');
    const decoded = json ? parseStoredJsonStrict(text) : undefined;
    if (json) inspectPortableDecodedValue(decoded, full);
    await consume(text, decoded);
  });
}

/** ContentHost's revision can remain visible-1 while secret forms change.
 * Compare the private snapshot locally; never export an isolated secret digest. */
export function samePortablePolicy(left: TextPolicy, right: TextPolicy): boolean {
  return left.revision === right.revision && left.inspectionBytes === right.inspectionBytes &&
    left.secrets.length === right.secrets.length && left.secrets.every((value, index) => value === right.secrets[index]);
}
