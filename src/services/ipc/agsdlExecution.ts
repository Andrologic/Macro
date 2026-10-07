import { invoke } from '../tauriRuntimeBridge';
import { toNativeAiChatRequest, type AiStreamChatInput } from './ai';
import type {
  PublicSnapshot as PublicSnapshotWire, PublicStartReceipt as PublicStartReceiptWire, PublicProjection as PublicProjectionWire, PublicEventPage as PublicEventPageWire, PublicStopState as PublicStopStateWire,
  ApprovalScope, ApprovalPage, ApprovalDecision, PublicApproval, HostToolInvocation, HostToolReceipt, EngineOwner, EngineContext, EngineWork, EngineTerminalCommit, HostInspection, HostAdmission, Prepare, Emission, Closure,
  ExecutionPreflightRequest, ExecutionPreflight, HostCompileJob, RunListRequest, RunPage, DiagnosticRequest, PublicExecutionDiagnostic, NativeModelCatalogue,
} from '../../types/generated/ipc';
import type {
  AcceptedDelivery, ExternalDeliveryRequest, SourceOwner, SystemStartId, Sequence, StartRequest, StopRequest, PublicStartReceipt, PublicSnapshot,
  PublicProjection, ProjectionPage, PublicEventPage, PublicStopState,
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
export async function readExecutionProjection(systemStartId: SystemStartId, page?: ProjectionPage): Promise<PublicProjection> {
  return nativeContract<PublicProjectionWire, PublicProjection>(await invoke<PublicProjectionWire>('execution_read_projection', { systemStartId, page: page ?? null }));
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
export function readExecutionDiagnostic(request: Omit<DiagnosticRequest, 'selected' | 'before' | 'recent'> & Partial<Pick<DiagnosticRequest, 'selected' | 'before' | 'recent'>>): Promise<PublicExecutionDiagnostic> {
  return invoke<PublicExecutionDiagnostic>('execution_read_diagnostic', { request });
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

export function executionHostFailed(): Promise<void> {
  return invoke<void>('execution_host_failed');
}

/** Canonical source discovery and assessment only; no Agent or effect admission. */
export function preflightExecution(request: ExecutionPreflightRequest): Promise<ExecutionPreflight> {
  return invoke<ExecutionPreflight>('execution_preflight', { request });
}

export function executionHostOwners(): Promise<EngineOwner[]> { return invoke('execution_host_owners'); }
export function executionHostInspect(owner: EngineOwner): Promise<HostInspection> { return invoke('execution_host_inspect', { owner }); }
export function executionHostBegin(owner: EngineOwner, deliveryId: string): Promise<HostAdmission> { return invoke('execution_host_begin', { owner, deliveryId }); }
export function executionHostPrepareTerminal(request: Prepare): Promise<string> { return invoke('execution_host_prepare_terminal', { request }); }
export function executionHostCommitTerminal(owner: EngineOwner, witnessId: string): Promise<EngineTerminalCommit> { return invoke('execution_host_commit_terminal', { owner, witnessId }); }
export function executionHostAppendResponse(emission: Emission): Promise<boolean> { return invoke('execution_host_append_response', { emission }); }
export function executionHostReadResponses(owner: EngineOwner, work: EngineWork): Promise<[Emission[], string]> { return invoke('execution_host_read_responses', { owner, work }); }
export function executionHostCloseResponses(closure: Closure): Promise<Closure> { return invoke('execution_host_close_responses', { closure }); }
export function executionHostRegisterProvider(context: EngineContext, request: AiStreamChatInput): Promise<boolean> {
  return invoke('execution_host_register_provider', { context, request: toNativeAiChatRequest(request) });
}
export function executionHostDispatchProvider(context: EngineContext, request: AiStreamChatInput): Promise<void> {
  return invoke('execution_host_dispatch_provider', { context, request: toNativeAiChatRequest(request) });
}
export function executionHostEndProvider(context: EngineContext, requestId: string): Promise<void> {
  return invoke('execution_host_end_provider', { context, requestId });
}

/** External input targets a captured graphless Agent; native code allocates work IDs. */
export async function deliverExecution(request: ExternalDeliveryRequest): Promise<AcceptedDelivery> {
  const receipt = await invoke<import('../../types/generated/ipc').EngineAcceptedDelivery>('execution_deliver', { request });
  return nativeContract<import('../../types/generated/ipc').EngineAcceptedDelivery, AcceptedDelivery>(receipt);
}

export function resolveExecutionCardTask(request: import('../../types/generated/ipc').ResolveCardTask): Promise<import('../../types/generated/ipc').ResolvedCardTask | null> {
  return invoke('execution_resolve_card_task', { request });
}

export function executionHostInvokeTool(request: HostToolInvocation): Promise<HostToolReceipt> {
  return invoke('execution_host_invoke_tool', { request });
}
export function executionHostMarkUncertain(owner: EngineOwner, work: EngineWork, reason: string): Promise<void> {
  return invoke('execution_host_mark_uncertain', { owner, work, reason });
}

export function readExecutionApprovals(request: ApprovalScope): Promise<ApprovalPage> {
  return invoke('execution_pending_approvals', { request });
}
export function decideExecutionApproval(request: ApprovalDecision): Promise<PublicApproval> {
  return invoke('execution_decide_approval', { request });
}

/** Isolated debug QA profile only; native code refuses ordinary app profiles. */
export function executionQaAvailable(): Promise<boolean> { return invoke('execution_qa_available'); }
export function executionQaRun(systemStartId: string, deliveryId: string): Promise<void> { return invoke('execution_qa_run', { systemStartId, deliveryId }); }
export function executionHostQaTake(): Promise<[EngineOwner, string] | null> { return invoke('execution_host_qa_take'); }
export function executionQaReplaceHost(): Promise<void> { return invoke('execution_qa_replace_host'); }
