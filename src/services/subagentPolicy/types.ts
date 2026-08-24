import type { ReasoningEffort } from "../../types";

export const AGENT_CAPABILITIES = [
  "workspace.read",
  "workspace.write",
  "command.read",
  "command.mutate",
  "git.read",
  "git.write",
  "web.read",
  "worktree.create",
  "delegate",
] as const;

export type AgentCapability = (typeof AGENT_CAPABILITIES)[number];

export interface DelegationLimits {
  /** Maximum depth of the child being authorized. A root agent is at depth 0. */
  maxChildDepth: number;
  /** Maximum number of concurrent children owned by one parent. */
  maxConcurrencyPerParent: number;
  maxContextBytes: number;
  maxTurns?: number;
  maxTokens?: number;
}

export interface AgentDefinition {
  id: string;
  role: string;
  description: string;
  model?: string;
  effort?: ReasoningEffort;
  capabilities: AgentCapability[];
  limitations: string[];
  limits: DelegationLimits;
}

export interface DelegationPolicyScope {
  capabilities: readonly AgentCapability[];
  limits?: Partial<DelegationLimits>;
}

export interface EffectiveDelegationPolicy {
  capabilities: AgentCapability[];
  limits: DelegationLimits;
}

export interface DelegationRelevantArea {
  path: string;
  reason?: string;
}

export interface DelegationContext {
  objective: string;
  successCriteria: string[];
  relevantAreas: DelegationRelevantArea[];
  constraints: string[];
  establishedFacts: string[];
  responseFormat: string;
}

export interface DelegationContextInput {
  objective: string;
  successCriteria: readonly string[];
  relevantAreas?: readonly DelegationRelevantArea[];
  constraints?: readonly string[];
  establishedFacts?: readonly string[];
  responseFormat: string;
}

export type DelegationErrorCode =
  | "invalid_agent_definition"
  | "invalid_context"
  | "invalid_preflight"
  | "capability_not_allowed"
  | "depth_limit_reached"
  | "concurrency_limit_reached"
  | "turn_budget_exhausted"
  | "token_budget_exhausted"
  | "context_too_large"
  | "cancelled";

export interface DelegationError {
  code: DelegationErrorCode;
  message: string;
  path?: string;
  details?: Record<string, boolean | number | string | string[]>;
}

export type DelegationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: DelegationError[] };

export interface DelegationUsage {
  /** Non-negative amount already consumed from this child's effective budget. */
  turns?: number;
  /** Non-negative amount already consumed from this child's effective budget. */
  tokens?: number;
}

export interface DelegationCancellation {
  cancelled: boolean;
  reason?: string;
}

export interface DelegationPreflightInput {
  userPolicy: DelegationPolicyScope;
  parentPolicy: DelegationPolicyScope;
  childDefinition: AgentDefinition;
  modePolicy?: DelegationPolicyScope;
  requiredCapabilities?: readonly AgentCapability[];
  /** Depth of the parent requesting this delegation. */
  parentDepth: number;
  /** Number of active children currently owned by this parent. */
  activeDelegationsForParent: number;
  usage?: DelegationUsage;
  cancellation?: DelegationCancellation;
  context: DelegationContext;
}

export interface DelegationAuthorization {
  agentId: string;
  model?: string;
  effort?: ReasoningEffort;
  serializedContext: string;
  policy: EffectiveDelegationPolicy;
  childDepth: number;
  activeDelegationsForParent: number;
  remainingTurns?: number;
  remainingTokens?: number;
}
