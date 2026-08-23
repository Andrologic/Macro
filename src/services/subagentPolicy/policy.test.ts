import { describe, expect, it } from "bun:test";
import {
  authorizeDelegation,
  resolveEffectiveDelegationPolicy,
  V1_DELEGATION_RESTRICTIONS,
} from "./policy";
import type {
  AgentCapability,
  AgentDefinition,
  DelegationContext,
  DelegationPolicyScope,
  DelegationPreflightInput,
} from "./types";

const ALL_CAPABILITIES: AgentCapability[] = [
  "workspace.read",
  "workspace.write",
  "command.read",
  "command.mutate",
  "git.read",
  "git.write",
  "web.read",
  "worktree.create",
  "delegate",
];

const CHILD: AgentDefinition = {
  id: "auditor",
  role: "Auditor",
  description: "Inspects a repository.",
  capabilities: [...ALL_CAPABILITIES],
  limitations: ["Read-only"],
  limits: {
    maxChildDepth: 3,
    maxConcurrencyPerParent: 8,
    maxContextBytes: 100_000,
    maxTurns: 20,
    maxTokens: 20_000,
  },
};

const CONTEXT: DelegationContext = {
  objective: "Inspect policy",
  successCriteria: ["Report violations"],
  relevantAreas: [{ path: "src/services" }],
  constraints: ["Read only"],
  establishedFacts: [],
  responseFormat: "Concise text",
};

const scope = (
  capabilities: readonly AgentCapability[],
  limits: DelegationPolicyScope["limits"] = {}
): DelegationPolicyScope => ({ capabilities, limits });

const preflight = (
  overrides: Partial<DelegationPreflightInput> = {}
): DelegationPreflightInput => ({
  userPolicy: scope(ALL_CAPABILITIES),
  parentPolicy: scope(["workspace.read", "git.read", "delegate"]),
  childDefinition: CHILD,
  parentDepth: 0,
  activeDelegationsForParent: 0,
  context: CONTEXT,
  ...overrides,
});

describe("effective subagent policy", () => {
  it("never grants capabilities absent from the parent", () => {
    const result = resolveEffectiveDelegationPolicy({
      userPolicy: scope(ALL_CAPABILITIES),
      parentPolicy: scope(["workspace.read", "git.read"]),
      childPolicy: CHILD,
      modePolicy: scope(ALL_CAPABILITIES),
    });

    expect(result.capabilities).toEqual(["workspace.read", "git.read"]);
    expect(result.capabilities).not.toContain("workspace.write");
    expect(result.capabilities).not.toContain("delegate");
  });

  it("applies the tightest limit from every authority", () => {
    const result = resolveEffectiveDelegationPolicy({
      userPolicy: scope(ALL_CAPABILITIES, {
        maxChildDepth: 4,
        maxConcurrencyPerParent: 3,
        maxContextBytes: 8_000,
        maxTurns: 12,
      }),
      parentPolicy: scope(ALL_CAPABILITIES, {
        maxChildDepth: 2,
        maxConcurrencyPerParent: 2,
        maxContextBytes: 4_000,
        maxTurns: 8,
        maxTokens: 5_000,
      }),
      childPolicy: CHILD,
      modePolicy: scope(ALL_CAPABILITIES, {
        maxChildDepth: 1,
        maxConcurrencyPerParent: 4,
        maxContextBytes: 16_000,
      }),
    });

    expect(result.limits).toEqual({
      maxChildDepth: 1,
      maxConcurrencyPerParent: 2,
      maxContextBytes: 4_000,
      maxTurns: 8,
      maxTokens: 5_000,
    });
  });

  it("fails closed when a runtime scope contains a malformed numeric limit", () => {
    const result = resolveEffectiveDelegationPolicy({
      userPolicy: scope(ALL_CAPABILITIES),
      parentPolicy: scope(ALL_CAPABILITIES, { maxChildDepth: Number.NaN }),
      childPolicy: CHILD,
    });

    expect(result.limits.maxChildDepth).toBe(0);
    expect(
      authorizeDelegation(
        preflight({ parentPolicy: scope(ALL_CAPABILITIES, { maxChildDepth: Number.NaN }) })
      )
    ).toMatchObject({
      ok: false,
      errors: [{ code: "depth_limit_reached" }],
    });
  });

  it("keeps v1 read-only even if every supplied scope allows mutation", () => {
    const result = resolveEffectiveDelegationPolicy({
      userPolicy: scope(ALL_CAPABILITIES),
      parentPolicy: scope(ALL_CAPABILITIES),
      childPolicy: CHILD,
      modePolicy: scope(ALL_CAPABILITIES),
    });

    expect(result.capabilities).toEqual([
      "workspace.read",
      "command.read",
      "git.read",
      "web.read",
    ]);
    expect(result.limits.maxChildDepth).toBe(1);
    expect(V1_DELEGATION_RESTRICTIONS.capabilities).not.toContain("worktree.create");
    expect(Object.isFrozen(V1_DELEGATION_RESTRICTIONS)).toBe(true);
    expect(Object.isFrozen(V1_DELEGATION_RESTRICTIONS.capabilities)).toBe(true);
    expect(Object.isFrozen(V1_DELEGATION_RESTRICTIONS.limits)).toBe(true);
  });

  it("explicitly rejects a required mutation capability", () => {
    const result = authorizeDelegation(
      preflight({
        parentPolicy: scope(ALL_CAPABILITIES),
        requiredCapabilities: ["workspace.write", "command.mutate", "worktree.create", "delegate"],
      })
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toMatchObject({
      code: "capability_not_allowed",
      details: {
        capabilities: ["workspace.write", "command.mutate", "worktree.create", "delegate"],
      },
    });
  });

  it("rejects an unknown required capability instead of dropping it", () => {
    const result = authorizeDelegation(
      preflight({
        requiredCapabilities: ["root.access" as AgentCapability],
      })
    );

    expect(result).toMatchObject({
      ok: false,
      errors: [
        {
          code: "invalid_preflight",
          path: "requiredCapabilities[0]",
        },
      ],
    });
  });

  it("rejects delegation when the parent lacks delegation rights", () => {
    const result = authorizeDelegation(
      preflight({ parentPolicy: scope(["workspace.read", "git.read"]) })
    );

    expect(result).toMatchObject({
      ok: false,
      errors: [
        {
          code: "capability_not_allowed",
          path: "delegate",
          details: { authorities: ["parentPolicy"] },
        },
      ],
    });
  });
});

describe("delegation preflight guards", () => {
  it("blocks recursive delegation beyond depth one", () => {
    const result = authorizeDelegation(preflight({ parentDepth: 1 }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((item) => item.code)).toContain("depth_limit_reached");
  });

  it("blocks delegation at the concurrency limit", () => {
    const result = authorizeDelegation(
      preflight({
        parentPolicy: scope(["workspace.read", "delegate"], {
          maxConcurrencyPerParent: 2,
        }),
        activeDelegationsForParent: 2,
      })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((item) => item.code)).toContain("concurrency_limit_reached");
  });

  it("blocks exhausted turn and token budgets when provided", () => {
    const result = authorizeDelegation(
      preflight({
        parentPolicy: scope(["workspace.read", "git.read", "delegate"], {
          maxTurns: 4,
          maxTokens: 1_000,
        }),
        usage: { turns: 4, tokens: 1_000 },
      })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((item) => item.code)).toEqual([
      "turn_budget_exhausted",
      "token_budget_exhausted",
    ]);
  });

  it("rejects malformed runtime counters without non-JSON error details", () => {
    const result = authorizeDelegation(
      preflight({
        parentDepth: Number.NaN,
        activeDelegationsForParent: -1,
        usage: { turns: Number.POSITIVE_INFINITY, tokens: -2 },
      })
    );

    expect(result).toEqual({
      ok: false,
      errors: [
        {
          code: "invalid_preflight",
          path: "parentDepth",
          message: "Expected a non-negative safe integer.",
        },
        {
          code: "invalid_preflight",
          path: "activeDelegationsForParent",
          message: "Expected a non-negative safe integer.",
        },
        {
          code: "invalid_preflight",
          path: "usage.turns",
          message: "Expected a non-negative safe integer.",
        },
        {
          code: "invalid_preflight",
          path: "usage.tokens",
          message: "Expected a non-negative safe integer.",
        },
      ],
    });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it("allows absent optional budgets and reports remaining known budgets", () => {
    const result = authorizeDelegation(
      preflight({
        childDefinition: { ...CHILD, limits: { ...CHILD.limits, maxTokens: undefined } },
        parentPolicy: scope(["workspace.read", "git.read", "delegate"], { maxTurns: 5 }),
        usage: { turns: 2 },
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.remainingTurns).toBe(3);
    expect(result.value.remainingTokens).toBeUndefined();
  });

  it("returns a compact result that a separate runtime can serialize", () => {
    const result = authorizeDelegation(preflight());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const serialized = JSON.stringify(result.value);
    expect(JSON.parse(serialized)).toEqual(result.value);
    expect(Object.keys(result.value)).toEqual([
      "agentId",
      "serializedContext",
      "policy",
      "childDepth",
      "activeDelegationsForParent",
      "remainingTurns",
      "remainingTokens",
    ]);
    expect(serialized.length).toBeLessThan(1_000);
  });

  it("blocks an oversized context", () => {
    const result = authorizeDelegation(
      preflight({
        parentPolicy: scope(["workspace.read", "git.read", "delegate"], {
          maxContextBytes: 100,
        }),
      })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((item) => item.code)).toContain("context_too_large");
  });

  it("rejects a malformed runtime context instead of serializing it", () => {
    const result = authorizeDelegation(
      preflight({
        context: { objective: "Inspect policy" } as DelegationContext,
      })
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual([
      {
        code: "invalid_context",
        path: "successCriteria",
        message: "Expected at least one success criterion.",
      },
      {
        code: "invalid_context",
        path: "responseFormat",
        message: "Expected a non-empty response format.",
      },
    ]);
  });

  it("blocks a cancelled delegation with its reason", () => {
    const result = authorizeDelegation(
      preflight({ cancellation: { cancelled: true, reason: "Parent stopped" } })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toEqual({ code: "cancelled", message: "Parent stopped" });
  });
});
