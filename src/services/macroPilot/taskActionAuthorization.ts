import type { ContentRequest } from './contentProtocol';
import { PilotError, object } from './protocol';
export function taskActionPermissions(request: ContentRequest): string[] | null {
  if (request.operation !== 'task.action') return null;
  return request.body.action === 'run_commands' ? ['respond', 'approve_tools'] : ['respond'];
}
export function assertTaskActionPermissions(required: string[] | null, authorization: unknown): void {
  if (!required) return;
  const granted = object(authorization).granted_permissions;
  if (!Array.isArray(granted) || required.some(permission => !granted.includes(permission))) throw new PilotError('forbidden');
}
