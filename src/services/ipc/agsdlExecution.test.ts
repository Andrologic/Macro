import { describe,expect,it,mock } from 'bun:test';
import type { ExecutionIntentKey,ExecutionStageIntentRequest,PublicExecutionIntent } from '../../types/generated/ipc';

let response: PublicExecutionIntent | null = null;
const invoke = mock(async (_command: string, _args: unknown) => response);
mock.module('../tauriRuntimeBridge', () => ({ invoke }));
const intent = await import('./agsdlExecutionIntentVersioned');

describe('durable execution intent IPC', () => {
  it('does not submit on import and preserves exact payload, native revision and key-only retries', async () => {
    expect(invoke).not.toHaveBeenCalled();
    const key = { scope: { owner: { projectId: 'project', planId: 'plan', branch: 'feature/synthetic' }, conversationId: 'conversation' }, intentId: 'intent' } as ExecutionIntentKey;
    const request = { scope: key.scope, intentId: key.intentId, payload: { kind: 'start', request: { source: { owner: key.scope.owner, revision: '9007199254740993', sourceSha256: 'a'.repeat(64) }, requestId: 'start', profile: 'macro-agsdl-030-v1', associations: {}, entry: { deliveryId: 'entry', messageJson: '{ "n":9007199254740993, "lexeme":1.0 }' } } } } as ExecutionStageIntentRequest;
    response = { formatVersion: '1', key, revision: '9007199254740994', payload: request.payload, state: { kind: 'submissionPending', retryableFailure: 'RUNTIME_UNAVAILABLE' } };
    expect(await intent.stageExecutionIntentVersioned(request)).toBe(response);
    expect(invoke).toHaveBeenLastCalledWith('execution_stage_intent', { request });
    const retained = response;
    expect(await intent.submitExecutionIntentVersioned(key)).toBe(retained);
    expect(invoke).toHaveBeenLastCalledWith('execution_submit_intent', { key });
    await intent.submitExecutionIntentVersioned(key);
    expect(invoke).toHaveBeenLastCalledWith('execution_submit_intent', { key });
    expect(await intent.readExecutionIntentVersioned(key)).toBe(retained);
    expect(invoke).toHaveBeenLastCalledWith('execution_read_intent', { key });
    response = null;
    expect(await intent.readExecutionIntentVersioned(key)).toBeNull();
  });
});
