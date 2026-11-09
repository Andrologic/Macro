/**
 * Product contract for AgSDL 0.3. These types grant no native authority and are
 * not generated IPC DTOs. See docs/agsdl-030.md for command adapters and gaps.
 * Native decoders must reject unknown fields and attest every returned fact.
 */
import type {
  EngineSourceRevision,
  EngineVersions,
  ExecutionIntentErrorCode,
  ExecutionIntentAdmission,
  ExecutionIntentDisposition,
  ExecutionIntentPayload,
  ExecutionIntentRefusalCode,
  ExecutionIntentRetryableCode,
  ExecutionIntentScope,
  ExecutionIntentState,
  HumanContent030,
  HumanScope030,
  PublicExecutionIntent,
  PublicSnapshot,
  RuntimeActivation030,
  RuntimeGroup030,
  RuntimeInstance030,
  RuntimePath030,
  RuntimeProjectionScope030,
} from './generated/ipc';

/** Decimal integers and JSON retain their exact wire text, never JS numbers. */
export type RunRevision030 = string;
export type RunJson030 = string;
export type RunVersions030 = Readonly<Omit<EngineVersions, 'snapshot' | 'contract' | 'profile'>> & {
  readonly snapshot: '2';
  readonly contract: 'agsdl-0.3.0';
  readonly profile: 'macro-agsdl-030-v1';
};
export type RunCapture030 = Readonly<Omit<PublicSnapshot, 'versions'>> & {
  readonly versions: RunVersions030;
};
export type RunScope030 = Readonly<RuntimeProjectionScope030>;

/** Narrow by edition before selecting a reader or an action. No fallback. */
export type VersionedRunCaptureUi =
  | { readonly contract: 'agsdl-0.2.0'; readonly capture: Readonly<Omit<PublicSnapshot, 'versions'>> & {
      readonly versions: Readonly<Omit<EngineVersions, 'snapshot' | 'contract' | 'profile'>> & {
        readonly snapshot: '1'; readonly contract: 'agsdl-0.2.0'; readonly profile: 'macro-serial-inline-v1';
      };
    } }
  | { readonly contract: 'agsdl-0.3.0'; readonly capture: RunCapture030 };

/** Missing projection fields are unavailable, not empty, false or zero. */
export type NativeFact030<T> =
  | { readonly kind: 'available'; readonly value: T }
  | { readonly kind: 'unavailable'; readonly gap: NativeDtoGap030 };
export type NativeDtoGap030 =
  | 'qualification' | 'delivery' | 'human-flow-projection' | 'human-purpose'
  | 'human-receipt' | 'question-validator' | 'stop-proof' | 'diagnostics'
  | 'occurrence-details' | 'chronology' | 'uncertainty';

export type RunVerdict030 = 'succeeded' | 'failed' | 'cancelled' | null;
/** Independent of the flow verdict. Only native physical evidence confirms Stop. */
export type RunStop030 =
  | { readonly kind: 'none' }
  | { readonly kind: 'requested'; readonly requestId: string }
  | { readonly kind: 'awaitingPhysicalEnd'; readonly requestId: string; readonly pending: string }
  | { readonly kind: 'stopped'; readonly requestId: string; readonly receiptId: string }
  | { readonly kind: 'uncertain'; readonly requestId: string | null; readonly diagnosticIds: readonly string[] };
export interface RunUncertainty030 {
  readonly id: string;
  readonly subject: 'start' | 'delivery' | 'human' | 'stop' | 'work' | 'owner';
  readonly receiptId: string | null;
  readonly diagnosticIds: readonly string[];
  /** Native reconciliation result. An absent receipt never authorizes replay. */
  readonly state: 'unresolved' | 'reconciled';
}
export interface RunStateUi030 {
  readonly scope: RunScope030;
  readonly flowInvocationId: string;
  readonly revision: RunRevision030;
  readonly verdict: RunVerdict030;
  readonly ownerStatus: 'live' | 'revoked';
  readonly stopping: boolean;
  readonly physicalPending: string;
  readonly stop: NativeFact030<RunStop030>;
  readonly uncertainties: NativeFact030<readonly RunUncertainty030[]>;
  readonly humans: RunRead030<readonly RunHumanRequest030[]>;
  readonly occurrences: RunRead030<readonly RunOccurrence030[]>;
  readonly instances: readonly RuntimeInstance030[];
  readonly groups: readonly RuntimeGroup030[];
  readonly paths: readonly RuntimePath030[];
  readonly diagnostics: RunRead030<readonly RunDiagnostic030[]>;
  readonly chronology: NativeFact030<{
    readonly startedAt: string; readonly endedAt: string | null;
    readonly provenanceJson: RunJson030;
  }>;
}

/** A source pointer is an authoring owner, never the identity of a visit. */
export interface RunOccurrence030 {
  readonly scope: RunScope030;
  readonly activation: Readonly<RuntimeActivation030>;
  readonly details: NativeFact030<{
    readonly sourcePointer: string | null;
    readonly occurrenceId: string;
    readonly visit: string | null;
    readonly countsForFlow: boolean;
    readonly receivedMessageJson: RunJson030 | null;
    readonly outputJson: RunJson030 | null;
    readonly diagnosticIds: readonly string[];
    readonly deliveryActivationId: string | null;
    readonly targetActivationId: string | null;
    readonly senderJson: RunJson030 | null;
  }>;
}
export interface RunDiagnostic030 {
  readonly id: string;
  readonly code: string;
  /** Original diagnostic text is data; translate explanations separately. */
  readonly message: string;
  readonly severity: 'error' | 'warning' | 'info';
  readonly activationId: string | null;
  readonly sourcePointer: string | null;
  readonly step: readonly string[] | null;
  readonly disposition: 'handled' | 'unhandled' | 'notCounting' | 'unknown';
  readonly causeId: string | null;
  readonly handlerStep: readonly string[] | null;
  readonly effectsJson: NativeFact030<RunJson030>;
}

/** Publish only complete, coherent pages; retained stale data stays inspectable. */
export type RunRead030<T> =
  | { readonly kind: 'unavailable'; readonly gap: NativeDtoGap030 }
  | { readonly kind: 'loading'; readonly retained: T | null }
  | { readonly kind: 'ready'; readonly revision: string; readonly value: T }
  | { readonly kind: 'stale'; readonly revision: string; readonly retained: T; readonly refusal: RunRefusal030<'consult'> };

export type RunLaunchGate030 =
  | { readonly kind: 'closed'; readonly assessment: 'notAssessed' | 'unqualified' | 'refused'; readonly diagnostics: readonly RunDiagnostic030[] }
  | { readonly kind: 'qualified'; readonly qualificationId: string; readonly profile: 'macro-agsdl-030-v1';
      readonly registryVersion: string; readonly platform: string; readonly supportedProperties: readonly string[] };
export type RunPreflight030 = {
  readonly source: Readonly<EngineSourceRevision>;
  readonly staticValid: boolean;
  readonly runtimeSupported: boolean;
  readonly incomplete: boolean;
  readonly unassessed: readonly string[];
} & (
  | { readonly launchGate: Extract<RunLaunchGate030, { kind: 'closed' }>; readonly productRuntimeAvailable: false }
  | { readonly launchGate: Extract<RunLaunchGate030, { kind: 'qualified' }>; readonly productRuntimeAvailable: boolean }
);

/** Flow choice and action permission are separate even when both say approval. */
export type RunHumanContent030 =
  | { readonly kind: 'unclassified'; readonly content: Readonly<HumanContent030>; readonly gap: 'human-purpose' }
  | { readonly kind: 'flowChoice'; readonly title: string; readonly description: string;
      readonly messageJson: RunJson030; readonly choices: readonly string[] }
  | { readonly kind: 'actionApproval'; readonly title: string; readonly actionJson: RunJson030 }
  | { readonly kind: 'plan'; readonly plan: string }
  | { readonly kind: 'question'; readonly question: string; readonly expectedResponse: string;
      readonly answerContract: NativeFact030<{ readonly schemaJson: RunJson030; readonly protocol: string }> };
export type RunHumanAnswer030 =
  | { readonly kind: 'approval'; readonly choice: string; readonly comment: string }
  | { readonly kind: 'decision'; readonly decision: 'yes' | 'no'; readonly comment: string }
  | { readonly kind: 'question'; readonly answerJson: RunJson030 };
export type RunHumanState030 =
  | { readonly kind: 'open' }
  | { readonly kind: 'submitted'; readonly receiptId: string }
  | { readonly kind: 'resolved'; readonly receiptId: string; readonly reason: 'answer' | 'answerTimeout' | 'approvalTimeout'; readonly accepted: boolean }
  | { readonly kind: 'consumed'; readonly receiptId: string; readonly resolutionReceiptId: string }
  | { readonly kind: 'expired'; readonly reason: 'answerTimeout' | 'approvalTimeout' }
  | { readonly kind: 'cancelled'; readonly reason: 'stop' | 'ownerLost' | 'workEnded' }
  | { readonly kind: 'uncertain'; readonly receiptId: string | null };
export interface RunHumanRequest030 {
  readonly scope: Readonly<HumanScope030>;
  readonly id: string;
  readonly revision: RunRevision030;
  readonly workIds: readonly string[];
  readonly content: RunHumanContent030;
  readonly state: RunHumanState030;
  /** Same-generation monotone values; no client wall-clock arbitration. */
  readonly clock: NativeFact030<{
    readonly openedAtMs: string; readonly timeoutMs: string | null;
    readonly works: readonly {
      readonly workId: string; readonly machineElapsedMs: string; readonly machinePaused: boolean;
    }[];
  }>;
}
export type RunHumanSubmission030<A extends RunHumanAnswer030 = RunHumanAnswer030> = {
  readonly scope: Readonly<HumanScope030>;
  readonly requestId: string;
  readonly expectedRevision: RunRevision030;
  readonly answer: A;
};
export type RunHumanReceipt030 = {
  readonly scope: Readonly<HumanScope030>;
  readonly requestId: string;
  readonly receiptId: string;
  readonly revision: RunRevision030;
  readonly state: RunHumanState030;
};
export type RunHumanDraft030<A extends RunHumanAnswer030 = RunHumanAnswer030> = {
  readonly scope: Readonly<HumanScope030>;
  readonly requestId: string;
  readonly basedOnRevision: string;
  readonly answer: A;
};

/** Client ids are public deduplication keys, never epochs or host capabilities. */
export interface RunStartInput030 {
  readonly scope: Readonly<ExecutionIntentScope>;
  readonly id: string;
  readonly expected: Readonly<EngineSourceRevision>;
  readonly response: { readonly entryMessageJson: RunJson030 | null };
}
export type RunDeliveryTarget030 =
  | { readonly agentName: string; readonly instance: { readonly kind: 'shared' } }
  | { readonly agentName: string; readonly instance: { readonly kind: 'named'; readonly name: string } };
export interface RunDeliveryInput030 {
  readonly scope: RunScope030;
  readonly id: string;
  readonly expectedRevision: RunRevision030;
  readonly response: { readonly target: RunDeliveryTarget030; readonly messageJson: RunJson030 };
}
export interface RunDeliveryReceipt030 {
  /** Required native extension; historical `deliver` is not a 0.3 receipt. */
  readonly kind: 'deliver030';
  readonly scope: RunScope030;
  readonly id: string;
  readonly receiptId: string;
  readonly revision: RunRevision030;
  readonly deliveryActivationId: string;
  readonly state:
    | { readonly kind: 'queued'; readonly instanceId: string }
    | { readonly kind: 'started'; readonly activationId: string }
    | { readonly kind: 'steerPending'; readonly targetActivationId: string }
    | { readonly kind: 'absorbed'; readonly targetActivationId: string; readonly consumptionReceiptId: string }
    | { readonly kind: 'withdrawn' }
    | { readonly kind: 'uncertain' };
}

export type RunStartIntent030 = Readonly<Omit<PublicExecutionIntent, 'payload' | 'state'>> & {
  readonly payload: {
    readonly kind: 'start';
    readonly request: Omit<Extract<ExecutionIntentPayload, { kind: 'start' }>['request'], 'profile'> & {
      readonly profile: 'macro-agsdl-030-v1';
    };
  };
  readonly state:
    | Exclude<ExecutionIntentState, { kind: 'admitted' | 'closed' }>
    | { readonly kind: 'admitted'; readonly admission: Extract<ExecutionIntentAdmission, { kind: 'start030' }> }
    | { readonly kind: 'closed'; readonly disposition: ExecutionIntentDisposition;
        readonly admission: Extract<ExecutionIntentAdmission, { kind: 'start030' }> | null };
};

export interface RunActionInputs030 {
  readonly consult: { readonly scope: RunScope030 };
  readonly preflight: { readonly scope: Readonly<ExecutionIntentScope>; readonly expected: Readonly<EngineSourceRevision> | null };
  readonly start: RunStartInput030;
  readonly queue: RunDeliveryInput030;
  readonly steer: RunDeliveryInput030;
  readonly flowChoice: RunHumanSubmission030<Extract<RunHumanAnswer030, { kind: 'approval' }>>;
  readonly actionApproval: RunHumanSubmission030<Extract<RunHumanAnswer030, { kind: 'decision' }>>;
  readonly plan: RunHumanSubmission030<Extract<RunHumanAnswer030, { kind: 'decision' }>>;
  readonly question: RunHumanSubmission030<Extract<RunHumanAnswer030, { kind: 'question' }>>;
  /** System Stop only. Native admission arbitrates against the latest state. */
  readonly stop: { readonly scope: RunScope030; readonly id: string };
  readonly inspectUncertainty: { readonly scope: RunScope030; readonly id: string };
}
export interface RunActionReceipts030 {
  readonly consult: RunStateUi030;
  readonly preflight: RunPreflight030;
  /** Preserve the native start/start030/deliver admission discriminants. */
  readonly start: RunStartIntent030;
  readonly queue: RunDeliveryReceipt030;
  readonly steer: RunDeliveryReceipt030;
  readonly flowChoice: RunHumanReceipt030;
  readonly actionApproval: RunHumanReceipt030;
  readonly plan: RunHumanReceipt030;
  readonly question: RunHumanReceipt030;
  readonly stop: { readonly scope: RunScope030; readonly state: RunStop030 };
  readonly inspectUncertainty: RunUncertainty030;
}
export type RunAction030 = keyof RunActionInputs030;
type CommonRefusal030 = 'SCOPE_INVALID' | 'SCOPE_UNAVAILABLE' | 'CORRELATION' | 'NOT_FOUND' | 'CONTRACT_UNSUPPORTED';
type ActionRefusal030 = {
  consult: 'REVISION_CONFLICT' | 'CONFLICT' | 'INPUT_LIMIT' | 'DTO_UNAVAILABLE';
  preflight: 'SOURCE_CHANGED' | 'HARNESS_REFUSED' | 'POLICY_UNAVAILABLE' | 'DTO_UNAVAILABLE';
  start: ExecutionIntentErrorCode | ExecutionIntentRefusalCode | ExecutionIntentRetryableCode | 'PROFILE_UNQUALIFIED';
  queue: 'REVISION_CONFLICT' | 'IDENTITY_CONFLICT' | 'TARGET_INVALID' | 'TARGET_CLOSED' | 'INPUT_CONSTRAINT' | 'PROFILE_UNQUALIFIED';
  steer: ActionRefusal030['queue'] | 'STEER_UNSUPPORTED';
  flowChoice: 'REVISION_CONFLICT' | 'CONFLICT' | 'INPUT_CONSTRAINT' | 'REQUEST_CLOSED' | 'ANSWER_EXPIRED';
  actionApproval: ActionRefusal030['flowChoice'] | 'HUMAN_PURPOSE_UNATTESTED';
  plan: ActionRefusal030['flowChoice'];
  question: ActionRefusal030['flowChoice'] | 'QUESTION_UNATTESTED';
  stop: 'PARTIAL_STOP_UNAVAILABLE' | 'TARGET_CLOSED';
  inspectUncertainty: 'DTO_UNAVAILABLE';
};
/** Product codes include required extensions; they are not a claim of native support. */
export interface RunRefusal030<A extends RunAction030> {
  readonly code: CommonRefusal030 | ActionRefusal030[A];
  readonly message: string;
  readonly currentRevision: string | null;
}
export type RunActionResult030<A extends RunAction030> =
  | { readonly kind: 'received'; readonly receipt: RunActionReceipts030[A] }
  | { readonly kind: 'refused'; readonly refusal: RunRefusal030<A> }
  | { readonly kind: 'uncertain'; readonly code: 'STORAGE_UNCERTAIN' | 'RUNTIME_UNAVAILABLE' | 'UNCERTAIN' | 'STOP_PENDING'; readonly receiptId: string | null };
/** Navigation detaches observation only. Resume means readback of the same key. */
export type RunActionProgress030<A extends RunAction030> =
  | { readonly kind: 'idle' }
  | { readonly kind: 'pending'; readonly input: RunActionInputs030[A] }
  | { readonly kind: 'retained'; readonly input: RunActionInputs030[A]; readonly result: RunActionResult030<A> };
