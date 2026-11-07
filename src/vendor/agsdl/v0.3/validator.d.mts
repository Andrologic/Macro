/** Internal AgSDL 0.3.0 validator API. Apache-2.0; see LICENSE. */
import type { ExactValue } from './json.mjs';
import type { Diagnostic030, DiagnosticCode030, HarnessModule030, Report030 } from './reader.mjs';
export const CONTRACT: 'agsdl-0.3.0';
export class ModuleError extends Error { constructor(message: string); }
export function check_module(module: unknown): HarnessModule030;
export class Report {
  diagnostics: Diagnostic030[];
  joins: Report030['joins'];
  readonly valid: boolean;
  add(severity: Diagnostic030['severity'], code: DiagnosticCode030, parts: string | (string | number)[], message: string, step?: string[] | null): void;
  error(code: DiagnosticCode030, parts: string | (string | number)[], message: string, step?: string[] | null): void;
  warning(code: DiagnosticCode030, parts: string | (string | number)[], message: string, step?: string[] | null): void;
  as_json(): Report030;
}
/** The reader validates and detaches the registry before invoking these helpers. */
export function validate_bytes(bytes: Uint8Array, modules: ReadonlyMap<string, HarnessModule030>): Report;
export function validate_document(document: ExactValue, modules: ReadonlyMap<string, HarnessModule030>, report?: Report): Report;
