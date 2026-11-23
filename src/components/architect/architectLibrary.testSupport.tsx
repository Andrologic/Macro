import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ImportPreview, MacroProjectSettings, ProjectView } from "../../services/ipc/architectLibrary";

/** A preview of a small, valid system: two agents, one local tool with a secret, one external link. */
export function previewFixture(overrides: Partial<ImportPreview> = {}): ImportPreview {
  return {
    title: "Revue de code", authoredId: "revue", contract: "agsdl-0.4.0", packageFormat: "agsdl-archive-1",
    projectFormat: "agsdl-project-1", stagedSha256: "a".repeat(64), historyWillBeRemoved: false, entryPoint: "write",
    agents: {
      writer: { usage: "reachable", harness: "codex", harnessVersion: null, model: { name: "gpt-x", effort: null },
        permissions: { preset: "workspace", directories: {}, outside: null, reviewer: null, rules: [] }, mcpServers: ["github"], completionCheck: null },
      reviewer: { usage: "reachable", harness: "claude-code", harnessVersion: null, model: null,
        permissions: { preset: "read-only", directories: {}, outside: null, reviewer: null, rules: [] }, mcpServers: [], completionCheck: null },
    },
    directCalls: [],
    mcpServers: {
      github: { usage: "reachable", transport: { type: "local", command: ["node", "github.js"] }, packagedFiles: ["github.js"], requiredSecrets: ["GITHUB_TOKEN"] },
    },
    files: [{ path: "agsdl.json", size: 10, executable: false }, { path: "agents/writer.json", size: 20, executable: false }],
    externalReferences: [], warnings: [],
    ...overrides,
  };
}

export const defaultSettings: MacroProjectSettings = { schemaVersion: 1, hiddenAgentIds: [], workingFolderMode: "perExecution" };

export function projectViewFixture(source: string, overrides: Partial<ProjectView> = {}): ProjectView {
  return {
    revision: 1, files: [{ path: "agsdl.json", size: 10, executable: false }], settings: defaultSettings,
    projection: { source, origins: {} }, diagnostics: [], ...overrides,
  };
}

type Handler = (command: string, args: Record<string, unknown>) => unknown;

/** Route native commands (including the file dialogs) to a test double. */
export function installNative(handler: Handler) {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: { invoke: async (command: string, args: Record<string, unknown> = {}) => handler(command, args) },
  });
}
export const removeNative = () => { Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); };

export function createHost() {
  const host = document.createElement("div");
  document.body.append(host);
  const root: Root = createRoot(host);
  return {
    host,
    render: (element: ReactElement) => act(async () => root.render(element)),
    unmount: () => { act(() => root.unmount()); host.remove(); },
  };
}

export const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
export const click = async (element: Element | null | undefined) => {
  if (!element) throw new Error("Nothing to click");
  await act(async () => (element as HTMLElement).click());
};
export const byText = <T extends Element = HTMLButtonElement>(selector: string, text: string, scope: ParentNode = document) =>
  [...scope.querySelectorAll<T>(selector)].find(item => item.textContent?.trim() === text);
export const fillField = async (element: Element, value: string) => {
  const proto = element.tagName === "INPUT" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
export const dialogText = () => document.querySelector('[role="dialog"]')?.textContent ?? "";
