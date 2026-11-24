// SPDX-License-Identifier: Apache-2.0
import type { PointerPart, Problem } from './schemacheck.mjs';
export function is_index(value: unknown): boolean;
export function consistency(schema: unknown, path?: readonly PointerPart[]): Problem[];
export function validate(value: unknown, schema: unknown, path?: readonly PointerPart[]): Problem[];
export function descend(schema: unknown, path: readonly PointerPart[]): [boolean | null, string | null];
export function kind_at(schema: unknown, path: readonly PointerPart[]): string | null;
