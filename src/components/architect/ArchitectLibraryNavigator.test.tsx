import { afterEach, expect, it } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createExampleDocument } from "../../services/agsdl/examples";
import type {
  ArchitectProject, BlueprintDocument, BlueprintDraft, BlueprintVersion, VersionKey,
} from "../../services/ipc/architectLibrary";
import { agsdlSessionKey, useAgsdlStore } from "../../stores/useAgsdlStore";
import { useArchitectLibraryStore } from "../../stores/useArchitectLibraryStore";
import ArchitectLibraryNavigator from "./ArchitectLibraryNavigator";
import ArchitectStrategyPanel from "./ArchitectStrategyPanel";

function libraryPort() {
  const projects = new Map<string, ArchitectProject>();
  const drafts = new Map<string, BlueprintDraft>();
  const versions = new Map<string, BlueprintVersion[]>();
  const delayedReads = new Map<string, Promise<BlueprintDraft>>();
  const writes: Array<{ blueprintId: string; expectedRevision: number }> = [];
  let id = 0;

  const createProject = (name: string) => {
    const project = { id: `project-${++id}`, name };
    projects.set(project.id, project);
    return project;
  };
  const createDraft = (projectId: string, name: string, document: BlueprintDocument, options: Partial<BlueprintDraft> = {}) => {
    const draft: BlueprintDraft = { id: `bp${++id}`, projectId, name, document: structuredClone(document), revision: 1,
      origin: null, archived: false, conversationId: null, history: null, ...options };
    drafts.set(draft.id, draft);
    return draft;
  };
  const readDraft = (blueprintId: string) => {
    const draft = drafts.get(blueprintId);
    if (!draft) throw new Error("Missing draft");
    return draft;
  };
  const readVersion = ({ blueprintId, number }: VersionKey) => {
    const version = versions.get(blueprintId)?.find(entry => entry.number === number);
    if (!version) throw new Error("Missing version");
    return version;
  };
  const freeze = (draft: BlueprintDraft, note: string | null) => {
    const history = versions.get(draft.id) ?? [];
    const version: BlueprintVersion = { blueprintId: draft.id, number: history.length + 1, revision: draft.revision,
      note, document: structuredClone(draft.document) };
    versions.set(draft.id, [version, ...history]);
    return version;
  };

  const invoke = async (command: string, args: Record<string, unknown> = {}) => {
    const projectId = String(args.projectId);
    const blueprintId = String(args.blueprintId);
    const name = String(args.name);
    const expectedRevision = Number(args.expectedRevision);
    const key = args.key as VersionKey;
    switch (command) {
      case "architect_list_projects": return [...projects.values()];
      case "architect_create_project": return createProject(name);
      case "architect_list_blueprints": return [...drafts.values()].filter(draft => draft.projectId === projectId)
        .map(({ document: _document, history: _history, ...summary }) => summary);
      case "architect_create_blueprint": return createDraft(projectId, name, args.document as BlueprintDocument);
      case "architect_get_draft": return structuredClone(await (delayedReads.get(blueprintId) ?? readDraft(blueprintId)));
      case "architect_save_draft": {
        writes.push({ blueprintId, expectedRevision });
        const draft = readDraft(blueprintId);
        if (draft.revision !== expectedRevision) throw { message: "Validation error: stale_revision" };
        const saved = { ...draft, revision: draft.revision + 1, document: structuredClone(args.document as BlueprintDocument) };
        drafts.set(blueprintId, saved);
        return saved;
      }
      case "architect_save_version": {
        const draft = readDraft(blueprintId);
        if (draft.revision !== expectedRevision) throw { message: "Validation error: stale_revision" };
        const { document: _document, ...summary } = freeze(draft, args.note as string | null);
        return summary;
      }
      case "architect_list_versions": return (versions.get(blueprintId) ?? []).map(({ document: _document, ...summary }) => summary);
      case "architect_get_version": return structuredClone(readVersion(key));
      case "architect_adapt_version": return createDraft(projectId, name, readVersion(key).document, { origin: key });
      default: throw new Error(`Unexpected library command: ${command}`);
    }
  };

  return { invoke, createProject, createDraft, freeze, projects, drafts, versions, delayedReads, writes };
}

let host: HTMLDivElement;
let root: Root;
const initialLibrary = useArchitectLibraryStore.getState();
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  useArchitectLibraryStore.setState(initialLibrary);
  useAgsdlStore.setState({ sessions: {} });
});

async function mount(port: ReturnType<typeof libraryPort>) {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: { invoke: port.invoke } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<><ArchitectLibraryNavigator /><ArchitectStrategyPanel /></>));
}
const click = async (selector: string) => {
  const button = document.querySelector<HTMLButtonElement>(selector);
  expect(button).not.toBeNull();
  await act(async () => button!.click());
};
const buttonByText = async (selector: string, text: string) => {
  const button = [...document.querySelectorAll<HTMLButtonElement>(selector)].find(item => item.textContent?.trim() === text);
  expect(button).toBeDefined();
  await act(async () => button!.click());
};
const fill = async (selector: string, value: string) => {
  const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
  const proto = input.tagName === "INPUT" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const pick = async (selector: string, value: string) => {
  const select = document.querySelector<HTMLSelectElement>(selector)!;
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
};
const submit = () => click('[role="dialog"] button[type="submit"]');
const panel = () => host.querySelector("aside")!;
const projectPicker = 'nav select[aria-label="Project"]';
const editDocument = () => click('aside button[aria-label="Document and definitions"]');
const newNamed = async (action: string, name: string) => {
  await click(`nav button[aria-label="${action}"]`);
  await fill('[role="dialog"] input', name);
  await submit();
};

it("creates a project without Git, saves revisioned drafts and adapts the exact older version to another project", async () => {
  const port = libraryPort();
  const destination = port.createProject("Destination");
  await mount(port);
  await newNamed("New project", "Logical project");
  const source = [...port.projects.values()].find(project => project.name === "Logical project")!;
  expect(document.querySelector<HTMLSelectElement>(projectPicker)?.value).toBe(source.id);
  await newNamed("New blueprint", "Original");
  const blueprint = [...port.drafts.values()][0];
  expect(blueprint.projectId).toBe(source.id);
  expect(JSON.parse(blueprint.document.source).contract).toBe("agsdl-0.3.0");
  expect(panel().textContent).toContain("Draft");
  expect(panel().querySelector('[aria-label="Start"]')).toBeNull();
  expect(panel().querySelector('.agsdl-runs-drawer')).toBeNull();

  await click('aside button[aria-label="Save version"]');
  await fill('[role="dialog"] textarea', "Initial baseline");
  await submit();
  const v1 = port.versions.get(blueprint.id)![0];
  expect(v1).toMatchObject({ number: 1, revision: 1, note: "Initial baseline", document: blueprint.document });

  await editDocument();
  await fill('[role="dialog"] input', "Edited draft document");
  await submit();
  expect(port.writes).toEqual([{ blueprintId: blueprint.id, expectedRevision: 1 }]);
  expect(JSON.parse(port.drafts.get(blueprint.id)!.document.source).title).toBe("Edited draft document");
  expect(panel().textContent).toContain("Edited draft document");
  await click('[role="dialog"] button[aria-label="Close"]');
  await click('aside button[aria-label="Save version"]');
  await submit();
  expect(port.versions.get(blueprint.id)?.[0]).toMatchObject({ number: 2, revision: 2, note: null });

  await buttonByText('nav [aria-label="Versions"] button', "Version 1Initial baseline");
  expect(panel().textContent).toContain("Version 1 · Read-only");
  expect(panel().textContent).toContain("Initial baseline");
  expect(panel().textContent).not.toContain("Edited draft document");
  expect(panel().querySelector('[aria-label="Save version"]')).toBeNull();
  await editDocument();
  expect(document.querySelector<HTMLInputElement>('[role="dialog"] input')?.disabled).toBe(true);
  expect(document.querySelector<HTMLInputElement>('[role="dialog"] input')?.value).toBe("Original");
  await click('[role="dialog"] button[aria-label="Close"]');

  await click('aside button[aria-label="Adapt this version"]');
  await pick('[role="dialog"] select', destination.id);
  await fill('[role="dialog"] input', "Copy of v1");
  await submit();
  const copy = [...port.drafts.values()].find(draft => draft.name === "Copy of v1")!;
  expect(copy).toMatchObject({ projectId: destination.id, origin: { blueprintId: blueprint.id, number: 1 }, document: blueprint.document });
  expect(useArchitectLibraryStore.getState().draft?.id).toBe(copy.id);
  expect(panel().textContent).toContain("Adapted from version 1");
  expect(port.versions.get(blueprint.id)![1]).toEqual(v1);
});

it("opens historical archives and their versions as read-only diagrams", async () => {
  const port = libraryPort();
  const project = port.createProject("Imported project");
  const archived = port.createDraft(project.id, "Archived system", createExampleDocument("release"), {
    archived: true, history: { status: "archived" }, conversationId: "historical-conversation",
  });
  port.freeze(archived, null);
  await mount(port);
  await pick(projectPicker, project.id);
  await click('nav [aria-label="Archives"] button[title="Archived system"]');
  expect(panel().textContent).toContain("Archived · Read-only");
  expect(panel().querySelectorAll(".agsdl-graph-node").length).toBeGreaterThan(0);
  expect(panel().querySelector('[aria-label="Save version"]')).toBeNull();
  expect(useArchitectLibraryStore.getState().draft?.conversationId).toBe("historical-conversation");
  await buttonByText('nav [aria-label="Versions"] button', "Version 1");
  expect(panel().textContent).toContain("Version 1 · Read-only");
  expect(panel().querySelector('[aria-label="Adapt this version"]')).not.toBeNull();
  await buttonByText("aside button", "Back to archive");
  expect(panel().textContent).toContain("Archived · Read-only");
});

it("keeps the selected homonym when an older read completes", async () => {
  const port = libraryPort();
  const project = port.createProject("Project");
  const first = port.createDraft(project.id, "Same name", createExampleDocument("release"));
  const second = port.createDraft(project.id, "Same name", createExampleDocument("feature"));
  const late = Promise.withResolvers<BlueprintDraft>();
  port.delayedReads.set(first.id, late.promise);
  await mount(port);
  await pick(projectPicker, project.id);
  await click(`nav button[title="Same name · ${first.id}"]`);
  expect(panel().querySelector('[role="status"]')).not.toBeNull();
  await click(`nav button[title="Same name · ${second.id}"]`);
  expect(useArchitectLibraryStore.getState().draft?.id).toBe(second.id);
  expect(panel().querySelector("[data-agsdl-blueprint]")?.getAttribute("data-agsdl-blueprint")).toBe(second.id);
  await act(async () => late.resolve(first));
  expect(useArchitectLibraryStore.getState().draft?.id).toBe(second.id);
  expect(panel().querySelector("[data-agsdl-blueprint]")?.getAttribute("data-agsdl-blueprint")).toBe(second.id);
});

it("retains local edits and refuses a new version when the stored draft revision changed", async () => {
  const port = libraryPort();
  const project = port.createProject("Project");
  const blueprint = port.createDraft(project.id, "Concurrent", createExampleDocument("feature"));
  await mount(port);
  await pick(projectPicker, project.id);
  await click('nav button[title="Concurrent"]');
  port.drafts.set(blueprint.id, { ...blueprint, revision: 2 });
  const target = { blueprintId: blueprint.id };
  act(() => useAgsdlStore.getState().edit(target, [{ op: "set", path: "/title", valueJson: '"Local edits"' }]));
  await click('aside button[aria-label="Save version"]');
  await submit();
  expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toContain("The draft changed elsewhere");
  expect(port.versions.get(blueprint.id)).toBeUndefined();
  const session = useAgsdlStore.getState().sessions[agsdlSessionKey(target)];
  expect(session.dirty).toBe(true);
  expect(JSON.parse(session.source).title).toBe("Local edits");
});

it("retries a transient title write failure in the same dialog", async () => {
  const port = libraryPort();
  const project = port.createProject("Project");
  const blueprint = port.createDraft(project.id, "Original", createExampleDocument("feature"));
  const invoke = port.invoke;
  let attempts = 0;
  port.invoke = async (command, args) => {
    if (command === "architect_save_draft" && ++attempts === 1) throw new Error("Temporary failure");
    return invoke(command, args);
  };
  await mount(port);
  await pick(projectPicker, project.id);
  await click('nav button[title="Original"]');
  await editDocument();
  await fill('[role="dialog"] input', "Renamed");
  await submit();
  expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toContain("Try again");
  await submit();
  expect(attempts).toBe(2);
  expect(JSON.parse(port.drafts.get(blueprint.id)!.document.source).title).toBe("Renamed");
  expect(document.querySelector('[role="dialog"] [role="alert"]')).toBeNull();
});

it("an intervening edit during save prevents versioning and survives a draft switch", async () => {
  const port = libraryPort();
  const project = port.createProject("Project");
  const blueprint = port.createDraft(project.id, "Original", createExampleDocument("feature"));
  port.createDraft(project.id, "Other", createExampleDocument("feature"));
  const release = Promise.withResolvers<void>();
  const invoke = port.invoke;
  port.invoke = async (command, args) => {
    if (command === "architect_save_draft") await release.promise;
    return invoke(command, args);
  };
  await mount(port);
  await pick(projectPicker, project.id);
  await click('nav button[title="Original"]');
  const target = { blueprintId: blueprint.id };
  const rename = (name: string) => useAgsdlStore.getState().edit(target, [{ op: "set", path: "/title", valueJson: JSON.stringify(name) }]);
  act(() => rename("First edit"));
  await click('aside button[aria-label="Save version"]');
  await submit();
  expect(useAgsdlStore.getState().sessions[agsdlSessionKey(target)].saving).toBe(true);
  act(() => rename("Second edit"));
  await act(async () => release.resolve());
  expect(port.versions.get(blueprint.id)).toBeUndefined();
  expect(JSON.parse(port.drafts.get(blueprint.id)!.document.source).title).toBe("First edit");
  await buttonByText('[role="dialog"] button', "Cancel");
  await click('nav button[title="Other"]');
  await click('nav button[title="Original"]');
  const session = useAgsdlStore.getState().sessions[agsdlSessionKey(target)];
  expect(session.dirty).toBe(true);
  expect(session.persistedRevision).toBe(2);
  expect(JSON.parse(session.source).title).toBe("Second edit");
});

it("requires a fresh decision after each CAS conflict and preserves edits made during the reread", async () => {
  const port = libraryPort();
  const project = port.createProject("Project");
  const blueprint = port.createDraft(project.id, "Original", createExampleDocument("feature"));
  port.createDraft(project.id, "Other", createExampleDocument("feature"));
  const target = { blueprintId: blueprint.id };
  const local = () => useAgsdlStore.getState().sessions[agsdlSessionKey(target)];
  const rename = (name: string) => useAgsdlStore.getState().edit(target, [{ op: "set", path: "/title", valueJson: JSON.stringify(name) }]);
  const external = (revision: number, title: string) => ({
    ...blueprint, revision, document: { ...blueprint.document, source: JSON.stringify({ ...JSON.parse(blueprint.document.source), title }) },
  });
  await mount(port);
  await pick(projectPicker, project.id);
  await click('nav button[title="Original"]');
  const release = Promise.withResolvers<BlueprintDraft>();
  port.delayedReads.set(blueprint.id, release.promise);
  const saved = external(2, "Saved elsewhere");
  port.drafts.set(blueprint.id, saved);
  await editDocument();
  await fill('[role="dialog"] input', "Local title");
  await submit();
  expect(local().saving).toBe(true);
  act(() => rename("Intervening edit"));
  await act(async () => release.resolve(saved));
  port.delayedReads.delete(blueprint.id);
  expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toContain("revision 1");
  expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toContain("revision read: 2");
  await click('[role="dialog"] button[aria-label="Close"]');
  await click('nav button[title="Other"]');
  await click('nav button[title="Original"]');
  expect(JSON.parse(local().source).title).toBe("Intervening edit");
  expect(port.writes.map(write => write.expectedRevision)).toEqual([1]);

  port.drafts.set(blueprint.id, external(3, "Newer saved draft"));
  await buttonByText('aside [role="alert"] button', "Apply local edits and replace saved draft");
  expect(panel().textContent).toContain("revision read: 3");
  expect(port.writes.map(write => write.expectedRevision)).toEqual([1, 2]);
  expect(JSON.parse(port.drafts.get(blueprint.id)!.document.source).title).toBe("Newer saved draft");
  await buttonByText('aside [role="alert"] button', "Apply local edits and replace saved draft");
  expect(port.writes.map(write => write.expectedRevision)).toEqual([1, 2, 3]);
  expect(local()).toMatchObject({ persistedRevision: 4, dirty: false, error: null });
  expect(JSON.parse(port.drafts.get(blueprint.id)!.document.source).title).toBe("Intervening edit");
  expect(panel().querySelector('[role="alert"]')).toBeNull();
});

it("retries a failed conflict read and can adopt the saved draft without writing", async () => {
  const port = libraryPort();
  const project = port.createProject("Project");
  const blueprint = port.createDraft(project.id, "Original", createExampleDocument("feature"));
  const target = { blueprintId: blueprint.id };
  const invoke = port.invoke;
  let failRead = false;
  port.invoke = (command, args) => command === "architect_get_draft" && failRead
    ? Promise.reject(new Error("Temporary read failure"))
    : invoke(command, args);
  await mount(port);
  await pick(projectPicker, project.id);
  await click('nav button[title="Original"]');
  port.drafts.set(blueprint.id, { ...blueprint, revision: 2 });
  failRead = true;
  await editDocument();
  await fill('[role="dialog"] input', "Local title");
  await submit();
  const local = () => useAgsdlStore.getState().sessions[agsdlSessionKey(target)];
  expect(JSON.parse(local().source).title).toBe("Local title");
  expect(local().draftConflict?.saved).toBeNull();
  failRead = false;
  await buttonByText('[role="dialog"] button', "Read saved draft");
  await buttonByText('[role="dialog"] button', "Use saved draft and discard local edits");
  expect(local()).toMatchObject({ persistedRevision: 2, dirty: false, source: blueprint.document.source });
  expect(port.writes.map(write => write.expectedRevision)).toEqual([1]);
  expect(document.querySelector('[role="dialog"] [role="alert"]')).toBeNull();
});

it("reloads a clean draft on return from a version and keeps a dirty draft", async () => {
  const port = libraryPort();
  const project = port.createProject("Project");
  const blueprint = port.createDraft(project.id, "Original", createExampleDocument("feature"));
  port.freeze(blueprint, null);
  const target = { blueprintId: blueprint.id };
  const local = () => useAgsdlStore.getState().sessions[agsdlSessionKey(target)];
  await mount(port);
  await pick(projectPicker, project.id);
  await click('nav button[title="Original"]');
  await buttonByText('nav [aria-label="Versions"] button', "Version 1");
  port.drafts.set(blueprint.id, { ...blueprint, revision: 2 });
  await buttonByText("aside button", "Back to draft");
  expect(local().persistedRevision).toBe(2);
  await buttonByText('nav [aria-label="Versions"] button', "Version 1");
  act(() => useAgsdlStore.getState().edit(target, [{ op: "set", path: "/title", valueJson: '"Dirty draft"' }]));
  port.drafts.set(blueprint.id, { ...blueprint, revision: 3 });
  await buttonByText("aside button", "Back to draft");
  expect(local()).toMatchObject({ persistedRevision: 2, dirty: true });
  expect(JSON.parse(local().source).title).toBe("Dirty draft");
});

it("ignores a delayed return-to-draft read after a newer version selection", async () => {
  const port = libraryPort();
  const project = port.createProject("Project");
  const blueprint = port.createDraft(project.id, "Original", createExampleDocument("feature"));
  port.freeze(blueprint, null);
  port.freeze(blueprint, null);
  await mount(port);
  await pick(projectPicker, project.id);
  await click('nav button[title="Original"]');
  await buttonByText('nav [aria-label="Versions"] button', "Version 1");
  const release = Promise.withResolvers<BlueprintDraft>();
  port.delayedReads.set(blueprint.id, release.promise);
  await buttonByText("aside button", "Back to draft");
  await buttonByText('nav [aria-label="Versions"] button', "Version 2");
  await act(async () => release.resolve({ ...blueprint, revision: 2 }));
  expect(useArchitectLibraryStore.getState()).toMatchObject({ versionNumber: 2, draftStatus: "idle" });
  expect(panel().textContent).toContain("Version 2");
});

it("keeps a local edit made after a return-to-draft read has started", async () => {
  const port = libraryPort();
  const project = port.createProject("Project");
  const blueprint = port.createDraft(project.id, "Original", createExampleDocument("feature"));
  port.freeze(blueprint, null);
  const target = { blueprintId: blueprint.id };
  await mount(port);
  await pick(projectPicker, project.id);
  await click('nav button[title="Original"]');
  await buttonByText('nav [aria-label="Versions"] button', "Version 1");
  const release = Promise.withResolvers<BlueprintDraft>();
  port.delayedReads.set(blueprint.id, release.promise);
  await buttonByText("aside button", "Back to draft");
  act(() => useAgsdlStore.getState().edit(target, [{ op: "set", path: "/title", valueJson: '"Edit during reload"' }]));
  await act(async () => release.resolve({ ...blueprint, revision: 2 }));
  const session = useAgsdlStore.getState().sessions[agsdlSessionKey(target)];
  expect(session).toMatchObject({ persistedRevision: 1, dirty: true, draftConflict: { saved: { revision: 2 } } });
  expect(JSON.parse(session.source).title).toBe("Edit during reload");
});

it("requires adopting the saved revision before retrying a conflicting version save on a clean draft", async () => {
  const port = libraryPort();
  const project = port.createProject("Project");
  const blueprint = port.createDraft(project.id, "Original", createExampleDocument("feature"));
  await mount(port);
  await pick(projectPicker, project.id);
  await click('nav button[title="Original"]');
  port.drafts.set(blueprint.id, { ...blueprint, revision: 2 });
  await click('aside button[aria-label="Save version"]');
  await submit();
  expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toContain("The draft changed elsewhere");
  expect(port.versions.get(blueprint.id)).toBeUndefined();
  await buttonByText('[role="dialog"] button', "Cancel");
  await buttonByText('aside [role="alert"] button', "Use saved draft and discard local edits");
  await click('aside button[aria-label="Save version"]');
  await submit();
  expect(port.versions.get(blueprint.id)?.[0].revision).toBe(2);
  expect(port.writes).toEqual([]);
});

it("accepts another title in the same dialog after explicit conflict overwrite", async () => {
  const port = libraryPort();
  const project = port.createProject("Project");
  const blueprint = port.createDraft(project.id, "Original", createExampleDocument("feature"));
  const target = { blueprintId: blueprint.id };
  const local = () => useAgsdlStore.getState().sessions[agsdlSessionKey(target)];
  const release = Promise.withResolvers<BlueprintDraft>();
  const saved = { ...blueprint, revision: 2 };
  await mount(port);
  await pick(projectPicker, project.id);
  await click('nav button[title="Original"]');
  port.drafts.set(blueprint.id, saved);
  port.delayedReads.set(blueprint.id, release.promise);
  await editDocument();
  await fill('[role="dialog"] input', "Title from the dialog");
  await submit();
  expect(local().saving).toBe(true);
  act(() => useAgsdlStore.getState().edit(target, [{ op: "set", path: "/title", valueJson: '"Intervening title"' }]));
  await act(async () => release.resolve(saved));
  await buttonByText('[role="dialog"] button', "Apply local edits and replace saved draft");
  expect(local()).toMatchObject({ persistedRevision: 3, dirty: false });
  expect(JSON.parse(port.drafts.get(blueprint.id)!.document.source).title).toBe("Intervening title");
  await fill('[role="dialog"] input', "Final title");
  await submit();
  expect(JSON.parse(port.drafts.get(blueprint.id)!.document.source).title).toBe("Final title");
  await click('[role="dialog"] button[aria-label="Close"]');
  await editDocument();
  await fill('[role="dialog"] input', "Final title after reopening");
  await submit();
  expect({ title: JSON.parse(port.drafts.get(blueprint.id)!.document.source).title,
    alert: document.querySelector('[role="dialog"] [role="alert"]')?.textContent,
    expectedRevisions: port.writes.map(write => write.expectedRevision),
  }).toEqual({ title: "Final title after reopening", alert: undefined, expectedRevisions: [1, 2, 3, 4] });
});

it("restores the exact blueprint and selected version into a fresh store", async () => {
  const port = libraryPort();
  const project = port.createProject("Local library");
  port.createDraft(project.id, "Same", createExampleDocument("release"));
  const chosen = port.createDraft(project.id, "Same", createExampleDocument("feature"), { conversationId: "feature-chat" });
  port.freeze(chosen, "Reviewed");
  await mount(port);
  await act(async () => {
    await useArchitectLibraryStore.getState().selectBlueprint(project.id, chosen.id);
    await useArchitectLibraryStore.getState().selectVersion(1);
  });
  const freshModule = "../../stores/useArchitectLibraryStore.ts?restart";
  const { useArchitectLibraryStore: fresh } = await import(freshModule) as typeof import("../../stores/useArchitectLibraryStore");
  await fresh.getState().restoreSelection();
  expect(fresh.getState()).toMatchObject({ projectId: project.id, blueprintId: chosen.id,
    draft: { conversationId: "feature-chat" }, versionNumber: 1, version: { status: "ready" } });
});
