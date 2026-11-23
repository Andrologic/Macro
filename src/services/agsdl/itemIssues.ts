import type { ProjectDiagnostic } from "../ipc/architectLibrary";

/** A problem expressed in terms of what the author sees: an agent, a step, a skill, a tool. */
export type IssueKind = "agent" | "step" | "skill" | "tool" | "content" | "document";
export type IssueView = "flow" | "agents" | "skills" | "tools";
export interface ItemIssue {
  kind: IssueKind;
  /** Logical name of the item, when it can be told. */
  name: string | null;
  /** Raw location and message. Shown on demand only. */
  technical: string;
}

export const issueView = (kind: IssueKind): IssueView =>
  kind === "agent" ? "agents" : kind === "skill" ? "skills" : kind === "tool" ? "tools" : "flow";

const unescape = (part: string) => part.replace(/~1/g, "/").replace(/~0/g, "~");
const segments = (pointer: string) => pointer.split("/").slice(1).map(unescape);
const stem = (path: string) => (path.split("/").at(-1) ?? path).replace(/\.[^.]+$/, "");

type Located = Pick<ItemIssue, "kind" | "name">;

function fromPointer(parts: string[]): Located {
  const [head, name] = parts;
  const stepAt = parts.indexOf("steps");
  if (stepAt >= 0 && (head === "flow" || head === "compositions") && parts[stepAt + 1])
    return { kind: "step", name: parts[stepAt + 1] };
  if (head === "agents" && name) return { kind: "agent", name };
  if (head === "skills" && name) return { kind: "skill", name };
  if (head === "mcpServers" && name) return { kind: "tool", name };
  if (head === "content" && name) return { kind: "content", name };
  return { kind: "document", name: null };
}

/**
 * Upgrade failures reach the interface as lines "CODE /pointer — message".
 * Lines that do not follow that shape stay readable as document-level issues.
 */
export function parseUpgradeDetails(details: string | undefined): ItemIssue[] {
  return (details ?? "").split("\n").map(line => line.trim()).filter(Boolean).map(line => {
    const match = /^\S+\s+(\/\S*)\s+—\s/.exec(line);
    return { ...(match ? fromPointer(segments(match[1])) : { kind: "document" as const, name: null }), technical: line };
  });
}

/** Project diagnostics name a file and a pointer inside it. The file says which item owns it. */
export function diagnosticIssue(diagnostic: Pick<ProjectDiagnostic, "code" | "file" | "pointer" | "message">): ItemIssue {
  const technical = [diagnostic.code, diagnostic.file && `${diagnostic.file}${diagnostic.pointer ? `#${diagnostic.pointer}` : ""}`, diagnostic.message]
    .filter(Boolean).join(" · ");
  const file = diagnostic.file ?? "";
  const folder = file.slice(0, Math.max(0, file.indexOf("/")));
  const parts = segments(diagnostic.pointer);
  let located: Located;
  if (folder === "agents") located = { kind: "agent", name: stem(file) };
  else if (folder === "skills") located = { kind: "skill", name: stem(file) };
  else if (folder === "mcp") located = { kind: "tool", name: stem(file) };
  else if ((folder === "flows" || folder === "flow") && parts.includes("steps") && parts[parts.indexOf("steps") + 1])
    located = { kind: "step", name: parts[parts.indexOf("steps") + 1] };
  else located = fromPointer(parts);
  return { ...located, technical };
}
