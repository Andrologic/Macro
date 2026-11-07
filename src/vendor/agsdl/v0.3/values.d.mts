// SPDX-License-Identifier: Apache-2.0
import type { NumberToken } from './json.mjs';
export function isNumber(value: unknown): value is NumberToken | number;
export function isObject(value: unknown): value is Record<string, unknown>;
export function isInteger(value: unknown): boolean;
export function compareNumbers(left: NumberToken | number, right: NumberToken | number): -1 | 0 | 1;
export function equal(left: unknown, right: unknown): boolean;
export function json_type_matches(value: unknown, name: string): boolean;
export function stringify(value: unknown): string;

export function rememberKeyOrder(value: object, keys: string[]): void;
export function orderedKeys(value: object): string[];
export function orderedEntries(value: Record<string, unknown>): [string, unknown][];
