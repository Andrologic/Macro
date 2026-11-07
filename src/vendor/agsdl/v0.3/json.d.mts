// SPDX-License-Identifier: Apache-2.0
// Runtime identity is the class exported by the AgSDL 0.2 scanner used by execution helpers.
import type { NumberToken } from '../v0.2/values.mjs';
export { NumberToken } from '../v0.2/values.mjs';
export class ParseError extends Error { constructor(byte: number); byte: number; }
export type ExactValue = null | boolean | string | NumberToken | ExactValue[] | ExactObject;
export interface ExactObject { [key: string]: ExactValue; }
export interface ParsedExactJson {
  tree: ExactValue;
  spans: Map<string, { start: number; end: number }>;
  bytes: Uint8Array;
  error?: ParseError;
}
export function parse(bytes: Uint8Array): ParsedExactJson;
export function pointer(path: string, key: string | number): string;
export { stringify } from './values.mjs';
