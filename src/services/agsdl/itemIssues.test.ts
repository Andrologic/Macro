import { expect, it } from "bun:test";
import { diagnosticIssue, issueView, parseUpgradeDetails } from "./itemIssues";

it("names the item an upgrade failure belongs to and keeps the raw line for the details", () => {
  const issues = parseUpgradeDetails([
    "MESSAGE_PATH /flow/steps/collect/next/each — bad reference",
    "UNKNOWN_AGENT /agents/relecteur/skills/0 — missing skill",
    "BAD_URL /mcpServers/github/url — not a url",
    "OTHER /skills/style — missing file",
    "NESTED /compositions/review/steps/inspect/prompt — empty",
    "ROOT /title — wrong type",
    "free text without a location",
  ].join("\n"));
  expect(issues.map(({ kind, name }) => [kind, name])).toEqual([
    ["step", "collect"], ["agent", "relecteur"], ["tool", "github"], ["skill", "style"],
    ["step", "inspect"], ["document", null], ["document", null],
  ]);
  expect(issues[0].technical).toBe("MESSAGE_PATH /flow/steps/collect/next/each — bad reference");
  expect(issues[6].technical).toBe("free text without a location");
});

it("handles escaped pointer parts and an absent message", () => {
  expect(parseUpgradeDetails("X /agents/a~1b — oops")[0]).toMatchObject({ kind: "agent", name: "a/b" });
  expect(parseUpgradeDetails(undefined)).toEqual([]);
  expect(parseUpgradeDetails("\n\n")).toEqual([]);
});

it("reads the owner of a project diagnostic from its file, then its pointer", () => {
  const issue = (file: string | null, pointer: string) => diagnosticIssue({ code: "C", file, pointer, message: "m" });
  expect(issue("agents/relecteur.json", "/instructions")).toMatchObject({ kind: "agent", name: "relecteur" });
  expect(issue("skills/style.json", "")).toMatchObject({ kind: "skill", name: "style" });
  expect(issue("mcp/github.json", "/command")).toMatchObject({ kind: "tool", name: "github" });
  expect(issue("flows/main.json", "/steps/review/next")).toMatchObject({ kind: "step", name: "review" });
  expect(issue("agsdl.json", "/agents/writer")).toMatchObject({ kind: "agent", name: "writer" });
  expect(issue(null, "")).toMatchObject({ kind: "document", name: null });
  expect(issue("agents/a.json", "/x").technical).toBe("C · agents/a.json#/x · m");
});

it("sends each kind of item to the part of the system that shows it", () => {
  expect([issueView("agent"), issueView("skill"), issueView("tool"), issueView("step"), issueView("document")])
    .toEqual(["agents", "skills", "tools", "flow", "flow"]);
});
