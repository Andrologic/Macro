import { Reject } from './connect-codec-framing';
import { PortableWorkBudget } from '../../src/services/ai/portableHistoryInspection';

export class TransferFailure extends Error {
  constructor(readonly status: number, readonly fatal = status === 8, readonly rejectCode: number = Reject.state) { super('connect_transfer_failed'); }
}
export const ensure: (value: unknown, status?: number, rejectCode?: number) => asserts value = (value, status = 8, rejectCode = Reject.state) => {
  if (!value) throw new TransferFailure(status, status === 8, rejectCode);
};
export const safe = (n: number): number => { ensure(Number.isSafeInteger(n) && n >= 0, 1); return n; };
export const sum = (...n: number[]): number => safe(n.reduce((a, b) => a + safe(b), 0));
export const mul = (n: number, factor: number): number => safe(safe(n) * safe(factor));
export const decimal = (n: number): string => String(safe(n));
export const integer = (value: unknown): number => {
  ensure(typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) && value.length <= 20);
  const n = BigInt(value); ensure(n <= 9_007_199_254_740_991n, 1); return Number(n);
};
export const handle = (value: unknown): string => {
  ensure(typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 18_446_744_073_709_551_615n);
  return value;
};
export function keys(value: unknown, expected: readonly string[]): void {
  ensure(value && typeof value === 'object' && !Array.isArray(value));
  const actual = Object.keys(value);
  ensure(actual.length === expected.length && expected.every(key => Object.hasOwn(value, key)));
}
export const hash = (value: unknown): void => ensure(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value));

/** Counts occurrences without stringify/encoding or cloning. Callers own its input. */
export function measureValue(value: unknown): { nodes: number; units: number; jsonBytes: number; jsonChars: number } {
  let nodes = 0, units = 0;
  const ancestors = new Set<object>();
  const text = (s: string) => {
    units = sum(units, mul(s.length, 2));
    let bytes = 2, chars = 2;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c === 34 || c === 92 || [8, 9, 10, 12, 13].includes(c)) { bytes += 2; chars += 2; }
      else if (c < 32) { bytes += 6; chars += 6; }
      else if (c >= 0xd800 && c <= 0xdbff) {
        const low = s.charCodeAt(++i); ensure(low >= 0xdc00 && low <= 0xdfff); bytes += 4; chars += 2;
      } else { ensure(c < 0xdc00 || c > 0xdfff); bytes += c < 128 ? 1 : c < 2048 ? 2 : 3; chars++; }
    }
    return { bytes: safe(bytes), chars: safe(chars) };
  };
  const visit = (item: unknown, depth: number): { bytes: number; chars: number } => {
    ensure(depth <= 32); nodes = sum(nodes, 1); units = sum(units, 256);
    if (typeof item === 'string') return text(item);
    if (item === null || typeof item === 'boolean' || typeof item === 'number') {
      ensure(typeof item !== 'number' || Number.isFinite(item));
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
  const size = visit(value, 0); return { nodes, units, jsonBytes: size.bytes, jsonChars: size.chars };
}
export const CONTROL_RESERVE = 4096 * 256 + 4096 * 8;
export const secretQuote = (bytes: number, count: number): number => sum(65_536, mul(sum(bytes, count), 4096));
export const preparationQuote = (value: unknown, members: number): number => {
  const s = measureValue(value);
  return sum(65_536, mul(s.units, 16), mul(s.jsonChars, 8), mul(members, 4096));
};
export async function withEncodedValue<T>(value: unknown, budget: PortableWorkBudget,
  consume: (bytes: Uint8Array) => Promise<T>): Promise<T> {
  const size = measureValue(value);
  const release = budget.reserve(sum(4096, size.units, mul(size.jsonChars, 2), size.jsonBytes));
  try {
    const text = JSON.stringify(value), bytes = new Uint8Array(size.jsonBytes);
    const encoded = new TextEncoder().encodeInto(text, bytes);
    ensure(encoded.read === text.length && encoded.written === bytes.length, 2);
    return await consume(bytes);
  } finally { release(); }
}
export function controlBytes(value: unknown): Uint8Array {
  const size = measureValue(value); ensure(size.jsonBytes <= 4096, 1);
  return new TextEncoder().encode(JSON.stringify(value));
}
