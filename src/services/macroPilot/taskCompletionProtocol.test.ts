import { expect, test } from 'bun:test';
import { validateContentMessage, validateContentResponse } from './contentProtocol';
const ref = { instance_id: 'instance:demo', workspace_id: 'workspace:demo', task_id: 'task:sample' };
const request = { contract_version: '2.0', type: 'request', request_id: 'request:demo', account_id: 'account:demo', operation: 'task.action', body: {
  ref, snapshot_id: 'snapshot:demo', expected_revision: 4, idempotency_key: 'action:demo', action: 'rename', confirmation: 'confirm_task_action', title: 'Synthetic title',
} };
test('task actions require confirmation, a current capture and an exclusive nonblank rename title', () => {
  expect(validateContentMessage(request)).toBe(true);
  for (const change of [{ confirmation: undefined }, { snapshot_id: undefined }, { title: '  ' }, { action: 'delete' }, { hidden_context: 'private' }]) {
    expect(validateContentMessage({ ...request, body: { ...request.body, ...change } })).toBe(false);
  }
  const response = { ...request, type: 'response', body: undefined, result: { outcome: 'applied', revision: 5 } };
  delete (response as { body?: unknown }).body;
  expect(validateContentResponse(request, response)).toBe(true);
  expect(validateContentResponse(request, { ...response, result: { outcome: 'applied', revision: 6 } })).toBe(false);
});
test('capability selection cannot invent consumer support', () => {
  const offer = { negotiation_version: '1.0', type: 'negotiate', request_id: 'request:demo', instance_id: ref.instance_id, supported_versions: ['2.0'], capabilities: ['task-details-1'] };
  const selected = { negotiation_version: '1.0', type: 'negotiated', request_id: offer.request_id, instance_id: ref.instance_id, selected_version: '2.0', capabilities: ['task-details-1'] };
  expect(validateContentResponse(offer, selected)).toBe(true);
  expect(validateContentResponse(offer, { ...selected, capabilities: ['task-actions-1'] })).toBe(false);
});
