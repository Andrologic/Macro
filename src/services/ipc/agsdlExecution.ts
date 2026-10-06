import { invoke } from '../tauriRuntimeBridge';
import type {
  PublicSnapshot as PublicSnapshotWire, PublicStartReceipt as PublicStartReceiptWire, PublicProjection as PublicProjectionWire, PublicEventPage as PublicEventPageWire, PublicStopState as PublicStopStateWire,
  RunListRequest, RunPage, DiagnosticRequest, PublicExecutionDiagnostic, NativeModelCatalogue,
} from '../../types/generated/ipc';
import type {
  SourceOwner, SystemStartId, Sequence, StartRequest, StopRequest, PublicStartReceipt, PublicSnapshot,
  PublicProjection, PublicEventPage, PublicStopState,
} from '../agsdlExecution/contracts';

type ReadonlyWire<T> = T extends readonly (infer Item)[]
  ? readonly ReadonlyWire<Item>[]
  : T extends object ? { readonly [Key in keyof T]: ReadonlyWire<T[Key]> } : T;

/** Rust validates identities and exact-value fields. Check the DTO shape here,
 * then restore the contract's brands without parsing or copying JSON values. */
function nativeContract<Wire, Contract extends ReadonlyWire<Wire>>(value: Wire): Contract {
  return value as unknown as Contract;
}

/** Public transport only. Native validation supplies the branded wire identities. */
export async function startExecution(request: StartRequest): Promise<PublicStartReceipt> {
  return nativeContract<PublicStartReceiptWire, PublicStartReceipt>(await invoke<PublicStartReceiptWire>('execution_start', { request }));
}
export async function stopExecution(request: StopRequest): Promise<PublicStopState> {
  return nativeContract<PublicStopStateWire, PublicStopState>(await invoke<PublicStopStateWire>('execution_stop', { request: { ...request, activationId: request.activationId ?? null } }));
}
export async function readExecutionSnapshot(systemStartId: SystemStartId): Promise<PublicSnapshot> {
  return nativeContract<PublicSnapshotWire, PublicSnapshot>(await invoke<PublicSnapshotWire>('execution_read_snapshot', { systemStartId }));
}
export async function readExecutionProjection(systemStartId: SystemStartId): Promise<PublicProjection> {
  return nativeContract<PublicProjectionWire, PublicProjection>(await invoke<PublicProjectionWire>('execution_read_projection', { systemStartId }));
}
export async function readExecutionEvents(systemStartId: SystemStartId, after: Sequence | null, limit: number): Promise<PublicEventPage> {
  return nativeContract<PublicEventPageWire, PublicEventPage>(await invoke<PublicEventPageWire>('execution_read_events', { systemStartId, after, limit }));
}

/** Private: the backend verifies the physical webview resource and incarnation. */
export function executionHostReady(): Promise<string> {
  return invoke<string>('execution_host_ready');
}

/** Stable native pagination, including its original upper creation boundary. */
export function listExecutionRuns(request: RunListRequest): Promise<RunPage> {
  return invoke<RunPage>('execution_list_runs', { request });
}
/** Null is an observation, not a proof that a pending Start cannot still commit. */
export async function findExecutionStart(owner: SourceOwner, requestId: string): Promise<PublicStartReceipt | null> {
  const receipt = await invoke<PublicStartReceiptWire | null>('execution_find_start', { owner, requestId });
  return receipt === null ? null : nativeContract<PublicStartReceiptWire, PublicStartReceipt>(receipt);
}
export function readExecutionDiagnostic(request: DiagnosticRequest): Promise<PublicExecutionDiagnostic> {
  return invoke<PublicExecutionDiagnostic>('execution_read_diagnostic', { request });
}
export function executionModelChoices(): Promise<NativeModelCatalogue> {
  return invoke<NativeModelCatalogue>('execution_model_choices');
}
