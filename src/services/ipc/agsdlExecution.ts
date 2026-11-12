import type {
ExecutionPreflight,
ExecutionPreflightRequest,
HostCompileJob,
HostRouteCompletion030,
HostRouteJob030,
HostWorkCompletion030,
HostWorkJob030,
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

/** Private: the backend verifies the physical webview resource and incarnation. */
export function executionHostReady(): Promise<string> {
  return invoke<string>('execution_host_ready');
}
export function executionModelChoices(): Promise<NativeModelCatalogue> {
  return invoke<NativeModelCatalogue>('execution_model_choices');
}

/** Private mailbox. Native caller resources and generation authenticate each operation. */
export function executionHostNextCompile(): Promise<HostCompileJob> {
  return invoke<HostCompileJob>('execution_host_next_compile');
}
export function executionHostCompleteCompile(ticket: string, resultJson: string): Promise<void> {
  return invoke<void>('execution_host_complete_compile', { ticket, resultJson });
}

/** The native mailbox authenticates the resident webview and correlates each ticket. */
export function executionHostNextWork030(): Promise<HostWorkJob030> {
  return invoke<HostWorkJob030>('execution_host_next_work030');
}
export function executionHostCompleteWork030(completion: HostWorkCompletion030): Promise<void> {
  return invoke<void>('execution_host_complete_work030', { completion });
}

/** The route mailbox is available only to the authenticated resident host. */
export function executionHostNextRoute030(): Promise<HostRouteJob030> {
  return invoke<HostRouteJob030>('execution_host_next_route030');
}
export function executionHostCompleteRoute030(completion: HostRouteCompletion030): Promise<void> {
  return invoke<void>('execution_host_complete_route030', { completion });
}

export function executionHostFailed(): Promise<void> {
  return invoke<void>('execution_host_failed');
}

/** Canonical source discovery and assessment only; no Agent or effect admission. */
export function preflightExecution(request: ExecutionPreflightRequest): Promise<ExecutionPreflight> {
  return invoke<ExecutionPreflight>('execution_preflight', { request });
}

/** Isolated debug QA profile only; native code refuses ordinary app profiles. */
export function executionQaAvailable(): Promise<boolean> { return invoke('execution_qa_available'); }
export function executionQaReplaceHost(): Promise<void> { return invoke('execution_qa_replace_host'); }

export function executionCodexStatus(): Promise<import('../../types/generated/ipc').CodexStatus> {
  return invoke('execution_codex_status');
}
export function executionClaudeStatus(): Promise<import('../../types/generated/ipc').ClaudeStatus> { return invoke('execution_claude_status'); }
export function executionClaudeSetApiKey(apiKey: string): Promise<void> { return invoke('execution_claude_set_api_key', { apiKey }); }
