import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ArchitectPlanRecord } from "../architectPlanService";
import type { AgsdlEditorDocument } from "../../types/agsdl";
import { createExample } from "./examples";

let plan: ArchitectPlanRecord;
let releaseSave: (() => void) | undefined;
let saveDelay: Promise<void> | undefined;
let failSave = false;
mock.module("../architectPlanService", () => ({
  getArchitectPlan: async (_branch: string, id: string) =>
    id === plan.id ? structuredClone(plan) : null,
  updateArchitectPlan: async (input: {
    agsdl: AgsdlEditorDocument;
    expectedAgsdlRevision: number;
  }) => {
    if (saveDelay) await saveDelay;
    if (failSave) throw new Error("Storage unavailable");
    if (
      plan.status !== "draft" ||
      input.expectedAgsdlRevision !== (plan.agsdl?.revision ?? 0)
    )
      throw new Error("Revision conflict");
    plan = {
      ...plan,
      agsdl: { ...input.agsdl, revision: input.expectedAgsdlRevision + 1 },
    };
    return structuredClone(plan);
  },
}));
const { useAgsdlStore, agsdlSessionKey } = await import(
  "../../stores/useAgsdlStore"
);
const { handleAgsdlToolCall } = await import("./tools");
const target = { branchName: "develop", planId: "plan-test" };
const current = () =>
  useAgsdlStore.getState().sessions[agsdlSessionKey(target)];
const call = (
  toolName: string,
  args: Record<string, unknown> = {},
  conversationId = "conversation-test",
  isCurrent = () => true,
) =>
  handleAgsdlToolCall({
    toolName,
    args: { plan_id: target.planId, target_branch: target.branchName, ...args },
    conversationId,
    isCurrent,
  });

beforeEach(() => {
  plan = {
    id: target.planId,
    title: "Test",
    slug: "test",
    description: "",
    status: "draft",
    targetBranch: "develop",
    conversationId: "conversation-test",
    nodes: [],
    predictedBranches: [],
    createdAt: "",
    updatedAt: "",
    agsdl: { source: createExample("release"), annexes: {}, revision: 1 },
  };
  useAgsdlStore.setState({ sessions: {} });
  failSave = false;
  saveDelay = undefined;
});
afterEach(() => {
  releaseSave?.();
});

describe("shared AgSDL authoring session", () => {
  it("keeps newer UI edits dirty when a prior snapshot finishes saving", async () => {
    const store = useAgsdlStore.getState();
    await store.load(target);
    store.replace(target, createExample("feature"));
    saveDelay = new Promise((resolve) => {
      releaseSave = resolve;
    });
    const saving = store.save(target);
    store.replace(target, createExample("hotfix"));
    releaseSave!();
    await saving;
    expect(plan.agsdl?.source).toBe(createExample("feature"));
    expect(current().source).toBe(createExample("hotfix"));
    expect(current().dirty).toBe(true);
    expect(current().persistedRevision).toBe(2);
    saveDelay = undefined;
    await store.save(target);
    expect(plan.agsdl?.source).toBe(createExample("hotfix"));
    expect(current().dirty).toBe(false);
    store.undo(target);
    expect(current().source).toBe(createExample("feature"));
    store.undo(target, true);
    expect(current().source).toBe(createExample("hotfix"));
  });

  it("retains the local draft on save failure", async () => {
    const store = useAgsdlStore.getState();
    await store.load(target);
    store.replace(target, createExample("feature"));
    failSave = true;
    await expect(store.save(target)).rejects.toThrow("Storage unavailable");
    expect(current().source).toBe(createExample("feature"));
    expect(current().dirty).toBe(true);
    expect(current().saving).toBe(false);
    expect(plan.agsdl?.source).toBe(createExample("release"));
  });

  it("shares agent edits with the panel and requires current revisions", async () => {
    const read = JSON.parse(await call("agsdl_get"));
    expect(read.source).toBe(current().source);
    const result = JSON.parse(
      await call("agsdl_update", {
        expected_revision: read.revision,
        changes: [
          {
            op: "set",
            path: "/graphs/0/steps/0/success",
            value_json: '"unknown"',
          },
        ],
      }),
    );
    expect(result.revision).not.toBe(read.revision);
    expect(
      result.diagnostics.some(
        (report: { results: Array<{ verdict: string }> }) =>
          report.results.some((value) => value.verdict !== "pass"),
      ),
    ).toBe(true);
    expect(current().dirty).toBe(false);
    expect(plan.agsdl?.source).toBe(current().source);
    await expect(
      call("agsdl_update", { expected_revision: read.revision, source: "{}" }),
    ).rejects.toThrow("changed");
  });

  it("rejects another conversation, expired turns, locked plans and unapplied user fields", async () => {
    await expect(call("agsdl_get", {}, "other-conversation")).rejects.toThrow(
      "calling plan",
    );
    await expect(call("agsdl_get", {}, undefined, () => false)).rejects.toThrow(
      "ended",
    );
    const read = JSON.parse(await call("agsdl_get"));
    useAgsdlStore
      .getState()
      .setFieldDraft(target, "source", {
        value: "typing",
        base: current().source,
        version: current().version,
      });
    await expect(
      call("agsdl_update", { expected_revision: read.revision, source: "{}" }),
    ).rejects.toThrow("unapplied");
    expect(plan.agsdl?.revision).toBe(1);
    plan.status = "validated";
    await expect(
      call("agsdl_update", { expected_revision: read.revision, source: "{}" }),
    ).rejects.toThrow("draft");
  });

  it("initializes an empty document through an example and reads exact pointer values", async () => {
    delete plan.agsdl;
    const read = JSON.parse(await call("agsdl_get"));
    expect(read.error).toBeNull();
    expect(read.examples).toContain("release");
    const result = JSON.parse(
      await call("agsdl_update", {
        expected_revision: read.revision,
        example: "release",
      }),
    );
    expect(result.persisted_revision).toBe(1);
    const subtree = JSON.parse(
      await call("agsdl_get", { path: "/graphs/0/entry" }),
    );
    expect(JSON.parse(subtree.source)).toBe("checklist");
    await expect(
      call("agsdl_update", {
        expected_revision: result.revision,
        example: "hotfix",
      }),
    ).rejects.toThrow("empty");
  });
});
