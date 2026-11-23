import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { act } from "react";
import type { BlueprintDraft, InspectedImport } from "../../services/ipc/architectLibrary";
import { useAgsdlStore } from "../../stores/useAgsdlStore";
import { useArchitectLibraryStore } from "../../stores/useArchitectLibraryStore";
import { notify } from "../ui/toastService";
import { ArchitectImportDialog } from "./ArchitectImportDialog";
import {
  byText, click, createHost, dialogText, fillField, flush, installNative, previewFixture, removeNative,
} from "./architectLibrary.testSupport";

const initialLibrary = useArchitectLibraryStore.getState();
let view: ReturnType<typeof createHost>;
let success: ReturnType<typeof spyOn<typeof notify, "success">>;
let calls: Array<{ command: string; args: Record<string, unknown> }>;

const draft = (): BlueprintDraft => ({ id: "bp-new", projectId: "p1", name: "Revue de code", revision: 1, origin: null,
  archived: false, conversationId: null, history: null, document: { source: "{}", annexes: {} } });

beforeEach(() => {
  calls = [];
  success = spyOn(notify, "success").mockReturnValue("toast");
  useArchitectLibraryStore.setState({
    projects: { status: "ready", value: [{ id: "p1", name: "Mes systèmes" }, { id: "p2", name: "Essais" }] },
    projectBlueprints: { p1: { status: "ready", value: [{ id: "x", projectId: "p1", name: "Veille", revision: 1, origin: null, archived: false, conversationId: null }] } },
  });
});
afterEach(() => {
  view?.unmount();
  removeNative();
  success.mockRestore();
  useArchitectLibraryStore.setState(initialLibrary);
  useAgsdlStore.setState({ sessions: {} });
});

function native(inspect: () => Promise<InspectedImport> | InspectedImport) {
  installNative(async (command, args) => {
    calls.push({ command, args });
    switch (command) {
      case "architect_inspect_import": return inspect();
      case "architect_discard_import": return undefined;
      case "architect_commit_import": return { draft: draft(), version: null };
      case "architect_list_versions": return [];
      case "architect_list_blueprints": return [];
      default: throw new Error(`Unexpected command ${command}`);
    }
  });
}
const mount = async (path = "/tmp/revue.agsdl", onClose = () => {}) => {
  view = createHost();
  await view.render(<ArchitectImportDialog path={path} projectId="p1" onClose={onClose} />);
  await flush();
};
const importButton = () => byText('[role="dialog"] footer button', "Import")!;
const order = (...parts: string[]) => parts.map(part => dialogText().indexOf(part));

it("reads first, then gives the verdict, what it can do, what to prepare, then the details", async () => {
  const gate = Promise.withResolvers<InspectedImport>();
  native(() => gate.promise);
  await mount();
  expect(document.querySelector('[role="status"]')?.textContent).toContain("Reading the file…");
  expect(importButton().disabled).toBe(true);
  expect(importButton().title).toBe("Reading in progress…");
  await act(async () => gate.resolve({ handle: "h1", preview: previewFixture() }));
  const positions = order("Valid file — nothing runs when you import it.", "What it will be able to do", "Engines and models", "To prepare", "All the detail", "Project");
  expect(positions.every(position => position >= 0)).toBe(true);
  expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  expect(dialogText()).toContain("revue.agsdl");
  expect(dialogText()).toContain("2 files");
  expect(dialogText()).toContain("Agents: 2 · Tools: 1");
  expect(importButton().disabled).toBe(false);
});

it("says what the system will be able to do in plain words and asks for secrets by name only", async () => {
  native(() => ({ handle: "h1", preview: previewFixture() }));
  await mount();
  const text = dialogText();
  expect(text).toContain("Create and change files in the execution folder");
  expect(text).toContain("Run commands on this computer");
  expect(text).toContain("Use the tool “github”");
  expect(text).toContain("Codex (model gpt-x)");
  expect(text).toContain("Secret requested: GITHUB_TOKEN (tool “github”)");
  expect(text).toContain("The values are never in the file.");
  expect(text).toContain("Required program: node");
  // Command lines and technical values stay behind "All the detail".
  const summary = document.querySelector('[role="dialog"]')!.cloneNode(true) as HTMLElement;
  summary.querySelectorAll("details").forEach(details => details.remove());
  expect(summary.textContent).not.toContain("github.js");
  expect(document.querySelector('[role="dialog"] details')?.textContent).toContain("node github.js");
  expect(text).toContain("Macro’s settings");
});

it("counts the points to know about and keeps addresses as plain, copyable text", async () => {
  const hostile = "https://example.test/<img src=x onerror=alert(1)>";
  native(() => ({ handle: "h1", preview: previewFixture({
    historyWillBeRemoved: true,
    externalReferences: [{ uri: hostile, kind: "content", usage: "reachable", location: { file: "agsdl.json", pointer: "/content/a" } }],
    warnings: [{ code: "SOMETHING", message: "Check this", launchBlocker: false, location: { file: "agsdl.json", pointer: "/agents/writer" } }],
  }) }));
  await mount();
  expect(dialogText()).toContain("Valid file, with 2 points to know about");
  expect(dialogText()).toContain("1 piece of content points to an outside address");
  expect(dialogText()).toContain("The history inside the archive is not kept");
  expect(dialogText()).toContain(hostile);
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.querySelector("img")).toBeNull();
  expect(dialog.querySelector("a")).toBeNull();
});

it("bounds long archive text instead of rendering it whole", async () => {
  native(() => ({ handle: "h1", preview: previewFixture({
    externalReferences: [{ uri: `https://example.test/${"a".repeat(500)}`, kind: "content", usage: "reachable", location: { file: "agsdl.json", pointer: "/content/a" } }],
  }) }));
  await mount();
  expect(dialogText()).not.toContain("a".repeat(250));
});

it("blocks an altered archive with a plain sentence, the technical reason on demand, and no import", async () => {
  native(() => Promise.reject({ code: "ARCHITECT_PROJECT_ERROR", message: "x", details: { code: "ARCHIVE_INTEGRITY", pointer: "", message: "digest mismatch for agents/a.json" } }));
  await mount();
  const alert = document.querySelector('[role="alert"]')!;
  expect(alert.textContent).toContain("Import not possible");
  expect(alert.textContent).toContain("it may be damaged or altered");
  expect(alert.querySelector("details")?.textContent).toContain("ARCHIVE_INTEGRITY · digest mismatch for agents/a.json");
  expect(importButton().disabled).toBe(true);
  expect(importButton().title).toBe("Fix the file before importing it.");
  expect(calls.some(call => call.command === "architect_commit_import")).toBe(false);
});

it.each([
  ["ARCHIVE_LAYOUT", "not a valid AgSDL archive"],
  ["PROJECT_PATH", "a path that leaves its folder"],
  ["ARCHIVE_LIMIT", "too large to import"],
  ["UNSUPPORTED_SOURCE", "agsdl.json"],
  ["PROJECT", "could not open this project"],
])("explains %s in terms of the file", async (code, expected) => {
  native(() => Promise.reject({ code: "ARCHITECT_PROJECT_ERROR", message: "x", details: { code, pointer: "", message: "m" } }));
  await mount();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(expected);
});

it("falls back to a generic sentence for an unknown failure", async () => {
  native(() => Promise.reject(new Error("boom")));
  await mount();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("Macro could not read this source.");
});

it("refuses a name already used in the destination project, until another project or name is chosen", async () => {
  native(() => ({ handle: "h1", preview: previewFixture({ title: "Veille" }) }));
  await mount();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("already has this name");
  expect(importButton().disabled).toBe(true);
  const select = document.querySelector<HTMLSelectElement>("#architect-import-project")!;
  await act(async () => { select.value = "p2"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(importButton().disabled).toBe(false);
  await act(async () => { select.value = "p1"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  await fillField(document.querySelector("#architect-import-name")!, "Veille 2");
  expect(importButton().disabled).toBe(false);
});

it("imports with the chosen name, announces it and closes", async () => {
  native(() => ({ handle: "h1", preview: previewFixture() }));
  let closed = 0;
  await mount("/tmp/revue.agsdl", () => { closed++; });
  await fillField(document.querySelector("#architect-import-name")!, "Revue importée");
  await click(importButton());
  await flush();
  expect(calls.find(call => call.command === "architect_commit_import")?.args).toEqual({ handle: "h1", projectId: "p1", name: "Revue importée" });
  expect(success).toHaveBeenCalledWith("“Revue importée” imported");
  expect(closed).toBe(1);
  // The committed handle is consumed by the import: it must not be discarded afterwards.
  view.unmount();
  expect(calls.some(call => call.command === "architect_discard_import")).toBe(false);
  view = createHost();
});

it("keeps the dialog open with a calm message when the import fails, and releases the preview on cancel", async () => {
  native(() => ({ handle: "h1", preview: previewFixture() }));
  const base = (window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a: Record<string, unknown>) => Promise<unknown> } }).__TAURI_INTERNALS__.invoke;
  installNative(async (command, args) => {
    if (command === "architect_commit_import") { calls.push({ command, args }); throw new Error("disk full"); }
    return base(command, args);
  });
  let closed = 0;
  await mount("/tmp/revue.agsdl", () => { closed++; });
  await click(importButton());
  await flush();
  expect(closed).toBe(0);
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("The import failed. Nothing was added.");
  await click(byText('[role="dialog"] footer button', "Cancel"));
  view.unmount();
  expect(calls.filter(call => call.command === "architect_discard_import").map(call => call.args.handle)).toEqual(["h1"]);
  view = createHost();
});

it("discards a preview that arrives after the dialog was closed", async () => {
  const gate = Promise.withResolvers<InspectedImport>();
  native(() => gate.promise);
  await mount();
  view.unmount();
  await act(async () => gate.resolve({ handle: "late", preview: previewFixture() }));
  await flush();
  expect(calls.filter(call => call.command === "architect_discard_import").map(call => call.args.handle)).toEqual(["late"]);
  view = createHost();
});

it("states what the import creates: a version 1 for an archive, a draft for a folder", async () => {
  native(() => ({ handle: "h1", preview: previewFixture() }));
  await mount();
  expect(dialogText()).toContain("The archive becomes version 1 and an editable draft.");
  view.unmount();
  native(() => ({ handle: "h2", preview: previewFixture({ packageFormat: "agsdl-project-1" }) }));
  await mount("/tmp/revue");
  expect(dialogText()).toContain("The folder becomes an editable draft.");
});

it("names the dialog for what is imported: an archive file, or a project folder", async () => {
  native(() => ({ handle: "h1", preview: previewFixture({ title: "" }) }));
  await mount("/tmp/revue.agsdl");
  expect(document.querySelector('[role="dialog"] header strong')?.textContent).toBe("Import an archive");
  view.unmount();
  native(() => ({ handle: "h2", preview: previewFixture({ title: "", packageFormat: "agsdl-project-1" }) }));
  await mount("/tmp/revue");
  expect(document.querySelector('[role="dialog"] header strong')?.textContent).toBe("Import a project folder");
  view.unmount();
  native(() => ({ handle: "h3", preview: previewFixture({ title: "Veille", packageFormat: "agsdl-project-1" }) }));
  await mount("/tmp/revue");
  expect(document.querySelector('[role="dialog"] header strong')?.textContent).toBe("Import the folder “Veille”");
});

it("already uses the archive wording while the file is being read", async () => {
  native(() => new Promise<InspectedImport>(() => {}));
  await mount("/tmp/revue.AGSDL");
  expect(document.querySelector('[role="dialog"] header strong')?.textContent).toBe("Import an archive");
});
