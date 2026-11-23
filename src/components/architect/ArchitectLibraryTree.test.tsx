import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { act } from "react";
import type { BlueprintDraft, BlueprintSummary, BlueprintVersionSummary, InspectedImport } from "../../services/ipc/architectLibrary";
import { useAgsdlStore } from "../../stores/useAgsdlStore";
import { useArchitectDialogStore } from "../../stores/useArchitectDialogStore";
import { useArchitectLibraryStore } from "../../stores/useArchitectLibraryStore";
import { useArchitectViewStore } from "../../stores/useArchitectViewStore";
import { notify } from "../ui/toastService";
import ArchitectLibraryNavigator from "./ArchitectLibraryNavigator";
import {
  byText, click, createHost, dialogText, fillField, flush, installNative, previewFixture, removeNative,
} from "./architectLibrary.testSupport";

const document030 = '{"contract":"agsdl-0.4.0","id":"x","agents":{}}';
const summary = (id: string, name: string, extra: Partial<BlueprintSummary> = {}): BlueprintSummary =>
  ({ id, projectId: "p1", name, revision: 1, origin: null, archived: false, conversationId: null, ...extra });
const version = (number: number, extra: Partial<BlueprintVersionSummary> = {}): BlueprintVersionSummary =>
  ({ blueprintId: "bp1", number, revision: number, note: null, storageState: "archive", ...extra });

let view: ReturnType<typeof createHost>;
let calls: Array<{ command: string; args: Record<string, unknown> }>;
let projects: Array<{ id: string; name: string }>;
let blueprints: Record<string, BlueprintSummary[]>;
let versions: BlueprintVersionSummary[];
let draftRevision: number;
let uses: unknown[];
let picked: string | null;
let inspected: InspectedImport;
let success: ReturnType<typeof spyOn<typeof notify, "success">>;
const initialLibrary = useArchitectLibraryStore.getState();

const draft = (id: string): BlueprintDraft => {
  const found = Object.values(blueprints).flat().find(item => item.id === id)!;
  return { ...found, revision: draftRevision, history: null, document: { source: document030, annexes: {} } };
};

beforeEach(() => {
  calls = [];
  projects = [{ id: "p1", name: "Mes systèmes" }, { id: "p2", name: "Essais" }];
  blueprints = {
    p1: [summary("bp1", "Revue de code"), summary("bp2", "Veille"), summary("old", "Ancien système", { archived: true })],
    p2: [],
  };
  versions = [version(1), version(2)];
  draftRevision = 2;
  uses = [];
  picked = "/tmp/revue.agsdl";
  inspected = { handle: "h1", preview: previewFixture() };
  success = spyOn(notify, "success").mockReturnValue("toast");
  installNative(async (command, args) => {
    calls.push({ command, args });
    switch (command) {
      case "architect_list_projects": return projects;
      case "architect_list_blueprints": return blueprints[String(args.projectId)] ?? [];
      case "architect_list_versions": return versions;
      case "architect_get_draft": return draft(String(args.blueprintId));
      case "architect_get_version": return { ...version((args.key as { number: number }).number), document: { source: document030, annexes: {} } };
      case "architect_list_uses": return uses;
      case "architect_delete_version": return undefined;
      case "architect_adapt_version": return { ...draft("bp1"), id: "copy", name: String(args.name), projectId: String(args.projectId), origin: args.key };
      case "architect_inspect_import": return inspected;
      case "architect_discard_import": return undefined;
      case "plugin:dialog|open": return picked;
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
  useArchitectDialogStore.setState({ dialog: null });
  useArchitectViewStore.setState({ views: {}, filesVisible: false });
  try { localStorage.clear(); } catch { /* not available */ }
});

const mount = async () => {
  view = createHost();
  await view.render(<ArchitectLibraryNavigator />);
  await flush();
};
const nav = () => document.querySelector("nav")!;
const projectButton = (name: string) => nav().querySelector<HTMLButtonElement>(`section[aria-label="${name}"] button[title="${name}"]`)!;
const rows = () => [...nav().querySelectorAll("li button")].map(button => button.textContent?.trim()).filter(Boolean);
const open = async (name: string, blueprint?: string) => {
  await click(projectButton(name));
  if (blueprint) await click(nav().querySelector(`button[title="${blueprint}"]`));
  await flush();
};
const menuItems = () => [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map(item => item.textContent?.trim());

it("shows a loading state, then the projects collapsed", async () => {
  const gate = Promise.withResolvers<typeof projects>();
  const base = (window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a: Record<string, unknown>) => Promise<unknown> } }).__TAURI_INTERNALS__.invoke;
  installNative(async (command, args) => command === "architect_list_projects" ? gate.promise : base(command, args));
  view = createHost();
  await view.render(<ArchitectLibraryNavigator />);
  expect(nav().querySelector('[role="status"]')?.textContent).toContain("Loading library…");
  await act(async () => gate.resolve(projects));
  await flush();
  expect(nav().querySelector('[role="status"]')).toBeNull();
  expect(projectButton("Mes systèmes").getAttribute("aria-expanded")).toBe("false");
  expect(rows()).toEqual([]);
});

it("invites to create the first project when the library is empty", async () => {
  projects = [];
  await mount();
  expect(nav().textContent).toContain("No project yet.");
  expect(nav().querySelector<HTMLButtonElement>('button[aria-label="Import…"]')!.disabled).toBe(true);
  await click(byText("button", "New project", nav()));
  expect(dialogText()).toContain("New project");
});

it("opens a project to show its blueprints, and says when a project has none", async () => {
  await mount();
  await open("Mes systèmes");
  expect(rows()).toEqual(["Revue de code", "Veille"]);
  await open("Essais");
  expect(nav().textContent).toContain("No blueprints in this project.");
  expect(byText("button", "New blueprint", nav())).toBeDefined();
  await click(projectButton("Mes systèmes"));
  expect(rows()).toEqual([]);
});

it("opens a blueprint on its draft, then its versions from the newest, with the draft marked modified only when it moved on", async () => {
  versions = [version(1), version(2, { note: "Added the reviewer" })];
  await mount();
  await open("Mes systèmes", "Revue de code");
  expect(rows()).toEqual(["Revue de code", "Draft", "v2Added the reviewer", "v1", "Veille"]);
  expect(nav().querySelector('li button[aria-current="page"]')?.textContent).toContain("Draft");
  expect(nav().textContent).not.toContain("modified");
  // The draft moves past the revision frozen in the latest version.
  const key = Object.keys(useAgsdlStore.getState().sessions)[0];
  act(() => useAgsdlStore.setState(state => ({ sessions: { ...state.sessions, [key]: { ...state.sessions[key], persistedRevision: 3 } } })));
  expect(nav().textContent).toContain("modified");
});

it("keeps older versions one click away and always shows entries to repair, marked in words and with a dot", async () => {
  versions = Array.from({ length: 8 }, (_, index) => version(index + 1));
  versions[0] = version(1, { storageState: "recovery" });
  await mount();
  await open("Mes systèmes", "Revue de code");
  expect(rows().filter(label => /^v\d/.test(label ?? ""))).toEqual(["v8", "v7", "v6", "v5", "v4", "v1needs repair"]);
  expect(nav().querySelector('[aria-label="A version needs repair"]')).not.toBeNull();
  await click(byText("button", "Older versions (2)", nav()));
  expect(rows().filter(label => /^v\d/.test(label ?? ""))).toHaveLength(8);
  expect(byText("button", "Older versions (2)", nav())).toBeUndefined();
});

it("tells apart blueprints that share a name by a short identifier only", async () => {
  blueprints.p1 = [summary("aaaaaaaa-1111", "Same"), summary("bbbbbbbb-2222", "Same")];
  await mount();
  await open("Mes systèmes");
  expect(rows()).toEqual(["Same · aaaaaaaa", "Same · bbbbbbbb"]);
});

it("offers version actions in a menu: open, adapt, export both ways and delete", async () => {
  await mount();
  await open("Mes systèmes", "Revue de code");
  await click(nav().querySelector('button[aria-label="Actions for version 2"]'));
  expect(menuItems()).toEqual(["Open", "Adapt…", "Export the archive (.agsdl)…", "Export as a folder…", "Delete…"]);
  expect(document.querySelector('[role="menu"]')?.getAttribute("aria-label")).toBe("Version 2");
});

it("offers only repair, download and delete for a version to repair — nothing to export or launch", async () => {
  versions = [version(1, { storageState: "recovery" })];
  await mount();
  await open("Mes systèmes", "Revue de code");
  await click(nav().querySelector('button[aria-label="Actions for version 1"]'));
  expect(menuItems()).toEqual(["Adapt to repair…", "Download the original", "Delete…"]);
});

it("opens the same menu with a right click on a row, and has none for an archived blueprint", async () => {
  await mount();
  await open("Mes systèmes");
  await act(async () => nav().querySelector('button[title="Veille"]')!.parentElement!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })));
  expect(menuItems()).toEqual(["Save a version…", "Export the draft (folder)…"]);
});

it("saves a version of a blueprint that is not open yet by opening it first", async () => {
  await mount();
  await open("Mes systèmes");
  await click(nav().querySelector('button[aria-label="Actions for blueprint “Veille”"]'));
  await click(byText('[role="menuitem"]', "Save a version…", document as unknown as ParentNode));
  await flush();
  expect(useArchitectLibraryStore.getState().blueprintId).toBe("bp2");
  expect(useArchitectDialogStore.getState().dialog).toEqual({ kind: "saveVersion", blueprintId: "bp2" });
});

it("filters by project and blueprint names, opens the matching projects and says when nothing matches", async () => {
  await mount();
  await click(nav().querySelector('button[aria-label="Search a project or a blueprint…"]'));
  const input = nav().querySelector("input")!;
  await fillField(input, "veille");
  expect(nav().querySelector('section[aria-label="Mes systèmes"]')).not.toBeNull();
  expect(nav().querySelector('section[aria-label="Essais"]')).toBeNull();
  expect(rows()).toEqual(["Veille"]);
  await fillField(input, "zzz");
  expect(nav().textContent).toContain("No blueprint matches this search.");
  await fillField(input, "");
  expect(nav().querySelector('section[aria-label="Essais"]')).not.toBeNull();
});

it("keeps archived blueprints in their own collapsed group", async () => {
  await mount();
  expect(nav().textContent).toContain("Archived (1)");
  expect(nav().querySelector('button[title="Ancien système"]')).toBeNull();
  await click(byText("button", "Archived (1)", nav()));
  expect(nav().querySelector('button[title="Ancien système"]')).not.toBeNull();
  expect(nav().querySelector('[aria-label="Archives"]')?.textContent).toContain("Mes systèmes");
});

it("deletes a free version after a confirmation, and refuses a version a run or a schedule uses", async () => {
  await mount();
  await open("Mes systèmes", "Revue de code");
  await click(nav().querySelector('button[aria-label="Actions for version 1"]'));
  await click(byText('[role="menuitem"]', "Delete…", document as unknown as ParentNode));
  await flush();
  expect(dialogText()).toContain("Delete version 1?");
  expect(dialogText()).toContain("The other versions do not change.");
  await click(byText('[role="dialog"] button', "Delete"));
  await flush();
  expect(calls.find(call => call.command === "architect_delete_version")?.args).toEqual({ key: { blueprintId: "bp1", number: 1 } });
  expect(success).toHaveBeenCalledWith("Version 1 deleted");

  uses = [{ kind: "execution", ownerId: "run-1" }];
  await click(nav().querySelector('button[aria-label="Actions for version 2"]'));
  await click(byText('[role="menuitem"]', "Delete…", document as unknown as ParentNode));
  await flush();
  expect(dialogText()).toContain("used by an execution or a schedule");
  expect(byText('[role="dialog"] button', "Delete")).toBeUndefined();
  expect(calls.filter(call => call.command === "architect_delete_version")).toHaveLength(1);
});

it("adapts a version into a new blueprint named after it, in the chosen project", async () => {
  await mount();
  await open("Mes systèmes", "Revue de code");
  await click(nav().querySelector('button[aria-label="Actions for version 2"]'));
  await click(byText('[role="menuitem"]', "Adapt…", document as unknown as ParentNode));
  expect(dialogText()).toContain("Adapt version 2");
  expect(dialogText()).toContain("The original does not change");
  expect(document.querySelector<HTMLInputElement>('[role="dialog"] input')!.value).toBe("Revue de code (adapted)");
  const select = document.querySelector<HTMLSelectElement>('[role="dialog"] select')!;
  await act(async () => { select.value = "p2"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  await click(document.querySelector('[role="dialog"] button[type="submit"]'));
  await flush();
  expect(calls.find(call => call.command === "architect_adapt_version")?.args)
    .toEqual({ key: { blueprintId: "bp1", number: 2 }, projectId: "p2", name: "Revue de code (adapted)" });
  expect(success).toHaveBeenCalledWith("Blueprint “Revue de code (adapted)” created");
});

it("imports a chosen file through a preview, into the project the menu belongs to", async () => {
  await mount();
  await click(nav().querySelector('button[aria-label="Actions for project “Essais”"]'));
  await click(byText('[role="menuitem"]', "Import a .agsdl file…", document as unknown as ParentNode));
  await flush();
  expect(calls.find(call => call.command === "plugin:dialog|open")?.args).toMatchObject({ options: { directory: false } });
  expect(calls.find(call => call.command === "architect_inspect_import")?.args).toEqual({ path: "/tmp/revue.agsdl" });
  expect(dialogText()).toContain("Import the archive “Revue de code”");
  expect(document.querySelector<HTMLSelectElement>("#architect-import-project")!.value).toBe("p2");
});

it("opens nothing when the native chooser is cancelled", async () => {
  picked = null;
  await mount();
  await click(nav().querySelector('button[aria-label="Import…"]'));
  await click(byText('[role="menuitem"]', "Import a project folder…", document as unknown as ParentNode));
  await flush();
  expect(calls.find(call => call.command === "plugin:dialog|open")?.args).toMatchObject({ options: { directory: true } });
  expect(calls.some(call => call.command === "architect_inspect_import")).toBe(false);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it("shows a retryable failure when the library cannot be read", async () => {
  let fail = true;
  const base = (window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a: Record<string, unknown>) => Promise<unknown> } }).__TAURI_INTERNALS__.invoke;
  installNative(async (command, args) => {
    if (command === "architect_list_projects" && fail) throw new Error("locked");
    return base(command, args);
  });
  view = createHost();
  await view.render(<ArchitectLibraryNavigator />);
  await flush();
  expect(nav().querySelector('[role="alert"]')?.textContent).toContain("The action failed");
  fail = false;
  await click(byText("button", "Retry", nav()));
  await flush();
  expect(projectButton("Mes systèmes")).not.toBeNull();
});
