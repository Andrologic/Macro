import { describe, expect, it } from "bun:test";
import {
  buildDelegationContext,
  serializeDelegationContext,
} from "./context";

describe("delegation context", () => {
  it("builds a compact, stable, serializable context", () => {
    const input = {
      objective: "  Inspect   the policy  ",
      successCriteria: ["Find escalation paths", "Find escalation paths", " Report files "],
      relevantAreas: [
        { path: " src/services ", reason: " policy code " },
        { path: "src/services", reason: "duplicate" },
        { path: " docs/technical-architecture.md " },
      ],
      constraints: ["Read only", " Read only "],
      establishedFacts: ["The parent cannot write"],
      responseFormat: " concise JSON ",
    } as const;

    const first = buildDelegationContext(input);
    const second = buildDelegationContext(input);

    expect(first).toEqual(second);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value).toEqual({
      objective: "Inspect the policy",
      successCriteria: ["Find escalation paths", "Report files"],
      relevantAreas: [
        { path: "src/services", reason: "policy code" },
        { path: "docs/technical-architecture.md" },
      ],
      constraints: ["Read only"],
      establishedFacts: ["The parent cannot write"],
      responseFormat: "concise JSON",
    });
    expect(JSON.parse(serializeDelegationContext(first.value))).toEqual(first.value);
    expect(serializeDelegationContext(first.value)).not.toContain("history");
  });

  it("rejects missing required fields with usable paths", () => {
    const result = buildDelegationContext({
      objective: " ",
      successCriteria: [],
      responseFormat: " ",
    });

    expect(result).toEqual({
      ok: false,
      errors: [
        {
          code: "invalid_context",
          path: "objective",
          message: "Expected a non-empty objective.",
        },
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
      ],
    });
  });

  it("rejects a context above its byte limit", () => {
    const result = buildDelegationContext(
      {
        objective: "Inspect policy",
        successCriteria: ["Report findings"],
        establishedFacts: ["é".repeat(100)],
        responseFormat: "Text",
      },
      100
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0].code).toBe("context_too_large");
    expect(result.errors[0].details?.actualBytes).toBeGreaterThan(100);
  });
});
