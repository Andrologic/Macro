import { expect, test } from 'bun:test';
import { taskActionPermissions, assertTaskActionPermissions } from './taskActionAuthorization';
import type { ContentRequest } from './contentProtocol';
test('task mutations reject supervise-only and legacy execute-before responses', () => {
  for (const action of ['rename', 'archive', 'delete', 'run_commands']) {
    const required = taskActionPermissions({ operation: 'task.action', body: { action } } as ContentRequest);
    expect(required).toContain('respond');
    expect(() => assertTaskActionPermissions(required, { granted_permissions: ['supervise'] })).toThrow('forbidden');
    expect(() => assertTaskActionPermissions(required, {})).toThrow('forbidden');
    if (action === 'run_commands') expect(() => assertTaskActionPermissions(required, { granted_permissions: ['respond'] })).toThrow('forbidden');
    expect(() => assertTaskActionPermissions(required, { granted_permissions: ['respond', 'approve_tools'] })).not.toThrow();
  }
});
