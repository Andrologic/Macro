import { describe, expect, it } from "bun:test";
import { validateAgentDefinition } from "./validation";

describe("agent definition validation", () => {
  it("returns stable paths for malformed definitions", () => {
    const result = validateAgentDefinition({
      id: "",
      role: "Auditor",
      description: "Read-only audit",
      effort: "invalid effort",
      capabilities: ["workspace.read", "root.access"],
      limitations: [""],
      limits: {
        maxChildDepth: 0,
        maxConcurrencyPerParent: 1,
        maxContextBytes: 1024,
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((item) => item.path)).toEqual([
      "id",
      "effort",
      "capabilities[1]",
      "limitations",
      "limits.maxChildDepth",
    ]);
  });

  it("accepts provider-defined safe reasoning efforts", () => {
    for (const effort of ["max", "provider_custom"]) {
      const result = validateAgentDefinition({
        id: "reviewer",
        role: "Reviewer",
        description: "Reviews code",
        effort,
        capabilities: ["workspace.read"],
        limitations: ["Read only"],
        limits: {
          maxChildDepth: 1,
          maxConcurrencyPerParent: 1,
          maxContextBytes: 1024,
        },
      });
      expect(result.ok).toBe(true);
    }
  });
});
