import { describe, expect, it } from "bun:test";
import { filterToolIdsForInternalAgentProfile } from "../internalAgentProfile";
import { getDelegatableInternalAgentDefinition } from "./internalProfileAdapter";

describe("internal agent profile adapter", () => {
  it("keeps goal_auditor compatible with its existing read-only behavior", () => {
    const definition = getDelegatableInternalAgentDefinition("goal_auditor");

    expect(definition).toMatchObject({
      id: "goal_auditor",
      capabilities: ["workspace.read", "git.read"],
      limits: { maxChildDepth: 1, maxConcurrencyPerParent: 1 },
    });
    expect(
      filterToolIdsForInternalAgentProfile(
        ["list", "read", "git_status", "git_diff", "terminal_run", "apply_patch"],
        "goal_auditor"
      )
    ).toEqual(["list", "read", "git_status", "git_diff"]);
  });

  it("does not expose mutable internal profiles as v1 delegates", () => {
    expect(getDelegatableInternalAgentDefinition("task_reviewer")).toBeNull();
    expect(getDelegatableInternalAgentDefinition("plan_explorer")).toBeNull();
  });
});
