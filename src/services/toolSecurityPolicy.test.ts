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

  it("allows skill activation and resource reads as observe tools", () => {
    const activate = evaluateToolSecurity(
      "skill_activate",
      { skill_id: "project:docs" },
      {
        mode: "Chat",
        riskLevel: "balanced",
        workspacePath: "/repo",
      },
    );
    const read = evaluateToolSecurity(
      "skill_read_resource",
      { skill_id: "project:docs", path: "references/style.md" },
      {
        mode: "Implement",
        riskLevel: "strict",
        workspacePath: "/repo",
      },
    );

    expect(activate.decision).toBe("allow");
    expect(activate.normalizedCall.detail).toBe("project:docs");
    expect(read.decision).toBe("allow");
    expect(read.normalizedCall.detail).toBe("references/style.md");
  });

  it("gates skill script execution as an escape action", () => {
    const balanced = evaluateToolSecurity(
      "skill_run_script",
      { skill_id: "global:formatter", script_path: "scripts/check.js" },
      {
        mode: "Chat",
        riskLevel: "balanced",
        workspacePath: "/repo",
      },
    );
    const strictIds = filterDeniedToolIdsForRiskLevel(
      ["skill_activate", "skill_read_resource", "skill_run_script"],
      "strict",
    );
    const granted = evaluateToolSecurity(
      "skill_run_script",
      { skill_id: "global:formatter", script_path: "scripts/check.js" },
      {
        mode: "Chat",
        riskLevel: "balanced",
        workspacePath: "/repo",
        grants: [
          {
            toolId: "skill_run_script",
            rememberKey: "tool:skill_run_script",
            createdAt: "2026-04-21T00:00:00.000Z",
          },
        ],
      },
    );

    expect(balanced.decision).toBe("ask");
    expect(balanced.normalizedCall.detail).toBe("scripts/check.js");
    expect(strictIds).toEqual(["skill_activate", "skill_read_resource"]);
    expect(granted.decision).toBe("allow");
  });

  it("allows additive Architect actions in balanced mode", () => {
    const planResult = evaluateToolSecurity(
      "plan_create",
      { label: "Onboarding refresh" },
      {
        mode: "Architect",
        riskLevel: "balanced",
        workspacePath: "/repo",
      },
    );

    expect(planResult.decision).toBe("allow");
  });

  it("asks before modifying or replacing Architect records in balanced mode", () => {
    const strategyResult = evaluateToolSecurity(
      "strategy_generate",
      { nodes: [{ title: "New plan", type: "task" }] },
      {
        mode: "Architect",
        riskLevel: "balanced",
        workspacePath: "/repo",
      },
    );

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

  it("requires a fresh approval for every Chat terminal command at every risk level", () => {
    for (const riskLevel of ["strict", "balanced", "yolo"] as const) {
      const result = evaluateToolSecurity(
        "terminal_run",
        { session_id: "session-1", command: "npm test" },
        {
          mode: "Chat",
          riskLevel,
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
      expect(result.normalizedCall.canApproveForConversation).toBe(false);
    }
  });

  it("allows Chat to create a general terminal outside an attached workspace", () => {
    const result = evaluateToolSecurity(
      "terminal_create_session",
      { cwd: "/outside" },
      {
        mode: "Chat",
        riskLevel: "strict",
        workspacePath: "/repo",
      },
    );

    expect(result.decision).toBe("allow");
    expect(result.normalizedCall.isExternalToWorkspace).toBe(false);
  });

  it("keeps the per-command Chat terminal on the strict model surface", () => {
    const strictIds = filterDeniedToolIdsForRiskLevel(
      ["terminal_create_session", "terminal_run", "terminal_read", "terminal_kill"],
      "strict",
      "Chat",
    );

    expect(strictIds).toEqual([
      "terminal_create_session",
      "terminal_run",
      "terminal_read",
      "terminal_kill",
    ]);
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
      ["web_search", "strategy_delete", "strategy_update"],
      "strict",
    );

    expect(result).toEqual(["strategy_update"]);
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
