import { afterEach, expect, it } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AgentDetails } from "./AgentDetails";
import { projectViewer } from "../../services/agsdl/viewer";

let root: Root | undefined;
let host: HTMLDivElement;
afterEach(() => { act(() => root?.unmount()); host?.remove(); });
it("shows declared URI sources and keeps structured prompts and engine settings behind disclosures", async () => {
  const source = `{"contract":"agsdl-0.2.0","id":"inspection","bindings":{"engine":{"contract":{"identity":"example/engine","version":"1"},"implementation":{"identity":"example/runtime","version":"1"},"settings":{"workspace":"sandbox"}}},"configurations":{"main":{"engine":"engine","settings":{"workspace":"project"}}},"agents":{"worker":{"configuration":"main","prompt":[{"uri":"https://example.com/instructions.md","mediaType":"text/markdown"},{"value":{"limit":9007199254740993}}],"resources":{"diagram":{"uri":"https://example.com/diagram.png","mediaType":"image/png"}}}}}`;
  const viewer = projectViewer(source);
  const selections: string[] = [];
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => root!.render(<AgentDetails card={viewer.declarations[0]} cards={viewer.declarations} source={source} onSelect={path => selections.push(path)} />));
  expect(host.textContent).toContain("https://example.com/instructions.md");
  expect(host.textContent).toContain("https://example.com/diagram.png");
  expect(host.textContent).not.toContain("No mission declared");
  expect(host.textContent).not.toContain("Source not specified");
  const structured = host.querySelector<HTMLDetailsElement>(".agsdl-source-structured")!;
  expect(structured.open).toBe(false);
  act(() => structured.querySelector<HTMLElement>("summary")!.click());
  expect(structured.open).toBe(true);
  expect(structured.querySelector("pre")!.textContent).toBe('{"limit":9007199254740993}');
  const configuration = host.querySelector<HTMLDetailsElement>(".agsdl-runtime-settings")!;
  expect(configuration.open).toBe(false);
  act(() => configuration.querySelector<HTMLElement>("summary")!.click());
  const engineSettings = configuration.querySelector<HTMLDetailsElement>("details")!;
  expect(engineSettings.open).toBe(false);
  act(() => engineSettings.querySelector<HTMLElement>("summary")!.click());
  expect(engineSettings.textContent).toContain("sandbox");
  expect(configuration.querySelector(".agsdl-configuration-values")!.textContent).toContain("sandbox");
  act(() => configuration.querySelector<HTMLButtonElement>(".agsdl-reference-chip")!.click());
  expect(selections).toEqual(["/bindings/engine"]);
});


it("shows the agent response and its real successor without inventing a named result", async () => {
  const source = JSON.stringify({ contract: "agsdl-0.2.0", id: "response-flow", bindings: {}, configurations: {},
    agents: { worker: { configuration: "main", interface: { results: {} } } },
    flow: { entry: "ask", steps: { ask: { type: "agent", agent: "worker", next: ["relay"], onError: ["failed"] },
      relay: { type: "prepare", message: {} }, failed: { type: "prepare", message: {} } } } });
  const viewer = projectViewer(source);
  const cards = viewer.graphs[0].cards;
  const selections: string[] = [];
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => root!.render(<AgentDetails card={cards[0]} cards={cards} source={source} onSelect={path => selections.push(path)} />));
  const outputs = host.querySelectorAll(".agsdl-agent-io section")[1]!;
  expect(outputs.textContent).toContain("Response");
  expect(outputs.textContent).not.toContain("No outputs declared");
  expect(outputs.textContent).toContain("relay");
  expect(outputs.textContent).not.toContain("failed");
  act(() => outputs.querySelector<HTMLButtonElement>("button")!.click());
  expect(selections).toEqual(["/flow/steps/relay"]);
  await act(async () => root!.render(<AgentDetails card={cards[2]} cards={cards} source={source} onSelect={() => {}} />));
  expect(host.querySelectorAll(".agsdl-agent-io section")[1]!.textContent).not.toContain("Response");
});


it("shows Message and Response for a graphless Agent without inventing a source or recipient", async () => {
  const source = JSON.stringify({ contract: "agsdl-0.2.0", id: "messages", bindings: {}, configurations: {}, agents: { worker: { configuration: "main", prompt: [], interface: { results: {} } } } });
  const viewer = projectViewer(source);
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => root!.render(<AgentDetails card={viewer.declarations.find(card => card.path === "/agents/worker")!} cards={viewer.declarations} source={source} onSelect={() => {}} />));
  const [inputs, outputs] = host.querySelectorAll(".agsdl-agent-io section");
  expect(inputs!.textContent).toContain("Message");
  expect(inputs!.textContent).not.toContain("No inputs declared");
  expect(inputs!.querySelector("button")).toBeNull();
  expect(outputs!.textContent).toContain("Response");
  expect(outputs!.querySelector("button")).toBeNull();
});
