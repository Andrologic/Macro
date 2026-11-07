/** Browser port of AgSDL v0.3.0 permissions.py, Apache-2.0. See LICENSE. */
export type Action = 'read' | 'write' | 'shell' | 'network' | 'mcp' | 'delegate';
export type Effect = 'allow' | 'ask' | 'deny';
export type Preset = 'read-only' | 'workspace' | 'full';
export interface PermissionRule { action: Action; effect: Effect; match?: string; }
export interface PermissionDeclaration {
  preset?: Preset;
  rules?: PermissionRule[];
  outside?: 'read' | 'deny';
  directories?: Record<string, 'read' | 'write'>;
  reviewer?: 'person' | 'model';
}
export type Permissions = Preset | PermissionDeclaration | null;
export const ACTIONS: readonly Action[];
export const ORDER: Readonly<Record<Effect, number>>;
export const PRESETS: Readonly<Record<Preset, Readonly<Record<Action, Effect>>>>;
export function normalize(permissions: Permissions): [Preset | null, PermissionRule[]];
export function outside(permissions: Permissions): 'read' | 'deny';
export function covers_all(rule: PermissionRule): boolean;
export function shell_denied(permissions: Permissions): boolean;
export function glob_matches(pattern: string, text: string, paths?: boolean, command?: boolean): boolean;
export function effect_for(permissions: Permissions, action: Action, subject: string): Effect;
export function command_prefix(pattern: string): boolean;
export function effects_in_use(permissions: Permissions): Record<Action, Set<Effect>>;
