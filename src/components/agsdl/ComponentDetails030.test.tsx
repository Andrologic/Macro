import { afterEach, expect, it, mock, spyOn } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ComponentDetailsDialog } from "./ComponentDetailsDialog";
import { projectViewer030 } from "../../services/agsdl/viewer030";
import { agsdlSessionKey, useAgsdlStore } from "../../stores/useAgsdlStore";

const target = { branchName: "develop", planId: "exact-ui" }, key = agsdlSessionKey(target);
const source = '{"contract":"agsdl-0.3.0","id":"example","agents":{"a":{"harness":"codex","permissions":"read-only"}}}';
const originalSave = useAgsdlStore.getState().save;
let root: Root | undefined, host: HTMLDivElement;
afterEach(() => { act(() => root?.unmount()); host?.remove(); mock.restore(); useAgsdlStore.setState({ sessions: {}, save: originalSave }); });
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

it("locks the captured agent definition during reassignment and edits B only after reopening", async () => {
 const documentSource = JSON.stringify({ contract: "agsdl-0.3.0", id: "reassign", agents: {
  a: { harness: "codex", permissions: "read-only", instructions: "Instructions A" },
  b: { harness: "codex", permissions: "read-only", instructions: "Instructions B" },
 }, flow: { entry: "one", steps: { one: { type: "agent", agent: "a" }, other: { type: "agent", agent: "a" } } } });
 await mount(documentSource, "/flow/steps/one");
 const save = spyOn(useAgsdlStore.getState(), "save").mockResolvedValue(undefined);
 fill("Responsible agent", "b");
 expect(inputFor("Standing instructions").disabled).toBe(true);
 expect(document.body.querySelector('[role="status"]')?.textContent).toContain("Save, then reopen");
 const agentJson = Array.from(document.body.querySelectorAll("label")).find(label => label.querySelector("small")?.textContent === "/agents/a/instructions")!.querySelector("textarea")!;
 expect(agentJson.disabled).toBe(true);
 expect(document.body.querySelector<HTMLFieldSetElement>("fieldset")!.disabled).toBe(true);
 // Even an artificial event on the disabled control must not produce a patch for A.
 fill("Standing instructions", "Must not reach A");
 await act(async () => document.body.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
 const reassigned = JSON.parse(useAgsdlStore.getState().sessions[key].source);
 expect(reassigned.flow.steps.one.agent).toBe("b");
 expect(reassigned.flow.steps.other.agent).toBe("a");
 expect(reassigned.agents.a.instructions).toBe("Instructions A");
 expect(reassigned.agents.b.instructions).toBe("Instructions B");
 const currentSource = useAgsdlStore.getState().sessions[key].source;
 const card = projectViewer030(currentSource).graphs[0].cards[0];
 await act(async () => root!.render(<ComponentDetailsDialog title="Agent" target={target} card={card} onClose={() => {}}><p>Details</p></ComponentDetailsDialog>));
 act(() => document.body.querySelector<HTMLButtonElement>('[aria-label="Edit component"]')!.click());
 expect(inputFor("Standing instructions").value).toBe("Instructions B");
 expect(inputFor("Standing instructions").disabled).toBe(false);
 fill("Standing instructions", "Updated B");
 expect(inputFor("Responsible agent").disabled).toBe(true);
 await act(async () => document.body.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
 const updated = JSON.parse(useAgsdlStore.getState().sessions[key].source);
 expect(updated.agents.a.instructions).toBe("Instructions A");
 expect(updated.agents.b.instructions).toBe("Updated B");
 expect(save).toHaveBeenCalledTimes(2);
});

function typeCharacters(label: string, text: string) {
 let typed = inputFor(label).value;
 for (const character of text) {
  typed += character;
  act(() => {
   const input = inputFor(label);
   input.dispatchEvent(new KeyboardEvent("keydown", { key: character === "\n" ? "Enter" : character, bubbles: true }));
   Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, typed);
   input.dispatchEvent(new InputEvent("input", { data: character, inputType: character === "\n" ? "insertLineBreak" : "insertText", bubbles: true }));
  });
  expect(inputFor(label).value).toBe(typed);
 }
}
it("preserves Enter and blank lines while typing choices and data paths, then normalizes on save", async () => {
 const documentSource = JSON.stringify({ contract: "agsdl-0.3.0", id: "line-entry", agents: {}, flow: { entry: "vote", steps: {
  vote: { type: "join", quorum: { count: 1, accept: [] }, next: { step: "done", message: { resources: { answer: { from: [] } } } } },
  done: { type: "call", command: "echo" },
 } } });
 await mount(documentSource, "/flow/steps/vote");
 spyOn(useAgsdlStore.getState(), "save").mockResolvedValue(undefined);
 typeCharacters("Accepted choices, one per line", "yes\n\nno\n");
 typeCharacters("Selected data path, one name per line · answer", "branches\nreview\n");
 // Another field edit must not prematurely normalize the line drafts.
 fill("Work title", "Gather reviews");
 expect(inputFor("Accepted choices, one per line").value).toBe("yes\n\nno\n");
 expect(useAgsdlStore.getState().sessions[key].source).toBe(documentSource);
 await act(async () => document.body.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
 const vote = JSON.parse(useAgsdlStore.getState().sessions[key].source).flow.steps.vote;
 expect(vote.quorum.accept).toEqual(["yes", "no"]);
 expect(vote.next.message.resources.answer.from).toEqual(["branches", "review"]);
});
it("warns that a call in a reused composition changes both uses", async () => {
 const documentSource = JSON.stringify({ contract: "agsdl-0.3.0", id: "shared", agents: {},
  flow: { entry: "first", steps: { first: { type: "compose", composition: "common", next: { done: "second" } }, second: { type: "compose", composition: "common", next: { done: [] } } } },
  compositions: { common: { entry: "work", steps: { work: { type: "call", command: "echo", next: { output: "done" } } }, outputs: ["done"] } },
 });
 await mount(documentSource, "/compositions/common/steps/work");
 expect(document.body.querySelector("form")?.textContent).toContain("Changes to shared definitions also affect other components");
});

it("selects a scalar next destination from the same scope and preserves exact siblings", async () => {
 const documentSource = '{"contract":"agsdl-0.3.0","id":"scalar","future":9007199254740993,"agents":{},"flow":{"entry":"one","steps":{"one":{"type":"call","command":"echo","next":"vote","future":123456789012345678901234567890},"vote":{"type":"call","command":"echo"},"done":{"type":"call","command":"echo"}}},"compositions":{"other":{"entry":"outside","steps":{"outside":{"type":"call","command":"echo"}},"outputs":[]}}}';
 await mount(documentSource, "/flow/steps/one");
 spyOn(useAgsdlStore.getState(), "save").mockResolvedValue(undefined);
 const destination = Array.from(document.body.querySelectorAll("label")).find(label => label.querySelector("span")?.textContent === "Continue at")!.querySelector("select")!;
 expect(destination.value).toBe("vote");
 expect(Array.from(destination.options).map(option => option.value)).toEqual(["one", "vote", "done"]);
 act(() => { destination.value = "done"; destination.dispatchEvent(new Event("change", { bubbles: true })); });
 await act(async () => document.body.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
 const result = useAgsdlStore.getState().sessions[key].source;
 expect(result).toContain('"next":"done"');
 expect(result).toContain('"future":9007199254740993');
 expect(result).toContain('"future":123456789012345678901234567890');
});
