import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import type { BlueprintDraft, ProjectBatch, ProjectView } from "../../services/ipc/architectLibrary";
import { architectLibrary } from "../../services/ipc/architectLibrary";
import { agsdlSessionKey, useAgsdlStore, type BlueprintDocumentTarget } from "../../stores/useAgsdlStore";
import { notify } from "../ui/toastService";
import { AddComponentDialog } from "./AddComponentDialog";
import { byText, click, createHost, dialogText, fillField, flush, installNative, projectViewFixture, removeNative } from "./architectLibrary.testSupport";

const target: BlueprintDocumentTarget = { blueprintId: "bp" };
const manifest = '{"projectFormat":"agsdl-project-1","contract":"agsdl-0.4.0","id":"p","title":"T","agents":{"writer":{"harness":"codex","permissions":"read-only"}}}';
const blank = '{"contract":"agsdl-0.4.0","id":"p","title":"T","agents":{"writer":{"harness":"codex","permissions":"read-only"}}}';
let view: ReturnType<typeof createHost>;
let batches: ProjectBatch[];
let documents: string[];
let failSave: boolean;
let success: ReturnType<typeof spyOn<typeof notify, "success">>;

const projectDraft = (): BlueprintDraft => {
  const project = projectViewFixture(blank, { files: [{ path: "agsdl.json", size: manifest.length, executable: false }] });
  return { id: "bp", projectId: "p", name: "Review", revision: 1, archived: false, origin: null, conversationId: null, history: null, project, document: { source: blank, annexes: {} } };
};
const documentDraft = (): BlueprintDraft => ({ ...projectDraft(), project: undefined });

beforeEach(() => {
  batches = []; documents = []; failSave = false;
  success = spyOn(notify, "success").mockReturnValue("toast");
  installNative(async (command, args) => {
    if (command === "architect_read_project_file" && args.path === "agsdl.json")
      return { revision: 1, content: { kind: "text", file: { path: "agsdl.json", size: manifest.length, executable: false }, text: manifest } };
    throw new Error(`Unexpected command ${command}`);
  });
  spyOn(architectLibrary, "saveProjectDraft").mockImplementation(async (_id, _revision, batch) => {
    if (failSave) throw new Error("disk");
    batches.push(batch);
    return { ...projectViewFixture(blank), revision: 2 } as ProjectView;
  });
  spyOn(architectLibrary, "saveDraft").mockImplementation(async (id, revision, document) => {
    documents.push(document.source);
    return { ...documentDraft(), id, revision: revision + 1, document } as never;
  });
});
afterEach(() => {
  view?.unmount();
  removeNative();
  success.mockRestore();
  (architectLibrary.saveProjectDraft as unknown as { mockRestore: () => void }).mockRestore();
  (architectLibrary.saveDraft as unknown as { mockRestore: () => void }).mockRestore();
  useAgsdlStore.setState({ sessions: {} });
});

const mount = async (kind: "agent" | "skill" | "tool", draft: BlueprintDraft, onClose = () => {}) => {
  useAgsdlStore.getState().openBlueprintDocument(draft);
  view = createHost();
  await view.render(<AddComponentDialog kind={kind} target={target} onClose={onClose} />);
  await flush();
};
const field = (index: number) => document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[role="dialog"] input, [role="dialog"] textarea')[index];
const submit = () => document.querySelector<HTMLButtonElement>('[role="dialog"] footer button.is-primary')!;

it("writes the agent file and declares it in the manifest through one project batch, without touching the flow", async () => {
  let closed = 0;
  await mount("agent", projectDraft(), () => { closed++; });
  expect(submit().disabled).toBe(true);
  expect(submit().title).toBe("Give it a name.");
  await fillField(field(0), "Relecteur sécurité");
  expect(dialogText()).toContain("Its files are named “relecteur-securite”.");
  await fillField(field(1), "Reviews the change");
  await fillField(field(2), "Report what is missing.");
  expect(submit().disabled).toBe(false);
  await click(submit());
  await flush();
  expect(batches).toHaveLength(1);
  const [agent, declaration] = batches[0].files;
  expect(agent).toMatchObject({ kind: "write", path: "agents/relecteur-securite.json" });
  expect(JSON.parse((agent as { text: string }).text)).toEqual({ harness: "codex", permissions: "read-only", description: "Reviews the change", instructions: "Report what is missing." });
  expect(declaration).toMatchObject({ kind: "write", path: "agsdl.json" });
  const written = JSON.parse((declaration as { text: string }).text);
  expect(written.agents["relecteur-securite"]).toEqual({ file: "agents/relecteur-securite.json" });
  expect(written.agents.writer).toBeDefined();
  expect(written.flow).toBeUndefined();
  // The name the author typed is kept as typed; only the files use the identifier.
  expect(batches[0].settings).toEqual({ agentNames: { "relecteur-securite": "Relecteur sécurité" } });
  expect(success).toHaveBeenCalledTimes(1);
  expect(String(success.mock.calls[0][0])).toContain("Relecteur sécurité");
  expect(closed).toBe(1);
});

it("keeps no separate name when the typed name is already its identifier", async () => {
  await mount("agent", projectDraft());
  await fillField(field(0), "relecteur");
  await click(submit());
  await flush();
  expect(batches[0].settings).toBeUndefined();
});

it("refuses a name that is already used, and says so beside the field", async () => {
  await mount("agent", projectDraft());
  await fillField(field(0), "Writer");
  expect(document.querySelector('[role="dialog"] form [role="alert"]')?.textContent).toBe("This name is already used. Choose another one.");
  expect(submit().disabled).toBe(true);
  await click(submit());
  expect(batches).toEqual([]);
});

it("writes a skill as a file with the header harnesses read, and needs to know when to use it", async () => {
  await mount("skill", projectDraft());
  await fillField(field(0), "Écriture sobre");
  expect(submit().title).toBe("Say when this skill should be used.");
  await fillField(field(1), "When writing a report");
  await fillField(field(2), "Short sentences.");
  await click(submit());
  await flush();
  const [skill, declaration] = batches[0].files as Array<{ path: string; text: string }>;
  expect(skill.path).toBe("skills/ecriture-sobre/SKILL.md");
  expect(skill.text).toBe('---\nname: ecriture-sobre\ndescription: "When writing a report"\n---\n\nShort sentences.\n');
  expect(JSON.parse(declaration.text).skills).toEqual({ "ecriture-sobre": { uri: "skills/ecriture-sobre/SKILL.md" } });
});

it("declares a remote tool server from a full web address, with no file", async () => {
  await mount("tool", projectDraft());
  await fillField(field(0), "Wiki");
  await fillField(field(1), "wiki.example.test");
  expect(document.querySelector('[role="dialog"] form [role="alert"]')?.textContent).toContain("https://");
  expect(submit().disabled).toBe(true);
  await fillField(field(1), "https://wiki.example.test/mcp");
  await click(submit());
  await flush();
  expect(batches[0].files.map(file => file.path)).toEqual(["agsdl.json"]);
  expect(JSON.parse((batches[0].files[0] as { text: string }).text).mcpServers).toEqual({ wiki: { url: "https://wiki.example.test/mcp" } });
});

it("keeps the dialog open with the reason when the draft cannot be saved, then retries only the save", async () => {
  failSave = true;
  let closed = 0;
  await mount("agent", projectDraft(), () => { closed++; });
  await fillField(field(0), "Rapporteur");
  await click(submit());
  await flush();
  expect(closed).toBe(0);
  expect(document.querySelector('[role="dialog"] form [role="alert"]')?.textContent).toContain("The draft was not saved yet");
  expect(useAgsdlStore.getState().sessions[agsdlSessionKey(target)].dirty).toBe(true);
  failSave = false;
  await click(byText("button", "Retry", document.querySelector('[role="dialog"] footer')!));
  await flush();
  expect(batches).toHaveLength(1);
  expect(closed).toBe(1);
});

it("declares the agent inline when the draft has no project files", async () => {
  await mount("agent", documentDraft());
  await fillField(field(0), "Rapporteur");
  expect(dialogText()).not.toContain("Files written in the project");
  await click(submit());
  await flush();
  expect(documents).toHaveLength(1);
  expect(JSON.parse(documents[0]).agents.rapporteur).toEqual({ harness: "codex", permissions: "read-only" });
});
