/** Projection of native admission, not an evaluator of authored permissions.
 * The native host authenticates the ticket, revalidates paths and live policy,
 * and consumes any approval once before performing the actual effect. */
export type PermissionEffect = 'allow' | 'ask' | 'deny';
export type PermissionAction = 'read' | 'write' | 'shell' | 'network' | 'mcp' | 'delegate';
export type PermissionReviewer = 'person' | 'model';
export type PermissionPurpose = 'agent' | 'planLocked' | 'completionCheck';
export type PermissionActionRequest =
  | { readonly action: 'read' | 'write'; readonly path: string }
  | { readonly action: 'shell'; readonly command: string }
  | { readonly action: 'network'; readonly host: string }
  | { readonly action: 'mcp'; readonly server: string; readonly tool: string | null }
  | { readonly action: 'delegate' };

/** Mirrors PermissionDecision from Rust until09 generates the central IPC types. */
export interface PermissionDecision {
  readonly policyDigest: string;
  readonly request: PermissionActionRequest;
  readonly purpose: PermissionPurpose;
  readonly effect: PermissionEffect;
  readonly reviewer: PermissionReviewer | null;
  readonly resolvedPath: string | null;
}
/** Native-owned correlation fields. Every action of a multi-path operation must
 * be admitted natively; a single projection never authorizes its siblings. */
export interface NativePermissionProjection {
  readonly invocationIdentity: string;
  readonly toolId: string;
  readonly bindingJson: string;
  readonly argumentsJson: string;
  readonly decision: PermissionDecision;
}
export interface PermissionInvocation {
  readonly invocationIdentity: string;
  readonly toolId: string;
  readonly bindingJson: string;
  readonly argumentsJson: string;
  readonly permissionPolicyDigest: string;
  readonly permissionPurpose: PermissionPurpose;
}

export function intersectPermissionEffects(...effects: readonly PermissionEffect[]): PermissionEffect {
  if (!effects.length || effects.some(effect => !['allow', 'ask', 'deny'].includes(effect))) return 'deny';
  return effects.includes('deny') ? 'deny' : effects.includes('ask') ? 'ask' : 'allow';
}

/** Correlation checks detect a stale/mismatched response. They cannot authenticate
 * an untrusted caller; only09's native transport/ticket boundary can do that. */
export function projectNativePermission(
  invocation: PermissionInvocation,
  projection: NativePermissionProjection | undefined,
): PermissionEffect {
  if (!projection || !projection.decision || !/^[a-f0-9]{64}$/.test(invocation.permissionPolicyDigest)
    || !['agent', 'planLocked', 'completionCheck'].includes(invocation.permissionPurpose)
    || !invocation.invocationIdentity
    || projection.invocationIdentity !== invocation.invocationIdentity
    || projection.toolId !== invocation.toolId
    || projection.bindingJson !== invocation.bindingJson
    || projection.argumentsJson !== invocation.argumentsJson
    || projection.decision.policyDigest !== invocation.permissionPolicyDigest
    || projection.decision.purpose !== invocation.permissionPurpose
    || !['allow', 'ask', 'deny'].includes(projection.decision.effect)
    || ![null, 'person', 'model'].includes(projection.decision.reviewer)
    || projection.decision.effect !== 'ask' && projection.decision.reviewer !== null) return 'deny';
  return projection.decision.effect;
}
