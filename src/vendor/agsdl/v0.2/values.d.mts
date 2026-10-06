export class NumberToken { constructor(raw: string); raw: string; }
export function parse(bytes: Uint8Array): { tree: unknown; spans: Map<string, { start: number; end: number }>; bytes: Uint8Array; error?: { byte: number } };
export function clone<T>(value: T): T;
export function decimal(value: NumberToken | number): [string, string, bigint];
export function stringify(value: unknown): string;
