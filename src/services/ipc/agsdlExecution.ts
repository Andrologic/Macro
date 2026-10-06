import { invoke } from '../tauriRuntimeBridge';
import type {
  EngineSnapshot, EngineStartReceipt, EngineProjection, EngineEventPage, EngineStopState,
} from '../../types/generated/ipc';
import type {
  SystemStartId, Sequence, StartRequest, StopRequest, StartReceipt, SystemSnapshot,
  ExecutionProjection, EventPage, StopState,
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
export async function startExecution(request: StartRequest): Promise<StartReceipt> {
  return nativeContract<EngineStartReceipt, StartReceipt>(await invoke<EngineStartReceipt>('execution_start', { request }));
}
export async function stopExecution(request: StopRequest): Promise<StopState> {
  return nativeContract<EngineStopState, StopState>(await invoke<EngineStopState>('execution_stop', { request: { ...request, activationId: request.activationId ?? null } }));
}
export async function readExecutionSnapshot(systemStartId: SystemStartId): Promise<SystemSnapshot> {
  return nativeContract<EngineSnapshot, SystemSnapshot>(await invoke<EngineSnapshot>('execution_read_snapshot', { systemStartId }));
}
export async function readExecutionProjection(systemStartId: SystemStartId): Promise<ExecutionProjection> {
  return nativeContract<EngineProjection, ExecutionProjection>(await invoke<EngineProjection>('execution_read_projection', { systemStartId }));
}
export async function readExecutionEvents(systemStartId: SystemStartId, after: Sequence | null, limit: number): Promise<EventPage> {
  return nativeContract<EngineEventPage, EventPage>(await invoke<EngineEventPage>('execution_read_events', { systemStartId, after, limit }));
}
