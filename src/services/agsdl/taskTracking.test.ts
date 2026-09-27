import { describe, expect, it } from "bun:test";
import type { CatalogedImplementTask } from "../implementTaskCatalog";
import { createExample } from "./examples";
import { projectViewer } from "./viewer";
import { groupTaskState, trackCardTasks, type TrackedTask } from "./taskTracking";

const target = { planId: "plan", branchName: "feature/example" };
const card = () => ({ ...projectViewer(createExample("feature")).graphs[0].cards[0], details: { displayAnnotations: { macroTaskId: "task" } } });
const task = (overrides: Partial<CatalogedImplementTask> = {}) => ({ id: "task", title: "Task", plan_id: "plan", plan_storage_branch: target.branchName, status: "Completed", task_source: "architect", ...overrides }) as CatalogedImplementTask;
const track = (tasks: CatalogedImplementTask[], running = new Set<string>()) => trackCardTasks([card()], target, tasks, running, {});

describe("AgSDL live task tracking", () => {
  it("uses real Macro activity instead of treating persisted InProgress as running", () => {
    expect(track([task()])[card().path].state).toBe("completed");
    expect(track([task({ status: "InProgress" })])[card().path].state).toBe("idle_prompt");
    expect(track([task({ status: "InProgress" })], new Set(["task"]))[card().path].state).toBe("running");
    expect(track([task({ status: "Pending", is_blocked: true })])[card().path].state).toBe("blocked");
  });
  it("rejects archived, ambiguous and other-plan or other-branch links", () => {
    for (const tasks of [[task({ plan_id: "other" })], [task({ plan_storage_branch: "other" })], [task({ archived_at: "2026-01-01" })], [task(), task()]]) {
      expect(track(tasks)).toEqual({});
    }
  });
  it("preserves legacy node identity but never infers a native link from titles or ids", () => {
    const native = { ...card(), id: "node", details: {} };
    const tasks = [task({ node_id: "node" })];
    expect(trackCardTasks([native], target, tasks, new Set(), {})).toEqual({});
    const legacy = { ...native, path: "/legacy/0" };
    expect(trackCardTasks([legacy], target, tasks, new Set(), {})[legacy.path].state).toBe("completed");
  });
  it("shows attention states in folded groups without inventing completion", () => {
    const done: TrackedTask = { taskId: "one", title: "One", state: "completed" };
    const waiting: TrackedTask = { taskId: "two", title: "Two", state: "awaiting_response" };
    expect(groupTaskState([done], 2)).toBeUndefined();
    expect(groupTaskState([done], 1)?.state).toBe("completed");
    expect(groupTaskState([done, waiting], 3)?.state).toBe("awaiting_response");
  });
});
