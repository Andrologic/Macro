import { afterEach, expect, it, mock, spyOn } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ComponentDetailsDialog } from "./ComponentDetailsDialog";
import { projectViewer030 } from "../../services/agsdl/viewer030";
import { agsdlSessionKey, useAgsdlStore } from "../../stores/useAgsdlStore";

const target = { branchName: "develop", planId: "exact-ui" }, key = agsdlSessionKey(target);
const source = '{"contract":"agsdl-0.3.0","id":"example","agents":{"a":{"harness":"codex","permissions":"read-only"}}}';
let root: Root | undefined, host: HTMLDivElement;
afterEach(() => { act(() => root?.unmount()); host?.remove(); mock.restore(); useAgsdlStore.setState({ sessions: {} }); });
const mount = async (documentSource = source, path = "/agents/a") => {
 useAgsdlStore.setState({ sessions: { [key]: { source: documentSource, annexes: {}, version: "initial", persistedRevision: 1, dirty: false, saving: false, status: "draft", history: [], future: [], reports: [], error: null } } });
 host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
 const card = [...projectViewer030(documentSource).declarations, ...projectViewer030(documentSource).graphs.flatMap(graph => graph.cards)].find(card => card.path === path)!;
 await act(async () => root!.render(<ComponentDetailsDialog title="Agent" target={target} card={card} onClose={() => {}}><p>Standing instructions</p></ComponentDetailsDialog>));
 act(() => Array.from(document.body.querySelectorAll("button")).find(button => button.textContent === "Edit component")!.click());
};
const model = (name: string) => act(() => {
 const input = document.body.querySelector("fieldset input")!;
 Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,name);
 input.dispatchEvent(new Event("input",{bubbles:true}));
});
it("allows an open private model without a provider or local catalogue and preserves a stale draft", async () => {
 await mount(); model("private/model");
 expect(document.body.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
 expect(useAgsdlStore.getState().sessions[key].source).toBe(source);
 act(() => useAgsdlStore.setState(state => ({ sessions: { ...state.sessions, [key]: { ...state.sessions[key], version: "concurrent" } } })));
 await act(async () => document.body.querySelector("form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
 expect(document.body.querySelector('[role="alert"]')!.textContent).toContain("document changed");
 expect(document.body.querySelector<HTMLInputElement>("fieldset input")!.value).toBe("private/model");
 expect(useAgsdlStore.getState().sessions[key].source).toBe(source);
});
it("keeps model and effort independently optional and asks before discarding", async () => {
 await mount();
 const inputs = document.body.querySelectorAll<HTMLInputElement>("fieldset input");
 expect(inputs[0].value).toBe(""); expect(inputs[1].value).toBe("");
 model("private/model");
 act(() => Array.from(document.body.querySelectorAll<HTMLButtonElement>("footer button")).find(button => button.textContent === "Cancel")!.click());
 expect(document.body.querySelectorAll('[role="dialog"]')).toHaveLength(2);
 expect(useAgsdlStore.getState().sessions[key].source).toBe(source);
});
it("preserves unknown exact model properties while editing a model name", async () => {
 const exact = source.replace('"permissions":"read-only"', '"permissions":"read-only","model":{"future":9007199254740993}');
 useAgsdlStore.setState({ sessions: { [key]: { source: exact, annexes: {}, version: "initial", persistedRevision: 1, dirty: false, saving: false, status: "draft", history: [], future: [], reports: [], error: null } } });
 host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
 const card = projectViewer030(exact).declarations.find(item => item.path === "/agents/a")!;
 await act(async () => root!.render(<ComponentDetailsDialog title="Agent" target={target} card={card} onClose={() => {}}><p>Details</p></ComponentDetailsDialog>));
 act(() => Array.from(document.body.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent === "Edit component")!.click());
 model("private/model");
 expect(Array.from(document.body.querySelectorAll("textarea")).some(input => input.value.includes('"future":9007199254740993') && input.value.includes('"name":"private/model"'))).toBe(true);
});

function inputFor(label: string) {
 return Array.from(document.body.querySelectorAll("label")).find(item => item.querySelector("span")?.textContent === label)!.querySelector<HTMLInputElement | HTMLTextAreaElement>("input,textarea")!;
}
function fill(label: string, value: string) {
 act(() => {
  const input = inputFor(label);
  Object.getOwnPropertyDescriptor(input.tagName === "INPUT" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
 });
}
it("saves a shared standing instruction separately from a mission and exact background data", async () => {
 const documentSource = source.replace('"permissions":"read-only"', '"permissions":"read-only","instructions":"Standing orders","resources":{"brief":{"value":"Background","future":9007199254740993}}').replace(/}$/, ',"flow":{"entry":"one","steps":{"one":{"type":"agent","agent":"a","prompt":"One mission"},"two":{"type":"agent","agent":"a"}}}}');
 await mount(documentSource, "/flow/steps/one");
 const save = spyOn(useAgsdlStore.getState(), "save").mockResolvedValue(undefined);
 fill("Standing instructions", "New standing orders");
 fill("Mission text", "New mission");
 await act(async () => document.body.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
 expect(save).toHaveBeenCalledTimes(1);
 const result = useAgsdlStore.getState().sessions[key].source;
 expect(result).toContain('"instructions":"New standing orders"');
 expect(result).toContain('"prompt":"New mission"');
 expect(result).toContain('"future":9007199254740993');
 expect(result).toContain('"two":{"type":"agent","agent":"a"}');
});
it("saves a statically invalid document as a draft and keeps JSON and business fields in sync", async () => {
 await mount(source.replace('"harness":"codex",', ''));
 const save = spyOn(useAgsdlStore.getState(), "save").mockResolvedValue(undefined);
 fill("Standing instructions", "Draft instructions");
 const exact = Array.from(document.body.querySelectorAll("textarea")).find(input => input.value === '"Draft instructions"');
 expect(exact).toBeDefined();
 expect(document.body.textContent).toContain("Static checks do not authorize execution");
 expect(document.body.querySelector<HTMLButtonElement>('button[type="submit"]')!.textContent).toBe("Save draft");
 await act(async () => document.body.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
 expect(save).toHaveBeenCalledTimes(1);
 expect(useAgsdlStore.getState().sessions[key].source).toContain('"instructions":"Draft instructions"');
 expect(useAgsdlStore.getState().sessions[key].source).not.toContain('"harness"');
});
