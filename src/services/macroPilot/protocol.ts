import { deliveryValidate, resultValidate, schemaValidate } from './schemaValidators';

export type Wire = Record<string, unknown>;
export type Resource = Wire & { type: string; ref: Record<string, string>; revision: number };
export type Actor = { account_id: string; session_id: string; device_id: string };
export type Command = Wire & {
  type: 'command'; kind: string; command_id: string; idempotency_key: string;
  expected_revision: number; target: Record<string, string>; issued_by: Actor; payload: Wire;
};
export type Delivery = { transport_version: '1.0'; type: 'delivery'; exchange_id: string; delivery_id: string; actor: Actor; message: Wire };
export type ErrorCode = 'validation_failed' | 'invalid_reference' | 'stale_revision' | 'conflict' | 'unavailable' | 'cursor_expired' | 'forbidden';
export class PilotError extends Error {
  constructor(public readonly code: ErrorCode) { super(code); }
}
export const object = (value: unknown): Wire => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Wire : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const unique = (values: unknown[]) => new Set(values).size === values.length;
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(object(value)[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export const same = (a: unknown, b: unknown) => stableJson(a) === stableJson(b);
const fieldsEqual = (a: unknown, b: unknown, fields: string[]) => fields.every(key => object(a)[key] === object(b)[key]);
const runFields = ['instance_id', 'workspace_id', 'task_id', 'run_id'];
export function validAnswers(steps: unknown, answers: unknown): boolean {
  const source = array(steps).map(object); const supplied = array(answers).map(object);
  return source.length === supplied.length && unique(supplied.map(a => a.step_id)) && supplied.every(answer => {
    const step = source.find(item => item.step_id === answer.step_id);
    return step && (array(step.choices).includes(answer.answer) || step.free_text_allowed === true);
  });
}
function semantic(value: unknown): boolean {
  const m = object(value); const ref = object(m.ref);
  switch (m.type) {
    case 'task': {
      const ids = array(m.project_ids); const targets = array(m.execution_targets).map(t => object(t).project_id);
      const missing = array(object(m.projection).missing).includes('reply_context');
      if (m.state === 'waiting_reply' ? Boolean(m.reply_context) === missing : Boolean(m.reply_context) || missing) return false;
      return !ids.some(id => array(m.context_project_ids).includes(id)) && unique(targets) && targets.length === ids.length && targets.every(id => ids.includes(id));
    }
    case 'decision':
      return unique(array(m.steps).map(s => object(s).step_id)) && (!m.resolution || validAnswers(m.steps, object(m.resolution).answers));
    case 'tool_approval':
      return !object(m.resolution).grant_scope || array(m.allowed_scopes).includes(object(m.resolution).grant_scope);
    case 'run': return !m.waiting_on || fieldsEqual(ref, m.waiting_on, m.state === 'waiting_reply' ? runFields.slice(0, 3) : runFields);
    case 'review': return fieldsEqual(ref, m.related_run, runFields);
    case 'command':
      if (m.kind === 'session.revoke' && object(m.target).account_id !== object(m.issued_by).account_id) return false;
      return m.kind !== 'decision.resolve' || unique(array(object(m.payload).answers).map(a => object(a).step_id));
    case 'command_result': return m.resulting_revision === undefined || Number(m.resulting_revision) >= Number(m.previous_revision);
    case 'page': return array(m.items).every(item => object(item).type === m.item_type && semantic(item));
    case 'event': return same(m.resource, object(m.snapshot).ref) && m.revision === object(m.snapshot).revision && semantic(m.snapshot);
    case 'event_batch': {
      const events = array(m.events).map(object);
      return events.every((event, index) => event.stream_id === m.stream_id && event.sequence === Number(m.after_sequence) + index + 1 && semantic(event)) &&
        m.next_sequence === Number(m.after_sequence) + events.length && m.next_cursor === (events.at(-1)?.resume_cursor ?? m.after_cursor);
    }
    default: return true;
  }
}
export const validateA1 = (value: unknown): boolean => Boolean(schemaValidate(value)) && semantic(value);
export function assertA1(value: unknown): asserts value is Wire {
  if (!validateA1(value)) throw new PilotError('validation_failed');
}
export function assertDelivery(value: unknown): asserts value is Delivery {
  if (!deliveryValidate(value) || !validateA1(object(value).message)) throw new PilotError('validation_failed');
}
export function errorEnvelope(requestId: string, code: ErrorCode): Wire {
  return { contract_version: '1.0', type: 'error', request_id: requestId, error: { code, message: code, retryable: code === 'unavailable' } };
}

export function assertDeliveryResult(value: unknown): void {
  if (!resultValidate(value) || !validateA1(object(value).message)) throw new PilotError('validation_failed');
}
