import { decode, decimal, fail, NumberToken } from './exact';

/** An exact JSON integer lexeme, including exponent notation. Never a JS double. */
export type Integer030 = string;

export function integer030(raw: string, positive = false): Integer030 {
  if (typeof raw !== 'string') fail('CORRELATION', '', 'Expected an exact integer lexeme.');
  const value = decode(raw);
  if (!(value instanceof NumberToken)) fail('CORRELATION', '', 'Expected an exact JSON integer.');
  const [sign, digits, exponent] = decimal(value);
  if (sign || exponent < 0n || positive && digits === '0') fail('CORRELATION', '', 'Expected a nonnegative integer, positive when required.');
  return value.raw;
}

/** Compare nonnegative exact integers without expanding their exponents. */
export function compareIntegers030(left: Integer030, right: Integer030): -1 | 0 | 1 {
  const [, a, ae] = decimal(new NumberToken(integer030(left)));
  const [, b, be] = decimal(new NumberToken(integer030(right)));
  if (a === '0' || b === '0') return a === b ? 0 : a === '0' ? -1 : 1;
  const al = BigInt(a.length) + ae, bl = BigInt(b.length) + be;
  if (al !== bl) return al < bl ? -1 : 1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const ac = a[i] ?? '0', bc = b[i] ?? '0';
    if (ac !== bc) return ac < bc ? -1 : 1;
  }
  return 0;
}

export function monotoneMs030(value: string): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) fail('CORRELATION', '', 'Expected canonical monotone milliseconds.');
  return BigInt(value);
}

/** Convert only after proving the integer fits an already materialized bound. */
export function boundedInteger030(value: Integer030, bound: bigint): bigint {
  if (compareIntegers030(value, bound.toString()) > 0) fail('CORRELATION', '', 'Exact integer exceeds the supplied bound.');
  const [, digits, exponent] = decimal(new NumberToken(integer030(value)));
  if (digits === '0') return 0n;
  return BigInt(digits) * 10n ** exponent;
}

export function timerDelay030(limit: Integer030 | null, elapsed: bigint, maxSliceMs = 2_147_483_647): number | null {
  if (!Number.isSafeInteger(maxSliceMs) || maxSliceMs < 1 || maxSliceMs > 2_147_483_647) fail('CORRELATION', '', 'Invalid timer slice.');
  if (limit === null) return null;
  if (compareIntegers030(limit, elapsed.toString()) <= 0) return 0;
  const bound = elapsed + BigInt(maxSliceMs);
  if (compareIntegers030(limit, bound.toString()) > 0) return maxSliceMs;
  return Number(boundedInteger030(limit, bound) - elapsed);
}
