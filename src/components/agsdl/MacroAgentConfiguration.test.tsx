import { afterEach, expect, it } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AgentDetails } from "./AgentDetails";
import { ComponentDetailsDialog } from "./ComponentDetailsDialog";
import { createLegacyExample as createExample, createExample as createExample020 } from "../../services/agsdl/examples";
import { macroNativeModelEdition } from "../../services/agsdl/nativeModelEdition";
import { projectViewer } from "../../services/agsdl/viewer";
import { agsdlSessionKey, useAgsdlStore } from "../../stores/useAgsdlStore";
import { useAgsdlModelCatalogue } from "../../stores/useAgsdlModelCatalogue";
import { useProviderStore } from "../../stores/useProviderStore";

const target = { branchName: "feature/example", planId: "macro-config" };
const key = agsdlSessionKey(target);
const originalSave = useAgsdlStore.getState().save;
const originalCatalogue = useAgsdlModelCatalogue.getState();
const nativeCatalogue = { revision: "catalogue-1", models: [{ providerId: "demo-provider", modelId: "demo-model", providerName: "Demo provider", modelName: "Demo model", edition: macroNativeModelEdition("demo-provider", "demo-model") }], unavailableProviders: [] };
const originalProviders = useProviderStore.getState();
let root: Root | undefined;
let host: HTMLDivElement;
afterEach(() => {
  act(() => root?.unmount()); host?.remove();
  useAgsdlStore.setState({ sessions: {}, save: originalSave });
  useAgsdlModelCatalogue.setState(originalCatalogue);
  useProviderStore.setState({ providers: originalProviders.providers, modelsByProvider: originalProviders.modelsByProvider });
});
async function mount(source = createExample("release"), catalogue = nativeCatalogue) {
  useAgsdlModelCatalogue.setState({ catalogue, loading: false, error: undefined, load: async () => useAgsdlModelCatalogue.getState().catalogue ?? catalogue });
  useProviderStore.setState({
    providers: [{ id: "demo-provider", name: "Demo provider", status: "online" }],
    modelsByProvider: { "demo-provider": [{ id: "demo-model", name: "Demo model", provider_id: "demo-provider" }] },
  });
  useAgsdlStore.setState({ sessions: { [key]: { source, annexes: {}, version: "initial", persistedRevision: 1, dirty: false, saving: false, status: "draft", history: [], future: [], reports: [], error: null } } });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => root!.render(<ComponentDetailsDialog target={target} title="Checklist" card={projectViewer(source).graphs[0].cards[0]} onClose={() => {}}>Details</ComponentDetailsDialog>));
  act(() => document.body.querySelector<HTMLButtonElement>('button[aria-label="Edit component"]')!.click());
}
function choose(index: number, value: string) {
  act(() => {
    const select = document.body.querySelectorAll<HTMLSelectElement>(".agsdl-macro-config select")[index];
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
const submit = () => act(async () => { document.body.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });

it("saves the explicit model selection through the shared versioned edit and persistence flow", async () => {
  await mount();
  choose(0, "demo-provider"); choose(1, "demo-model");
  const original = useAgsdlStore.getState().sessions[key].source;
  let persisted = "";
  useAgsdlStore.setState({ save: async () => { persisted = useAgsdlStore.getState().sessions[key].source; } });
  expect(useAgsdlStore.getState().sessions[key].source).toBe(original);
  await submit();
  expect(JSON.parse(persisted).runtime.configurations[0].agents[0].parameters).toEqual({ providerId: "demo-provider", modelId: "demo-model" });
  expect(JSON.parse(persisted).runtime.configurations[0].agents[0].tools).toEqual([]);
  expect(document.body.querySelector("form")).toBeNull();
});

it("rejects a model selection if the agent has changed the document while the form is open", async () => {
  await mount(); choose(0, "demo-provider"); choose(1, "demo-model");
  act(() => useAgsdlStore.getState().edit(target, [{ op: "set", path: "/root/annotations/title", valueJson: '"Concurrent edit"' }], "initial"));
  const concurrent = useAgsdlStore.getState().sessions[key].source;
  await submit();
  expect(document.body.querySelector('[role="alert"]')!.textContent).toContain("document changed");
  expect(useAgsdlStore.getState().sessions[key].source).toBe(concurrent);
});

it("shows Macro provider and model names while keeping opaque parameters collapsed", async () => {
  await mount();
  const doc = JSON.parse(createExample("release"));
  doc.runtime.configurations[0].agents[0].engine = { identity: "macro/desktop", version: "1" };
  doc.runtime.configurations[0].agents[0].parameters = { providerId: "demo-provider", modelId: "demo-model", temperature: 0.5 };
  const source = JSON.stringify(doc);
  const cards = projectViewer(source).graphs[0].cards;
  await act(async () => root!.render(<AgentDetails source={source} cards={cards} card={cards[0]} onSelect={() => {}} />));
  const configuration = host.querySelector(".agsdl-runtime-settings")!;
  expect(configuration.querySelector("summary")!.textContent).toContain("Demo model");
  expect(configuration.querySelector("summary")!.textContent).toContain("Demo provider");
  expect(configuration.textContent).not.toContain("providerId");
  expect(configuration.textContent).not.toContain("modelId");
  expect(configuration.querySelector("details")!.open).toBe(false);
  act(() => useProviderStore.setState({ providers: [], modelsByProvider: {} }));
  expect(host.querySelector(".agsdl-runtime-settings summary")!.textContent).toContain("Demo model");
  act(() => useAgsdlModelCatalogue.setState({ catalogue: { ...nativeCatalogue, models: [] } }));
  expect(host.querySelector(".agsdl-runtime-settings summary")!.textContent).toContain("Unavailable locally");
  expect(host.querySelector(".agsdl-runtime-settings summary")!.textContent).toContain("demo-model");
});


it("saves an explicit 0.2 Edition and settings atomically without rewriting Engine or Tool bindings", async () => {
  const source = createExample020("release");
  const before = JSON.parse(source);
  await mount(source);
  choose(0, "demo-provider"); choose(1, "demo-model");
  let persisted = "";
  useAgsdlStore.setState({ save: async () => { persisted = useAgsdlStore.getState().sessions[key].source; } });
  await submit();
  const after = JSON.parse(persisted);
  expect(after.configurations.project.model).toEqual(macroNativeModelEdition("demo-provider", "demo-model"));
  expect(after.configurations.project.settings).toEqual({ providerId: "demo-provider", modelId: "demo-model" });
  expect(after.configurations.project.engine).toBe(before.configurations.project.engine);
  expect(after.bindings).toEqual(before.bindings);
  expect(after.agents).toEqual(before.agents);
  expect(after.flow).toEqual(before.flow);
  expect(after.runtime).toBeUndefined();
  expect(document.body.querySelector("form")).toBeNull();
});


it("edits a native 0.2 Edition and shows its declared identities when settings omit them", async () => {
  const doc = JSON.parse(createExample020("release"));
  doc.configurations.project.model = macroNativeModelEdition("demo-provider", "demo-model");
  delete doc.configurations.project.settings;
  await mount(JSON.stringify(doc));
  const selects = document.body.querySelectorAll<HTMLSelectElement>(".agsdl-macro-config select");
  expect(selects[0].value).toBe("demo-provider");
  expect(selects[1].value).toBe("demo-model");
  choose(1, "demo-model");
  let persisted = "";
  useAgsdlStore.setState({ save: async () => { persisted = useAgsdlStore.getState().sessions[key].source; } });
  await submit();
  expect(JSON.parse(persisted).configurations.project).toMatchObject({
    model: doc.configurations.project.model, settings: { providerId: "demo-provider", modelId: "demo-model" },
  });
  const source = JSON.stringify(doc), cards = projectViewer(source).graphs[0].cards;
  await act(async () => root!.render(<AgentDetails source={source} cards={cards} card={cards[0]} onSelect={() => {}} />));
  expect(host.querySelector(".agsdl-runtime-settings summary")!.textContent).toContain("Demo model");
  expect(host.querySelector(".agsdl-runtime-settings summary")!.textContent).toContain("Demo provider");
});

it("does not create a Model Edition while editing only the prompt", async () => {
  await mount(createExample020("release"));
  const textarea = document.body.querySelector<HTMLTextAreaElement>("form textarea")!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, textarea.value + " Explicit prompt change.");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  let persisted = "";
  useAgsdlStore.setState({ save: async () => { persisted = useAgsdlStore.getState().sessions[key].source; } });
  await submit();
  expect(persisted).not.toBe("");
  expect(JSON.parse(persisted).configurations.project.model).toBeUndefined();
});

it("revalidates qualification at save and keeps the draft when the native model is no longer available", async () => {
  await mount(createExample020("release")); choose(0, "demo-provider"); choose(1, "demo-model");
  const original = useAgsdlStore.getState().sessions[key].source;
  useAgsdlModelCatalogue.setState({ load: async () => ({ ...nativeCatalogue, models: [] }) });
  await submit();
  expect(useAgsdlStore.getState().sessions[key].source).toBe(original);
  expect(document.body.querySelector("form")).not.toBeNull();
  expect(document.body.querySelector('[role="alert"]')!.textContent).toContain("Unavailable");
});

it("refuses duplicate native catalogue identities without substituting a global model", async () => {
  await mount(createExample020("release")); choose(0, "demo-provider"); choose(1, "demo-model");
  const original = useAgsdlStore.getState().sessions[key].source;
  useAgsdlModelCatalogue.setState({ load: async () => ({ ...nativeCatalogue, models: [nativeCatalogue.models[0], nativeCatalogue.models[0]] }) });
  await submit();
  expect(useAgsdlStore.getState().sessions[key].source).toBe(original);
  expect(document.body.querySelector("form")).not.toBeNull();
});

it("selects only observed Codex models and saves the native Edition without replacing its engine", async () => {
  const doc=JSON.parse(createExample020("release"));
  doc.bindings[doc.configurations.project.engine].implementation={identity:"openai/codex",version:"1"};
  const before=structuredClone(doc.bindings);
  const choice={providerId:"codex-native",modelId:"synthetic-codex-model",providerName:"Codex",modelName:"Synthetic Codex model",edition:macroNativeModelEdition("codex-native","synthetic-codex-model")};
  await mount(JSON.stringify(doc),{...nativeCatalogue,models:[...nativeCatalogue.models,choice]});
  const providers=document.body.querySelectorAll<HTMLSelectElement>(".agsdl-macro-config select")[0];
  expect([...providers.options].map(option=>option.value)).toEqual(["","codex-native"]);
  choose(0,"codex-native");choose(1,"synthetic-codex-model");
  let persisted="";useAgsdlStore.setState({save:async()=>{persisted=useAgsdlStore.getState().sessions[key].source;}});
  await submit();
  const saved=JSON.parse(persisted);
  expect(saved.configurations.project.model).toEqual(choice.edition);
  expect(saved.configurations.project.settings).toEqual({providerId:"codex-native",modelId:"synthetic-codex-model"});
  expect(saved.bindings).toEqual(before);
});
