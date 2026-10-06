import {
  NumberToken, clone, decimal, equal, parse, shape, stringify,
} from '../../vendor/agsdl/v0.2/values.mjs';
import type { ExactJsonText, ExactValuePort, ExecutionFailure, WorkIdentity } from './contracts';

export type ExactValue = null | boolean | string | NumberToken | ExactValue[] | ExactObject;
export interface ExactObject { [key: string]: ExactValue }
export class ConformanceError extends Error implements ExecutionFailure {
  readonly work: WorkIdentity | null;
  constructor(readonly code: string, readonly pointer: string, message: string, work: WorkIdentity | null = null) {
    super(message);
    this.name = 'ConformanceError';
    this.work = work;
  }
}
export function fail(code: string, pointer: string, message: string): never {
  throw new ConformanceError(code, pointer, message);
}
export function decode(text: string): ExactValue {
  try {
    const parsed = parse(new TextEncoder().encode(text));
    if (parsed.error) return fail('PARSE', '', 'Invalid or unsupported exact JSON.');
    return parsed.tree as ExactValue;
  }
  catch { return fail('PARSE', '', 'Invalid or unsupported exact JSON.'); }
}
export function encode(value: ExactValue): ExactJsonText { return stringify(value) as ExactJsonText; }
export function record(value: ExactValue | undefined, pointer = ''): ExactObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || value instanceof NumberToken) {
    return fail('INVALID_RECORD', pointer, 'Expected an object.');
  }
  return value;
}
export function list(value: ExactValue | undefined, pointer = ''): ExactValue[] {
  if (!Array.isArray(value)) return fail('INVALID_RECORD', pointer, 'Expected an array.');
  return value;
}
export function text(value: ExactValue | undefined, pointer = ''): string {
  if (typeof value !== 'string') return fail('INVALID_RECORD', pointer, 'Expected a string.');
  return value;
}
export function at(pointer: string, key: string): string {
  return `${pointer}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`;
}
export function has(object: ExactObject, key: string): boolean { return Object.hasOwn(object, key); }
export const exactValues: ExactValuePort = { equal: (left, right) => equal(decode(left), decode(right)) };
export { NumberToken, clone, decimal, equal, shape };
