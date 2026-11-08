import { expect, it, mock } from 'bun:test';
import type { StartRequest030 } from './agsdlExecution030';

let response: unknown;
const invoke = mock(async (_command: string, _args: unknown) => response);
mock.module('../tauriRuntimeBridge', () => ({ invoke }));
const ipc = await import('./agsdlExecution030');
const source = { owner: { projectId: 'project', planId: 'plan', branch: 'feature/test' }, revision: '1', sourceSha256: 'a'.repeat(64) };
const request = { source, profile: 'macro-agsdl-030-v1', associations: {}, requestId: 'request',
  entry: { deliveryId: 'delivery', messageJson: '{"n":9007199254740993}' } } as StartRequest030;
const snapshot = { systemStartId: 'run', source, authoredSource: '{"contract":"agsdl-0.3.0"}', associations: {},
  versions: { snapshot: '2', contract: 'agsdl-0.3.0', compiler: 'compiler', runtime: 'runtime', registry: 'registry', profile: 'macro-agsdl-030-v1' } };

it('uses the native Start command and preserves exact input under a verified 030 snapshot', async () => {
  response = { systemStartId: 'run', flowInvocationId: 'flow', snapshot };
  expect(await ipc.startExecution030(request)).toMatchObject({ systemStartId: 'run', flowInvocationId: 'flow', snapshot });
  expect(invoke).toHaveBeenLastCalledWith('execution_start', { request });
  response = snapshot;
  expect((await ipc.readExecutionSnapshot030('run')).versions.contract).toBe('agsdl-0.3.0');
});

it('rejects a historical or foreign native snapshot', async () => {
  response = { systemStartId: 'run', flowInvocationId: 'flow', snapshot: { ...snapshot,
    versions: { ...snapshot.versions, snapshot: '1', contract: 'agsdl-0.2.0', profile: 'macro-serial-inline-v1' } } };
  await expect(ipc.startExecution030(request)).rejects.toThrow('not an AgSDL 0.3 capture');
  response = { systemStartId: 'run', flowInvocationId: 'flow', snapshot: { ...snapshot,
    source: { ...source, revision: '2' } } };
  await expect(ipc.startExecution030(request)).rejects.toThrow('differs from the requested source');
});


it('reads native human pages with the complete scope and opaque continuation', async () => {
  const scope = { systemStartId: 'run', source };
  const continuation = { scope, cursor: 'opaque-native-cursor', offset: 64 };
  response = { scope, cursor: continuation.cursor, total: '65', requests: [], nextPage: null };
  expect(await ipc.readExecutionHumans030(scope, continuation)).toMatchObject({ scope, cursor: continuation.cursor, total: '65' });
  expect(invoke).toHaveBeenLastCalledWith('execution_read_humans030', { scope, continuation });
  await ipc.readExecutionHumans030(scope);
  expect(invoke).toHaveBeenLastCalledWith('execution_read_humans030', { scope, continuation: null });
});

it('passes projection scope and revision-bound continuation without rewriting section data', async () => {
  const scope = { systemStartId: 'run', source, snapshotId: 'snapshot' };
  const continuation = { scope, revision: '9007199254740993', offset: 100 };
  response = { scope, flowInvocationId: 'flow', revision: continuation.revision, stopping: false,
    verdict: null, total: '101', items: [{ kind: 'path', value: { id: 'path' } }], nextPage: null };
  expect(response).toBe(await ipc.readExecutionRuntimeProjection030(scope, continuation));
  expect(invoke).toHaveBeenLastCalledWith('execution_read_runtime_projection030', { scope, continuation });
  await ipc.readExecutionRuntimeProjection030(scope);
  expect(invoke).toHaveBeenLastCalledWith('execution_read_runtime_projection030', { scope, continuation: null });
  const initial = { ...scope, snapshotId: null };
  await ipc.readExecutionRuntimeProjection030(initial);
  expect(invoke).toHaveBeenLastCalledWith('execution_read_runtime_projection030', { scope: initial, continuation: null });
});
