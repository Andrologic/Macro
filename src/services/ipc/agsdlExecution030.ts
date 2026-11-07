import type { PublicSnapshot, PublicStartReceipt } from '../../types/generated/ipc';
import type { StartRequest } from '../agsdlExecution/contracts';
import type { EngineVersions030, ExecutionProfile030 } from '../agsdlExecution/contracts030';
import { invoke } from '../tauriRuntimeBridge';

/** This transport does not qualify Start 030. Native admission remains authoritative. */
export type StartRequest030 = Omit<StartRequest, 'profile'> & { readonly profile: ExecutionProfile030 };
export type PublicSnapshot030 = Omit<PublicSnapshot, 'versions'> & { readonly versions: EngineVersions030 };
export type PublicStartReceipt030 = Omit<PublicStartReceipt, 'snapshot'> & { readonly snapshot: PublicSnapshot030 };

function snapshot030(snapshot: PublicSnapshot): PublicSnapshot030 {
  const versions = snapshot.versions;
  if (versions.snapshot !== '2' || versions.contract !== 'agsdl-0.3.0' || versions.profile !== 'macro-agsdl-030-v1') {
    throw new Error('Native snapshot is not an AgSDL 0.3 capture.');
  }
  return { ...snapshot, versions: { snapshot: '2', contract: 'agsdl-0.3.0', profile: 'macro-agsdl-030-v1',
    compiler: versions.compiler, runtime: versions.runtime, registry: versions.registry } };
}

/** The existing native command currently refuses 030 until its host is qualified. */
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
