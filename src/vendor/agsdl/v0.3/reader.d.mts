/** AgSDL 0.3.0 browser reader. Apache-2.0; see LICENSE. */
import type { ExactValue, NumberToken } from './json.mjs';
export { NumberToken, parse, stringify } from './json.mjs';
export type { ExactValue, ExactObject, ParsedExactJson } from './json.mjs';
export { equal, compareNumbers, isInteger } from './values.mjs';
export { ModuleError } from './validator.mjs';

export type DiagnosticCode030 =
  | 'PARSE' | 'SHAPE' | 'REFERENCE' | 'COMPOSITION' | 'ROUTES' | 'DELIVERY'
  | 'JOIN' | 'DUPLICATE' | 'UNREACHABLE' | 'RESULT_NAME' | 'SCHEMA'
  | 'PERMISSIONS' | 'PROMPT' | 'MESSAGE_PATH' | 'HARNESS_UNSUPPORTED'
  | 'HARNESS_VALUE' | 'HARNESS_SETTINGS' | 'HARNESS_UNVERIFIED'
  | 'HARNESS_APPROXIMATE' | 'HARNESS_VERSION' | 'SHARED_INSTANCE_PARALLEL'
  | 'FANOUT_VISITS';
export interface Diagnostic030 {
  severity: 'error' | 'warning';
  code: DiagnosticCode030;
  path: string;
  message: string;
  step?: string[];
}
export interface Report030 {
  contract: 'agsdl-0.3.0';
  valid: boolean;
  diagnostics: Diagnostic030[];
  joins: Record<string, { origin: string; branches: string[] }>;
}
export interface ValueSchema030 {
  type: 'null' | 'boolean' | 'number' | 'integer' | 'string' | 'array' | 'object';
  description?: string;
  enum?: ExactValue[];
  items?: ValueSchema030;
  minItems?: NumberToken;
  maxItems?: NumberToken;
  properties?: Record<string, ValueSchema030>;
  required?: string[];
  additionalProperties?: boolean;
}
export interface HarnessSupport030 {
  support: 'native' | 'approximate' | 'absent';
  note?: string;
  values?: string[];
  suggestions?: string[];
  versions?: string;
}
export type HarnessEnforcement030 = 'sandbox' | 'harness' | 'absent';
export interface HarnessPermission030 {
  allow?: HarnessEnforcement030;
  ask?: HarnessEnforcement030;
  deny?: HarnessEnforcement030;
  note?: string;
}
export interface HarnessModule030 {
  $schema?: string;
  name: string;
  title?: string;
  version: string;
  contract: 'agsdl-0.3.0';
  harnessVersions: string;
  sources?: string[];
  properties: Partial<Record<
    'resources' | 'model.name' | 'model.effort' | 'skills' | 'mcpServers' |
    'plan' | 'planFirst.auto' | 'reviewer.person' | 'reviewer.model' |
    'directories' | 'instance.new' | 'delivery.steer', HarnessSupport030
  >> & { 'planFirst.ask'?: Omit<HarnessSupport030, 'support'> & { support: 'native' | 'absent' } };
  permissions: {
    read?: HarnessPermission030 & { outside?: HarnessEnforcement030 };
    write?: HarnessPermission030;
    shell?: HarnessPermission030 & { match?: 'prefix' };
    network?: HarnessPermission030;
    mcp?: HarnessPermission030;
    delegate?: HarnessPermission030;
  };
  settings?: ValueSchema030;
}
export interface ReaderOptions030 {
  /** Omitted: the four pinned modules. An explicitly empty map stays empty. */
  modules?: ReadonlyMap<string, HarnessModule030>;
}
export function read(bytes: Uint8Array, options?: ReaderOptions030): Report030;
export function validateExact(document: ExactValue, options?: ReaderOptions030): Report030;
/** Throws ModuleError for malformed JSON, shape or inconsistent settings. */
export function loadHarnessModule(bytes: Uint8Array): HarnessModule030;
