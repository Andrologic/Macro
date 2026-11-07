// SPDX-License-Identifier: Apache-2.0
// Port of AgSDL v0.3.0 schemacheck.py JSON value helpers. See LICENSE.
import { NumberToken } from '../v0.2/json.mjs';

export const isNumber = (value) => value instanceof NumberToken ||
  (typeof value === 'number' && Number.isFinite(value));
export const isObject = (value) => value !== null && typeof value === 'object' &&
  !Array.isArray(value) && !(value instanceof NumberToken);

// JavaScript strings may contain unpaired UTF-16 surrogates, which AgSDL JSON forbids.
function hasUnpairedSurrogate(text) {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = text.charCodeAt(++i);
      if (!(low >= 0xdc00 && low <= 0xdfff)) return true;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return true;
  }
  return false;
}

// Only internal JS numbers are stringified here. Author lexemes stay decimal.
function decimal(value) {
  const raw = value instanceof NumberToken ? value.raw :
    typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
  const match = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/.exec(raw);
  if (!match || match[0] !== raw) throw new TypeError('Expected a finite JSON number');
  let digits = (match[2] + (match[3] || '')).replace(/^0+/, '');
  if (!digits) return { sign: 0, digits: '0', power: 0n };
  const trimmed = digits.replace(/0+$/, '');
  const power = BigInt(match[4] || '0') - BigInt((match[3] || '').length) +
    BigInt(digits.length - trimmed.length);
  digits = trimmed;
  return { sign: match[1] ? -1 : 1, digits, power };
}

export function compareNumbers(left, right) {
  const a = decimal(left), b = decimal(right);
  if (a.sign !== b.sign) return a.sign < b.sign ? -1 : 1;
  if (!a.sign) return 0;
  const orderA = BigInt(a.digits.length) + a.power;
  const orderB = BigInt(b.digits.length) + b.power;
  if (orderA !== orderB) return (orderA < orderB ? -1 : 1) * a.sign;
  // Equal orders require at most the supplied coefficient lengths, never 10**power.
  for (let i = 0; i < Math.max(a.digits.length, b.digits.length); i++) {
    const x = a.digits[i] || '0', y = b.digits[i] || '0';
    if (x !== y) return (x < y ? -1 : 1) * a.sign;
  }
  return 0;
}

export function isInteger(value) {
  if (!isNumber(value)) return false;
  const n = decimal(value);
  return n.sign === 0 || n.power >= 0n;
}

export function json_type_matches(value, name) {
  switch (name) {
    case 'null': return value === null;
    case 'boolean': return typeof value === 'boolean';
    case 'number': return isNumber(value);
    case 'integer': return isInteger(value);
    case 'string': return typeof value === 'string';
    case 'array': return Array.isArray(value);
    case 'object': return isObject(value);
    default: return false;
  }
}

export function equal(left, right) {
  const pending = [[left, right]];
  while (pending.length) {
    const [a, b] = pending.pop();
    if (isNumber(a) && isNumber(b)) {
      if (compareNumbers(a, b)) return false;
    } else if (a === b) continue;
    else if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) pending.push([a[i], b[i]]);
    } else if (isObject(a) && isObject(b)) {
      const keys = Object.keys(a);
      if (keys.length !== Object.keys(b).length) return false;
      for (const key of keys) {
        if (!Object.hasOwn(b, key)) return false;
        pending.push([a[key], b[key]]);
      }
    } else return false;
  }
  return true;
}

// Iterative serialization also supports the internal numeric fields in reports.
// Inputs must be acyclic JSON values; unsupported JS values fail explicitly.
export function stringify(value) {
  const output = [], active = new Set(), pending = [{ value }];
  while (pending.length) {
    const task = pending.pop();
    if ('text' in task) { output.push(task.text); continue; }
    if ('leave' in task) { active.delete(task.leave); continue; }
    const v = task.value;
    if (v instanceof NumberToken) { decimal(v); output.push(v.raw); }
    else if (typeof v === 'string') {
      if (hasUnpairedSurrogate(v)) throw new TypeError('Invalid JSON: unpaired UTF-16 surrogate');
      output.push(JSON.stringify(v));
    } else if (v === null || typeof v === 'boolean' ||
      (typeof v === 'number' && Number.isFinite(v))) output.push(JSON.stringify(v));
    else if (Array.isArray(v) || isObject(v)) {
      if (active.has(v)) throw new TypeError('Cannot stringify cyclic JSON');
      active.add(v);
      const array = Array.isArray(v), keys = Object.keys(v);
      output.push(array ? '[' : '{');
      pending.push({ leave: v }, { text: array ? ']' : '}' });
      // Array holes are not JSON values either.
      if (array && keys.length !== v.length) throw new TypeError('Expected a JSON array');
      for (let i = keys.length - 1; i >= 0; i--) {
        const key = keys[i];
        pending.push({ value: v[key] });
        if (!array) {
          if (hasUnpairedSurrogate(key)) throw new TypeError('Invalid JSON: unpaired UTF-16 surrogate');
          pending.push({ text: `${JSON.stringify(key)}:` });
        }
        if (i) pending.push({ text: ',' });
      }
    } else throw new TypeError('Expected a JSON value');
  }
  return output.join('');
}
