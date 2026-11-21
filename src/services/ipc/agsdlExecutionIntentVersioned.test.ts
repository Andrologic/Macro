import { expect, it, mock } from 'bun:test';
import type { ExecutionStageIntentRequest, PublicExecutionIntent } from '../../types/generated/ipc';

const owner = { projectId: 'project', planId: 'plan', branch: 'feature/test' };
const source = { owner, revision: '9007199254740993', sourceSha256: 'a'.repeat(64) };
const scope = { owner, conversationId: 'conversation' };
const key = { scope, intentId: 'intent' };
const request: ExecutionStageIntentRequest = { scope, intentId: key.intentId, payload: {
  kind: 'start', request: { source, profile: 'macro-agsdl-030-v1', associations: {}, requestId: 'request', entry: null },
} };
const row: PublicExecutionIntent = { formatVersion: '1', key, revision: '2', payload: request.payload, state: {
  kind: 'admitted', admission: { kind: 'start030', receipt: { systemStartId: 'system', flowInvocationId: 'flow',
    source, versions: { snapshot: '2', contract: 'agsdl-0.3.0', profile: 'macro-agsdl-030-v1', compiler: 'c', runtime: 'r', registry: 'g' }, entryDeliveryId: null } },
} };
const invoke = mock(async () => row);
mock.module('../tauriRuntimeBridge', () => ({ invoke }));
const ipc = await import('./agsdlExecutionIntentVersioned');

it('keeps the native 0.3 admission and exact versioned payload on every intent operation', async () => {
  expect(await ipc.stageExecutionIntentVersioned(request)).toBe(row);
  expect(invoke).toHaveBeenLastCalledWith('execution_stage_intent', { request });
  expect(await ipc.submitExecutionIntentVersioned(key)).toBe(row);
  expect(invoke).toHaveBeenLastCalledWith('execution_submit_intent', { key });
  expect(await ipc.readExecutionIntentVersioned(key)).toBe(row);
  expect(invoke).toHaveBeenLastCalledWith('execution_read_intent', { key });
  const close = { key, expectedRevision: '2', disposition: 'acknowledged' as const };
  expect(await ipc.closeExecutionIntentVersioned(close)).toBe(row);
  expect(invoke).toHaveBeenLastCalledWith('execution_close_intent', { request: close });
});
