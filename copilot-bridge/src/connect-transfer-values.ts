import { Reject } from './connect-codec-framing';
import { PortableWorkBudget, measurePortableJson } from '../../src/services/ai/portableHistoryInspection';

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

/** Shared exact measurement; preserve private error codes and result shape. */
export function measureValue(value: unknown): { nodes: number; units: number; jsonBytes: number; jsonChars: number } {
  try {
    const size = measurePortableJson(value, ensure, true);
    return { nodes: size.nodes, units: size.units, jsonBytes: size.jsonBytes, jsonChars: size.jsonChars };
  } catch (error) {
    if (error instanceof Error && error.message === 'resource_limit') throw new TransferFailure(1);
    throw error;
  }
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
