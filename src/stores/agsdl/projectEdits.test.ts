import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { architectLibrary, type BlueprintDraft, type ProjectBatch, type ProjectView } from "../../services/ipc/architectLibrary";
import { agsdlSessionKey, useAgsdlStore } from "../useAgsdlStore";
import { handleAgsdlToolCall } from "./tools";
import { componentProperties, projectComponentProperties, propertyChanges } from "../../services/agsdl/componentProperties";
import { MAX_AGSDL_BYTES } from "../../services/agsdl/document";
import { projectViewer } from "../../services/agsdl/viewer";

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
let executable: Set<string>;

function view(): ProjectView {
  const text = source.get("agents/review.json");
  const file = (path: string, raw: string) => ({ path, size: new TextEncoder().encode(raw).byteLength, executable: executable.has(path) });
  const invalid = text?.startsWith("{bad");
  return {
    revision, files: [...source].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([path, raw]) => file(path, raw)),
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
  executable = new Set();
  store().openBlueprintDocument(draft());
  spyOn(architectLibrary, "getDraft").mockImplementation(async () => draft());
  spyOn(architectLibrary, "readProjectFile").mockImplementation(async (ref, path) => {
    if (ref.kind !== "draft" || ref.revision !== revision) throw { message: "Validation error: stale_revision" };
    const file = view().files.find(entry => entry.path === path)!;
    return { revision, content: path === opaque ? { kind: "binary", file } : { kind: "text", file, text: source.get(path)! } };
  });
  spyOn(architectLibrary, "saveProjectDraft").mockImplementation(async (_blueprint, expected, batch) => {
    if (expected !== revision) throw { message: "Validation error: stale_revision" };
    if (batch.files.some(file => file.kind === "remove" && file.path === "agsdl.json")) throw new Error("MANIFEST_REQUIRED");
    lastBatch = batch;
    for (const file of batch.files) {
      if (file.kind === "write") {
        source.set(file.path, file.text);
        if (file.executable === true) executable.add(file.path);
        if (file.executable === false) executable.delete(file.path);
      } else {
        source.delete(file.path);
        executable.delete(file.path);
      }
    }
    if (batch.settings?.hiddenAgentIds) hidden = batch.settings.hiddenAgentIds;
    revision++;
    return view();
  });
});

afterEach(() => {
  useAgsdlStore.setState({ sessions: {} });
  for (const method of [architectLibrary.getDraft, architectLibrary.readProjectFile, architectLibrary.saveProjectDraft, architectLibrary.saveVersion, architectLibrary.validateDraft]) {
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

test("undoing the last unsaved edit restores the saved graph and diagnostics", async () => {
  const saved = session().project!.saved;
  spyOn(architectLibrary, "validateDraft").mockResolvedValue({
    ...saved, projection: null,
    diagnostics: [{ code: "PROJECT", file: "agents/review.json", pointer: "", message: "Invalid JSON" }],
  });
  await store().applyProjectBatch(target, [{ kind: "write", path: "agents/review.json", text: "{bad" }]);
  await store().validate(target);
  expect(session().project?.view.diagnostics[0]?.message).toBe("Invalid JSON");
  const staleVersion = session().version;

  store().undo(target);
  expect(session().dirty).toBe(false);
  expect(session().version).not.toBe(staleVersion);
  expect(session().project?.graphVersion).toBe(session().version);
  expect(session().project?.view).toBe(saved);
  expect(session().source).toBe(saved.projection!.source);
  store().undo(target, true);
  expect(session().dirty).toBe(true);
  store().undo(target);
  await store().edit(target, [{ op: "set", path: "/title", valueJson: '"Corrected"' }], session().version);
  expect(session().project?.pending.files[0]).toMatchObject({ path: "agsdl.json", text: manifest.replace("Original", "Corrected") });
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

test("a rejected agent batch leaves unrelated edits queued and undo drops unsaved operations", async () => {
  await store().applyProjectBatch(target, [{ kind: "write", path: "notes.txt", text: "Pending user edit" }]);
  const original = session().version;
  await expect(handleAgsdlToolCall({
    toolName: "agsdl_update", blueprintId: "p", conversationId: "chat", isCurrent: () => true,
    args: { blueprint_id: "p", expected_revision: original, file_operations: [{ file: "agsdl.json", op: "remove_file" }] },
  })).rejects.toThrow("MANIFEST_REQUIRED");
  expect(session().version).toBe(original);
  expect(session().project?.pending.files.map(file => file.path)).toEqual(["notes.txt"]);

  await store().applyProjectBatch(target, [{ kind: "remove", path: "agsdl.json" }]);
  await expect(store().save(target)).rejects.toThrow("MANIFEST_REQUIRED");
  store().undo(target);
  expect(session().project?.pending.files.map(file => file.path)).toEqual(["notes.txt"]);
  await store().save(target);
  expect(source.get("notes.txt")).toBe("Pending user edit");
  expect(source.get("agsdl.json")).toBe(manifest);
});

test("undo restores the executable bit and rejects edits whose inverse would exceed the request limit", async () => {
  source.set("script.sh", "echo hi");
  source.set("boundary.txt", "x".repeat(MAX_AGSDL_BYTES));
  executable.add("script.sh");
  revision++;
  await store().load(target, true);
  await expect(store().applyProjectBatch(target, [{ kind: "remove", path: "boundary.txt" }])).rejects.toThrow("1 MiB");
  expect(session().dirty).toBe(false);
  await store().applyProjectBatch(target, [{ kind: "remove", path: "script.sh" }]);
  await store().save(target);
  expect(executable.has("script.sh")).toBe(false);
  store().undo(target);
  expect((await store().readProjectFile(target, "script.sh"))?.file.executable).toBe(true);
  await store().save(target);
  expect(lastBatch?.files).toEqual([{ kind: "write", path: "script.sh", text: "echo hi", executable: true }]);
  expect(executable.has("script.sh")).toBe(true);
});

test("saving a pending project invalidates its inventory and file pagination tokens", async () => {
  const call = (args: Record<string, unknown>) => handleAgsdlToolCall({
    toolName: "agsdl_get", args, blueprintId: "p", conversationId: "chat", isCurrent: () => true,
  }).then(JSON.parse);
  await store().applyProjectBatch(target, [{ kind: "write", path: "Z.txt", text: "New file" }]);
  const first = await call({ section: "files", limit: 1 });
  const page = await call({ section: "file", file_path: "Z.txt", limit: 3, expected_revision: first.revision });
  await store().save(target);
  await expect(call({ section: "files", offset: first.next_offset, expected_revision: first.revision })).rejects.toThrow("project changed");
  await expect(call({ section: "file", file_path: "Z.txt", cursor: page.text_page.next_cursor, expected_revision: first.revision })).rejects.toThrow("project changed");
  const saved = await call({ section: "files" });
  expect(saved.files[0].path).toBe("Z.txt");
});

test("structured properties edit source links and detached settings without inlining the projection", async () => {
  const settingsPath = "settings/review.json";
  const agentPath = "agents/review.json";
  const settingsText = '{"exact":9876543210987654321}';
  const authoredAgent = '{"harness":"codex","permissions":"read-only","description":"Original"}';
  const authoredManifest = manifest.replace(/}$/, ',"settingsFiles":{"review":"settings/review.json"}}');
  source.set("agsdl.json", authoredManifest);
  source.set(agentPath, authoredAgent);
  source.set(settingsPath, settingsText);
  revision++;
  const project = view();
  project.projection!.source = project.projection!.source.replace(authoredAgent, agent);
  project.projection!.origins["/agents/review/harnessSettings"] = { file: settingsPath, pointer: "" };
  store().openBlueprintDocument({ ...draft(), project });
  const review = projectViewer(project.projection!.source, {}, [], true).declarations.find(card => card.kind === "Agent")!;
  const system = { ...review, kind: "System", path: "", edition030: { ...review.edition030!, ownerPath: "" } };
  const read = (path: string) => store().readProjectFile(target, path);
  const systemFields = (await projectComponentProperties(project, system, read)).fields;
  expect(systemFields.find(field => field.path === "/agents")?.value).toBe('{"review":{"file":"agents/review.json"}}');
  const agentFields = (await projectComponentProperties(project, review, read)).fields;
  expect(agentFields.find(field => field.path.endsWith("/harnessSettings"))?.value).toBe(settingsText);
  const changes = propertyChanges(agentFields, agentFields.map(field => field.label === "harnessSettings" ? "" : field.label === "description" ? '"Edited"' : field.value));
  await store().edit(target, changes);
  await store().save(target);
  expect(JSON.parse(source.get("agsdl.json")!)).toMatchObject({ agents: { review: { file: agentPath } }, settingsFiles: {} });
  expect(source.get(agentPath)).toBe(authoredAgent.replace("Original", "Edited"));
  expect(source.get(settingsPath)).toBe(settingsText);
});

test("component inspection accepts an assembled project over 1 MiB", async () => {
  const part = '{"harness":"codex","permissions":"read-only","instructions":"' + "x".repeat(270_000) + '"}';
  const project = view();
  project.projection!.source = '{"contract":"agsdl-0.4.0","id":"p","agents":{' + [0, 1, 2, 3].map(i => '"a' + i + '":' + part).join(",") + "}}";
  project.projection!.origins["/agents/a0"] = { file: "agents/a0.json", pointer: "" };
  const card = projectViewer(project.projection!.source, {}, [], true).declarations.find(card => card.kind === "Agent")!;
  expect(componentProperties(project.projection!.source, card, true).fields.find(field => field.label === "instructions")?.value).toHaveLength(270_002);
  const edited = await projectComponentProperties(project, card, async path => ({
    kind: "text", file: { path, size: part.length, executable: false }, text: part,
  }));
  expect(edited.fields.find(field => field.label === "instructions")?.value).toHaveLength(270_002);
});
