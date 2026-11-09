import { NumberToken, parse, stringify, type ExactValue } from '../../src/vendor/agsdl/v0.3/json.mjs';
import { compareNumbers, isInteger, isObject } from '../../src/vendor/agsdl/v0.3/values.mjs';

/** Normalized durable observations. Messages and joins retain delivery/decision order.
 * This transport comparator covers the published 0.3 scenarios; message nth+item
 * and join nth have no defined selection rule and return UNSUPPORTED_SELECTION.
 * It does not validate or execute an AgSDL run.
 */
export interface ObservedRun030 {
  run: 'succeeded' | 'failed';
  starts: Record<string, number>;
  messages: Array<{ to: string; item?: number; prompt?: string | null; resources?: Record<string, unknown>; element?: unknown; comments?: Array<{ step: string; comment: string }> }>;
  joins: Array<{ join: string; outcome: 'done' | 'incomplete' | 'reached' | 'missed'; branches?: Record<string, unknown> }>;
  failures: Array<{ step: string; item?: number; code: string }>;
  cancelled: Array<{ step: string; item?: number }>;
  answers: Array<{ work: string; item?: number; answer: 'no' }>;
}

export interface Diagnostic {
  code: 'INVALID_JSON' | 'INVALID_EXPECTED' | 'INVALID_OBSERVED' | 'MISMATCH' | 'MISSING' | 'AMBIGUOUS' | 'UNSUPPORTED_SELECTION';
  path: string;
  message: string;
  expected?: string;
  observed?: string;
}

type Obj = Record<string, ExactValue>;
const own = (o: Obj, key: string) => Object.hasOwn(o, key);
const object = (v: unknown): v is Obj => isObject(v);
const integer = (v: unknown, min: number) => v instanceof NumberToken && isInteger(v) && compareNumbers(v, min) >= 0;
const text = (v: unknown) => typeof v === 'string' && v.length > 0;
const hasKeys = (o: Obj, keys: string[]) => keys.every((k) => own(o, k));
const onlyKeys = (o: Obj, keys: string[]) => Object.keys(o).every((k) => keys.includes(k));
const isComments = (v: ExactValue) => Array.isArray(v) && v.every((x) => object(x) && text(x.step) && text(x.comment));
const optItem = (o: Obj) => !own(o, 'item') || integer(o.item, 0);
const optNth = (o: Obj) => !own(o, 'nth') || (integer(o.nth, 1) && Number.isSafeInteger(Number((o.nth as NumberToken).raw)));
const validMessage = (o: Obj, expected: boolean) => text(o.to) && optItem(o) && (!expected || optNth(o)) &&
  (!own(o, 'prompt') || o.prompt === null || typeof o.prompt === 'string') &&
  (!own(o, 'resources') || object(o.resources)) && (!own(o, 'comments') || isComments(o.comments)) &&
  (!expected || onlyKeys(o, ['to', 'item', 'nth', 'prompt', 'resources', 'element', 'comments']));
const outcomes = ['done', 'incomplete', 'reached', 'missed'];
const validJoin = (o: Obj, expected: boolean) => text(o.join) && typeof o.outcome === 'string' && outcomes.includes(o.outcome) &&
  (!expected || optNth(o)) && (!own(o, 'branches') || object(o.branches)) &&
  (!expected || onlyKeys(o, ['join', 'nth', 'outcome', 'branches']));
const validEntry = (o: Obj, key: string, expected: boolean) => {
  const keys = key === 'failures' ? ['step', 'item', 'code'] : key === 'cancelled' ? ['step', 'item'] : ['work', 'item', 'answer'];
  return optItem(o) && (!expected || onlyKeys(o, keys)) && (key === 'answers'
    ? text(o.work) && o.answer === 'no'
    : text(o.step) && (key !== 'failures' || text(o.code)));
};
const fields = ['run', 'starts', 'messages', 'joins', 'failures', 'cancelled', 'answers'];
function validRoot(v: ExactValue, expected: boolean): v is Obj {
  if (!object(v) || (expected && !onlyKeys(v, fields)) || !hasKeys(v, expected ? ['run'] : fields) ||
    (v.run !== 'succeeded' && v.run !== 'failed')) return false;
  if (own(v, 'starts') && (!object(v.starts) || !Object.entries(v.starts).every(([k, n]) => text(k) && integer(n, expected ? 1 : 0)))) return false;
  for (const key of fields.slice(2)) {
    if (!own(v, key)) continue;
    const entries = v[key];
    if (!Array.isArray(entries) || !entries.every((x) => object(x) && (key === 'messages' ? validMessage(x, expected) : key === 'joins' ? validJoin(x, expected) : validEntry(x, key, expected)))) return false;
  }
  return true;
}
const pathKey = (path: string, key: string | number) => `${path}/${String(key).replaceAll('~', '~0').replaceAll('/', '~1')}`;
function mismatch(expected: ExactValue, observed: ExactValue | undefined, path: string): Diagnostic[] {
  const fail = (code: 'MISSING' | 'MISMATCH'): Diagnostic[] => [{ code, path, message: code === 'MISSING' ? 'Value is absent' : 'Values differ', expected: stringify(expected), ...(observed === undefined ? {} : { observed: stringify(observed) }) }];
  if (observed === undefined) return fail('MISSING');
  if (expected instanceof NumberToken || observed instanceof NumberToken) return expected instanceof NumberToken && observed instanceof NumberToken && expected.raw === observed.raw ? [] : fail('MISMATCH');
  if (Array.isArray(expected)) {
    if (!Array.isArray(observed) || expected.length !== observed.length) return fail('MISMATCH');
    return expected.flatMap((value, i) => mismatch(value, observed[i], pathKey(path, i)));
  }
  if (object(expected)) {
    if (!object(observed)) return fail('MISMATCH');
    return Object.keys(expected).flatMap((key) => mismatch(expected[key], own(observed, key) ? observed[key] : undefined, pathKey(path, key)));
  }
  return expected === observed ? [] : fail('MISMATCH');
}

/** Compares raw JSON for an expect object and an ObservedRun030 without I/O. */
export function compareRun030(expectedJson: string, observedJson: string): Diagnostic[] {
  const parsed = [expectedJson, observedJson].map((source) => parse(new TextEncoder().encode(source)));
  const errors: Diagnostic[] = [];
  for (let i = 0; i < parsed.length; i++) {
    if (parsed[i].error) errors.push({ code: 'INVALID_JSON', path: i ? '/observed' : '/expected', message: `Invalid JSON at byte ${parsed[i].error!.byte}` });
    else if (!validRoot(parsed[i].tree, i === 0)) errors.push({ code: i ? 'INVALID_OBSERVED' : 'INVALID_EXPECTED', path: i ? '/observed' : '/expected', message: 'Invalid run projection' });
  }
  if (errors.length) return errors;
  const expected = parsed[0].tree as Obj, observed = parsed[1].tree as Obj;
  errors.push(...mismatch(expected.run, observed.run, '/run'));
  if (own(expected, 'starts')) {
    const a = expected.starts as Obj, b = observed.starts as Obj;
    for (const key of Object.keys(a)) errors.push(...mismatch(a[key], b[key], pathKey('/starts', key)));
    for (const key of Object.keys(b)) if (!own(a, key) && compareNumbers(b[key] as NumberToken, 0) > 0) errors.push({ code: 'MISMATCH', path: pathKey('/starts', key), message: 'Unexpected start', observed: stringify(b[key]) });
  }
  if (own(expected, 'messages')) for (const [i, value] of (expected.messages as Obj[]).entries()) {
    const path = pathKey('/messages', i), entry = value;
    if (own(entry, 'nth') && own(entry, 'item')) { errors.push({ code: 'UNSUPPORTED_SELECTION', path, message: 'Combined nth and item selection is unspecified' }); continue; }
    let candidates = (observed.messages as Obj[]).filter((m) => m.to === entry.to);
    if (own(entry, 'nth')) candidates = [candidates[Number((entry.nth as NumberToken).raw) - 1]].filter((m): m is Obj => m !== undefined);
    else if (own(entry, 'item')) candidates = candidates.filter((m) => mismatch(entry.item, m.item, '').length === 0);
    if (candidates.length !== 1) { errors.push({ code: candidates.length ? 'AMBIGUOUS' : 'MISSING', path, message: `Message selection matched ${candidates.length} deliveries` }); continue; }
    for (const key of ['prompt', 'resources', 'element', 'comments']) if (own(entry, key)) errors.push(...mismatch(entry[key], candidates[0][key], pathKey(path, key)));
  }
  if (own(expected, 'joins')) {
    const a = expected.joins as Obj[], b = observed.joins as Obj[];
    if (a.length !== b.length) errors.push({ code: 'MISMATCH', path: '/joins', message: `Expected ${a.length} decisions, observed ${b.length}` });
    for (const [i, entry] of a.entries()) {
      const path = pathKey('/joins', i);
      if (own(entry, 'nth')) errors.push({ code: 'UNSUPPORTED_SELECTION', path, message: 'Join nth selection is unspecified' });
      else errors.push(...mismatch(entry, b[i], path));
    }
  }
  for (const key of ['failures', 'cancelled', 'answers']) if (own(expected, key)) {
    const a = expected[key] as Obj[], b = observed[key] as Obj[];
    // Maximum bipartite matching handles overlapping partial patterns and duplicates.
    const matched = Array<number>(b.length).fill(-1);
    const assign = (i: number, seen: Set<number>): boolean => {
      for (let j = 0; j < b.length; j++) if (!seen.has(j) && mismatch(a[i], b[j], '').length === 0) {
        seen.add(j);
        if (matched[j] === -1 || assign(matched[j], seen)) { matched[j] = i; return true; }
      }
      return false;
    };
    const missing: number[] = [];
    for (let i = 0; i < a.length; i++) if (!assign(i, new Set())) missing.push(i);
    for (const i of missing) errors.push({ code: 'MISSING', path: pathKey(`/${key}`, i), message: 'No distinct matching observation', expected: stringify(a[i]) });
    for (let j = 0; j < b.length; j++) if (matched[j] === -1) errors.push({ code: 'MISMATCH', path: pathKey(`/${key}`, j), message: 'Unexpected observation', observed: stringify(b[j]) });
  }
  return errors;
}
