import { expect, it } from "bun:test";
import { appendProjection, groupNativeState, nativeCardActivations } from "./executionView";
import type { PublicProjection, PublicSnapshot, PublicActivation, SourceRevision, SystemStartId, Sequence } from "../agsdlExecution/contracts";
import { projectViewer } from "./viewer";
import { createExample } from "./examples";
const source = { owner: { projectId: "p", planId: "plan", branch: "work" }, revision: "1", sourceSha256: "a".repeat(64) } as SourceRevision;
const snapshot = { systemStartId: "run", source } as PublicSnapshot;
const page = (overrides: Partial<PublicProjection> = {}): PublicProjection => ({ systemStartId: "run" as SystemStartId, source, cursor: "9007199254740993" as Sequence, agents: [], activations: [], nextPage: { cursor: "9007199254740993" as Sequence, offset: 64 }, systemStop: { kind: "none" }, ...overrides });
it("merges only one cursor's exact continuation and refuses foreign or duplicate pages", () => {
  const first = page(); const second = page({ nextPage: null });
  expect(appendProjection(first, second, snapshot).cursor).toBe(first.cursor);
  for (const value of [page({ cursor: "9007199254740994" as Sequence, nextPage: null }), page({ source: { ...source, revision: "2" } }), page({ nextPage: { cursor: first.cursor, offset: 192 } })]) expect(() => appendProjection(first, value, snapshot)).toThrow();
  const agent = { agentInstanceId: "instance" as import("../agsdlExecution/contracts").AgentInstanceId, agentName: "helper" };
  expect(() => appendProjection(page({ agents: [agent] }), page({ agents: [agent], nextPage: null }), snapshot)).toThrow();
});
it("uses exact step identity, native approval requests and stop evidence, never a matching title", () => {
  const cards = projectViewer(createExample("release")).graphs[0].cards;
  const card = cards.find(item => item.path.startsWith("/flow/steps/"))!;
  const activation = { work: { systemStartId: "run", flowInvocationId: "flow", activationId: "activation", step: [card.path.slice('/flow/steps/'.length)], agentInstanceId: null }, deliveryId: "delivery", queueSequence: "1", workState: "active", stopState: { kind: "none" }, terminalKind: null } as unknown as PublicActivation;
  expect(nativeCardActivations(cards, page({ activations: [activation] }), [])[card.path].state).toBe("active");
  const approvals = [{ approvalId: "approval", work: { ...activation.work, step: activation.work.step ? [...activation.work.step] : null }, toolName: "Tool", summary: "Request", status: "pending" }];
  expect(nativeCardActivations(cards, page({ activations: [activation] }), approvals)[card.path].state).toBe("approval");
  expect(nativeCardActivations(cards, page({ activations: [{ ...activation, stopState: { kind: "requested", requestId: "stop" } }] }), [])[card.path].state).toBe("stopRequested");
  expect(nativeCardActivations([{ ...card, path: '/foreign', title: card.title }], page({ activations: [activation] }), [])).toEqual({});
  expect(groupNativeState([{ state: "completed", activations: [activation] }], 2)).toBeUndefined();
});
