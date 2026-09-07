import { AGSDL_CONTRACT } from "./document";

export const AGSDL_EXAMPLES = [
  "release",
  "feature",
  "hotfix",
  "bugfix",
] as const;
export type AgsdlExample = (typeof AGSDL_EXAMPLES)[number];

const workflows: Record<AgsdlExample, Array<[string, string, string]>> = {
  release: [
    [
      "checklist",
      "Checklist",
      "Check each release prerequisite. Return the evidence and unresolved points in a report.",
    ],
    [
      "review",
      "PR review",
      "Examine the pull request reviews and the preceding report. Record resolved and unresolved findings.",
    ],
    [
      "installers",
      "Installers",
      "Verify the supplied installers against the checklist. Record actual checks, evidence, and unavailable checks.",
    ],
  ],
  feature: [
    [
      "specify",
      "Specification",
      "Clarify the request and produce acceptance criteria.",
    ],
    [
      "implement",
      "Implementation",
      "Implement the specified change and document the result.",
    ],
    [
      "verify",
      "Verification",
      "Review the change against the acceptance criteria and record evidence.",
    ],
  ],
  hotfix: [
    ["diagnose", "Diagnosis", "Reproduce the incident and record its cause."],
    [
      "correct",
      "Correction",
      "Apply a focused correction using the diagnosis.",
    ],
    [
      "verify",
      "Verification",
      "Verify the correction and record regression checks.",
    ],
  ],
  bugfix: [
    [
      "reproduce",
      "Reproduction",
      "Reproduce the defect and document expected behavior.",
    ],
    [
      "correct",
      "Correction",
      "Correct the defect with the reproduction as context.",
    ],
    [
      "verify",
      "Verification",
      "Verify the corrected behavior and record the result.",
    ],
  ],
};

/** Illustrative documents, with explicit missing engines and no executable adapter claims. */
export function createExample(kind: AgsdlExample): string {
  const scope = `example-${kind}`;
  const key = (id: string) => ({ scope, id, version: "1" });
  const root = key("system");
  const definition = (
    id: string,
    kind: string,
    payload: unknown,
    title?: string,
  ) => ({
    key: key(id),
    kind,
    owner: root,
    payload,
    ...(title ? { annotations: { title } } : {}),
  });
  const definitions: unknown[] = [
    definition("process", "ControlFlow", {}),
    definition("project", "Resource", {}),
  ];
  const relations: unknown[] = [];
  const agents: unknown[] = [];
  const steps: unknown[] = [];
  const stages = workflows[kind];
  stages.forEach(([id, title, body], index) => {
    definitions.push(
      definition(id, "Agent", {}, title),
      definition(`${id}-principal`, "Principal", {}),
      definition(`${id}-action`, "Action", {}),
      definition(`${id}-interface`, "Interface", {
        operations: [
          {
            id: "work",
            direction: "inbound",
            mode: "request-response",
            action: key(`${id}-action`),
            inputs: { brief: "string" },
            outputs: { report: "string" },
          },
        ],
      }),
      definition(`${id}-instructions`, "Instructions", {
        target: "Agent",
        at: "before-invoke",
        format: { identity: "text/plain", version: "1" },
        body,
        requires: [],
      }),
    );
    for (const [relation, target, expectedKind] of [
      ["actsAs", `${id}-principal`, "Principal"],
      ["exposes", `${id}-interface`, "Interface"],
      ["directedBy", `${id}-instructions`, "Instructions"],
    ]) {
      relations.push({
        source: key(id),
        relation,
        target: key(target),
        expectedKind,
      });
    }
    agents.push({
      agent: key(id),
      engine: null,
      parameters: {},
      requires: [],
      claims: [],
      tools: [],
      applications: [
        {
          content: key(`${id}-instructions`),
          adapter: { identity: "example/instructions", version: "1" },
          parameters: {},
        },
      ],
    });
    steps.push({
      id,
      kind: "invoke",
      operation: "work",
      agent: key(id),
      interface: key(`${id}-interface`),
      action: key(`${id}-action`),
      resources: [key("project")],
      principal: key(`${id}-principal`),
      context: { input: "context" },
      inputs: { brief: "string" },
      outputs: { report: "string" },
      bindings: {
        brief:
          index === 0
            ? { input: "brief" }
            : { step: stages[index - 1][0], port: "report" },
      },
      success: stages[index + 1]?.[0] ?? "done",
      failure: "failed",
    });
  });
  steps.push(
    {
      id: "done",
      kind: "end",
      outcome: "success",
      bindings: { report: { step: stages.at(-1)![0], port: "report" } },
    },
    {
      id: "failed",
      kind: "end",
      outcome: "failure",
      reason: "An invocation failed; inspect its report.",
    },
  );
  return JSON.stringify(
    {
      contract: AGSDL_CONTRACT,
      root: {
        key: root,
        kind: "System",
        annotations: { title: kind[0].toUpperCase() + kind.slice(1) },
      },
      definitions,
      relations,
      exports: [],
      dependencies: [],
      unresolved: [],
      extensions: [],
      graphs: [
        {
          definition: key("process"),
          entry: stages[0][0],
          inputs: { brief: "string", context: "json" },
          outputs: { report: "string" },
          steps,
        },
      ],
      runtime: {
        configurations: [{ id: "configure-me", graph: key("process"), agents }],
      },
    },
    null,
    2,
  );
}
