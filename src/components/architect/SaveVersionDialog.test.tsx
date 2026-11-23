import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { act } from "react";
import type { BlueprintDraft, ProjectView } from "../../services/ipc/architectLibrary";
import { agsdlSessionKey, useAgsdlStore } from "../../stores/useAgsdlStore";
import { useArchitectLaunchStore } from "../../stores/useArchitectLaunchStore";
import { useArchitectLibraryStore } from "../../stores/useArchitectLibraryStore";
import { notify } from "../ui/toastService";
import {
  byText, click, createHost, dialogText, fillField, flush, installNative, projectViewFixture, removeNative,
} from "./architectLibrary.testSupport";
import { SaveVersionDialog } from "./SaveVersionDialog";

const modern = '{"contract":"agsdl-0.4.0","id":"x","agents":{}}';
const legacy = '{"contract":"agsdl-0.3.0","id":"x","agents":{}}';
const initialLibrary = useArchitectLibraryStore.getState();
let view: ReturnType<typeof createHost>;
let success: ReturnType<typeof spyOn<typeof notify, "success">>;
let calls: Array<{ command: string; args: Record<string, unknown> }>;
let validation: () => ProjectView | Promise<ProjectView>;
let freeze: () => unknown;

function open(source: string, project?: ProjectView): BlueprintDraft {
  const draft: BlueprintDraft = { id: "bp", projectId: "p", name: "Revue de code", revision: 1, origin: null, archived: false,
    conversationId: null, history: null, document: { source, annexes: {} }, ...(project ? { project } : {}) };
  useAgsdlStore.getState().openBlueprintDocument(draft);
  useArchitectLibraryStore.setState({ blueprintId: "bp", draft, draftStatus: "idle", versionNumber: null,
    versions: { status: "ready", value: [{ blueprintId: "bp", number: 1, revision: 0, note: null }, { blueprintId: "bp", number: 2, revision: 0, note: "x" }] } });
  return draft;
}

beforeEach(() => {
  calls = [];
  validation = () => projectViewFixture(modern);
  freeze = () => ({ blueprintId: "bp", number: 3, revision: 1, note: null });
  success = spyOn(notify, "success").mockReturnValue("toast");
  installNative(async (command, args) => {
    calls.push({ command, args });
    switch (command) {
      case "architect_validate_draft": return validation();
      case "architect_save_version": return freeze();
      case "architect_list_versions": return [{ blueprintId: "bp", number: 3, revision: 1, note: "Added" }, { blueprintId: "bp", number: 2, revision: 1, note: null }];
      default: throw new Error(`Unexpected command ${command}`);
    }
  });
});
afterEach(() => {
  view?.unmount();
  removeNative();
  success.mockRestore();
  useArchitectLibraryStore.setState(initialLibrary);
  useAgsdlStore.setState({ sessions: {} });
});

const mount = async (onShow?: (view: string) => void, onClose = () => {}) => {
  view = createHost();
  await view.render(<SaveVersionDialog blueprintId="bp" onClose={onClose} onShow={onShow} />);
  await flush();
};
const primary = () => document.querySelector<HTMLButtonElement>('[role="dialog"] footer button.is-primary')!;

it("numbers the version it will create and checks the system without writing, while the note stays editable", async () => {
  const gate = Promise.withResolvers<ProjectView>();
  validation = () => gate.promise;
  open(modern, projectViewFixture(modern));
  await mount();
  expect(dialogText()).toContain("Save version 3");
  expect(document.querySelector('[role="status"]')?.textContent).toContain("Checking the system…");
  expect(primary().disabled).toBe(true);
  expect(primary().title).toBe("Check in progress…");
  const note = document.querySelector<HTMLTextAreaElement>("textarea")!;
  expect(note.disabled).toBe(false);
  await fillField(note, "Typing during the check");
  await act(async () => gate.resolve(projectViewFixture(modern)));
  expect(primary().disabled).toBe(false);
  expect(calls.map(call => call.command)).toEqual(["architect_validate_draft"]);
  expect(calls[0].args).toMatchObject({ blueprintId: "bp", expectedRevision: 1, batch: { files: [] } });
  expect(document.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("Typing during the check");
});

it("says which agent or step blocks the save, in plain words, with the technical reason on demand", async () => {
  validation = () => projectViewFixture(modern, { projection: null, diagnostics: [
    { code: "MISSING_FILE", file: "agents/relecteur.json", pointer: "/instructions/0", message: "content file not found" },
    { code: "BAD_NEXT", file: "flows/main.json", pointer: "/steps/review/next", message: "unknown step" },
  ] });
  open(modern, projectViewFixture(modern));
  const shown: string[] = [];
  let closed = 0;
  await mount(next => shown.push(next), () => { closed++; });
  const alert = document.querySelector('[role="alert"]')!;
  expect(alert.textContent).toContain("The system contains errors");
  expect(alert.textContent).toContain("2 items to fix.");
  expect(alert.textContent).toContain("Agent “relecteur”");
  expect(alert.textContent).toContain("Step “review”");
  expect(alert.querySelector("details")?.textContent).toContain("MISSING_FILE · agents/relecteur.json#/instructions/0 · content file not found");
  // The main text names items, never files.
  const summary = alert.cloneNode(true) as HTMLElement;
  summary.querySelectorAll("details").forEach(details => details.remove());
  expect(summary.textContent).not.toContain("agents/relecteur.json");
  expect(primary().disabled).toBe(true);
  expect(primary().title).toBe("Fix the points above first.");
  await click(byText("button", "Show", alert));
  expect(shown).toEqual(["agents"]);
  expect(closed).toBe(1);
});

it("lists warnings without blocking the save", async () => {
  validation = () => projectViewFixture(modern, { diagnostics: [{ code: "W", file: "skills/style.json", pointer: "", message: "unused" }] });
  open(modern, projectViewFixture(modern));
  await mount();
  expect(dialogText()).toContain("1 warning, nothing blocks the save");
  expect(dialogText()).toContain("Skill “style”");
  expect(document.querySelector('[role="alert"]')).toBeNull();
  expect(primary().disabled).toBe(false);
});

it("tells an older-format system it will be converted, without a dry run for it", async () => {
  open(legacy);
  await mount();
  expect(dialogText()).toContain("This system is in an older format");
  expect(dialogText()).toContain("Macro will update it to create version 3.");
  expect(dialogText()).toContain("The draft is converted at the same time");
  expect(document.querySelector('[role="dialog"] details')?.textContent).toContain("AgSDL 0.3.0 → 0.4.0.");
  expect(calls).toEqual([]);
  expect(primary().disabled).toBe(false);
});

it("expresses a refused conversion in terms of items and keeps the note for another try", async () => {
  open(legacy);
  freeze = () => { throw { code: "AGSDL_UPGRADE_INVALID", message: [
    "UNKNOWN_AGENT /agents/relecteur/skills/0 — missing skill",
    "BAD_NEXT /flow/steps/collect/next — unknown step",
  ].join("\n") }; };
  await mount();
  await fillField(document.querySelector("textarea")!, "Keep me");
  await click(primary());
  await flush();
  const alert = document.querySelector('[role="alert"]')!;
  expect(alert.textContent).toContain("This version cannot be saved");
  expect(alert.textContent).toContain("Agent “relecteur”");
  expect(alert.textContent).toContain("Step “collect”");
  expect(alert.querySelector("details")?.textContent).toContain("UNKNOWN_AGENT /agents/relecteur/skills/0 — missing skill");
  expect(dialogText()).not.toContain("Fix these issues before saving an AgSDL 0.4.0 version.");
  expect(document.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("Keep me");
  expect(primary().disabled).toBe(false);
  expect(success).not.toHaveBeenCalled();
});

it("saves with the note, announces the number Macro really assigned and closes", async () => {
  open(modern, projectViewFixture(modern));
  let closed = 0;
  await mount(undefined, () => { closed++; });
  await fillField(document.querySelector("textarea")!, "  Added the reviewer  ");
  await click(primary());
  await flush();
  expect(calls.find(call => call.command === "architect_save_version")?.args).toMatchObject({ blueprintId: "bp", note: "Added the reviewer" });
  expect(success).toHaveBeenCalledWith("Version 3 saved", { description: "Added the reviewer" });
  expect(closed).toBe(1);
});

it("saves and opens the launch window on the version Macro really assigned", async () => {
  open(modern, projectViewFixture(modern));
  const launch = useArchitectLaunchStore.getState();
  useArchitectLaunchStore.setState({ window: null, open: version => useArchitectLaunchStore.setState({ window: { version } }) });
  let closed = 0;
  await mount(undefined, () => { closed++; });
  await click(byText("button", "Save and launch in Operate", document));
  await flush();
  expect(calls.find(call => call.command === "architect_save_version")).toBeDefined();
  expect(useArchitectLaunchStore.getState().window).toEqual({ version: { blueprintId: "bp", number: 3 } });
  expect(success).toHaveBeenCalled();
  expect(closed).toBe(1);
  useArchitectLaunchStore.setState(launch);
});

it("does not open the launch window when the save fails", async () => {
  open(modern, projectViewFixture(modern));
  freeze = () => { throw new Error("disk full"); };
  const launch = useArchitectLaunchStore.getState();
  useArchitectLaunchStore.setState({ window: null });
  await mount();
  await click(byText("button", "Save and launch in Operate", document));
  await flush();
  expect(useArchitectLaunchStore.getState().window).toBeNull();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("The action failed");
  useArchitectLaunchStore.setState(launch);
});

it("shows a plain failure when the write fails, and stays open", async () => {
  open(modern, projectViewFixture(modern));
  freeze = () => { throw new Error("disk full"); };
  let closed = 0;
  await mount(undefined, () => { closed++; });
  await click(primary());
  await flush();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("The action failed");
  expect(closed).toBe(0);
  expect(primary().disabled).toBe(false);
});

it("does not offer to save while a revision conflict is unresolved", async () => {
  open(modern, projectViewFixture(modern));
  const key = agsdlSessionKey({ blueprintId: "bp" });
  const session = useAgsdlStore.getState().sessions[key];
  useAgsdlStore.setState({ sessions: { [key]: { ...session, draftConflict: { saved: null } } } });
  await mount();
  expect(primary().disabled).toBe(true);
  expect(primary().title).toContain("changed elsewhere");
});

it("does not save a version that would be the latest one again, and says why", async () => {
  open(modern, projectViewFixture(modern));
  useArchitectLibraryStore.setState({ versions: { status: "ready", value: [{ blueprintId: "bp", number: 2, revision: 1, note: "x" }] } });
  await mount();
  expect(primary().disabled).toBe(true);
  expect(primary().title).toBe("Nothing changed since version 2.");
  expect(dialogText()).toContain("Nothing changed since version 2.");
  await click(primary());
  expect(calls.find(call => call.command === "architect_save_version")).toBeUndefined();
});
