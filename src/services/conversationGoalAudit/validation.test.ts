import { describe, expect, it } from "bun:test";
import type { ConversationGoalVerdict } from "../../types";
import { validateConversationGoalVerdict } from "./validation";

const validVerdict = (): ConversationGoalVerdict => ({
  verdict: "needs_user",
  summary: "The repository evidence is inconclusive.",
  criteria: [
    {
      criterion: "Confirm the release artifact",
      status: "uncertain",
      evidence: [
        {
          source: "dist/",
          finding: "No signed artifact is available for inspection.",
        },
      ],
    },
  ],
  feedback: "Wait for the signing input.",
  questionForUser: "Which signing identity should be used?",
  confidence: 0.72,
});
describe("validateConversationGoalVerdict", () => {
  it("accepts the exact schema and normalizes its text", () => {
    const candidate = validVerdict();
    candidate.summary = "  The repository   evidence is inconclusive. ";

    expect(
      validateConversationGoalVerdict(candidate, ["Confirm the release artifact"]),
    ).toMatchObject({
      ok: true,
      value: { summary: "The repository evidence is inconclusive." },
    });
  });

  it.each([
    ["unknown verdict", { verdict: "done" }],
    ["unknown criterion status", { criteria: [{ status: "unknown" }] }],
    ["criterion mismatch", { criteria: [{ criterion: "A different criterion" }] }],
    ["missing evidence", { criteria: [{ evidence: [] }] }],
    ["question on a non-user verdict", { verdict: "continue" }],
    ["confidence above one", { confidence: 1.1 }],
    ["unexpected property", { unexpected: true }],
  ])("rejects %s", (_label, mutation) => {
    const candidate = validVerdict() as unknown as Record<string, unknown>;
    if ("criteria" in mutation) {
      const criterionMutation = mutation.criteria?.[0] ?? {};
      candidate.criteria = [
        {
          ...(validVerdict().criteria[0] as object),
          ...criterionMutation,
        },
      ];
    } else {
      Object.assign(candidate, mutation);
    }

    expect(
      validateConversationGoalVerdict(candidate, ["Confirm the release artifact"]).ok,
    ).toBe(false);
  });

  it("rejects achieved when any criterion is not met", () => {
    const candidate = validVerdict();
    candidate.verdict = "achieved";
    candidate.questionForUser = null;

    expect(
      validateConversationGoalVerdict(candidate, ["Confirm the release artifact"]),
    ).toMatchObject({ ok: false });
  });

  it("rejects achieved without criteria but permits continuation without criteria", () => {
    const achieved = validVerdict();
    achieved.verdict = "achieved";
    achieved.questionForUser = null;
    achieved.criteria = [];
    expect(validateConversationGoalVerdict(achieved, []).ok).toBe(false);

    const continuation = validVerdict();
    continuation.verdict = "continue";
    continuation.questionForUser = null;
    continuation.criteria = [];
    expect(validateConversationGoalVerdict(continuation, []).ok).toBe(true);
  });

  it("rejects normalized duplicate evidence but keeps distinct pairs containing NUL", () => {
    const duplicate = validVerdict();
    duplicate.criteria[0].evidence.push({
      source: " dist/ ",
      finding: " No signed artifact is available for inspection. ",
    });
    expect(
      validateConversationGoalVerdict(duplicate, ["Confirm the release artifact"]).ok,
    ).toBe(false);

    const distinct = validVerdict();
    distinct.criteria[0].evidence = [
      { source: "a\u0000b", finding: "c" },
      { source: "a", finding: "b\u0000c" },
    ];
    expect(
      validateConversationGoalVerdict(distinct, ["Confirm the release artifact"]).ok,
    ).toBe(true);
  });
});
