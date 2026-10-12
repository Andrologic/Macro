import type { ContentRequest } from './contentProtocol';
import { PilotError, object } from './protocol';
export function taskActionPermissions(request: ContentRequest): string[] | null {
  if (request.operation.startsWith('attachment.') || request.operation === 'conversation.send.attachments') return ['respond'];
  if (['conversation.send.status', 'conversation.files.list', 'conversation.file.capture', 'conversation.file.read'].includes(request.operation)) return ['supervise'];
  if (request.operation === 'instance.telemetry' || request.operation === 'project.icon') return ['supervise'];
  if (['conversation.action', 'conversation.create', 'conversation.acknowledge', 'conversation.interact'].includes(request.operation)) return ['respond'];
  if (request.operation !== 'task.action') return null;
  return request.body.action === 'run_commands' ? ['respond', 'approve_tools'] : ['respond'];
}
export function assertTaskActionPermissions(required: string[] | null, authorization: unknown): void {
  if (!required) return;
  const granted = object(authorization).granted_permissions;
  if (!Array.isArray(granted) || required.some(permission => !granted.includes(permission))) throw new PilotError('forbidden');
}
