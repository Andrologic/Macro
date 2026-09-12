import { afterEach, expect, it } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AgentDetails } from "./AgentDetails";
import { ComponentDetailsDialog } from "./ComponentDetailsDialog";
import { createExample } from "../../services/agsdl/examples";
import { projectViewer } from "../../services/agsdl/viewer";
import { agsdlSessionKey, useAgsdlStore } from "../../stores/useAgsdlStore";
import { useProviderStore } from "../../stores/useProviderStore";

const target = { branchName: "feature/example", planId: "macro-config" };
const key = agsdlSessionKey(target);
const originalSave = useAgsdlStore.getState().save;
const originalProviders = useProviderStore.getState();
let root: Root | undefined;
let host: HTMLDivElement;
afterEach(() => {
  act(() => root?.unmount()); host?.remove();
  useAgsdlStore.setState({ sessions: {}, save: originalSave });
  useProviderStore.setState({ providers: originalProviders.providers, modelsByProvider: originalProviders.modelsByProvider });
});
async function mount() {
  const source = createExample("release");
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
  doc.runtime.configurations[0].agents[0].engine = { identity: "macro", version: "1" };
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
  expect(host.querySelector(".agsdl-runtime-settings summary")!.textContent).toContain("Unavailable locally");
  expect(host.querySelector(".agsdl-runtime-settings summary")!.textContent).toContain("demo-model");
});
