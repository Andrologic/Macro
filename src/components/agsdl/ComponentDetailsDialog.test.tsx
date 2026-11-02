import { afterEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ComponentDetailsDialog } from "./ComponentDetailsDialog";
import { createLegacyExample, createExample } from "../../services/agsdl/examples";
import { projectViewer } from "../../services/agsdl/viewer";
import { agsdlSessionKey, useAgsdlStore } from "../../stores/useAgsdlStore";

const target = { branchName: "develop", planId: "component-edit" };
const key = agsdlSessionKey(target);
const originalSave = useAgsdlStore.getState().save;
let root: Root | undefined;
let host: HTMLDivElement;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  useAgsdlStore.setState({ sessions: {}, save: originalSave });
});
const mount = async (onClose = () => {}, source = createLegacyExample("release")) => {
  useAgsdlStore.setState({ sessions: { [key]: { source, annexes: {}, version: "initial", persistedRevision: 1, dirty: false, saving: false, status: "draft", history: [], future: [], reports: [], error: null } } });
  host = document.createElement("div"); document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<ComponentDetailsDialog target={target} title="Checklist" card={projectViewer(source).graphs[0].cards[0]} onClose={onClose}><p>Details</p></ComponentDetailsDialog>));
  act(() => document.body.querySelector<HTMLButtonElement>('button[aria-label="Edit component"]')!.click());
};
const rename = (value: string) => act(() => {
  const input = document.body.querySelector("input")!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
});
const submit = () => act(async () => { document.body.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });

describe("component detail editing", () => {
  it("saves a 0.2 literal prompt without replacing an external Engine configuration", async () => {
    const doc = JSON.parse(createExample("release"));
    doc.bindings.engine = { contract: { identity: "example/engine", version: "1" }, implementation: { identity: "example/runtime", version: "1" } };
    const source = JSON.stringify(doc);
    await mount(() => {}, source);
    act(() => {
      const input = document.body.querySelector("textarea")!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "Updated release instruction");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    useAgsdlStore.setState({ save: async () => {} });
    await submit();
    const updated = JSON.parse(useAgsdlStore.getState().sessions[key].source);
    expect(updated.agents.checklist.prompt[0].value).toBe("Updated release instruction");
    expect(updated.bindings).toEqual(doc.bindings);
    expect(updated.configurations).toEqual(doc.configurations);
    expect(updated.flow).toEqual(doc.flow);
    expect(updated.agents.checklist).not.toHaveProperty("annotations");
  });
  it("keeps edits local until saving and lets cancellation leave the source intact", async () => {
    await mount();
    const source = useAgsdlStore.getState().sessions[key].source;
    rename("Changed");
    expect(useAgsdlStore.getState().sessions[key].source).toBe(source);
    act(() => document.body.querySelector<HTMLButtonElement>("footer button")!.click());
    expect(document.body.querySelectorAll('[role="dialog"]')).toHaveLength(2);
    expect(document.body.querySelector("input")!.value).toBe("Changed");
    act(() => { Array.from(document.body.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent === "Discard changes")!.click(); });
    expect(document.body.querySelector("input")).toBeNull();
    expect(useAgsdlStore.getState().sessions[key].source).toBe(source);
  });
  it("rejects a stale form instead of overwriting an agent edit", async () => {
    await mount(); rename("Changed");
    act(() => useAgsdlStore.getState().edit(target, [{ op: "set", path: "/root/annotations/title", valueJson: '"Agent edit"' }], "initial"));
    const source = useAgsdlStore.getState().sessions[key].source;
    await submit();
    expect(document.body.querySelector('[role="alert"]')!.textContent).toContain("document changed");
    expect(useAgsdlStore.getState().sessions[key].source).toBe(source);
    expect(document.body.querySelector("input")!.value).toBe("Changed");
  });
  it("preserves a failed save and retries without applying the edit twice", async () => {
    await mount(); rename("Changed");
    let attempts = 0;
    useAgsdlStore.setState({ save: async () => { if (++attempts === 1) throw new Error("Save unavailable"); } });
    await submit();
    expect(document.body.querySelector('[role="alert"]')!.textContent).toContain("The action failed. Try again.");
    expect(document.body.textContent).not.toContain("Save unavailable");
    const version = useAgsdlStore.getState().sessions[key].version;
    expect(projectViewer(useAgsdlStore.getState().sessions[key].source).graphs[0].cards[0].title).toBe("Changed");
    await submit();
    expect(attempts).toBe(2);
    expect(useAgsdlStore.getState().sessions[key].version).toBe(version);
    expect(document.body.querySelector("form")).toBeNull();
  });
});
