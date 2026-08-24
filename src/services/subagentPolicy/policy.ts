import {
  buildDelegationContext,
  getDelegationContextSize,
  serializeDelegationContext,
} from "./context";
import type {
  AgentCapability,
  DelegationAuthorization,
  DelegationError,
  DelegationPolicyScope,
  DelegationPreflightInput,
  DelegationResult,
  EffectiveDelegationPolicy,
} from "./types";
import { AGENT_CAPABILITIES } from "./types";
import { normalizeCapabilities, validateAgentDefinition } from "./validation";

export const V1_READ_ONLY_CAPABILITIES = Object.freeze([
  "workspace.read",
  "command.read",
  "git.read",
  "web.read",
] as const satisfies readonly AgentCapability[]);

export const V1_DELEGATION_RESTRICTIONS: DelegationPolicyScope = Object.freeze({
  capabilities: V1_READ_ONLY_CAPABILITIES,
  limits: Object.freeze({
    maxChildDepth: 1,
    maxConcurrencyPerParent: 4,
    maxContextBytes: 64 * 1024,
  }),
});

const minDefined = (values: Array<number | undefined>): number | undefined => {
  const defined = values.filter((value): value is number => value !== undefined);
  if (defined.some((value) => !Number.isSafeInteger(value) || value <= 0)) return 0;
  return defined.length > 0 ? Math.min(...defined) : undefined;
};

const intersectCapabilities = (
  scopes: readonly DelegationPolicyScope[]
): AgentCapability[] => {
  const [first, ...rest] = scopes;
  if (!first) return [];
  return normalizeCapabilities(
    first.capabilities.filter((capability) =>
      rest.every((scope) => scope.capabilities.includes(capability))
    )
  );
};

export const resolveEffectiveDelegationPolicy = (input: {
  userPolicy: DelegationPolicyScope;
  parentPolicy: DelegationPolicyScope;
  childPolicy: DelegationPolicyScope;
  modePolicy?: DelegationPolicyScope;
}): EffectiveDelegationPolicy => {
  const scopes = [
    input.userPolicy,
    input.parentPolicy,
    input.childPolicy,
    input.modePolicy ?? V1_DELEGATION_RESTRICTIONS,
    V1_DELEGATION_RESTRICTIONS,
  ];
  const limits = scopes.map((scope) => scope.limits ?? {});
  const maxChildDepth = minDefined(limits.map((limit) => limit.maxChildDepth)) ?? 1;
  const maxConcurrencyPerParent =
    minDefined(limits.map((limit) => limit.maxConcurrencyPerParent)) ?? 1;
  const maxContextBytes = minDefined(limits.map((limit) => limit.maxContextBytes)) ?? 1;
  const maxTurns = minDefined(limits.map((limit) => limit.maxTurns));
  const maxTokens = minDefined(limits.map((limit) => limit.maxTokens));

  return {
    capabilities: intersectCapabilities(scopes),
    limits: {
      maxChildDepth,
      maxConcurrencyPerParent,
      maxContextBytes,
      ...(maxTurns === undefined ? {} : { maxTurns }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
    },
  };
};

const makeError = (
  code: DelegationError["code"],
  message: string,
  details?: DelegationError["details"]
): DelegationError => ({ code, message, ...(details ? { details } : {}) });

/** Translates a parent depth into the depth carried by its direct child. */
export const getChildDepth = (parentDepth: number): number => parentDepth + 1;

export const authorizeDelegation = (
  input: DelegationPreflightInput
): DelegationResult<DelegationAuthorization> => {
  const definition = validateAgentDefinition(input.childDefinition);
  if (!definition.ok) return definition;

  const policy = resolveEffectiveDelegationPolicy({
    userPolicy: input.userPolicy,
    parentPolicy: input.parentPolicy,
    childPolicy: definition.value,
    modePolicy: input.modePolicy,
  });
  const errors: DelegationError[] = [];

  if (input.cancellation?.cancelled) {
    errors.push(
      makeError("cancelled", input.cancellation.reason?.trim() || "Delegation was cancelled.")
    );
  }

  const delegationAuthorities = [
    ["userPolicy", input.userPolicy] as const,
    ["parentPolicy", input.parentPolicy] as const,
    ...(input.modePolicy ? [["modePolicy", input.modePolicy] as const] : []),
  ];
  const delegationDeniedBy = delegationAuthorities
    .filter(([, scope]) => !scope.capabilities.includes("delegate"))
    .map(([name]) => name);
  if (delegationDeniedBy.length > 0) {
    errors.push({
      ...makeError(
        "capability_not_allowed",
        `Delegation is not allowed by: ${delegationDeniedBy.join(", ")}.`,
        { authorities: delegationDeniedBy }
      ),
      path: "delegate",
    });
  }

  const requiredCapabilities = Array.isArray(input.requiredCapabilities)
    ? input.requiredCapabilities
    : [];
  if (input.requiredCapabilities !== undefined && !Array.isArray(input.requiredCapabilities)) {
    errors.push({
      code: "invalid_preflight",
      path: "requiredCapabilities",
      message: "Expected an array of known agent capabilities.",
    });
  }
  requiredCapabilities.forEach((capability, index) => {
    if (
      typeof capability !== "string" ||
      !AGENT_CAPABILITIES.includes(capability as AgentCapability)
    ) {
      errors.push({
        code: "invalid_preflight",
        path: `requiredCapabilities[${index}]`,
        message: "Unknown agent capability.",
      });
    }
  });
  const deniedCapabilities = normalizeCapabilities(requiredCapabilities).filter(
    (capability) => !policy.capabilities.includes(capability)
  );
  if (deniedCapabilities.length > 0) {
    errors.push(
      makeError(
        "capability_not_allowed",
        `Required capabilities are not allowed: ${deniedCapabilities.join(", ")}.`,
        { capabilities: deniedCapabilities }
      )
    );
  }

  const validParentDepth = Number.isSafeInteger(input.parentDepth) && input.parentDepth >= 0;
  const childDepth = validParentDepth ? getChildDepth(input.parentDepth) : 0;
  if (!validParentDepth) {
    errors.push({
      code: "invalid_preflight",
      path: "parentDepth",
      message: "Expected a non-negative safe integer.",
    });
  } else if (childDepth > policy.limits.maxChildDepth) {
    errors.push(
      makeError(
        "depth_limit_reached",
        `Child depth ${childDepth} exceeds limit ${policy.limits.maxChildDepth}.`,
        { childDepth, maxChildDepth: policy.limits.maxChildDepth }
      )
    );
  }

  const validActiveDelegations =
    Number.isSafeInteger(input.activeDelegationsForParent) &&
    input.activeDelegationsForParent >= 0;
  if (!validActiveDelegations) {
    errors.push({
      code: "invalid_preflight",
      path: "activeDelegationsForParent",
      message: "Expected a non-negative safe integer.",
    });
  } else if (input.activeDelegationsForParent >= policy.limits.maxConcurrencyPerParent) {
    errors.push(
      makeError(
        "concurrency_limit_reached",
        `Parent active delegation count ${input.activeDelegationsForParent} reaches limit ${policy.limits.maxConcurrencyPerParent}.`,
        {
          activeDelegationsForParent: input.activeDelegationsForParent,
          maxConcurrencyPerParent: policy.limits.maxConcurrencyPerParent,
        }
      )
    );
  }

  const usedTurns = input.usage?.turns ?? 0;
  const validUsedTurns = Number.isSafeInteger(usedTurns) && usedTurns >= 0;
  if (!validUsedTurns) {
    errors.push({
      code: "invalid_preflight",
      path: "usage.turns",
      message: "Expected a non-negative safe integer.",
    });
  } else if (policy.limits.maxTurns !== undefined && usedTurns >= policy.limits.maxTurns) {
    errors.push(
      makeError(
        "turn_budget_exhausted",
        `Turn usage ${usedTurns} reaches limit ${policy.limits.maxTurns}.`,
        { usedTurns, maxTurns: policy.limits.maxTurns }
      )
    );
  }

  const usedTokens = input.usage?.tokens ?? 0;
  const validUsedTokens = Number.isSafeInteger(usedTokens) && usedTokens >= 0;
  if (!validUsedTokens) {
    errors.push({
      code: "invalid_preflight",
      path: "usage.tokens",
      message: "Expected a non-negative safe integer.",
    });
  } else if (policy.limits.maxTokens !== undefined && usedTokens >= policy.limits.maxTokens) {
    errors.push(
      makeError(
        "token_budget_exhausted",
        `Token usage ${usedTokens} reaches limit ${policy.limits.maxTokens}.`,
        { usedTokens, maxTokens: policy.limits.maxTokens }
      )
    );
  }

  const context = buildDelegationContext(input.context);
  if (!context.ok) {
    errors.push(...context.errors);
  }
  const contextBytes = context.ok ? getDelegationContextSize(context.value) : 0;
  if (context.ok && contextBytes > policy.limits.maxContextBytes) {
    errors.push(
      makeError(
        "context_too_large",
        `Delegation context is ${contextBytes} bytes; limit is ${policy.limits.maxContextBytes}.`,
        { actualBytes: contextBytes, maxContextBytes: policy.limits.maxContextBytes }
      )
    );
  }

  if (errors.length > 0) return { ok: false, errors };
  if (!context.ok) return context;

  return {
    ok: true,
    value: {
      agentId: definition.value.id,
      ...(definition.value.model ? { model: definition.value.model } : {}),
      ...(definition.value.effort ? { effort: definition.value.effort } : {}),
      serializedContext: serializeDelegationContext(context.value),
      policy,
      childDepth,
      activeDelegationsForParent: input.activeDelegationsForParent,
      ...(policy.limits.maxTurns === undefined
        ? {}
        : { remainingTurns: policy.limits.maxTurns - usedTurns }),
      ...(policy.limits.maxTokens === undefined
        ? {}
        : { remainingTokens: policy.limits.maxTokens - usedTokens }),
    },
  };
};
