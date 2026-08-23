import { describe, expect, it } from "bun:test";
import { validateAgentDefinition } from "./validation";

describe("agent definition validation", () => {
  it("returns stable paths for malformed definitions", () => {
    const result = validateAgentDefinition({
      id: "",
      role: "Auditor",
      description: "Read-only audit",
      effort: "extreme",
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
});
