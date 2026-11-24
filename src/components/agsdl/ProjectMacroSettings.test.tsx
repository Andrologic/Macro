import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { act } from "react";
import { architectLibrary, type BlueprintDraft, type MacroProjectSettings, type ProjectBatch, type ProjectView } from "../../services/ipc/architectLibrary";
import { agsdlSessionKey, useAgsdlStore } from "../../stores/useAgsdlStore";
import { click, createHost, fillField, flush } from "../architect/architectLibrary.testSupport";
import { ProjectMacroSettings } from "./ProjectMacroSettings";

const target = { blueprintId: "p" };
const manifest = '{"projectFormat":"agsdl-project-1","contract":"agsdl-0.4.0","id":"p","title":"T","agents":{"review":{"file":"agents/review.json"}}}';
const agent = '{"harness":"codex","permissions":"read-only","description":"D"}';
let revision: number;
let settings: MacroProjectSettings;
let saves: ProjectBatch[];
let failSave: boolean;
let view: ReturnType<typeof createHost>;

function projectView(): ProjectView {
  const file = (path: string, raw: string) => ({ path, size: raw.length, executable: false });
  return {
    revision, settings, diagnostics: [],
    files: [file("agsdl.json", manifest), file("agents/review.json", agent)],
    projection: {
      source: '{"contract":"agsdl-0.4.0","id":"p","title":"T","agents":{"review":' + agent + "}}",
      origins: { "/agents/review": { file: "agents/review.json", pointer: "" } },
    },
  };
}
const draft = (): BlueprintDraft => {
  const project = projectView();
  return { id: "p", projectId: "lib", name: "Review", revision, archived: false, origin: null, conversationId: null, history: null,
    project, document: { source: project.projection!.source, annexes: {} } };
};

beforeEach(() => {
  revision = 1; saves = []; failSave = false;
  settings = { schemaVersion: 1, hiddenAgentIds: [], workingFolderMode: "perExecution" };
  useAgsdlStore.getState().openBlueprintDocument(draft());
  spyOn(architectLibrary, "getDraft").mockImplementation(async () => draft());
  spyOn(architectLibrary, "saveProjectDraft").mockImplementation(async (_id, _revision, batch) => {
    if (failSave) throw new Error("disk");
    saves.push(batch);
    settings = { ...settings, ...batch.settings };
    revision++;
    return projectView();
  });
});
afterEach(() => {
  view?.unmount();
  useAgsdlStore.setState({ sessions: {} });
  (architectLibrary.getDraft as unknown as { mockRestore: () => void }).mockRestore();
  (architectLibrary.saveProjectDraft as unknown as { mockRestore: () => void }).mockRestore();
});

const mount = async (agentId?: string) => {
  view = createHost();
  await view.render(<ProjectMacroSettings target={target} agentId={agentId} />);
  await flush();
};
const folderSelect = () => view.host.querySelector("select")!;
const required = () => view.host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;

it("saves the working-folder mode at once, in the same batch path as every other Macro setting", async () => {
  await mount();
  await act(async () => { folderSelect().value = "atLaunch"; folderSelect().dispatchEvent(new Event("change", { bubbles: true })); });
  await flush();
  expect(saves.map(batch => batch.settings)).toEqual([{ workingFolderMode: "atLaunch" }]);
  expect(saves[0].files).toEqual([]);
  expect(view.host.querySelector("[role=status]")?.textContent).toBe("Saved");
});

it("saves 'start message required' at once and shows it checked by default", async () => {
  await mount();
  expect(required().checked).toBe(true);
  await click(required());
  await flush();
  expect(saves.map(batch => batch.settings)).toEqual([{ startMessageRequired: false }]);
  expect(required().checked).toBe(false);
});

it("keeps an explicit Save for the entry hint, and writes nothing until it is pressed", async () => {
  await mount();
  const save = [...view.host.querySelectorAll("button")].find(button => button.textContent === "Save")!;
  expect(save.disabled).toBe(true);
  await fillField(view.host.querySelector("textarea")!, "Describe the repository");
  expect(saves).toEqual([]);
  expect(save.disabled).toBe(false);
  await click(save);
  await flush();
  expect(saves.map(batch => batch.settings)).toEqual([{ entryMessageHint: "Describe the repository" }]);
});

it("returns a box to what is stored and offers a retry when a save fails", async () => {
  failSave = true;
  await mount();
  await click(required());
  await flush();
  expect(view.host.querySelector("[role=alert]")?.textContent).toContain("The setting was not saved.");
  expect(required().checked).toBe(true);
  failSave = false;
  await click([...view.host.querySelectorAll("button")].find(button => button.textContent === "Retry"));
  await flush();
  expect(saves.map(batch => batch.settings)).toEqual([{ startMessageRequired: false }]);
});

it("reads the three settings without editing them once the draft is a saved version", async () => {
  settings = { ...settings, workingFolderMode: "atLaunch", entryMessageHint: "Name the branch" };
  useAgsdlStore.setState({ sessions: {} });
  useAgsdlStore.getState().openBlueprintDocument(draft());
  const key = agsdlSessionKey(target);
  useAgsdlStore.setState(state => ({ sessions: { ...state.sessions, [key]: { ...state.sessions[key], status: "version" as never } } }));
  await mount();
  expect(view.host.querySelector("select")).toBeNull();
  expect(view.host.textContent).toContain("Choose a folder at launch");
  expect(view.host.textContent).toContain("Require a start message");
  expect(view.host.textContent).toContain("Name the branch");
});

it("saves a validated launch schema and can remove it", async () => {
  await mount();
  const form = view.host.querySelector('form[aria-label="Launch fields"]')!;
  const button = (label: string, within: ParentNode = form) =>
    [...within.querySelectorAll("button")].find(item => item.textContent === label)!;
  await click(button("Add a field"));
  expect(button("Save").disabled).toBe(true);
  const [label, key] = form.querySelectorAll("input");
  await fillField(label, "Ticket");
  await fillField(key, "issue-id");
  expect(button("Save").disabled).toBe(true);
  await fillField(key, "issue_id");
  await click(button("Save"));
  await flush();

  expect(saves.map(batch => batch.settings)).toEqual([{
    launchFields: {
      version: "macro-launch-fields/1",
      fields: [{ key: "issue_id", label: "Ticket", type: "text", required: true }],
    },
  }]);
  const savedForm = view.host.querySelector('form[aria-label="Launch fields"]')!;
  expect(button("Save", savedForm).disabled).toBe(true);
  await click(button("Remove", savedForm));
  await click(button("Save", savedForm));
  await flush();
  expect(saves.at(-1)?.settings).toEqual({ launchFields: null });
  expect(required().checked).toBe(true);
});
