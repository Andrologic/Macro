import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { architectLibrary, type BlueprintDraft, type ProjectBatch, type ProjectView } from "../../services/ipc/architectLibrary";
import { agsdlSessionKey, useAgsdlStore } from "../useAgsdlStore";
import { handleAgsdlToolCall } from "./tools";

const target = { blueprintId: "p" };
const key = agsdlSessionKey(target);
const session = () => useAgsdlStore.getState().sessions[key];
const store = useAgsdlStore.getState;
const manifest = '{"projectFormat":"agsdl-project-1","contract":"agsdl-0.4.0","id":"p","title":"Original","agents":{"review":{"file":"agents/review.json"}}}';
const agent = '{"harness":"codex","permissions":"read-only","description":"Original","harnessSettings":{"exact":9876543210987654321}}';
const opaque = "skill/nested/data";
let source: Map<string, string>;
let revision: number;
let lastBatch: ProjectBatch | undefined;
let hidden: string[];

function view(): ProjectView {
  const text = source.get("agents/review.json");
  const file = (path: string, raw: string) => ({ path, size: new TextEncoder().encode(raw).byteLength, executable: false });
  const invalid = text?.startsWith("{bad");
  return {
    revision, files: [...source].map(([path, raw]) => file(path, raw)),
    settings: { schemaVersion: 1, hiddenAgentIds: hidden, workingFolderMode: "perExecution" },
    projection: invalid ? null : {
      source: `{"contract":"agsdl-0.4.0","id":"p","title":${JSON.stringify(JSON.parse(source.get("agsdl.json")!).title)},"agents":{"review":${text}}}`,
      origins: { "/agents/review": { file: "agents/review.json", pointer: "" } },
    },
    diagnostics: invalid ? [{ code: "PROJECT", file: "agents/review.json", pointer: "", message: "Invalid JSON" }] : [],
  };
}

function draft(): BlueprintDraft {
  const project = view();
  return {
    id: "p", projectId: "lib", name: "Review", revision, archived: false, origin: null, conversationId: "chat",
    history: null, project, document: { source: project.projection?.source ?? "", annexes: {} },
  };
}

beforeEach(() => {
  revision = 5;
  source = new Map([["agsdl.json", manifest], ["agents/review.json", agent], [opaque, ""]]);
  lastBatch = undefined;
  hidden = [];
  store().openBlueprintDocument(draft());
  spyOn(architectLibrary, "getDraft").mockImplementation(async () => draft());
  spyOn(architectLibrary, "readProjectFile").mockImplementation(async (ref, path) => {
    if (ref.kind !== "draft" || ref.revision !== revision) throw { message: "Validation error: stale_revision" };
    const file = view().files.find(entry => entry.path === path)!;
    return { revision, content: path === opaque ? { kind: "binary", file } : { kind: "text", file, text: source.get(path)! } };
  });
  spyOn(architectLibrary, "saveProjectDraft").mockImplementation(async (_blueprint, expected, batch) => {
    if (expected !== revision) throw { message: "Validation error: stale_revision" };
    lastBatch = batch;
    for (const file of batch.files) {
      if (file.kind === "write") source.set(file.path, file.text);
      else source.delete(file.path);
    }
    if (batch.settings?.hiddenAgentIds) hidden = batch.settings.hiddenAgentIds;
    revision++;
    return view();
  });
});

afterEach(() => {
  useAgsdlStore.setState({ sessions: {} });
  for (const method of [architectLibrary.getDraft, architectLibrary.readProjectFile, architectLibrary.saveProjectDraft, architectLibrary.saveVersion]) {
    if ("mockRestore" in method && typeof method.mockRestore === "function") method.mockRestore();
  }
});

test("structured edits address separate source files, and undo/redo persists their exact prior text", async () => {
  await store().edit(target, [
    { op: "set", path: "/title", valueJson: '"New"' },
    { op: "set", path: "/agents/review/description", valueJson: '"New role"' },
  ], session().version);
  expect(session().dirty).toBe(true);
  await store().save(target);
  expect(lastBatch?.files.map(file => file.path)).toEqual(["agsdl.json", "agents/review.json"]);
  expect(source.get("agsdl.json")).toContain('"file":"agents/review.json"');
  expect(source.get("agents/review.json")).toContain("9876543210987654321");
  store().undo(target);
  await store().save(target);
  expect(source.get("agsdl.json")).toBe(manifest);
  expect(source.get("agents/review.json")).toBe(agent);
  store().undo(target, true);
  await store().save(target);
  expect(source.get("agents/review.json")).toContain("New role");
});

test("an invalid batch retains the graph at its last valid revision and refuses opaque or oversized edits", async () => {
  await expect(store().applyProjectBatch(target, [{ kind: "write", path: opaque, text: "text" }])).rejects.toThrow("cannot be edited");
  await expect(store().applyProjectBatch(target, [{ kind: "write", path: "large.txt", text: "é".repeat(1024 * 1024) }])).rejects.toThrow("1 MiB");
  const graph = session().source;
  await store().applyProjectBatch(target, [{ kind: "write", path: "agents/review.json", text: "{bad" }]);
  await store().save(target);
  expect(session().source).toBe(graph);
  expect(session().project?.graphRevision).toBe(5);
  expect(session().project?.view.diagnostics[0]?.file).toBe("agents/review.json");
  expect(session().persistedRevision).toBe(6);
});

test("reloading a changed revision preserves local file edits until the user resolves the conflict", async () => {
  await store().applyProjectBatch(target, [{ kind: "write", path: "agents/review.json", text: agent.replace("Original", "Local") }]);
  source.set("agsdl.json", manifest.replace("Original", "Remote"));
  revision++;
  await store().load(target, true);
  expect(session().draftConflict?.saved?.revision).toBe(6);
  const file = await store().readProjectFile(target, "agents/review.json");
  expect(file?.kind === "text" && file.text).toContain("Local");
  await store().resolveDraftConflict(target, session().version, 6, "local");
  expect(source.get("agsdl.json")).toContain("Remote");
  expect(source.get("agents/review.json")).toContain("Local");
});

test("version creation flushes file and settings changes before freeze", async () => {
  const freeze = spyOn(architectLibrary, "saveVersion").mockImplementation(async (id, expected) => {
    expect(expected).toBe(6);
    expect(hidden).toEqual(["review"]);
    expect(source.get("agsdl.json")).toContain("Changed title");
    return { blueprintId: id, number: 1, revision: expected, note: null };
  });
  await store().applyProjectBatch(target, [{ kind: "write", path: "agsdl.json", text: manifest.replace("Original", "Changed title") }], { hiddenAgentIds: ["review"] });
  await store().saveVersion("p", null);
  expect(freeze).toHaveBeenCalledTimes(1);
});

test("agents page source files at a revision and apply one ordered file-local batch", async () => {
  const call = (toolName: string, args: Record<string, unknown>, isCurrent = () => true) =>
    handleAgsdlToolCall({ toolName, args, blueprintId: "p", conversationId: "chat", isCurrent }).then(JSON.parse);
  const first = await call("agsdl_get", { section: "files", limit: 1 });
  expect(first.next_offset).toBe(1);
  const file = await call("agsdl_get", { section: "file", file_path: "agents/review.json", limit: 9, expected_revision: first.revision });
  expect(file.text_page.content).toBe(agent.slice(0, 9));
  revision++;
  await expect(call("agsdl_get", { section: "files", offset: 1, expected_revision: first.revision })).rejects.toThrow("project changed");
  await expect(call("agsdl_get", { section: "file", file_path: "agents/review.json", cursor: file.text_page.next_cursor, expected_revision: first.revision })).rejects.toThrow("project changed");
  const latest = await call("agsdl_get", { section: "files" });
  const operations = [
    { op: "write", file: "notes.txt", text: "Notes" },
    { op: "set", file: "agents/review.json", pointer: "/description", value_json: '"Edited"' },
    { op: "remove_file", file: "notes.txt" },
  ];
  const updated = await call("agsdl_update", {
    blueprint_id: "p", expected_revision: latest.revision, file_operations: operations,
    macro_settings: { hidden_agent_ids: ["review"] },
  });
  expect(lastBatch?.files.map(file => file.kind)).toEqual(["write", "write", "remove"]);
  expect(updated.persisted_revision).toBe(7);
  expect(source.has("notes.txt")).toBe(false);
  expect(source.get("agents/review.json")).toContain("Edited");
  expect(hidden).toEqual(["review"]);
});
