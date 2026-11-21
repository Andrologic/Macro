// Shared official scanner is a lexical dependency only. No official or candidate
// semantic implementation is imported by this reader.
// Macro browser port: schema is bundled, never fetched.
export {
  parse,
  stringify,
  NumberToken,
  pointer,
} from './json.mjs';
import { NumberToken } from './json.mjs';
export const own = (x, k) => x != null && Object.hasOwn(x, k);
export const object = (x) =>
  x !== null &&
  typeof x === 'object' &&
  !Array.isArray(x) &&
  !(x instanceof NumberToken);
export const entries = (x) => Object.entries(x ?? {});
export const clone = (x) =>
  x instanceof NumberToken
    ? new NumberToken(x.raw)
    : Array.isArray(x)
      ? x.map(clone)
      : object(x)
        ? Object.fromEntries(entries(x).map(([k, v]) => [k, clone(v)]))
        : x;
// Coefficient/exponent normalization never expands an exponent into zeros.
export function decimal(x) {
  const raw = x instanceof NumberToken ? x.raw : String(x);
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(raw);
  if (!m) throw new Error('Invalid numeric value');
  let digits = (m[2] + (m[3] ?? '')).replace(/^0+/, ''),
    exponent = BigInt(m[4] ?? 0) - BigInt((m[3] ?? '').length);
  if (!digits) return ['', '0', 0n];
  const tail = /0+$/.exec(digits)?.[0].length ?? 0;
  if (tail) {
    digits = digits.slice(0, -tail);
    exponent += BigInt(tail);
  }
  return [m[1], digits, exponent];
}
export const numeric = (x) => x instanceof NumberToken || typeof x === 'number';
export const integer = (x) => numeric(x) && decimal(x)[2] >= 0n;
export function equal(a, b) {
  if (numeric(a) || numeric(b))
    return (
      numeric(a) &&
      numeric(b) &&
      decimal(a).every((v, i) => v === decimal(b)[i])
    );
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((x, i) => equal(x, b[i]))
    );
  if (object(a) || object(b))
    return (
      object(a) &&
      object(b) &&
      Object.keys(a).length === Object.keys(b).length &&
      entries(a).every(([k, v]) => own(b, k) && equal(v, b[k]))
    );
  return a === b;
}
