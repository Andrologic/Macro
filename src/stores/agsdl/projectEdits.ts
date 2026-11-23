import type {
  MacroProjectSettings, MacroSettingsChange, ProjectBatch, ProjectFile, ProjectFileChange,
  ProjectFileEntry, ProjectView,
} from "../../services/ipc/architectLibrary";
import { applyProjectChanges, MAX_AGSDL_BYTES } from "../../services/agsdl/document";
import { AgsdlUserError } from "../../services/agsdl/userErrors";
import type { AgsdlChange } from "../../types/agsdl";

export type ProjectOperation = ProjectFileChange | { kind: "edit"; path: string; change: AgsdlChange };

export interface FileHistoryEntry {
  forward: ProjectBatch;
  backward: ProjectBatch;
}

export interface ProjectEditState {
  /** Native view of the persisted revision. */
  saved: ProjectView;
  /** Most recent validation of the working files. */
  view: ProjectView;
  /** Last known valid graph, labelled with the persisted revision it came from. */
  graphRevision: number | null;
  graphVersion: string | null;
  buffers: ReadonlyMap<string, ProjectFile | null>;
  pending: ProjectBatch;
  past: FileHistoryEntry[];
  future: FileHistoryEntry[];
}

const utf8 = new TextEncoder();
export const byteSize = (text: string) => utf8.encode(text).byteLength;

export function batchSize({ files, settings }: ProjectBatch) {
  return files.reduce((size, file) => size + byteSize(file.path) + 1 + (file.kind === "write" ? byteSize(file.text) : 0), 0)
    + (settings ? byteSize(JSON.stringify(settings.hiddenAgentIds ?? null)) + byteSize(settings.entryMessageHint ?? "") : 0);
}

export function checkBatch(batch: ProjectBatch) {
  if (batchSize(batch) > MAX_AGSDL_BYTES || batch.files.length > 8192)
    throw new AgsdlUserError("agsdl.library.projectLimit", "Project edits exceed the 1 MiB limit.");
}

export function projectFileEntries(project: ProjectEditState): ProjectFileEntry[] {
  if (!project.pending.files.length) return project.saved.files;
  const files = new Map(project.saved.files.map(file => [file.path, file]));
  for (const change of project.pending.files) {
    const buffer = project.buffers.get(change.path);
    if (buffer) files.set(change.path, buffer.file);
    else files.delete(change.path);
  }
  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export function projectSettings(project: ProjectEditState): MacroProjectSettings {
  return { ...project.saved.settings, ...project.pending.settings };
}

export function initialProject(view: ProjectView, version: string): ProjectEditState {
  return {
    saved: view, view, graphRevision: view.projection ? view.revision : null,
    graphVersion: view.projection ? version : null,
    buffers: new Map(), pending: { files: [] }, past: [], future: [],
  };
}

function fileChange(path: string, file: ProjectFile | null): ProjectFileChange {
  if (!file) return { kind: "remove", path };
  if (file.kind !== "text") throw new AgsdlUserError("agsdl.library.opaqueFile", "This file cannot be edited as text.");
  return { kind: "write", path, text: file.text };
}

function applyFile(buffers: Map<string, ProjectFile | null>, change: ProjectFileChange) {
  if (change.kind === "remove") {
    buffers.set(change.path, null);
    return;
  }
  if (change.text.includes("\0") || new TextDecoder("utf-8", { ignoreBOM: true }).decode(utf8.encode(change.text)) !== change.text)
    throw new AgsdlUserError("agsdl.library.opaqueFile", "This file cannot be edited as UTF-8 text.");
  buffers.set(change.path, {
    kind: "text", text: change.text,
    file: { path: change.path, size: byteSize(change.text), executable: buffers.get(change.path)?.file.executable ?? false },
  });
}

export async function prepareProjectEdit(
  project: ProjectEditState, operations: ProjectOperation[], settings: MacroSettingsChange | undefined,
  read: (path: string) => Promise<ProjectFile | null>,
) {
  const buffers = new Map(project.buffers);
  const files: ProjectFileChange[] = [];
  const inverse: ProjectFileChange[] = [];
  for (const operation of operations) {
    const path = operation.path;
    const previous = buffers.has(path) ? buffers.get(path)! : await read(path);
    const undo = fileChange(path, previous);
    const next = operation.kind === "edit" ? {
      kind: "write" as const, path,
      text: previous?.kind === "text" ? applyProjectChanges(previous.text, [operation.change]) : null,
    } : operation;
    if (next.kind === "write" && next.text === null)
      throw new AgsdlUserError("agsdl.library.fileMissing", "Read an existing project file before editing it.");
    if ((next.kind === "remove" && !previous) || (next.kind === "write" && undo.kind === "write" && next.text === undo.text)) continue;
    const change: ProjectFileChange = next.kind === "remove" ? next : { ...next, text: next.text! };
    buffers.set(path, previous);
    applyFile(buffers, change);
    files.push(change);
    inverse.unshift(undo);
  }
  const currentSettings = projectSettings(project);
  const undoSettings: MacroSettingsChange | undefined = settings && {};
  if (undoSettings && settings?.hiddenAgentIds !== undefined) undoSettings.hiddenAgentIds = currentSettings.hiddenAgentIds;
  if (undoSettings && settings?.entryMessageHint !== undefined) undoSettings.entryMessageHint = currentSettings.entryMessageHint ?? null;
  return {
    buffers,
    entry: { forward: { files, settings }, backward: { files: inverse, settings: undoSettings } },
  };
}

export function historyBuffers(project: ProjectEditState, batch: ProjectBatch) {
  const buffers = new Map(project.buffers);
  for (const file of batch.files) applyFile(buffers, file);
  return buffers;
}

export function appendProjectBatch(pending: ProjectBatch, next: ProjectBatch): ProjectBatch {
  const files = [...pending.files];
  for (const file of next.files) {
    const previous = files.at(-1);
    if (file.kind === "write" && previous?.kind === "write" && previous.path === file.path) files.pop();
    files.push(file);
  }
  const settings = next.settings ? { ...pending.settings, ...next.settings } : pending.settings;
  const result = { files, settings };
  checkBatch(result);
  return result;
}

export function projectHistoryBudget(history: FileHistoryEntry[]) {
  let bytes = 0;
  return history.slice(-30).reverse().filter(entry => {
    bytes += batchSize(entry.forward) + batchSize(entry.backward);
    return bytes <= MAX_AGSDL_BYTES * 4;
  }).reverse();
}

export function localProjectEdit(view: ProjectView, change: AgsdlChange): ProjectOperation {
  for (let path = change.path; path; path = path.slice(0, path.lastIndexOf("/"))) {
    const origin = Object.hasOwn(view.projection?.origins ?? {}, path) ? view.projection?.origins[path] : undefined;
    if (origin) {
      if (!origin.pointer && path === change.path && change.op === "remove" && !path.endsWith("/harnessSettings"))
        return { kind: "edit", path: "agsdl.json", change };
      // Catalog entries in the manifest are links; use the local pointer
      // reported by Argentic, including the empty pointer in component files.
      return { kind: "edit", path: origin.file, change: { ...change, path: origin.pointer + change.path.slice(path.length) } };
    }
  }
  return { kind: "edit", path: "agsdl.json", change };
}
