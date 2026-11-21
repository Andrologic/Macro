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

// Shared measurement only: no parsing, canonical grammar or runtime ports.
type JsonAssertion = (value: unknown, status?: number) => asserts value;
const checked: JsonAssertion = (value, status = 8) => { if (!value) throw Error(status === 1 ? 'resource_limit' : 'invalid_portable_shape'); };
const safe = (n: number): number => { checked(Number.isSafeInteger(n) && n >= 0, 1); return n; };
const sum = (...n: number[]) => safe(n.reduce((a, b) => a + safe(b), 0));
const mul = (n: number, factor: number) => safe(safe(n) * safe(factor));

/** Counts JSON.stringify output without materializing it. Callers own input and
 * traversal scratch. Private controls retain their existing strict depth/number
 * policy; shared normalization adds no such semantic limit. */
export function measurePortableJson(value: unknown, ensure: JsonAssertion = checked, strict = false): { nodes: number; units: number; jsonBytes: number; jsonChars: number; textBytes: number } {
  let nodes = 0, units = 0, textBytes = 0;
  const ancestors = new Set<object>();
  const text = (s: string) => {
    units = sum(units, mul(s.length, 2));
    let bytes = 2, chars = 2, raw = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      raw += c < 128 ? 1 : c < 2048 ? 2 : 3;
      if (c === 34 || c === 92 || [8, 9, 10, 12, 13].includes(c)) { bytes += 2; chars += 2; }
      else if (c < 32) { bytes += 6; chars += 6; }
      else if (c >= 0xd800 && c <= 0xdbff) {
        const low = s.charCodeAt(i + 1);
        if (low >= 0xdc00 && low <= 0xdfff) { i++; bytes += 4; chars += 2; raw++; }
        else { if (strict) ensure(false); bytes += 6; chars += 6; }
      } else if (c >= 0xdc00 && c <= 0xdfff) { if (strict) ensure(false); bytes += 6; chars += 6; }
      else { bytes += c < 128 ? 1 : c < 2048 ? 2 : 3; chars++; }
    }
    textBytes = sum(textBytes, raw);
    return { bytes: safe(bytes), chars: safe(chars) };
  };
  const visit = (item: unknown, depth: number): { bytes: number; chars: number } => {
    if (strict) ensure(depth <= 32);
    nodes = sum(nodes, 1); units = sum(units, 256);
    if (typeof item === 'string') return text(item);
    if (item === null || typeof item === 'boolean' || typeof item === 'number') {
      if (strict) ensure(typeof item !== 'number' || Number.isFinite(item));
      const rendered = JSON.stringify(item); return { bytes: rendered.length, chars: rendered.length };
    }
    ensure(item && typeof item === 'object' && !ancestors.has(item));
    const array = Array.isArray(item), prototype = Object.getPrototypeOf(item);
    ensure(array ? prototype === Array.prototype : prototype === Object.prototype || prototype === null);
    ancestors.add(item);
    const names = Reflect.ownKeys(item); let bytes = 2, chars = 2, count = 0;
    ensure(!array || names.length === item.length + 1 && names.at(-1) === 'length');
    for (const name of names) {
      if (array && name === 'length') continue;
      ensure(typeof name === 'string' && (!array || name === String(count)));
      const descriptor = Object.getOwnPropertyDescriptor(item, name);
      ensure(descriptor?.enumerable && Object.hasOwn(descriptor, 'value'));
      if (!array && descriptor.value === undefined) continue;
      if (count++) { bytes++; chars++; }
      if (!array) { const key = text(name); bytes += key.bytes + 1; chars += key.chars + 1; }
      const child = visit(descriptor.value, depth + 1); bytes = sum(bytes, child.bytes); chars = sum(chars, child.chars);
    }
    ancestors.delete(item); return { bytes, chars };
  };
  const size = visit(value, 0); return { nodes, units, jsonBytes: size.bytes, jsonChars: size.chars, textBytes };
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
