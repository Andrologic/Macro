import { expect, it } from "bun:test";
import type { AgsdlRuntimeReference } from "../../types";
import type { PublicSnapshot, SourceRevision, SystemStartId, Sequence } from "../agsdlExecution/contracts";
import { captureRuntimeSelection, isAgsdlReference, assertRuntimeSelectionDestination } from "./runtimeSelection";
import { serializeAgsdlChatContext } from "./selectionContext";
import { agsdlContextForModel, readRuntimeCapture } from "./chatContextPayload";
import { persistableContextRefs, submissionHiddenContext } from "../chat/composerSubmission";

const authoredSource = '{ "agent": { "limit": 9007199254740993, "title": "capture" }, "related": 1.00 }';
async function fixture() {
  const sha = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(authoredSource))), byte => byte.toString(16).padStart(2, "0")).join("");
  const source = { owner: { projectId: "project", planId: "plan", branch: "feature/work" }, revision: "9007199254740993", sourceSha256: sha } as SourceRevision;
  const reference: AgsdlRuntimeReference = { id: "ref", conversationId: "conversation", branchName: source.owner.branch, planId: source.owner.planId, document: "agsdl", contextKind: "runtime",
    systemStartId: "run" as SystemStartId, source, cursor: "9007199254740995" as Sequence, path: "/agent", relatedPaths: ["/related"], title: "History" };
  const snapshot: PublicSnapshot = { systemStartId: reference.systemStartId, source, authoredSource,
    versions: { snapshot: "1", contract: "agsdl-0.2.0", compiler: "compiler", runtime: "runtime", registry: "registry", profile: "macro-serial-inline-v1" }, associations: {} };
  return { source, reference, snapshot };
}
it("captures exact authored lexemes and an explicit empty diagnostic selection, then replays without live resolution", async () => {
  const { reference, snapshot, source } = await fixture();
  let reads = 0;
  const capture = await captureRuntimeSelection(reference, { snapshot: async () => { reads++; return snapshot; }, diagnostic: async request => {
    reads++; expect(request.selected).toEqual([]); expect(request.through).toBe(reference.cursor);
    return { systemStartId: "run", source, activation: null, through: reference.cursor, diagnostics: [], incomplete: false, nextBefore: null };
  } });
  expect(capture.fragments.map(item => item.sourceText)).toEqual(['{ "limit": 9007199254740993, "title": "capture" }', '1.00']);
  const hidden = serializeAgsdlChatContext(reference, capture)!;
  const refs = persistableContextRefs([{ id: reference.id, kind: "agsdl", title: reference.title, data: reference }])!;
  expect(submissionHiddenContext(refs, hidden)).toBe(hidden);
  expect(agsdlContextForModel('PRIVATE METADATA\n'+hidden, refs)).toBe(hidden);
  expect(reads).toBe(2);
  expect(agsdlContextForModel(hidden)).toBeUndefined();
  const changed = structuredClone(refs); changed[0].agsdl!.title = "Other";
  expect(() => submissionHiddenContext(changed, hidden)).toThrow("exact public capture");
  expect(agsdlContextForModel(hidden, changed)).toBeUndefined();
  expect(() => serializeAgsdlChatContext(reference)).toThrow("exact public capture");
});
it("rejects foreign, duplicate, future and private identities without a title fallback", async () => {
  const { reference } = await fixture();
  for (const changed of [ { ...reference, source: { ...reference.source, owner: { ...reference.source.owner, planId: "foreign" } } },
    { ...reference, cursor: "01" }, { ...reference, version: "mixed" }, { ...reference, ownerEpoch: "private" },
    { ...reference, diagnosticSelection: [{ id: "foreign:1", sequence: "1" }] },
    { ...reference, diagnosticSelection: [{ id: "run:1", sequence: "1" }, { id: "run:1", sequence: "1" }] },
    { ...reference, diagnosticSelection: [{ id: "run:9007199254740996", sequence: "9007199254740996" }] },
    { ...reference, diagnosticSelection: Array.from({ length: 65 }, (_, index) => ({ id: `run:${index}`, sequence: String(index) })) } ]) expect(isAgsdlReference(changed)).toBe(false);
});
it("rejects a tampered snapshot and refuses diagnostic substitution or incomplete capture", async () => {
  const { reference, source, snapshot } = await fixture();
  await expect(captureRuntimeSelection(reference, { snapshot: async () => ({ ...snapshot, authoredSource: '{}' }), diagnostic: async () => { throw new Error("must not read"); } })).rejects.toThrow("source differs");
  await expect(captureRuntimeSelection(reference, { snapshot: async () => ({ ...snapshot, associations: { conversationId: "foreign" } }), diagnostic: async () => { throw new Error("must not read"); } })).rejects.toThrow("identity changed");
  const selected = { ...reference, diagnosticSelection: [{ id: "run:1", sequence: "1" as Sequence }] };
  for (const result of [{ id: "run:2", sequence: "2", code: "CODE", pointer: "", message: "known" }, { id: "run:1", sequence: "1", code: "CODE", pointer: "", message: "known" }]) {
    await expect(captureRuntimeSelection(selected, { snapshot: async () => snapshot, diagnostic: async () => ({ systemStartId: "run", source, activation: null, through: selected.cursor,
      diagnostics: [{ ...result, work: null }], incomplete: result.id === "run:1", nextBefore: null }) })).rejects.toThrow("identity changed");
  }
});
it("rejects private fields anywhere in persisted runtime captures", async () => {
  const { reference, source, snapshot } = await fixture();
  const capture = await captureRuntimeSelection(reference, { snapshot: async () => snapshot, diagnostic: async () => ({ systemStartId: "run", source, activation: null, through: reference.cursor, diagnostics: [], incomplete: false, nextBefore: null }) });
  const hidden = serializeAgsdlChatContext(reference, capture)!;
  for (const value of [{ context_kind: "runtime", ...capture, memory: "secret" }, { context_kind: "runtime", ...capture, versions: { ...capture.versions, credentials: "secret" } }]) {
    const block = `<agsdl_selection>\n${JSON.stringify(value)}\n</agsdl_selection>`;
    expect(readRuntimeCapture(block)).toBeUndefined(); expect(agsdlContextForModel(block)).toBeUndefined();
  }
  expect(readRuntimeCapture(hidden)?.reference).toEqual(reference);
});

it("revalidates destination project and recorded plan conversation after asynchronous ownership reads", async () => {
  const { reference } = await fixture();
  const refs = persistableContextRefs([{ id: reference.id, kind: 'agsdl', title: reference.title, data: reference }]);
  let projectId = 'project';
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const checking = assertRuntimeSelectionDestination(refs, 'conversation', { conversation: () => ({ project_id: projectId }), plan: async () => { await pending; return { conversationId: 'conversation', status: 'draft' }; } });
  projectId = 'foreign'; release(); await expect(checking).rejects.toThrow('destination differs');
  await expect(assertRuntimeSelectionDestination(refs, 'foreign', { conversation: () => ({ project_id: 'project' }), plan: async () => ({ conversationId: 'conversation', status: 'draft' }) })).rejects.toThrow('destination differs');
  await expect(assertRuntimeSelectionDestination(refs, 'conversation', { conversation: () => ({ project_id: 'project' }), plan: async () => ({ conversationId: 'foreign', status: 'draft' }) })).rejects.toThrow('destination differs');
});
