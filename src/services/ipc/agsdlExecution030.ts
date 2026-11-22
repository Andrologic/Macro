import { isFlowDocumentContract } from "../agsdl/contract";
import type { PublicSnapshot, PublicStartReceipt } from '../../types/generated/ipc';
import type { StartRequest } from '../agsdlExecution/contracts';
import type { EngineVersions030, ExecutionProfile030 } from '../agsdlExecution/contracts030';
import type { RunListRequest030, RunPage030, RuntimeProjectionContinuation030, RuntimeProjectionPage030, RuntimeProjectionQuery030 } from '../../types/generated/ipc';
import { invoke } from '../tauriRuntimeBridge';
import type { ExecutionIntentScope, ExecutionRunCorrelation030 } from '../../types/generated/ipc';

/** This transport does not qualify Start 030. Native admission remains authoritative. */
export type StartRequest030 = Omit<StartRequest, 'profile'> & { readonly profile: ExecutionProfile030 };
export type PublicSnapshot030 = Omit<PublicSnapshot, 'versions'> & { readonly versions: EngineVersions030 };
export type PublicStartReceipt030 = Omit<PublicStartReceipt, 'snapshot'> & { readonly snapshot: PublicSnapshot030 };

function snapshot030(snapshot: PublicSnapshot): PublicSnapshot030 {
  const versions = snapshot.versions;
  if (versions.snapshot !== '2' || !isFlowDocumentContract(versions.contract) || versions.profile !== 'macro-agsdl-030-v1') {
    throw new Error('Native snapshot is not an AgSDL flow capture.');
  }
  return { ...snapshot, versions: { snapshot: '2', contract: versions.contract, profile: 'macro-agsdl-030-v1',
    compiler: versions.compiler, runtime: versions.runtime, registry: versions.registry } };
}

/** Native admission validates the AgSDL execution slice. */
export async function startExecution030(request: StartRequest030): Promise<PublicStartReceipt030> {
  const receipt = await invoke<PublicStartReceipt>('execution_start', { request });
  const snapshot = snapshot030(receipt.snapshot);
  const actual = snapshot.source, expected = request.source;
  if (receipt.systemStartId !== snapshot.systemStartId || actual.revision !== expected.revision
    || actual.sourceSha256 !== expected.sourceSha256 || actual.owner.projectId !== expected.owner.projectId
    || actual.owner.planId !== expected.owner.planId || actual.owner.branch !== expected.owner.branch) {
    throw new Error('Native start receipt differs from the requested source.');
  }
  return { ...receipt, snapshot };
}

export async function readExecutionSnapshot030(systemStartId: string): Promise<PublicSnapshot030> {
  const snapshot = snapshot030(await invoke<PublicSnapshot>('execution_read_snapshot', { systemStartId }));
  if (snapshot.systemStartId !== systemStartId) throw new Error('Native snapshot differs from the requested run.');
  return snapshot;
}

/** Lists only requests explicitly attested for a human by the native host. */
export function readExecutionHumans030(
  scope: import('../../types/generated/ipc').HumanScope030,
  continuation?: import('../../types/generated/ipc').HumanContinuation030,
): Promise<import('../../types/generated/ipc').HumanPage030> {
  return invoke('execution_read_humans030', { scope, continuation: continuation ?? null });
}

/** Pages are invalidated by any flow revision or scope change. */
export function readExecutionRuntimeProjection030(
  scope: RuntimeProjectionQuery030,
  continuation?: RuntimeProjectionContinuation030,
): Promise<RuntimeProjectionPage030> {
  return invoke('execution_read_runtime_projection030', { scope, continuation: continuation ?? null });
}

/** Uses the distinct 030 cursor and never treats a historical run as 030. */
export function listExecutionRuns030(request: RunListRequest030): Promise<RunPage030> {
  return invoke('execution_list_runs030', { request });
}

/** Attests the retained Start intent, including after acknowledgement and closure. */
export function readExecutionRunCorrelation030(
  scope: ExecutionIntentScope,
  systemStartId: string,
): Promise<ExecutionRunCorrelation030> {
  return invoke('execution_read_run_correlation030', { scope, systemStartId });
}

/** Native receipt identifies durable arbitration, independently of UI lifetime. */
export function submitExecutionHuman030(input: {
  scope: import('../../types/generated/ipc').HumanScope030;
  requestId: string;
  expectedRevision: string;
  answer: { kind: 'decision'; decision: 'yes' | 'no'; comment: string }
    | { kind: 'approval'; choice: string; comment: string }
    | { kind: 'question'; answerJson: string };
}): Promise<string> {
  return invoke('execution_submit_human030', { input });
}

/** Request a run stop and return its native receipt. */
export function stopExecution030(request: import('../agsdlExecution/contracts').StopRequest): Promise<import('../agsdlExecution/contracts').PublicStopState> {
  return import('./agsdlExecution').then(({ stopExecution }) => stopExecution(request));
}

/** A delivery receipt records native admission, before consumption. */
export function deliverExecution030(request: import('../../types/generated/ipc').DeliveryRequest030): Promise<import('../../types/generated/ipc').DeliveryReceipt030> {
  return invoke('execution_deliver030', { request });
}
