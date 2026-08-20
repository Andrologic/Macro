import { describe, expect, it } from "bun:test";
import {
  getImplementAgentToolPolicy,
  getToolModePolicy,
  isMacroScopedPath,
  isMetadataRelativePath,
} from "./toolModePolicy";

const CHAT_ALLOWED_TOOL_IDS = [
  "question",
  "config_list",
  "config_get",
  "config_validate",
  "config_patch",
  "skill_activate",
  "skill_read_resource",
  "skill_run_script",
  "mark_source_passage",
  "read_sources",
  "edit_source_passage",
  "read_file",
  "web_search",
  "web_fetch",
];

describe("toolModePolicy", () => {
  it("disallows workspace mutations while retaining validated configuration tools in chat mode", () => {
    const policy = getToolModePolicy("Chat");
    expect(policy.allowedToolIds).toEqual(CHAT_ALLOWED_TOOL_IDS);
    expect(policy.allowedToolIds.includes("write")).toBe(false);
    expect(policy.allowedToolIds.includes("edit")).toBe(false);
    expect(policy.allowedToolIds.includes("delete")).toBe(false);
    expect(policy.allowedToolIds.includes("apply_patch")).toBe(false);
    expect(policy.allowedToolIds.includes("list")).toBe(false);
    expect(policy.allowedToolIds.includes("read")).toBe(false);
    expect(policy.allowedToolIds.includes("glob")).toBe(false);
    expect(policy.allowedToolIds.includes("grep")).toBe(false);
    expect(policy.allowedToolIds.includes("git_status")).toBe(false);
    expect(policy.allowedToolIds.includes("git_commit")).toBe(false);
    expect(policy.allowedToolIds.includes("terminal_run")).toBe(false);
    expect(policy.allowedToolIds.includes("plan_create")).toBe(false);
    expect(policy.allowedToolIds.includes("strategy_generate")).toBe(false);
    expect(policy.allowedToolIds.includes("skill_activate")).toBe(true);
    expect(policy.allowedToolIds.includes("skill_read_resource")).toBe(true);
    expect(policy.allowedToolIds.includes("skill_run_script")).toBe(true);
    expect(policy.allowedToolIds.includes("mark_source_passage")).toBe(true);
    expect(policy.allowedToolIds.includes("read_sources")).toBe(true);
    expect(policy.allowedToolIds.includes("edit_source_passage")).toBe(true);
    expect(policy.allowedToolIds.includes("read_file")).toBe(true);
    expect(policy.allowedToolIds.includes("web_search")).toBe(true);
    expect(policy.allowedToolIds.includes("web_fetch")).toBe(true);
    expect(policy.enforceMacroOnlyWrites).toBe(false);
  });

  it("enforces macro-only writes in architect mode", () => {
    const policy = getToolModePolicy("Architect");
    expect(policy.allowedToolIds.includes("mark_source_passage")).toBe(false);
    expect(policy.allowedToolIds.includes("read_sources")).toBe(false);
    expect(policy.allowedToolIds.includes("edit_source_passage")).toBe(false);
    expect(policy.allowedToolIds.includes("write")).toBe(true);
    expect(policy.allowedToolIds.includes("edit")).toBe(true);
    expect(policy.allowedToolIds.includes("delete")).toBe(true);
    expect(policy.allowedToolIds.includes("apply_patch")).toBe(true);
    expect(policy.allowedToolIds.includes("git_status")).toBe(true);
    expect(policy.allowedToolIds.includes("plan_create")).toBe(true);
    expect(policy.allowedToolIds.includes("plan_list")).toBe(true);
    expect(policy.allowedToolIds.includes("plan_update")).toBe(true);
    expect(policy.allowedToolIds.includes("plan_delete")).toBe(false);
    expect(policy.allowedToolIds.includes("plan_restore")).toBe(false);
    expect(policy.allowedToolIds.includes("plan_set_active")).toBe(false);
    expect(policy.allowedToolIds.includes("skill_activate")).toBe(true);
    expect(policy.allowedToolIds.includes("skill_read_resource")).toBe(true);
    expect(policy.allowedToolIds.includes("skill_run_script")).toBe(true);
    expect(policy.allowedToolIds.includes("strategy_get")).toBe(true);
    expect(policy.allowedToolIds.includes("strategy_update")).toBe(true);
    expect(policy.allowedToolIds.includes("strategy_delete")).toBe(true);
    expect(policy.allowedToolIds.includes("strategy_generate")).toBe(true);
    expect(policy.allowedToolIds.includes("git_commit")).toBe(false);
    expect(policy.enforceMacroOnlyWrites).toBe(true);
  });

  it("always includes the full Architect chat action surface", () => {
    const policy = getToolModePolicy("Architect");

    expect(policy.allowedToolIds.includes("strategy_delete")).toBe(true);
  });

  it("allows write/edit/delete in implement mode", () => {
    const policy = getToolModePolicy("Implement");
    expect(policy.allowedToolIds.includes("mark_source_passage")).toBe(false);
    expect(policy.allowedToolIds.includes("read_sources")).toBe(false);
    expect(policy.allowedToolIds.includes("edit_source_passage")).toBe(false);
    expect(policy.allowedToolIds.includes("write")).toBe(true);
    expect(policy.allowedToolIds.includes("edit")).toBe(true);
    expect(policy.allowedToolIds.includes("delete")).toBe(true);
    expect(policy.allowedToolIds.includes("apply_patch")).toBe(true);
    expect(policy.allowedToolIds.includes("skill_activate")).toBe(true);
    expect(policy.allowedToolIds.includes("skill_read_resource")).toBe(true);
    expect(policy.allowedToolIds.includes("skill_run_script")).toBe(true);
    expect(policy.allowedToolIds.includes("git_status")).toBe(true);
    expect(policy.allowedToolIds.includes("git_commit")).toBe(true);
    expect(policy.enforceMacroOnlyWrites).toBe(false);
  });

  it("keeps implement build aligned with the full implement mode policy", () => {
    expect(getImplementAgentToolPolicy("build")).toEqual(
      getToolModePolicy("Implement"),
    );
  });

  it("limits implement plan to read-only inspection tools", () => {
    const policy = getImplementAgentToolPolicy("plan");

    expect(policy.allowedToolIds).toEqual([
      "question",
      "config_list",
      "config_get",
      "config_validate",
      "config_patch",
      "skill_activate",
      "skill_read_resource",
      "read_file",
      "web_search",
      "web_fetch",
      "list",
      "read",
      "glob",
      "grep",
      "git_status",
      "git_log",
      "git_branch_list",
      "git_diff",
      "git_get_tree",
      "task_todo_get",
      "task_artifact_list",
      "task_artifact_get",
    ]);
    expect(policy.allowedToolIds.includes("write")).toBe(false);
    expect(policy.allowedToolIds.includes("edit")).toBe(false);
    expect(policy.allowedToolIds.includes("delete")).toBe(false);
    expect(policy.allowedToolIds.includes("apply_patch")).toBe(false);
    expect(policy.allowedToolIds.includes("skill_run_script")).toBe(false);
    expect(policy.allowedToolIds.includes("task_todo_update")).toBe(false);
    expect(policy.allowedToolIds.includes("task_artifact_put")).toBe(false);
    expect(policy.allowedToolIds.includes("git_add")).toBe(false);
    expect(policy.allowedToolIds.includes("git_commit")).toBe(false);
    expect(policy.allowedToolIds.includes("git_checkout")).toBe(false);
    expect(policy.allowedToolIds.includes("git_merge")).toBe(false);
    expect(policy.allowedToolIds.includes("git_reset")).toBe(false);
    expect(policy.allowedToolIds.includes("git_stash")).toBe(false);
    expect(policy.allowedToolIds.includes("terminal_create_session")).toBe(false);
    expect(policy.allowedToolIds.includes("terminal_run")).toBe(false);
    expect(policy.allowedToolIds.includes("terminal_kill")).toBe(false);
    expect(policy.enforceMacroOnlyWrites).toBe(false);
  });

  it("detects virtual .macro scoped paths", () => {
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

  it.each([
    "workspace.json",
    "./workspace.json",
    "branches/main/plans/index.json",
    "./branches/main/plans/plan-1/plan.md",
    "branches/main/../develop/plans/index.json",
  ])("accepts metadata-root relative architect write path %s", (path) => {
    expect(isMetadataRelativePath(path)).toBe(true);
  });

  it.each([
    ".macro/workspace.json",
    ".macro/branches/main/plan.md",
    "workspace.json/neighbor",
    "workspace.json.bak",
    "branch/main/plan.md",
    "branches/../../src/App.tsx",
    "branches/main/../../../src/App.tsx",
    ".git/config",
    "../src/App.tsx",
    "/branches/main/plan.md",
    "C:/repo/branches/main/plan.md",
    "src/App.tsx",
  ])("rejects non-metadata-root architect write path %s", (path) => {
    expect(isMetadataRelativePath(path)).toBe(false);
  });
});
