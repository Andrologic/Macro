import { expect, it } from 'bun:test';
import { intersectPermissionEffects, projectNativePermission, type NativePermissionProjection } from './permissionPolicy';
const invocation = { invocationIdentity: 'native/epoch/work/tool', toolId: 'write', bindingJson: '{"binding":1}',
  argumentsJson: '{"path":"file","content":"text"}', permissionPolicyDigest: 'a'.repeat(64), permissionPurpose: 'agent' as const };
function projection(effect: 'allow' | 'ask' | 'deny' = 'allow'): NativePermissionProjection {
  return { ...invocation, decision: { policyDigest: invocation.permissionPolicyDigest, purpose: 'agent',
    request: { action: 'write', path: 'file' }, effect, reviewer: effect === 'ask' ? 'person' : null, resolvedPath: '/workspace/file' } };
}
it('intersects all effects and closes missing or malformed decisions', () => {
  const rank = { allow: 0, ask: 1, deny: 2 };
  for (const a of ['allow', 'ask', 'deny'] as const) for (const b of ['allow', 'ask', 'deny'] as const) {
    expect(rank[intersectPermissionEffects(a, b)]).toBe(Math.max(rank[a], rank[b]));
  }
  expect(intersectPermissionEffects()).toBe('deny');
  expect(intersectPermissionEffects('bogus' as 'allow')).toBe('deny');
});
it('projects native decisions only for identical invocation bytes, purpose and policy', () => {
  for (const effect of ['allow', 'ask', 'deny'] as const) expect(projectNativePermission(invocation, projection(effect))).toBe(effect);
  expect(projectNativePermission(invocation, undefined)).toBe('deny');
  for (const key of ['invocationIdentity', 'toolId', 'bindingJson', 'argumentsJson'] as const) {
    expect(projectNativePermission(invocation, { ...projection(), [key]: 'changed' })).toBe('deny');
  }
  expect(projectNativePermission({ ...invocation, permissionPolicyDigest: 'b'.repeat(64) }, projection())).toBe('deny');
  expect(projectNativePermission({ ...invocation, permissionPurpose: 'planLocked' }, projection())).toBe('deny');
  expect(projectNativePermission({ ...invocation, permissionPolicyDigest: '' }, projection())).toBe('deny');
});
