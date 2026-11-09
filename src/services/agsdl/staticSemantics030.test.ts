import { describe, expect, it } from "bun:test";
import { validateDocumentBytes } from "./document";
import { projectStaticSemantics030 } from "./staticSemantics030";

const source = (flow: unknown, compositions = {}) => JSON.stringify({ contract: "agsdl-0.3.0", id: "static-projection",
  agents: { worker: { harness: "example", permissions: "read-only" } }, flow, compositions });
const project = (raw: string) => {
  const report = validateDocumentBytes(new TextEncoder().encode(raw));
  expect(report.valid).toBe(true);
  const result = projectStaticSemantics030(raw, { source: raw, report });
  expect(result.report).toBe(report);
  return result;
};
const call = (next?: unknown) => ({ type: "call", command: "echo synthetic", ...(next === undefined ? {} : { next }) });

describe("static semantics 0.3", () => {
  it("separates shared, named and fresh instances, independently of delivery", () => {
    const result = project(source({ entry: "shared", steps: {
      shared: { type: "agent", agent: "worker", next: "sharedAgain" },
      sharedAgain: { type: "agent", agent: "worker", delivery: "steer", next: "named" },
      named: { type: "agent", agent: "worker", instance: "review", delivery: "queue", next: "namedAgain" },
      namedAgain: { type: "agent", agent: "worker", instance: "review", delivery: "steer", next: "other" },
      other: { type: "agent", agent: "worker", instance: "other", next: "fresh" },
      fresh: { type: "agent", agent: "worker", instance: "new", next: "freshAgain" },
      freshAgain: { type: "agent", agent: "worker", instance: "new" },
    } }));
    const [shared, again, named, namedAgain, other, fresh, freshAgain] = result.occurrences;
    expect(shared.agent).toMatchObject({ instance: "shared", delivery: "queue", explicitDelivery: false });
    expect(again.agent).toMatchObject({ delivery: "steer", explicitDelivery: true });
    expect(shared.agent!.conversationKey).toBe(again.agent!.conversationKey);
    expect(named.agent!.conversationKey).toBe(namedAgain.agent!.conversationKey);
    expect(named.agent!.conversationKey).not.toBe(other.agent!.conversationKey);
    expect(named.agent!.conversationKey).not.toBe(shared.agent!.conversationKey);
    expect(fresh.agent).toMatchObject({ instance: "new", conversationKey: null, delivery: null });
    expect(freshAgain.agent!.conversationKey).toBeNull();
    expect(fresh.occurrenceId).not.toBe(freshAgain.occurrenceId);
  });

  it("keeps one conversation through nested parameter bindings and separates repeated source uses", () => {
    const compositions = {
      parent: { parameters: ["p"], entry: "child", outputs: ["done"], steps: {
        child: { type: "compose", composition: "leaf", agents: { q: { parameter: "p" } }, next: { done: { output: "done" } } },
      } },
      leaf: { parameters: ["q"], entry: "work", outputs: ["done"], steps: {
        work: { type: "agent", agent: { parameter: "q" }, instance: "review", next: { output: "done" } },
      } },
    };
    const result = project(source({ entry: "outside", steps: {
      outside: { type: "agent", agent: "worker", instance: "review", next: "first" },
      first: { type: "compose", composition: "parent", agents: { p: "worker" }, next: { done: "second" } },
      second: { type: "compose", composition: "parent", agents: { p: "worker" }, next: { done: [] } },
    } }, compositions));
    const outside = result.occurrences[0];
    const uses = result.occurrences.filter(item => item.sourcePath === "/compositions/leaf/steps/work" && item.address);
    expect(uses.map(item => item.address)).toEqual([["first", "child", "work"], ["second", "child", "work"]]);
    expect(new Set(uses.map(item => item.occurrenceId)).size).toBe(2);
    expect(uses.map(item => item.agent!.conversationKey)).toEqual([outside.agent!.conversationKey, outside.agent!.conversationKey]);
    expect(uses.every(item => item.sourcePath !== item.occurrenceId)).toBe(true);
    expect(uses[0].bindings).toEqual({ q: "worker" });
    const template = result.occurrences.find(item => item.occurrenceId === "/compositions/leaf/steps/work")!;
    expect(template.agent).toMatchObject({ parameter: "q", conversationKey: null });
    expect(template.address).toBeNull();
  });

  it("uses reported fan-out origins and branches and exposes quorum and remaining policy", () => {
    const result = project(source({ entry: "split", steps: {
      split: { ...call({ step: "work", each: ["data", "value"], concurrency: 2, max: 8 }), parse: "json" },
      work: { type: "agent", agent: "worker", instance: "new", next: { yes: "gather", no: "gather" } },
      gather: { type: "join", quorum: { count: 2, accept: ["yes"] }, remaining: "finish", next: { reached: [], missed: [] } },
    } }));
    expect(result.report!.joins.gather).toEqual({ origin: "split", branches: ["work"] });
    const join = result.occurrences.find(item => item.occurrenceId === "/flow/steps/gather")!.join!;
    expect(join).toMatchObject({ originOccurrenceId: "/flow/steps/split", mode: "quorum", quorumCountJson: "2", accept: ["yes"], remaining: "finish", failures: "keep" });
    expect(join.branches).toEqual([{ name: "work", targetOccurrenceId: "/flow/steps/work", memberOccurrenceIds: ["/flow/steps/work"], fanout: true }]);
    expect(result.occurrences.find(item => item.occurrenceId === "/flow/steps/work")!.error).toEqual({ kind: "join", joinOccurrenceIds: ["/flow/steps/gather"] });
  });

  it("does not inherit flow errors inside either level of nested joins", () => {
    const result = project(source({ entry: "split", onError: "recover", steps: {
      split: call(["nested", "right"]), nested: call(["one", "two"]), one: call("inner"), two: call("inner"),
      outer: { type: "join" }, inner: { type: "join", next: "outer" }, right: call("outer"), recover: call(),
    } }));
    expect(result.flowErrorCovered).toEqual(["/flow/steps/split", "/flow/steps/outer"]);
    expect(result.occurrences.find(item => item.occurrenceId === "/flow/steps/inner")!.error).toEqual({ kind: "join", joinOccurrenceIds: ["/flow/steps/outer"] });
    expect(result.occurrences.find(item => item.occurrenceId === "/flow/steps/one")!.error).toEqual({ kind: "join", joinOccurrenceIds: ["/flow/steps/inner", "/flow/steps/outer"] });
  });
});

it("keeps authored join policies for unused templates without inventing an origin", () => {
  const raw = JSON.stringify({ contract: "agsdl-0.3.0", id: "templates", agents: {}, compositions: {
    reusable: { entry: "split", outputs: ["done"], steps: {
      split: call(["left", "right"]), left: call("gather"), right: call("gather"),
      gather: { type: "join", remaining: "wait", failures: "keep", maxFailures: 1, next: { done: { output: "done" }, incomplete: { output: "done" } } },
    } },
  } });
  const result = project(raw);
  expect(result.report!.joins).toEqual({});
  expect(result.occurrences.find(item => item.sourcePath.endsWith("/gather"))!.join).toMatchObject({
    originOccurrenceId: null, branches: [], mode: "all", remaining: "wait", failures: "keep", maxFailuresJson: "1",
  });
});

it("keeps malformed authoring drafts readable without applying validated graph rules", () => {
  for (const flow of [null, {}, { steps: null }, { entry: "a", steps: { a: null } }, { entry: "a", onError: "recover", steps: { a: null } }]) {
    const result = projectStaticSemantics030(source(flow));
    expect(result.report).toBeNull();
    expect(result.flowErrorCovered).toEqual([]);
  }
});

it("shares the default instance across a composition while retaining each delivery policy", () => {
  const result = project(source({ entry: "outside", steps: {
    outside: { type: "agent", agent: "worker", next: "use" },
    use: { type: "compose", composition: "fragment", agents: { p: "worker" }, next: { done: [] } },
  } }, { fragment: { parameters: ["p"], entry: "inside", outputs: ["done"], steps: {
    inside: { type: "agent", agent: { parameter: "p" }, delivery: "steer", next: { output: "done" } },
  } } }));
  const [outside, , inside] = result.occurrences;
  expect(outside.agent!.conversationKey).toBe(inside.agent!.conversationKey);
  expect([outside.agent!.delivery, inside.agent!.delivery]).toEqual(["queue", "steer"]);
});

it("retains a fan-out declared on the global error handler", () => {
  const result = project(source({ entry: "a", onError: { step: "handler", each: ["error", "details"], max: 8 }, steps: {
    a: call(), handler: { type: "agent", agent: "worker", instance: "new", next: "gather" }, gather: { type: "join" },
  } }));
  expect(result.report!.joins.gather).toEqual({ origin: "a", branches: ["handler"] });
  expect(result.occurrences.find(item => item.join)!.join!.branches[0].fanout).toBe(true);
  expect(result.flowErrorCovered).toEqual(["/flow/steps/a"]);
});

it("drops a directly supplied report when its source bytes do not match", () => {
  const raw = source({ entry: "split", steps: {
    split: call(["left", "right"]), left: call("gather"), right: call("gather"), gather: { type: "join" },
  } });
  const report = validateDocumentBytes(new TextEncoder().encode(raw));
  const result = projectStaticSemantics030(`${raw}\n`, { source: raw, report });
  expect(result.report).toBeNull();
  expect(result.occurrences.find(item => item.join)!.join!.originOccurrenceId).toBeNull();
});
