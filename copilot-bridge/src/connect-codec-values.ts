import { assertUnicode, utf8JsonSize } from '../../contracts/macro-pilot/v2/transfer-transit/validate.mjs';
import { BODY_BYTES, GRAPH_SLOT, Reject, requireCodec } from './connect-codec-framing';

export interface ClosedSize { nodes: number; units: number; jsonUnits: number; jsonBytes: number }
/** Counts occurrences, including aliases. It does not decode or replace the canonical parser. */
export function measureClosed(value: unknown): ClosedSize {
  const ancestors = new Set<object>();
  let nodes = 0, units = 0;
  const stringSize = (text: string) => {
    assertUnicode(text);
    const bytes = utf8JsonSize(text).json;
    let chars = 2;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      chars += c === 34 || c === 92 || [8, 9, 10, 12, 13].includes(c) ? 2 : c < 32 ? 6 : 1;
    }
    return { bytes, chars };
  };
  const visit = (item: unknown, depth: number): { bytes: number; chars: number } => {
    requireCodec(depth <= 32, Reject.limit);
    nodes++; units += 256;
    requireCodec(nodes <= GRAPH_SLOT / 256 && units <= GRAPH_SLOT, Reject.limit);
    if (typeof item === 'string') {
      units += 2 * item.length;
      requireCodec(units <= GRAPH_SLOT, Reject.limit);
      return stringSize(item);
    }
    if (item === null || typeof item === 'boolean' || typeof item === 'number') {
      requireCodec(typeof item !== 'number' || Number.isFinite(item), Reject.state);
      const text = JSON.stringify(item); return { bytes: text.length, chars: text.length };
    }
    requireCodec(item && typeof item === 'object' && !ancestors.has(item), Reject.state);
    const array = Array.isArray(item);
    requireCodec(Object.getPrototypeOf(item) === (array ? Array.prototype : Object.prototype) || !array && Object.getPrototypeOf(item) === null, Reject.state);
    ancestors.add(item);
    const keys = Reflect.ownKeys(item);
    requireCodec(array ? keys.length === item.length + 1 && keys.at(-1) === 'length' : keys.every(key => typeof key === 'string'), Reject.state);
    let bytes = 2, chars = 2, index = 0;
    for (const key of keys) {
      if (array && key === 'length') continue;
      requireCodec(typeof key === 'string' && (!array || key === String(index)), Reject.state);
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      requireCodec(descriptor?.enumerable && Object.hasOwn(descriptor, 'value'), Reject.state);
      if (index++) { bytes++; chars++; }
      if (!array) {
        units += 2 * key.length;
        requireCodec(units <= GRAPH_SLOT, Reject.limit);
        const size = stringSize(key); bytes += size.bytes + 1; chars += size.chars + 1;
      }
      const child = visit(descriptor.value, depth + 1); bytes += child.bytes; chars += child.chars;
      requireCodec(bytes <= BODY_BYTES, Reject.limit);
    }
    ancestors.delete(item);
    return { bytes, chars };
  };
  const json = visit(value, 0);
  requireCodec(json.bytes <= BODY_BYTES && units <= GRAPH_SLOT, Reject.limit);
  return { nodes, units, jsonUnits: json.chars, jsonBytes: json.bytes };
}

/** Fixed slots of the parent's already acquired 2MiB bank, not another quota. */
export class ControlBank {
  private readonly graph = new Set<string>();
  // B always belongs to the native body/result reservoir. A belongs to
  // native expectations until BEGIN phase2, then to Child validation/result.
  private readonly encoded = new Set<string>();
  private bodyPhase = false;
  private readonly page = new Set<string>();
  peakGraphSlots = 0;
  private claim(set: Set<string>, name: string, count: number, limit: number): () => void {
    requireCodec(Number.isSafeInteger(count) && count >= 0 && !set.has(`${name}:0`) && set.size + count <= limit, Reject.credit);
    for (let i = 0; i < count; i++) set.add(`${name}:${i}`);
    this.peakGraphSlots = Math.max(this.peakGraphSlots, this.graph.size);
    let live = true;
    return () => {
      requireCodec(live, Reject.credit); live = false;
      for (let i = 0; i < count; i++) requireCodec(set.delete(`${name}:${i}`), Reject.credit);
    };
  }
  graphs(name: string, count: number): () => void { return this.claim(this.graph, name, count, 8); }
  beginBody(): void {
    requireCodec(!this.bodyPhase && this.encoded.size === 0, Reject.state);
    this.bodyPhase = true;
  }
  bytes(name: 'validator-bytes' | 'result-bytes', length: number): () => void {
    requireCodec(this.bodyPhase, Reject.credit);
    requireCodec(Number.isSafeInteger(length) && length >= 0 && length <= BODY_BYTES, Reject.limit);
    return this.claim(this.encoded, name, 1, 1);
  }
  pages(name: string, count: number): () => void { return this.claim(this.page, name, count, 4); }
  empty(): boolean { return this.graph.size === 0 && this.encoded.size === 0 && this.page.size === 0; }
}
export function copyClosed(value: unknown, bank: ControlBank, name: string): { value: unknown; release(): void } {
  measureClosed(value);
  const release = bank.graphs(name, 1);
  const copy = (item: unknown): unknown => {
    if (!item || typeof item !== 'object') return item;
    if (Array.isArray(item)) return item.map(copy);
    const result = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(item)) result[key] = copy((item as Record<string, unknown>)[key]);
    return result;
  };
  try { return { value: copy(value), release }; }
  catch (error) { release(); throw error; }
}
export function closedKeys(value: unknown, keys: readonly string[]): void {
  requireCodec(value && typeof value === 'object' && !Array.isArray(value), Reject.state);
  const own = Object.keys(value);
  requireCodec(own.length === keys.length && keys.every(key => Object.hasOwn(value, key)), Reject.state);
}
export const canonical = (value: { valid: boolean }): void => { if (!value.valid) throw new CanonicalFailure(); };
export class CanonicalFailure extends Error { constructor() { super('validation_failed'); } }
