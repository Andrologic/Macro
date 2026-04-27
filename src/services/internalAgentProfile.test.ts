import { describe, expect, it } from "bun:test";
import {
  buildInternalAgentProfileSystemPrompt,
  filterToolIdsForInternalAgentProfile,
  getInternalAgentProfilePromptPreferenceKey,
  resolveInternalAgentProfile,
} from "./internalAgentProfile";

describe("internalAgentProfile", () => {
  it("derives profiles from the existing product context", () => {
    expect(resolveInternalAgentProfile({ mode: "Architect" })).toBe(
      "plan_explorer"
    );
    expect(
      resolveInternalAgentProfile({
        mode: "Implement",
        taskStatus: "InReview",
      })
    ).toBe("task_reviewer");
    expect(
      resolveInternalAgentProfile({
        mode: "Implement",
        taskStatus: "InProgress",
      })
    ).toBe("default_executor");
    expect(resolveInternalAgentProfile({ mode: "Chat" })).toBeNull();
  });

  it("lets explicit overrides force the repo auditor profile", () => {
    expect(
      resolveInternalAgentProfile({
        mode: "Implement",
        overrideProfile: "repo_auditor",
      })
    ).toBe("repo_auditor");
  });

  it("keeps plan explorer read-only relative to architect mode", () => {
    const filtered = filterToolIdsForInternalAgentProfile(
      [
        "list",
        "read",
        "apply_patch",
        "write",
        "git_status",
        "git_commit",
        "plan_get",
        "strategy_update",
      ],
      "plan_explorer"
    );

    expect(filtered).toEqual([
      "list",
      "read",
      "git_status",
      "plan_get",
      "strategy_update",
    ]);
  });

  it("keeps plan explorer aligned with the Architect chat action surface", () => {
    const filtered = filterToolIdsForInternalAgentProfile(
      ["need_delete", "strategy_delete", "plan_create", "plan_get"],
      "plan_explorer"
    );

    expect(filtered).toEqual([
      "need_delete",
      "strategy_delete",
      "plan_create",
      "plan_get",
    ]);
  });

  it("keeps task reviewer focused on read, patch, and verification tools", () => {
    const filtered = filterToolIdsForInternalAgentProfile(
      [
        "read",
        "apply_patch",
        "git_diff",
        "git_commit",
        "terminal_create_session",
        "terminal_run",
        "terminal_read",
      ],
      "task_reviewer"
    );

    expect(filtered).toEqual([
      "read",
      "apply_patch",
      "git_diff",
      "terminal_create_session",
      "terminal_run",
      "terminal_read",
    ]);
  });

  it("keeps repo auditor limited to repository and workspace inspection", () => {
    const filtered = filterToolIdsForInternalAgentProfile(
      [
        "list",
        "read",
        "git_status",
        "git_diff",
        "terminal_run",
        "apply_patch",
        "web_search",
      ],
      "repo_auditor"
    );

    expect(filtered).toEqual(["list", "read", "git_status", "git_diff"]);
  });

  it("provides distinct system guidance for specialized profiles", () => {
    expect(buildInternalAgentProfileSystemPrompt("plan_explorer")).toContain(
      "PLAN_EXPLORER"
    );
    expect(buildInternalAgentProfileSystemPrompt("task_reviewer")).toContain(
      "TASK_REVIEWER"
    );
    expect(buildInternalAgentProfileSystemPrompt("repo_auditor")).toContain(
      "REPO_AUDITOR"
    );
    expect(
      buildInternalAgentProfileSystemPrompt("default_executor")
    ).toBeNull();
  });

  it("maps specialized profiles to prompt preference keys", () => {
    expect(getInternalAgentProfilePromptPreferenceKey("plan_explorer")).toBe(
      "promptPlanExplorer"
    );
    expect(getInternalAgentProfilePromptPreferenceKey("task_reviewer")).toBe(
      "promptTaskReviewer"
    );
    expect(getInternalAgentProfilePromptPreferenceKey("repo_auditor")).toBe(
      "promptRepoAuditor"
    );
    expect(getInternalAgentProfilePromptPreferenceKey("default_executor")).toBe(
      null
    );
  });
});
