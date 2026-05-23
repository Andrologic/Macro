import { describe, expect, it } from "bun:test";
import {
  evaluateToolSecurity,
  filterDeniedToolIdsForRiskLevel,
} from "./toolSecurityPolicy";

describe("toolSecurityPolicy", () => {
  it("allows non-destructive apply_patch calls in balanced mode", () => {
    const result = evaluateToolSecurity(
      "apply_patch",
      {
        patch_text: [
          "*** Begin Patch",
          "*** Update File: src/app.ts",
          "@@",
          "-oldLine();",
          "+newLine();",
          "*** End Patch",
        ].join("\n"),
      },
      {
        mode: "Implement",
        riskLevel: "balanced",
        workspacePath: "/repo",
      },
    );

    expect(result.decision).toBe("allow");
    expect(result.normalizedCall.rememberKey).toBe("path:src/app.ts");
  });

  it("denies apply_patch calls that target paths outside the workspace", () => {
    const result = evaluateToolSecurity(
      "apply_patch",
      {
        patch_text: [
          "*** Begin Patch",
          "*** Update File: ../outside.ts",
          "@@",
          "-oldLine();",
          "+newLine();",
          "*** End Patch",
        ].join("\n"),
      },
      {
        mode: "Implement",
        riskLevel: "balanced",
        workspacePath: "/repo",
      },
    );

    expect(result.decision).toBe("deny");
    expect(result.denialReason).toContain("outside the current workspace");
  });

  it("uses a tool-level remember key for web search grants", () => {
    const result = evaluateToolSecurity(
      "web_search",
      { query: "latest bun release notes" },
      {
        mode: "Chat",
        riskLevel: "balanced",
        grants: [
          {
            toolId: "web_search",
            rememberKey: "tool:web_search",
            createdAt: "2026-04-21T00:00:00.000Z",
          },
        ],
      },
    );

    expect(result.decision).toBe("allow");
    expect(result.normalizedCall.rememberKey).toBe("tool:web_search");
  });

  it("allows additive Architect actions in balanced mode", () => {
    const needResult = evaluateToolSecurity(
      "need_add",
      {
        title: "Capture onboarding requirements",
        description: "Understand the new onboarding flow.",
        category: "functional",
        priority: "medium",
      },
      {
        mode: "Architect",
        riskLevel: "balanced",
        workspacePath: "/repo",
      },
    );
    const planResult = evaluateToolSecurity(
      "plan_create",
      { label: "Onboarding refresh" },
      {
        mode: "Architect",
        riskLevel: "balanced",
        workspacePath: "/repo",
      },
    );

    expect(needResult.decision).toBe("allow");
    expect(planResult.decision).toBe("allow");
  });

  it("asks before modifying or replacing Architect records in balanced mode", () => {
    const needResult = evaluateToolSecurity(
      "need_update",
      { need_id: "need-1", description: "Replace the requirement text." },
      {
        mode: "Architect",
        riskLevel: "balanced",
        workspacePath: "/repo",
      },
    );
    const strategyResult = evaluateToolSecurity(
      "strategy_generate",
      { nodes: [{ title: "New plan", type: "task" }] },
      {
        mode: "Architect",
        riskLevel: "balanced",
        workspacePath: "/repo",
      },
    );

    expect(needResult.decision).toBe("ask");
    expect(strategyResult.decision).toBe("ask");
  });

  it("asks again when the terminal command prefix does not match the grant", () => {
    const result = evaluateToolSecurity(
      "terminal_run",
      { session_id: "session-1", command: "npm run lint" },
      {
        mode: "Implement",
        riskLevel: "balanced",
        workspacePath: "/repo",
        grants: [
          {
            toolId: "terminal_run",
            rememberKey: "terminal:npm test",
            createdAt: "2026-04-21T00:00:00.000Z",
          },
        ],
      },
    );

    expect(result.decision).toBe("ask");
    expect(result.normalizedCall.rememberKey).toBe("terminal:npm run");
  });

  it("allows attached read_file calls in strict mode even when the file path is outside the workspace", () => {
    const result = evaluateToolSecurity(
      "read_file",
      { file: "/Users/someone/Desktop/spec.pdf" },
      {
        mode: "Chat",
        riskLevel: "strict",
        workspacePath: "/repo",
      },
    );

    expect(result.decision).toBe("allow");
    expect(result.normalizedCall.isExternalToWorkspace).toBe(false);
  });

  it("removes escape tools from the strict model surface", () => {
    const result = filterDeniedToolIdsForRiskLevel(
      ["web_search", "need_delete", "strategy_delete", "need_update"],
      "strict",
    );

    expect(result).toEqual(["need_update"]);
  });

  it("treats MCP tools as external actions gated by risk level", () => {
    const balanced = evaluateToolSecurity(
      "mcp__github__list_issues",
      { state: "open" },
      {
        mode: "Chat",
        riskLevel: "balanced",
      },
    );
    const strictIds = filterDeniedToolIdsForRiskLevel(
      ["read_file", "mcp__github__list_issues"],
      "strict",
    );

    expect(balanced.decision).toBe("ask");
    expect(balanced.normalizedCall.actionGroup).toBe("escape");
    expect(balanced.normalizedCall.summary).toBe(
      "Call MCP tool list_issues on github",
    );
    expect(strictIds).toEqual(["read_file"]);
  });
});
