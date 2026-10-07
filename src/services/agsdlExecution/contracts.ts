/** Proposed execution boundary. These declarations do not implement a runtime. */
export type Identity<Kind extends string> = string & { readonly __identity: Kind };
export type SystemStartId = Identity<'systemStart'>;
export type FlowInvocationId = Identity<'flowInvocation'>;
export type AgentInstanceId = Identity<'agentInstance'>;
export type ActivationId = Identity<'activation'>;
export type DeliveryId = Identity<'delivery'>;
export type ProviderAttemptId = Identity<'providerAttempt'>;
export type ToolInvocationId = Identity<'toolInvocation'>;
export type ResponseMessageId = Identity<'responseMessage'>;
/** Canonical nonnegative decimal integers on the wire, never JS numbers. */
export type Sequence = Identity<'sequence'>;
export type OwnerEpoch = Identity<'ownerEpoch'>;
/** Validated with the exact vendor reader; never JSON.parse/structuredClone. */
export type ExactJsonText = Identity<'exactJsonText'>;
export type Sha256 = Identity<'sha256'>;
export type StepAddress = readonly [string, ...string[]];
export type ExecutionProfile = 'macro-serial-inline-v1';

export interface SourceOwner {
  readonly projectId: string;
  readonly planId: string;
  readonly branch: string;
}
export interface SourceRevision {
  readonly owner: SourceOwner;
  readonly revision: string;
  readonly sourceSha256: Sha256;
}
export interface Associations {
  readonly taskId?: string;
  readonly workspaceId?: string;
  readonly conversationId?: string;
}
export interface EngineVersions {
  readonly snapshot: '1';
  readonly contract: 'agsdl-0.2.0';
  readonly compiler: string;
  readonly runtime: string;
  readonly registry: string;
  readonly profile: ExecutionProfile;
}
export interface FrozenAgentConfiguration {
  readonly agentName: string;
  readonly configurationName: string;
  readonly providerId: string;
  readonly modelId: string;
  /** Complete expanded declaration, settings, bindings and initialization content. */
  readonly configurationJson: ExactJsonText;
  /** Effective settings and allowed scope, containing identifiers but no credentials. */
  readonly settingsJson: ExactJsonText;
  readonly permissionsJson: ExactJsonText;
  readonly scopeJson: ExactJsonText;
}
export interface SystemSnapshot {
  readonly systemStartId: SystemStartId;
  readonly source: SourceRevision;
  /** Exact authored UTF-8 source, including whitespace. SHA covers these bytes. */
  readonly authoredSource: string;
  readonly versions: EngineVersions;
  readonly agents: readonly FrozenAgentConfiguration[];
  /** Exact compiled representation, pinned to versions.compiler. */
  readonly compiledPlanJson: ExactJsonText;
  readonly associations: Associations;
}
export interface Diagnostic {
  readonly code: string;
  readonly pointer: string;
  readonly message: string;
}
export interface StaticAssessment {
  readonly valid: boolean;
  readonly diagnostics: readonly Diagnostic[];
}
export interface RuntimeAssessment {
  readonly profile: ExecutionProfile;
  /** Empty when no registry version was captured. */
  readonly registryVersion: string;
  /** Null only for a structurally invalid source capture. Supported work always has a source. */
  readonly source: SourceRevision | null;
  readonly supported: boolean;
  readonly diagnostics: readonly Diagnostic[];
  readonly unassessed: readonly string[];
}
/** Implemented behind native start. A UI assessment is advisory only. */
export interface SnapshotCapturePort {
  capture(request: StartRequest): Promise<SystemSnapshot>;
  assess(snapshot: SystemSnapshot): Promise<{
    readonly static: StaticAssessment;
    readonly runtime: RuntimeAssessment;
  }>;
}
export type ValueOrigin = 'entry' | 'prepare' | 'agent' | 'call' | 'join' | 'error';
export interface FlowValue {
  readonly origin: ValueOrigin;
  /** Condition retains both fields unchanged; shape never determines origin. */
  readonly valueJson: ExactJsonText;
}
export interface WorkIdentity {
  readonly systemStartId: SystemStartId;
  readonly flowInvocationId: FlowInvocationId;
  readonly activationId: ActivationId;
  readonly step: StepAddress | null;
  /** Null for non-Agent work; graphless work has a null step. */
  readonly agentInstanceId: AgentInstanceId | null;
}
export interface AgentInstanceRecord {
  readonly systemStartId: SystemStartId;
  readonly agentInstanceId: AgentInstanceId;
  readonly agentName: string;
  readonly configuration: FrozenAgentConfiguration;
  readonly memory: MemoryCheckpoint | null;
}
export interface FlowInvocationRecord {
  readonly systemStartId: SystemStartId;
  readonly flowInvocationId: FlowInvocationId;
  /** Counters belong to invocation + step, across loop visits. */
  readonly visits: readonly { readonly step: StepAddress; readonly started: Sequence; readonly maxVisits: Sequence | null }[];
}
export interface RuntimeOwner {
  readonly systemStartId: SystemStartId;
  readonly ownerEpoch: OwnerEpoch;
}
export interface DeliveryRequest {
  readonly deliveryId: DeliveryId;
  readonly work: WorkIdentity;
  readonly input: FlowValue;
}
export interface AcceptedDelivery extends DeliveryRequest {
  /** Persisted total order within the Agent queue, before acknowledgement. */
  readonly queueSequence: Sequence;
}
export type WorkState = 'queued' | 'active' | 'uncertain' | 'terminal';
export type StopState =
  | { readonly kind: 'none' }
  | { readonly kind: 'requested'; readonly requestId: string }
  | { readonly kind: 'uncertain'; readonly requestId: string; readonly reason: string }
  | { readonly kind: 'confirmed'; readonly requestId: string; readonly evidenceJson: ExactJsonText };
export interface MemoryCheckpoint {
  readonly agentInstanceId: AgentInstanceId;
  readonly revision: Sequence;
  readonly formatVersion: string;
  readonly stateJson: ExactJsonText;
}
export interface ActivationRecord {
  readonly delivery: AcceptedDelivery;
  readonly workState: WorkState;
  readonly stopState: StopState;
  readonly admittedEpoch?: OwnerEpoch;
  readonly terminal?: TerminalOutcome;
}
export type TerminalOutcome =
  | { readonly kind: 'completed'; readonly output: FlowValue }
  | { readonly kind: 'failed'; readonly code: string; readonly errorJson: ExactJsonText }
  | { readonly kind: 'stopped'; readonly evidenceJson: ExactJsonText };
export interface TerminalCommit {
  readonly owner: RuntimeOwner;
  readonly work: WorkIdentity;
  readonly outcome: TerminalOutcome;
  /** Activity has ended and collection is closed; cancel sent is insufficient. */
  readonly terminationEvidenceJson: ExactJsonText;
  readonly responseCursor: Sequence;
  readonly memory: MemoryCheckpoint | null;
  readonly outgoing: readonly DeliveryRequest[];
}
export interface BeginActivationRequest {
  readonly owner: RuntimeOwner;
  readonly deliveryId: DeliveryId;
}
export type BeginActivationResult =
  | { readonly kind: 'admitted'; readonly activation: ActivationRecord; readonly memory: MemoryCheckpoint | null }
  | { readonly kind: 'waiting'; readonly reason: 'fifo' | 'active' | 'uncertain' }
  | { readonly kind: 'rejected'; readonly code: 'CORRELATION' | 'VISIT_LIMIT' | 'STOP_PENDING' | 'PERMISSION' };
export interface StopRequest {
  readonly systemStartId: SystemStartId;
  readonly requestId: string;
  /** Omission stops the system, closes admission and cancels queued work. */
  readonly activationId?: ActivationId;
}
export interface StartRequest {
  readonly source: SourceRevision;
  readonly profile: ExecutionProfile;
  readonly associations: Associations;
  /** Same key and request recover the same start; conflict is CORRELATION. */
  readonly requestId: string;
  readonly entry: { readonly deliveryId: DeliveryId; readonly messageJson: ExactJsonText } | null;
}
/** External delivery cannot claim an internal origin or choose an activation id. */
export interface ExternalDeliveryRequest {
  readonly systemStartId: SystemStartId;
  readonly deliveryId: DeliveryId;
  readonly agentName: string;
  readonly messageJson: ExactJsonText;
}
export interface StartReceipt {
  readonly systemStartId: SystemStartId;
  readonly flowInvocationId: FlowInvocationId;
  readonly snapshot: SystemSnapshot;
}
export interface ExecutionEvent {
  readonly systemStartId: SystemStartId;
  readonly sequence: Sequence;
  readonly work: WorkIdentity | null;
  readonly kind: 'accepted' | 'admitted' | 'terminal' | 'stop' | 'uncertain' | 'diagnostic' | 'effect';
  readonly payloadJson: ExactJsonText;
}
export interface EventPage {
  readonly events: readonly ExecutionEvent[];
  readonly nextCursor: Sequence;
  readonly hasMore: boolean;
}
export interface ExecutionProjection {
  readonly systemStartId: SystemStartId;
  readonly cursor: Sequence;
  readonly activations: readonly ActivationRecord[];
  readonly systemStop: StopState;
}
export type PublicSnapshot = Pick<SystemSnapshot, 'systemStartId' | 'source' | 'authoredSource' | 'versions' | 'associations'>;
export interface PublicStartReceipt { readonly systemStartId: SystemStartId; readonly flowInvocationId: FlowInvocationId; readonly snapshot: PublicSnapshot }
export type PublicStopState =
  | { readonly kind: 'none' }
  | { readonly kind: 'requested' | 'uncertain' | 'confirmed'; readonly requestId: string };
export interface PublicActivation {
  readonly work: WorkIdentity;
  readonly deliveryId: DeliveryId;
  readonly queueSequence: Sequence;
  readonly workState: WorkState;
  readonly stopState: PublicStopState;
  readonly terminalKind: 'completed' | 'failed' | 'stopped' | null;
}
export interface ProjectionPage {
  readonly cursor: Sequence;
  readonly offset: number;
}
export interface PublicProjection {
  readonly systemStartId: SystemStartId;
  readonly source: SourceRevision;
  readonly cursor: Sequence;
  readonly agents: readonly { readonly agentInstanceId: AgentInstanceId; readonly agentName: string }[];
  readonly activations: readonly PublicActivation[];
  readonly nextPage: ProjectionPage | null;
  readonly systemStop: PublicStopState;
}
export interface PublicEventPage {
  readonly events: readonly Pick<ExecutionEvent, 'systemStartId' | 'sequence' | 'work' | 'kind'>[];
  readonly nextCursor: Sequence;
  readonly hasMore: boolean;
}
/** Only API available to product UI/browser clients. No owner epoch intake. */
export interface ExecutionPublicPort {
  start(request: StartRequest): Promise<PublicStartReceipt>;
  deliver(request: ExternalDeliveryRequest): Promise<AcceptedDelivery>;
  stop(request: StopRequest): Promise<PublicStopState>;
  readSnapshot(id: SystemStartId): Promise<PublicSnapshot>;
  readEvents(id: SystemStartId, after: Sequence | null, limit: number): Promise<PublicEventPage>;
  readProjection(id: SystemStartId, page?: ProjectionPage): Promise<PublicProjection>;
}
/** Native-only transactions. Authenticate caller independently of DTOs. */
export interface ExecutionRepositoryPort extends ExecutionRuntimePort {
  readAgent(id: AgentInstanceId): Promise<AgentInstanceRecord>;
  readInvocation(id: FlowInvocationId): Promise<FlowInvocationRecord>;
  readEffects(work: WorkIdentity): Promise<readonly { readonly registered: EffectRecord; readonly settlement: EffectSettlement | null; readonly resultJson: ExactJsonText | null }[]>;
  /** Validate owner/revision/SHA natively, capture/assess, then persist. */
  start(request: StartRequest): Promise<StartReceipt>;
  acceptDelivery(request: DeliveryRequest): Promise<AcceptedDelivery>;
  /** Atomic FIFO + no active/uncertain work + stop + maxVisits check/increment. */
  beginActivation(request: BeginActivationRequest): Promise<BeginActivationResult>;
  /** Outcome, memory, outgoing queue entries and cursor commit together. */
  commitTerminalAndDeliveries(commit: TerminalCommit): Promise<'committed' | 'duplicate'>;
  readSnapshot(id: SystemStartId): Promise<SystemSnapshot>;
  readEvents(id: SystemStartId, after: Sequence | null, limit: number): Promise<EventPage>;
  stop(request: StopRequest): Promise<StopState>;
}
/** Private commands restricted to the dedicated, native-authorized runtime host. */
export interface ExecutionRuntimePort {
  /** Persist correlation before any provider or Tool effect. Conflicts reject. */
  registerEffect(record: EffectRecord): Promise<'registered' | 'duplicate'>;
  /** Unknown effects retain the activation lock; settlement requires evidence. */
  settleEffect(record: EffectSettlement): Promise<void>;
  beginActivation(request: BeginActivationRequest): Promise<BeginActivationResult>;
  commitTerminalAndDeliveries(commit: TerminalCommit): Promise<'committed' | 'duplicate'>;
  confirmStop(request: {
    readonly owner: RuntimeOwner;
    readonly work: WorkIdentity;
    readonly requestId: string;
    readonly evidenceJson: ExactJsonText;
    readonly responseCursor: Sequence;
    readonly memory: MemoryCheckpoint | null;
  }): Promise<'committed' | 'duplicate'>;
  markUncertain(request: {
    readonly owner: RuntimeOwner;
    readonly work: WorkIdentity;
    readonly reason: string;
  }): Promise<void>;
}
export interface ExecutionContext {
  readonly owner: RuntimeOwner;
  readonly work: WorkIdentity;
  readonly permissionsJson: ExactJsonText;
  readonly scopeJson: ExactJsonText;
  readonly registryVersion: string;
}
export type EffectIdentity =
  | { readonly kind: 'provider'; readonly providerAttemptId: ProviderAttemptId }
  | { readonly kind: 'tool'; readonly toolInvocationId: ToolInvocationId; readonly providerAttemptId: ProviderAttemptId | null };
export interface EffectRecord {
  readonly context: ExecutionContext;
  readonly effect: EffectIdentity;
  readonly invocationJson: ExactJsonText;
}
export type EffectSettlement = {
  readonly context: ExecutionContext;
  readonly evidenceJson: ExactJsonText;
} & (
  | { readonly status: 'ended'; readonly effect: Extract<EffectIdentity, { kind: 'tool' }>; readonly resultJson: ExactJsonText }
  | { readonly status: 'ended'; readonly effect: Extract<EffectIdentity, { kind: 'provider' }>; readonly resultJson?: never }
  | { readonly status: 'uncertain'; readonly effect: EffectIdentity; readonly resultJson?: never }
);
export interface AgentExecutionRequest {
  readonly context: ExecutionContext;
  readonly configuration: FrozenAgentConfiguration;
  readonly messageJson: ExactJsonText;
  readonly memory: MemoryCheckpoint | null;
}
export interface AgentExecutionResult {
  readonly outcome: TerminalOutcome;
  readonly memory: MemoryCheckpoint;
  readonly responseCursor: Sequence;
  readonly terminationEvidenceJson: ExactJsonText;
}
/** Reuse streamingChat/toolCallingLoop and actual-invocation Macro approvals. */
export interface MacroAgentExecutionPort {
  execute(request: AgentExecutionRequest, responses: ResponseCollectionPort): Promise<AgentExecutionResult>;
  requestStop(context: ExecutionContext, requestId: string): Promise<'requested' | 'unsupported'>;
}
export interface MacroInvocationRequest {
  readonly context: ExecutionContext;
  readonly toolInvocationId: ToolInvocationId;
  readonly providerAttemptId: ProviderAttemptId | null;
  readonly bindingJson: ExactJsonText;
  readonly argumentsJson: ExactJsonText;
}
/** Calls and Agent Tools share actual permission/scope checks and explicit bindings. */
export interface MacroInvocationPort {
  invoke(request: MacroInvocationRequest): Promise<{
    readonly outcome: TerminalOutcome;
    readonly terminationEvidenceJson: ExactJsonText;
  }>;
  requestStop(request: MacroInvocationRequest, requestId: string): Promise<'requested' | 'unsupported'>;
}
export interface VisibleResponseMessage {
  readonly context: ExecutionContext;
  readonly providerAttemptId: ProviderAttemptId;
  readonly messageId: ResponseMessageId;
  readonly sequence: Sequence;
  /** Complete visible parts, attributed and filtered by the adapter. */
  readonly textParts: readonly string[];
}
export interface TypedPublication {
  readonly context: ExecutionContext;
  readonly providerAttemptId: ProviderAttemptId;
  readonly publicationId: string;
  readonly sequence: Sequence;
  /** Explicit registry declaration, never prose extraction. */
  readonly contractJson: ExactJsonText;
  readonly resultsJson: ExactJsonText;
  readonly choice: string | null;
}
export interface ResponseCollectionPort {
  /** Call only after the native registerEffect receipt. Native append verifies it again. */
  registerAttempt(context: ExecutionContext, attempt: ProviderAttemptId): Promise<'registered' | 'duplicate'>;
  append(message: VisibleResponseMessage): Promise<'accepted' | 'duplicate'>;
  publish(publication: TypedPublication): Promise<'accepted' | 'duplicate'>;
  close(context: ExecutionContext, finalCursor: Sequence): Promise<{
    readonly text: string;
    readonly resultsJson: ExactJsonText;
    readonly choice: string | null;
    readonly cursor: Sequence;
  }>;
}
export interface ProjectionPort {
  /** Deterministic fold only; no scheduler/provider/terminal side effects. */
  project(previous: ExecutionProjection | null, events: readonly ExecutionEvent[]): ExecutionProjection;
}
export interface ExecutionFailure {
  readonly code: string;
  readonly pointer: string;
  readonly message: string;
  readonly work: WorkIdentity | null;
}
/** Reuse exact vendor values/completion rules in the later conformance lot. */
export interface ExactValuePort {
  equal(left: ExactJsonText, right: ExactJsonText): boolean;
}
