import { describe, expect, it } from "bun:test";
import {
  getToolModePolicy,
  isMacroScopedPath,
  isMetadataRelativePath,
} from "./toolModePolicy";

describe("toolModePolicy", () => {
  it("disallows mutating and workspace tools in chat mode", () => {
    const policy = getToolModePolicy("Chat");
    expect(policy.allowedToolIds.includes("write")).toBe(false);
    expect(policy.allowedToolIds.includes("edit")).toBe(false);
    expect(policy.allowedToolIds.includes("apply_patch")).toBe(false);
    expect(policy.allowedToolIds.includes("list")).toBe(false);
    expect(policy.allowedToolIds.includes("read")).toBe(false);
    expect(policy.allowedToolIds.includes("glob")).toBe(false);
    expect(policy.allowedToolIds.includes("grep")).toBe(false);
    expect(policy.allowedToolIds.includes("git_status")).toBe(false);
    expect(policy.allowedToolIds.includes("git_commit")).toBe(false);
    expect(policy.allowedToolIds.includes("mark_source_passage")).toBe(false);
    expect(policy.allowedToolIds.includes("edit_source_passage")).toBe(false);
    expect(policy.allowedToolIds.includes("read_file")).toBe(true);
    expect(policy.allowedToolIds.includes("web_search")).toBe(true);
    expect(policy.allowedToolIds.includes("web_fetch")).toBe(true);
    expect(policy.enforceMacroOnlyWrites).toBe(false);
  });

  it("enforces macro-only writes in architect mode", () => {
    const policy = getToolModePolicy("Architect");
    expect(policy.allowedToolIds.includes("write")).toBe(true);
    expect(policy.allowedToolIds.includes("edit")).toBe(true);
    expect(policy.allowedToolIds.includes("apply_patch")).toBe(true);
    expect(policy.allowedToolIds.includes("git_status")).toBe(true);
    expect(policy.allowedToolIds.includes("plan_create")).toBe(false);
    expect(policy.allowedToolIds.includes("plan_list")).toBe(true);
    expect(policy.allowedToolIds.includes("plan_update")).toBe(true);
    expect(policy.allowedToolIds.includes("plan_delete")).toBe(false);
    expect(policy.allowedToolIds.includes("plan_restore")).toBe(false);
    expect(policy.allowedToolIds.includes("plan_set_active")).toBe(false);
    expect(policy.allowedToolIds.includes("strategy_get")).toBe(true);
    expect(policy.allowedToolIds.includes("strategy_update")).toBe(true);
    expect(policy.allowedToolIds.includes("strategy_delete")).toBe(true);
    expect(policy.allowedToolIds.includes("need_add")).toBe(true);
    expect(policy.allowedToolIds.includes("strategy_generate")).toBe(true);
    expect(policy.allowedToolIds.includes("git_commit")).toBe(false);
    expect(policy.enforceMacroOnlyWrites).toBe(true);
  });

  it("allows write/edit in implement mode", () => {
    const policy = getToolModePolicy("Implement");
    expect(policy.allowedToolIds.includes("write")).toBe(true);
    expect(policy.allowedToolIds.includes("edit")).toBe(true);
    expect(policy.allowedToolIds.includes("apply_patch")).toBe(true);
    expect(policy.allowedToolIds.includes("git_status")).toBe(true);
    expect(policy.allowedToolIds.includes("git_commit")).toBe(true);
    expect(policy.enforceMacroOnlyWrites).toBe(false);
  });

  it("allows all tools in debug mode without macro-only write restriction", () => {
    const policy = getToolModePolicy("Debug");
    expect(policy.allowedToolIds.includes("write")).toBe(true);
    expect(policy.allowedToolIds.includes("edit")).toBe(true);
    expect(policy.allowedToolIds.includes("apply_patch")).toBe(true);
    expect(policy.allowedToolIds.includes("list")).toBe(true);
    expect(policy.allowedToolIds.includes("read")).toBe(true);
    expect(policy.allowedToolIds.includes("glob")).toBe(true);
    expect(policy.allowedToolIds.includes("grep")).toBe(true);
    expect(policy.allowedToolIds.includes("git_status")).toBe(true);
    expect(policy.allowedToolIds.includes("git_log")).toBe(true);
    expect(policy.allowedToolIds.includes("git_branch_list")).toBe(true);
    expect(policy.allowedToolIds.includes("git_diff")).toBe(true);
    expect(policy.allowedToolIds.includes("git_get_tree")).toBe(true);
    expect(policy.allowedToolIds.includes("git_add")).toBe(true);
    expect(policy.allowedToolIds.includes("git_commit")).toBe(true);
    expect(policy.allowedToolIds.includes("git_checkout")).toBe(true);
    expect(policy.allowedToolIds.includes("git_reset")).toBe(true);
    expect(policy.allowedToolIds.includes("git_stash")).toBe(true);
    expect(policy.enforceMacroOnlyWrites).toBe(false);
  });

  it("detects legacy .macro scoped paths", () => {
    expect(isMacroScopedPath(".macro")).toBe(true);
    expect(isMacroScopedPath(".macro/branches/main/plan.md")).toBe(true);
    expect(isMacroScopedPath("./.macro/branches/main/plan.md")).toBe(true);
    expect(isMacroScopedPath(".macro/../src/App.tsx")).toBe(false);
    expect(isMacroScopedPath(".macro/../../etc/passwd")).toBe(false);
    expect(isMacroScopedPath("/.macro/branches/main/plan.md")).toBe(false);
    expect(isMacroScopedPath("C:/repo/.macro/branches/main/plan.md")).toBe(
      false,
    );
    expect(isMacroScopedPath("src/App.tsx")).toBe(false);
  });

  it("accepts metadata-root relative paths for architect writes", () => {
    expect(isMetadataRelativePath("branches/main/plans/index.json")).toBe(true);
    expect(isMetadataRelativePath("./branches/main/plans/plan-1/plan.md")).toBe(
      true,
    );
    expect(isMetadataRelativePath("workspace.json")).toBe(true);
    expect(isMetadataRelativePath("src/App.tsx")).toBe(false);
    expect(isMetadataRelativePath(".macro/branches/main/plan.md")).toBe(false);
    expect(isMetadataRelativePath(".git/config")).toBe(false);
    expect(isMetadataRelativePath("../src/App.tsx")).toBe(false);
    expect(isMetadataRelativePath("C:/repo/branches/main/plan.md")).toBe(false);
  });
});
