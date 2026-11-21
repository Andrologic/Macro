import type {
ExecutionPreflight,
ExecutionPreflightRequest,
NativeModelCatalogue,
PublicStopState as PublicStopStateWire
} from '../../types/generated/ipc';
import type {
PublicStopState,
StopRequest
} from '../agsdlExecution/contracts';
import { invoke } from '../tauriRuntimeBridge';

type ReadonlyWire<T> = T extends readonly (infer Item)[]
  ? readonly ReadonlyWire<Item>[]
  : T extends object ? { readonly [Key in keyof T]: ReadonlyWire<T[Key]> } : T;

/** Rust validates identities and exact-value fields. Check the DTO shape here,
 * then restore the contract's brands without parsing or copying JSON values. */
function nativeContract<Wire, Contract extends ReadonlyWire<Wire>>(value: Wire): Contract {
  return value as unknown as Contract;
}
export async function stopExecution(request: StopRequest): Promise<PublicStopState> {
  return nativeContract<PublicStopStateWire, PublicStopState>(await invoke<PublicStopStateWire>('execution_stop', { request: { ...request, activationId: request.activationId ?? null } }));
}

export function executionModelChoices(): Promise<NativeModelCatalogue> {
  return invoke<NativeModelCatalogue>('execution_model_choices');
}

/** Canonical source discovery and assessment only; no Agent or effect admission. */
export function preflightExecution(request: ExecutionPreflightRequest): Promise<ExecutionPreflight> {
  return invoke<ExecutionPreflight>('execution_preflight', { request });
}

export function executionCodexStatus(): Promise<import('../../types/generated/ipc').CodexStatus> {
  return invoke('execution_codex_status');
}
export function executionClaudeStatus(): Promise<import('../../types/generated/ipc').ClaudeStatus> { return invoke('execution_claude_status'); }
export function executionClaudeSetApiKey(apiKey: string): Promise<void> { return invoke('execution_claude_set_api_key', { apiKey }); }
