import type { ProjectFileChange } from "../ipc/architectLibrary";
import type { AgsdlChange } from "../../types/agsdl";
import { object, readDocument } from "./document";

/** What an author can add by hand, without the Architect agent. */
export type NewComponentKind = "agent" | "skill" | "tool";

export interface NewComponentForm {
  name: string;
  /** Agent: what it does, in one line. Skill: when to use it (required by the skill format). */
  description: string;
  /** Agent: its standing instructions. Skill: the body of the skill. */
  instructions: string;
  harness: "codex" | "claude-code";
  access: "read-only" | "workspace";
  transport: "remote" | "local";
  /** Tool: a web address, or a program followed by its arguments. */
  address: string;
}

export const emptyNewComponent: NewComponentForm = {
  name: "", description: "", instructions: "", harness: "codex", access: "read-only", transport: "remote", address: "",
};

export type NewComponentField = "name" | "description" | "address";
export interface NewComponentIssue { field: NewComponentField; key: "empty" | "invalid" | "taken" | "url" | "command" }

const catalog = { agent: "agents", skill: "skills", tool: "mcpServers" } as const;
export const componentCatalog = (kind: NewComponentKind) => catalog[kind];

/** The identifier an author's name becomes: lower case, accents removed, words joined by "-". Empty when nothing is left. */
export function componentId(name: string): string {
  const slug = name.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64).replace(/-+$/, "");
  return /^[a-z]/.test(slug) ? slug : slug ? `item-${slug}`.slice(0, 64).replace(/-+$/, "") : "";
}

/** Identifiers already used by the assembled document, per catalog. */
export function usedComponentIds(source: string, kind: NewComponentKind): ReadonlySet<string> {
  try { return new Set(Object.keys(object(readDocument(source)[catalog[kind]]))); } catch { return new Set(); }
}

const localCommand = (address: string) => address.trim().split(/\s+/).filter(Boolean);

export function validateNewComponent(kind: NewComponentKind, form: NewComponentForm, used: ReadonlySet<string>): NewComponentIssue | undefined {
  if (!form.name.trim()) return { field: "name", key: "empty" };
  const id = componentId(form.name);
  if (!id) return { field: "name", key: "invalid" };
  if (used.has(id)) return { field: "name", key: "taken" };
  if (kind === "skill" && !form.description.trim()) return { field: "description", key: "empty" };
  if (kind === "tool") {
    const address = form.address.trim();
    if (!address) return { field: "address", key: "empty" };
    if (form.transport === "remote") {
      let url: URL | undefined;
      try { url = new URL(address); } catch { /* reported below */ }
      if (!url || !["http:", "https:"].includes(url.protocol)) return { field: "address", key: "url" };
    } else if (/["'\\]/.test(address)) return { field: "address", key: "command" };
  }
}

const set = (path: string, value: unknown): AgsdlChange => ({ op: "set", path, valueJson: JSON.stringify(value) });
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** The text of a new skill. The header is what harnesses read to know when to use it. */
function skillText(id: string, form: NewComponentForm) {
  const oneLine = (value: string) => JSON.stringify(value.replace(/\s+/g, " ").trim());
  return `---\nname: ${id}\ndescription: ${oneLine(form.description)}\n---\n\n${form.instructions.trim() ? `${form.instructions.trim()}\n` : ""}`;
}

export interface NewComponentPlan {
  id: string;
  /** Project files to write before the declaration that points to them. Empty for a document without project files. */
  files: ProjectFileChange[];
  /** Edits of the assembled document. For a project, the caller maps them to the file that declares the catalog. */
  changes: AgsdlChange[];
}

/**
 * The files and declaration for one new component. Nothing is placed in the flow:
 * the author decides where an agent takes part.
 */
export function planNewComponent(kind: NewComponentKind, form: NewComponentForm, source: string, asProject: boolean): NewComponentPlan {
  const id = componentId(form.name);
  const map = catalog[kind];
  const files: ProjectFileChange[] = [];
  let declaration: unknown;
  if (kind === "agent") {
    const definition = {
      harness: form.harness, permissions: form.access,
      ...(form.description.trim() ? { description: form.description.trim() } : {}),
      ...(form.instructions.trim() ? { instructions: form.instructions.trim() } : {}),
    };
    if (asProject) { files.push({ kind: "write", path: `agents/${id}.json`, text: json(definition) }); declaration = { file: `agents/${id}.json` }; }
    else declaration = definition;
  } else if (kind === "skill") {
    files.push({ kind: "write", path: `skills/${id}/SKILL.md`, text: skillText(id, form) });
    declaration = { uri: `skills/${id}/SKILL.md` };
  } else declaration = form.transport === "remote" ? { url: form.address.trim() } : { command: localCommand(form.address) };
  const exists = Object.hasOwn(readDocument(source), map);
  return { id, files, changes: [exists ? set(`/${map}/${id}`, declaration) : set(`/${map}`, { [id]: declaration })] };
}
