import type {
  DecisionRequest, DecisionLedger, DecisionRecord, DecisionContext,
  DecisionStepReceipt, DecisionBirthReceipt, DecisionTerminal, DecisionActivation,
  DecisionStatus, DecisionSourceStatus, DecisionDefinitions,
} from './transfer-decision.js';

export type Failure = { valid: false; code: DecisionDefinitions['errorCode']; errors: ['Invalid transfer decision'] };
export type Validation = Failure | { valid: true; errors: [] };
export type Receipt = DecisionStepReceipt | DecisionBirthReceipt | DecisionTerminal | DecisionActivation;
export type DecisionPlan = Failure
  | { valid: true; kind: 'mutation'; errors: []; ledger: DecisionLedger; record: DecisionRecord | null; receipt: Receipt | null; reservation_bytes: string }
  | { valid: true; kind: 'retry' | 'terminal'; errors: []; receipt: Receipt; status: DecisionStatus | null }
  | { valid: true; kind: 'status'; errors: []; status: DecisionStatus }
  | { valid: true; kind: 'source_status'; errors: []; status: DecisionSourceStatus };
export type MaintenanceReason = 'session_invalidated' | 'access_changed' | 'producer_changed' | 'account_revoked' | 'operator_cancelled' | 'restore_uncertain';
export type FingerprintDomain = 'source-key' | 'provenance' | 'transfer-binding' | 'retry-body' | 'step-body' | 'birth' | 'frozen' | 'manifest' | 'prepared' | 'attestation' | 'terminal' | 'activation';
export interface DecisionValidator {
  validateObject(value: unknown, definition?: keyof DecisionDefinitions): Validation;
  decodeDecision<K extends keyof DecisionDefinitions>(raw: string, definition: K): Failure | { valid: true; errors: []; value: DecisionDefinitions[K] };
  validateExchange(request: unknown, plan: unknown): Validation;
  validateProducerAttestation(attestation: unknown, exchange: unknown, selected: unknown, authenticatedConnection: unknown): Validation;
  /** Pure synchronous plan. Adapter authenticates, performs atomic CAS, consumes
   * challenges, accounts bytes and commits durably before publishing the receipt. */
  planDecision(request: DecisionRequest, ledger: DecisionLedger | null, record: DecisionRecord | null, context: DecisionContext): DecisionPlan;
  /** Trusted adapter-only entry point, never selected by a network request. */
  planMaintenance(ledger: DecisionLedger, record: DecisionRecord, context: DecisionContext, reason: MaintenanceReason): DecisionPlan;
}
export const LIMITS: Readonly<{ envelope: 16384; terminal: 8192; ledger: 8192; record: 131072 }>;
export function exactInteger(value: string): bigint;
export function increment(value: string): string;
export function addBytes(...values: string[]): string;
export function fromSafeInteger(value: number): string;
export function canonicalJson(value: unknown): string;
export function canonicalBytes(value: unknown): Uint8Array;
export function metadataBytes(value: unknown): number;
export function fingerprint(domain: FingerprintDomain, value: unknown): string;
export function createTransferDecisionValidator(shape: (value: unknown, definition?: keyof DecisionDefinitions) => boolean): DecisionValidator;
export const validateObject: DecisionValidator['validateObject'];
export const decodeDecision: DecisionValidator['decodeDecision'];
export const validateExchange: DecisionValidator['validateExchange'];
export const validateProducerAttestation: DecisionValidator['validateProducerAttestation'];
export const planDecision: DecisionValidator['planDecision'];
export const planMaintenance: DecisionValidator['planMaintenance'];
