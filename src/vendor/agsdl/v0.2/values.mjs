// Shared official scanner is a lexical dependency only. No official or candidate
// semantic implementation is imported by this reader.
// Macro browser port: schema is bundled, never fetched.
import schemaData from './schema.json';
export {
  parse,
  stringify,
  NumberToken,
  pointer,
} from './json.mjs';
import { NumberToken } from './json.mjs';
export const schema = schemaData;
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
export const duplicates = (xs) =>
  xs.some((x, i) => xs.slice(0, i).some((y) => equal(x, y)));
export function type(x, t) {
  return t === 'object'
    ? object(x)
    : t === 'array'
      ? Array.isArray(x)
      : t === 'integer'
        ? integer(x)
        : t === 'number'
          ? numeric(x)
          : t === 'null'
            ? x === null
            : typeof x === t;
}
export function shape(x, s = schema) {
  if (s === true) return true;
  if (s === false) return false;
  if (s.$ref) return shape(x, schema.$defs[s.$ref.split('/').at(-1)]);
  if (s.oneOf && s.oneOf.filter((v) => shape(x, v)).length !== 1) return false;
  if (s.anyOf && !s.anyOf.some((v) => shape(x, v))) return false;
  if (s.type && !type(x, s.type)) return false;
  if (own(s, 'const') && !equal(x, s.const)) return false;
  if (s.enum && !s.enum.some((v) => equal(x, v))) return false;
  if (
    typeof x === 'string' &&
    ((s.minLength !== undefined && [...x].length < s.minLength) ||
      (s.pattern && !new RegExp(s.pattern, 'u').test(x)))
  )
    return false;
  if (numeric(x) && s.minimum !== undefined) {
    const [sign, digits, exp] = decimal(x);
    if (sign || (s.minimum === 1 && digits === '0')) return false;
  }
  if (Array.isArray(x)) {
    if (x.length < (s.minItems ?? 0)) return false;
    if (!x.every((v, i) => shape(v, s.prefixItems?.[i] ?? s.items ?? true)))
      return false;
  }
  if (object(x)) {
    if (
      Object.keys(x).length < (s.minProperties ?? 0) ||
      (s.required ?? []).some((k) => !own(x, k))
    )
      return false;
    if (
      !entries(x).every(
        ([k, v]) =>
          (!s.propertyNames || shape(k, s.propertyNames)) &&
          shape(
            v,
            own(s.properties, k)
              ? s.properties[k]
              : (s.additionalProperties ?? true),
          ),
      )
    )
      return false;
  }
  return true;
}
export function satisfies(x, c, skipEnum = false) {
  if (!type(x, c.type)) return false;
  if (!skipEnum && c.enum && !c.enum.some((v) => equal(x, v))) return false;
  if (c.type === 'array' && c.items && !x.every((v) => satisfies(v, c.items)))
    return false;
  if (c.type === 'object') {
    if ((c.required ?? []).some((k) => !own(x, k))) return false;
    if (
      !entries(x).every(([k, v]) =>
        own(c.properties, k)
          ? satisfies(v, c.properties[k])
          : c.additionalProperties !== false,
      )
    )
      return false;
  }
  return true;
}
