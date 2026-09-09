import { describe, expect, it } from "bun:test";
import { validateDocument } from "./document";
import { convertLegacyPlan } from "./legacy";
import type { ArchitectPlanRecord } from "../architectPlanService";

const plan = (overrides: Partial<ArchitectPlanRecord> = {}): Pick<
  ArchitectPlanRecord,
  "id" | "title" | "label" | "description" | "nodes" | "predictedBranches"
> => ({
  id: "legacy-plan",
  title: "Legacy plan",
  label: "Legacy",
  description: "A migrated plan",
  nodes: [
    {
      id: "one",
      title: "First task",
      description: "Inspect the code.",
      type: "task",
      status: "pending",
      dependencies: [],
      todos: [{ id: "todo-1", title: "Read files", status: "pending" }],
      artifactContracts: [],
    },
  ],
  predictedBranches: [
    {
      id: "branch-1",
      name: "feature/legacy",
      color: "#3b82f6",
      parentBranch: "develop",
      projectId: "project-1",
      taskIds: ["one"],
      status: "pending",
    },
  ],
  ...overrides,
});

describe("legacy AgSDL conversion", () => {
  it("returns null for an empty legacy strategy", () => {
    expect(convertLegacyPlan(plan({ nodes: [], predictedBranches: [] }))).toBeNull();
  });

  it("preserves the exact legacy records in the reserved Resource payload", () => {
    const legacy = plan();
    const converted = convertLegacyPlan(legacy)!;
    const document = JSON.parse(converted.source);
    const resource = document.definitions.find(
      (definition: { key: { id: string } }) => definition.key.id === "macro-legacy-plan",
    );
    expect(resource.payload.nodes).toEqual(legacy.nodes);
    expect(resource.payload.predictedBranches).toEqual(legacy.predictedBranches);
    expect(converted.revision).toBe(1);
    expect(document.root.annotations.macroMigration).toEqual({
      version: 1,
      issues: ["execution-not-migrated"],
    });
  });

  it("emits a valid D-only document and records topology warnings", async () => {
    const converted = convertLegacyPlan(
      plan({
        nodes: [
          { ...plan().nodes[0], dependencies: ["missing"] },
          {
            ...plan().nodes[0],
            id: "two",
            title: "Second task",
            dependencies: ["one"],
          },
        ],
      }),
    )!;
    const reports = await validateDocument(converted.source);
    const dReport = reports.find((report) => report.operation === "validateD");
    expect(dReport?.results.some((result) => result.verdict === "pass")).toBe(true);
    const document = JSON.parse(converted.source);
    expect(document.root.annotations.macroMigration.issues).toEqual([
      "missing-dependency",
      "nonlinear-dependencies",
      "execution-not-migrated",
    ]);
    expect(document.graphs).toBeUndefined();
  });

  it("does not mark a simple dependency chain as nonlinear", () => {
    const converted = convertLegacyPlan(
      plan({
        nodes: [
          plan().nodes[0],
          { ...plan().nodes[0], id: "two", title: "Second", dependencies: ["one"] },
          { ...plan().nodes[0], id: "three", title: "Third", dependencies: ["two"] },
        ],
      }),
    )!;
    const document = JSON.parse(converted.source);
    expect(document.root.annotations.macroMigration.issues).toEqual([
      "execution-not-migrated",
    ]);
  });

  it("marks a diamond dependency graph as nonlinear", () => {
    const converted = convertLegacyPlan(
      plan({
        nodes: [
          plan().nodes[0],
          { ...plan().nodes[0], id: "two", title: "Second", dependencies: ["one"] },
          { ...plan().nodes[0], id: "three", title: "Third", dependencies: ["one"] },
          { ...plan().nodes[0], id: "four", title: "Fourth", dependencies: ["two", "three"] },
        ],
      }),
    )!;
    const document = JSON.parse(converted.source);
    expect(document.root.annotations.macroMigration.issues).toEqual([
      "nonlinear-dependencies",
      "execution-not-migrated",
    ]);
  });
});
