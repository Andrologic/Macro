import type { FlowDocumentContract } from '../agsdl/contract';
import type { ExactJsonText, SourceRevision, StaticAssessment, StepAddress } from './contracts';

export const COMPILED_PLAN_FORMAT030 = 'macro-agsdl-compiled-plan/2' as const;
export const EXECUTION_PROFILE030 = 'macro-agsdl-030-v1' as const;
export type ExecutionProfile030 = typeof EXECUTION_PROFILE030;
/** Empty at the flow root; otherwise the address of the owning compose step. */
export type ScopeAddress030 = readonly string[];
export interface Diagnostic030 {
  readonly code: string;
  readonly pointer: string;
  readonly message: string;
  readonly severity: 'error' | 'warning';
  readonly step?: StepAddress;
}
export interface RuntimeAssessment030 {
  readonly profile: typeof EXECUTION_PROFILE030;
  readonly registryVersion: string;
  readonly source: SourceRevision | null;
  readonly supported: boolean;
  readonly diagnostics: readonly Diagnostic030[];
  readonly unassessed: readonly string[];
}
export interface EngineVersions030 {
  readonly snapshot: '2';
  readonly contract: FlowDocumentContract;
  readonly compiler: string;
  readonly runtime: string;
  readonly registry: string;
  readonly profile: typeof EXECUTION_PROFILE030;
}
export type InstanceSelector030 =
  | { readonly kind: 'shared' }
  | { readonly kind: 'named'; readonly name: string }
  | { readonly kind: 'new' };
export interface CompiledScope030 {
  readonly address: ScopeAddress030;
  readonly parent: ScopeAddress030 | null;
  readonly composition: string | null;
  readonly entry: StepAddress;
  readonly outputs: readonly string[];
  readonly agents: Readonly<Record<string, string>>;
}
export type CompiledTarget030 =
  | { readonly kind: 'step'; readonly address: StepAddress;
      readonly messageJson: ExactJsonText | null; readonly eachPathJson: ExactJsonText | null;
      readonly concurrencyJson: ExactJsonText | null; readonly maxJson: ExactJsonText | null }
  | { readonly kind: 'output'; readonly scope: ScopeAddress030; readonly name: string };
export interface CompiledRoute030 {
  readonly source: StepAddress;
  readonly kind: 'normal' | 'error';
  /** Null for an unconditional route. Choice/outcome/output names otherwise. */
  readonly key: string | null;
  readonly declarationJson: ExactJsonText;
  readonly targets: readonly CompiledTarget030[];
  /** True only for the flow.onError shorthand, expanded onto covered steps. */
  readonly inherited: boolean;
}
export interface CompiledStep030 {
  readonly address: StepAddress;
  readonly scope: ScopeAddress030;
  readonly type: 'agent' | 'call' | 'approval' | 'compose' | 'join';
  readonly declarationJson: ExactJsonText;
  readonly agent: string | null;
  readonly instance: InstanceSelector030 | null;
  /** Null for non-agents or a new instance; otherwise effective queue/steer. */
  readonly delivery: 'queue' | 'steer' | null;
  readonly maxVisitsJson: ExactJsonText | null;
  readonly timeoutMsJson: ExactJsonText | null;
  /** Exact serialized AgentWorkContract030 from lot 04; no runtime state. */
  readonly submissionContractJson: ExactJsonText | null;
}
export interface CompiledJoin030 {
  readonly address: StepAddress;
  readonly scope: ScopeAddress030;
  readonly origin: StepAddress;
  readonly branches: readonly { readonly name: string; readonly target: StepAddress;
    readonly members: readonly StepAddress[]; readonly fanout: boolean }[];
  readonly mode: 'all' | 'quorum';
  readonly failures: 'fail' | 'keep';
  readonly maxFailuresJson: ExactJsonText | null;
  readonly quorumCountJson: ExactJsonText | null;
  readonly accept: readonly string[];
  readonly remaining: 'stop' | 'finish' | 'wait';
}
export interface CompiledHandler030 {
  readonly address: StepAddress;
  readonly scope: ScopeAddress030;
  readonly local: boolean;
  readonly flow: boolean;
  /** Containing branches in this scope, innermost first. Parent scopes stay explicit. */
  readonly joins: readonly { readonly join: StepAddress; readonly branch: string }[];
}
export interface CapabilityObservation030 {
  readonly name: string;
  readonly support: 'native' | 'approximate' | 'absent';
  /** Native qualification receipt. A module declaration is not evidence. */
  readonly evidenceJson: ExactJsonText;
}
export interface HarnessObservation030 {
  readonly harness: string;
  readonly version: string | null;
  readonly installation: 'available' | 'missing';
  readonly adapterId: string | null;
  readonly qualified: boolean;
  readonly capabilities: readonly CapabilityObservation030[];
  readonly models: readonly { readonly name: string; readonly efforts: readonly string[];
    readonly defaultEffort: string | null }[];
  readonly defaultModel: string | null;
}
export interface AgentObservation030 {
  readonly agentName: string;
  readonly agentDeclarationJson: ExactJsonText;
  readonly settingsJson: ExactJsonText;
  /** Effective ceiling computed and enforced by the native permission authority. */
  readonly permissionsJson: ExactJsonText;
  readonly scopeJson: ExactJsonText;
  readonly evidenceJson: ExactJsonText;
  /** Captured content provenance envelope supplied by lot 11, outside authored JSON. */
  readonly provenanceJson: ExactJsonText;
}
export interface CapturedRegistry030 {
  readonly format: 'macro-agsdl-registry/030';
  readonly version: string;
  /** Exact, validated modules. An empty list means no modules, not bundled defaults. */
  readonly modules: readonly { readonly harness: string; readonly moduleJson: ExactJsonText }[];
  /** Native host qualification for command, MCP and human approval effects. */
  readonly hostCapabilities?: readonly CapabilityObservation030[];
  readonly harnesses: readonly HarnessObservation030[];
  readonly agents: readonly AgentObservation030[];
}
export interface FrozenAgentConfiguration030 extends AgentObservation030 {
  readonly harness: string;
  readonly harnessVersion: string;
  readonly adapterId: string;
  readonly modelName: string;
  readonly modelEffort: string | null;
}
export interface CompiledPlan030 {
  readonly format: typeof COMPILED_PLAN_FORMAT030;
  readonly versions: EngineVersions030;
  readonly source: SourceRevision;
  readonly documentJson: ExactJsonText;
  readonly agents: readonly FrozenAgentConfiguration030[];
  readonly entry: StepAddress | null;
  readonly scopes: readonly CompiledScope030[];
  readonly steps: readonly CompiledStep030[];
  readonly routes: readonly CompiledRoute030[];
  readonly joins: readonly CompiledJoin030[];
  readonly handlers: readonly CompiledHandler030[];
  readonly graphlessSubmissionContracts: Readonly<Record<string, ExactJsonText>>;
}
export interface CompilationResult030 {
  readonly static: Omit<StaticAssessment, 'diagnostics'> & { readonly diagnostics: readonly Diagnostic030[] };
  readonly runtime: RuntimeAssessment030;
  readonly plan: CompiledPlan030 | null;
  readonly compiledPlanJson: ExactJsonText | null;
  readonly productRuntimeAvailable: boolean;
}
