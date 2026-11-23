import { afterEach, beforeEach, expect, it } from "bun:test";
import { act } from "react";
import { createExampleDocument } from "../../services/agsdl/examples";
import type { BlueprintDraft, BlueprintVersionSummary, MacroProjectSettings, ProjectView } from "../../services/ipc/architectLibrary";
import { useAgsdlStore } from "../../stores/useAgsdlStore";
import { useArchitectDialogStore } from "../../stores/useArchitectDialogStore";
import { useArchitectLibraryStore } from "../../stores/useArchitectLibraryStore";
import { useArchitectViewStore } from "../../stores/useArchitectViewStore";
import ArchitectLibraryNavigator from "./ArchitectLibraryNavigator";
import ArchitectStrategyPanel from "./ArchitectStrategyPanel";
import { byText, click, createHost, defaultSettings, flush, installNative, removeNative } from "./architectLibrary.testSupport";

const source = createExampleDocument("release").source;
let view: ReturnType<typeof createHost>;
let calls: Array<{ command: string; args: Record<string, unknown> }>;
let settings: MacroProjectSettings;
let revision: number;
let versions: BlueprintVersionSummary[];
let draftState: Partial<BlueprintDraft>;
let saveFailures: number;
const initialLibrary = useArchitectLibraryStore.getState();

const projectView = (): ProjectView => ({
  revision, settings, files: [{ path: "agsdl.json", size: 10, executable: false }, { path: "agents/implement.json", size: 20, executable: false }],
  projection: { source, origins: {} }, diagnostics: [],
});
const draft = (): BlueprintDraft => ({ id: "bp", projectId: "p", name: "Revue de code", revision, origin: null, archived: false,
  conversationId: null, history: null, storageState: "draft", document: { source, annexes: {} }, project: projectView(), ...draftState });

beforeEach(() => {
  calls = [];
  settings = defaultSettings;
  revision = 1;
  versions = [];
  draftState = {};
  saveFailures = 0;
  installNative(async (command, args) => {
    calls.push({ command, args });
    switch (command) {
      case "architect_list_projects": return [{ id: "p", name: "Mes systèmes" }];
      case "architect_list_blueprints": return [{ id: "bp", projectId: "p", name: "Revue de code", revision, origin: null, archived: false, conversationId: null }];
      case "architect_list_versions": return versions;
      case "architect_get_draft": return draft();
      case "architect_get_version": return { ...versions.find(item => item.number === (args.key as { number: number }).number)!, project: { ...projectView(), settings: { ...settings, hiddenAgentIds: [] } } };
      case "architect_save_draft": {
        if (saveFailures-- > 0) throw new Error("disk full");
        const batch = args.batch as { settings?: Partial<MacroProjectSettings> };
        settings = { ...settings, ...batch.settings };
        revision += 1;
        return projectView();
      }
      default: throw new Error(`Unexpected command ${command}`);
    }
  });
});
afterEach(() => {
  view?.unmount();
  removeNative();
  useArchitectLibraryStore.setState(initialLibrary);
  useAgsdlStore.setState({ sessions: {} });
  useArchitectDialogStore.setState({ dialog: null });
  useArchitectViewStore.setState({ views: {}, filesVisible: false });
  try { localStorage.clear(); } catch { /* not available */ }
});

const mount = async () => {
  view = createHost();
  await view.render(<><ArchitectLibraryNavigator /><ArchitectStrategyPanel /></>);
  await flush();
  await click(document.querySelector('nav section[aria-label="Mes systèmes"] button'));
  await click(document.querySelector('nav button[title="Revue de code"]'));
  await flush();
};
const panel = () => document.querySelector("aside")!;
const tab = (label: string) => [...panel().querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(item => item.textContent?.startsWith(label))!;
const headerButtons = () => [...panel().querySelectorAll("header > div:first-of-type button")].map(button => button.textContent?.trim()).filter(Boolean);

it("puts what to do first in the header: the draft state, saving a version, and the system's views", async () => {
  await mount();
  const header = panel().querySelector("header")!;
  expect(header.textContent).toContain("Revue de code");
  expect(header.querySelector('[role="status"]')?.textContent).toBe("Draft · saved");
  expect(headerButtons()).toEqual(["Save version"]);
  expect([...panel().querySelectorAll('[role="tab"]')].map(item => item.textContent?.trim())).toEqual(["Flow", "Agents2", "Skills", "Tools"]);
  expect(tab("Flow").getAttribute("aria-selected")).toBe("true");
  expect(panel().querySelectorAll(".agsdl-graph-node").length).toBeGreaterThan(0);
});

it("lists agents as plain rows that open the same card as a block of the graph", async () => {
  await mount();
  await click(tab("Agents"));
  const list = panel().querySelector('ul[aria-label="Agents"]')!;
  expect(list.querySelectorAll("li")).toHaveLength(2);
  expect(list.textContent).toContain("implement");
  expect(list.textContent).toContain("used in the flow");
  expect(panel().querySelector(".agsdl-graph-node")).toBeNull();
  await click(list.querySelector("li button"));
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("implement");
});

it("says plainly when a kind of item is absent", async () => {
  await mount();
  await click(tab("Skills"));
  expect(panel().textContent).toContain("This system uses no skill.");
  await click(tab("Tools"));
  expect(panel().textContent).toContain("This system uses no tool server.");
});

it("hides an agent's thread from Operate with a checkbox that saves at once, as a Macro setting", async () => {
  await mount();
  await click(tab("Agents"));
  await click(panel().querySelector('ul[aria-label="Agents"] li button'));
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.querySelector("section[aria-label='In Operate']")?.textContent).toContain("A Macro setting");
  const box = dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  expect(box.checked).toBe(false);
  await act(async () => box.click());
  await flush();
  const save = calls.find(call => call.command === "architect_save_draft")!;
  expect(save.args).toMatchObject({ blueprintId: "bp", expectedRevision: 1, batch: { files: [], settings: { hiddenAgentIds: ["implement"] } } });
  expect(dialog.querySelector('[role="status"]')?.textContent).toBe("Saved");
  expect(dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(true);
  expect(settings.hiddenAgentIds).toEqual(["implement"]);
  await click(dialog.querySelector('button[aria-label="Close"]'));
  expect(panel().querySelector('ul[aria-label="Agents"]')?.textContent).toContain("Hidden in Operate");
});

it("puts the box back and offers a retry when the setting could not be saved", async () => {
  await mount();
  await click(tab("Agents"));
  await click(panel().querySelector('ul[aria-label="Agents"] li button'));
  const dialog = document.querySelector('[role="dialog"]')!;
  saveFailures = 1;
  await act(async () => dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await flush();
  expect(dialog.querySelector('[role="alert"]')?.textContent).toContain("The setting was not saved.");
  expect(dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(false);
  expect(settings.hiddenAgentIds).toEqual([]);
  await click(byText("button", "Retry", dialog));
  await flush();
  expect(dialog.querySelector('[role="alert"]')).toBeNull();
  expect(dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(true);
  expect(settings.hiddenAgentIds).toEqual(["implement"]);
});

it("keeps the files out of sight until asked, remembers the choice, and shows them read only", async () => {
  await mount();
  expect(tab("Files")).toBeUndefined();
  await click(panel().querySelector('button[aria-label="More actions"]'));
  const item = document.querySelector('[role="menuitemcheckbox"]')!;
  expect(item.getAttribute("aria-checked")).toBe("false");
  await click(item);
  expect(tab("Files")).toBeDefined();
  expect(localStorage.getItem("macro_architect_show_files_v1")).toBe("1");
  await click(tab("Files"));
  expect(panel().textContent).toContain("Read only. To change an item");
  expect(panel().querySelector("textarea")).toBeNull();
  // Hiding them again returns to the flow, never to an empty view.
  await click(panel().querySelector('button[aria-label="More actions"]'));
  await click(document.querySelector('[role="menuitemcheckbox"]'));
  expect(tab("Files")).toBeUndefined();
  expect(tab("Flow").getAttribute("aria-selected")).toBe("true");
});

it("shows a saved version read only, with its note, Adapt and Export, and no way to save", async () => {
  versions = [{ blueprintId: "bp", number: 2, revision: 1, note: "First line\nSecond line, a longer explanation of what changed.", storageState: "archive", createdAt: "2026-11-22T10:00:00Z" }];
  await mount();
  await click(panel().ownerDocument.querySelector('nav [aria-label="Versions"] button'));
  await flush();
  const header = panel().querySelector("header")!;
  expect(header.querySelector('[role="status"]')?.textContent).toContain("Version 2");
  expect(header.querySelector('[role="status"]')?.textContent).toContain("read-only");
  expect(header.textContent).toContain("First line");
  expect(headerButtons().filter(label => ["Adapt", "Export", "Save version"].includes(label!))).toEqual(["Adapt", "Export"]);
  expect(header.querySelector("button[aria-label='More actions']")).not.toBeNull();
  await click(byText("button", "Export", header));
  expect([...document.querySelectorAll('[role="menuitem"]')].map(entry => entry.textContent?.trim())).toEqual(["Archive (.agsdl)…", "Project folder…"]);
  await click(document.querySelectorAll('[role="menuitem"]')[1]);
  expect(useArchitectDialogStore.getState().dialog).toMatchObject({ kind: "export", format: "project", target: { kind: "version", key: { blueprintId: "bp", number: 2 } } });
  await click(byText("button", "Show more", header));
  expect(header.textContent).toContain("Back to draft");
});

it("replaces the editor with a recovery card for a draft that could not be recovered", async () => {
  draftState = { storageState: "recovery", project: undefined };
  await mount();
  expect(panel().querySelector("[data-recovery-card]")).not.toBeNull();
  expect(panel().querySelector('[role="tab"]')).toBeNull();
  expect(headerButtons()).not.toContain("Save version");
  expect(panel().textContent).toContain("This draft could not be recovered");
});

it("opens the save-version dialog with Ctrl+S from the panel, but never for a version", async () => {
  await mount();
  const event = new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true });
  await act(async () => panel().querySelector("header")!.dispatchEvent(event));
  expect(event.defaultPrevented).toBe(true);
  expect(useArchitectDialogStore.getState().dialog).toEqual({ kind: "saveVersion", blueprintId: "bp" });
});

it("states where an adapted draft comes from, by the origin's name", async () => {
  draftState = { origin: { blueprintId: "bp", number: 1 } };
  versions = [{ blueprintId: "bp", number: 1, revision: 1, note: null, storageState: "archive" }];
  await mount();
  expect(panel().querySelector("header")?.textContent).toContain("Adapted from version 1 of “Revue de code”");
});

it("says a draft comes from a version to repair, with what to do next", async () => {
  draftState = { origin: { blueprintId: "bp", number: 1 } };
  versions = [{ blueprintId: "bp", number: 1, revision: 1, note: null, storageState: "recovery" }];
  await mount();
  expect(panel().querySelector("header")?.textContent).toContain("Comes from a version to repair. Fix the issues shown, then save a version.");
});
