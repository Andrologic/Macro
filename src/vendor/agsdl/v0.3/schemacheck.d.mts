// SPDX-License-Identifier: Apache-2.0
import type { NumberToken } from './json.mjs';
export type PointerPart = string | number | NumberToken;
export type Problem = [pointer: string, message: string];
export function pointer(parts: readonly PointerPart[]): string;
export class SchemaChecker {
  constructor(root: unknown);
  check(value: unknown): Problem[];
}
export { equal as json_equal, isNumber as is_number, isInteger as is_integer,
  json_type_matches } from './values.mjs';
