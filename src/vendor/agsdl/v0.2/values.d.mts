export class NumberToken { constructor(raw: string); raw: string; }
export function parse(bytes: Uint8Array): { tree: unknown; spans: Map<string, { start: number; end: number }>; bytes: Uint8Array; error?: { byte: number } };
export function clone<T>(value: T): T;
export function decimal(value: NumberToken | number): [string, string, bigint];
export function stringify(value: unknown): string;
export const schema: { $defs: Record<string, unknown>; [key: string]: unknown };
export function equal(left: unknown, right: unknown): boolean;
export function satisfies(value: unknown, constraint: unknown, skipEnum?: boolean): boolean;
export function shape(value: unknown, schema?: unknown): boolean;
export function integer(value: unknown): boolean;
export function numeric(value: unknown): boolean;
export function object(value: unknown): boolean;
export function type(value: unknown, type: string): boolean;
