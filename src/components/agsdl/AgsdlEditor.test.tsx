import { afterEach, describe, expect, it, spyOn, mock } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AgsdlEditor } from "./AgsdlEditor";
import { agsdlSessionKey, useAgsdlStore } from "../../stores/useAgsdlStore";
import * as chatContext from "../../services/agsdl/chatContext";
import { createExample } from "../../services/agsdl/examples";

const target = { branchName: "develop", planId: "viewer-test" };
const key = agsdlSessionKey(target);
let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  mock.restore();
  container?.remove();
  useAgsdlStore.setState({ sessions: {} });
});

describe("AgSDL viewer", () => {
  const mount = async (source = createExample("feature")) => {
    // Document validation is tested in the service suite. Keep explicitly injected
    // diagnostics stable while testing the modal's asynchronous retry behavior.
    spyOn(useAgsdlStore.getState(), "validate").mockResolvedValue(undefined);
    useAgsdlStore.setState({ sessions: { [key]: {
      source, annexes: {}, version: "v1", persistedRevision: 1,
      dirty: false, saving: false, status: "draft", history: [], future: [], reports: [], error: null,
    } } });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root!.render(<AgsdlEditor target={target} />));
  };

  it("returns from the expanded graph only after attaching context successfully", async () => {
    await mount();
    const closeExpanded = mock(() => undefined);
    const attach = spyOn(chatContext, "prepareAgsdlChatContext").mockRejectedValueOnce(new Error("Storage unavailable"));
    await act(async () => root!.render(<AgsdlEditor target={target} expanded onExpand={closeExpanded} />));
    act(() => container!.querySelector<HTMLButtonElement>(".agsdl-graph-node")!.click());
    const button = document.body.querySelector<HTMLButtonElement>('[aria-label="Attach to chat"]')!;
    await act(async () => button.click());
    expect(closeExpanded).not.toHaveBeenCalled();
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain("Storage unavailable");
    attach.mockResolvedValueOnce(undefined);
    await act(async () => button.click());
    expect(closeExpanded).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector(".agsdl-detail-modal")).toBeNull();
  });

  it("attaches a localized diagnostic through the same chat return path and preserves failures", async () => {
    await mount();
    const closeExpanded = mock(() => undefined);
    const attach = spyOn(chatContext, "prepareAgsdlChatContext").mockRejectedValueOnce(new Error("agsdl.chatConversationMissing"));
    act(() => useAgsdlStore.setState(state => ({ sessions: { [key]: { ...state.sessions[key], reports: [{ operation: "inspect", results: [{ input: "primary", unit: "test", verdict: "fail", findings: [
      { rule: "resource-rule", outcome: "fail", details: "Check this resource", location: { pointer: "/graphs/0/steps/0/resources/0" } },
      { rule: "unknown-rule", outcome: "fail", details: "Unknown location", location: { pointer: "/missing" } },
    ] }] }] } } })));
    await act(async () => root!.render(<AgsdlEditor target={target} expanded onExpand={closeExpanded} />));
    act(() => container!.querySelector<HTMLButtonElement>(".agsdl-graph-node")!.click());
    const button = [...document.body.querySelectorAll<HTMLButtonElement>(".agsdl-inspector button")].find(button => button.textContent === "Prepare correction in chat")!;
    await act(async () => button.click());
    expect(attach).toHaveBeenCalledWith(target, { path: "/graphs/0/steps/0/resources/0", title: "Specification", diagnostic: "resource-rule: Check this resource" });
    expect(closeExpanded).not.toHaveBeenCalled();
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain("Open this plan");
    attach.mockResolvedValueOnce(undefined);
    await act(async () => button.click());
    expect(closeExpanded).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector(".agsdl-detail-modal")).toBeNull();
  });

  it("separates agent prompts, input provenance and output recipients from system contracts", async () => {
    await mount();
    const nodes = [...container!.querySelectorAll<HTMLButtonElement>(".agsdl-graph-node")];
    expect(nodes).toHaveLength(3);
    expect(container!.querySelector(".is-boundary, .react-flow__edge-text")).toBeNull();
    expect(globalThis.document.body.querySelector(".agsdl-inspector")).toBeNull();
    act(() => container!.querySelector<HTMLButtonElement>(".agsdl-header-actions button")!.click());
    const overview = globalThis.document.body.querySelector(".agsdl-inspector")!;
    expect(overview.textContent).toContain("brief");
    expect(overview.textContent).toContain("context");
    expect(overview.textContent).toContain("report");
    expect(overview.querySelector(".agsdl-provenance")).toBeNull();
    act(() => nodes[0].click());
    const agentDetails = globalThis.document.body.querySelector(".agsdl-inspector")!;
    expect(agentDetails.querySelector(".agsdl-prompt")?.textContent).toBe("Clarify the request and produce acceptance criteria.");
    expect(agentDetails.querySelector(".agsdl-agent-io")?.textContent).toContain("System input");
    expect(agentDetails.querySelector(".agsdl-agent-io")?.textContent).toContain("Implementation");
    expect(agentDetails.querySelector(".agsdl-properties")).toBeNull();
  });

  it("previews a linked agent on focus and opens its modal on click without changing source", async () => {
    await mount();
    const agents = container!.querySelectorAll<HTMLButtonElement>(".agsdl-graph-node");
    act(() => agents[1].click());
    const input = document.body.querySelector<HTMLButtonElement>(".agsdl-agent-io .agsdl-reference-chip")!;
    act(() => input.focus());
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toContain("acceptance criteria");
    expect(input.getAttribute("aria-describedby")).toBe(document.body.querySelector('[role="tooltip"]')?.id ?? null);
    act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
    expect(document.body.querySelector(".agsdl-detail-modal")).not.toBeNull();
    act(() => input.click());
    expect(document.body.querySelector(".agsdl-detail-modal > header strong")?.textContent).toBe("Specification");
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
    const output = document.body.querySelector<HTMLButtonElement>(".agsdl-agent-io .agsdl-reference-chip")!;
    act(() => output.click());
    expect(document.body.querySelector(".agsdl-detail-modal > header strong")?.textContent).toBe("Implementation");
    expect(useAgsdlStore.getState().sessions[key].source).toBe(createExample("feature"));
  });

  it("keeps saved graphs quiet while preserving validation and unsaved-work notices", async () => {
    await mount();
    expect(container!.querySelector(".agsdl-status, .agsdl-graph-caption")).toBeNull();
    act(() => useAgsdlStore.setState(state => ({ sessions: { [key]: {
      ...state.sessions[key], dirty: true,
      reports: [{ operation: "validate", results: [{ input: "graph", unit: "test", verdict: "fail", findings: [
        { rule: "missing-agent", outcome: "fail", details: "Unknown agent reference", location: {} },
      ] }] }],
    } } })));
    expect(container!.querySelector('[role="status"]')).not.toBeNull();
    act(() => container!.querySelector<HTMLButtonElement>(".agsdl-header-actions button")!.click());
    expect(globalThis.document.body.querySelector(".agsdl-inspector")!.textContent).toContain("Unknown agent reference");
  });

  it("keeps an unreadable document recoverable through chat with technical details collapsed", async () => {
    await mount("{broken");
    const alert = container!.querySelector("[role=alert]")!;
    expect(alert.querySelector("p")!.textContent).toContain("AgSDL");
    expect(alert.querySelector("details")!.open).toBe(false);
    expect(alert.querySelector("details")!.textContent).toContain("Invalid JSON");
    expect(alert.querySelector("button")).toBeNull();
    expect(container!.querySelector("input, textarea")).toBeNull();
  });

  it("resets details on graph navigation and clamps the selector after agent changes", async () => {
    const document = JSON.parse(createExample("feature"));
    document.graphs.push(...["second", "third"].map(id => ({ ...structuredClone(document.graphs[0]), id })));
    await mount(JSON.stringify(document));
    const selector = container!.querySelector("select")!;
    act(() => container!.querySelector<HTMLButtonElement>(".agsdl-graph-node")!.click());
    expect(globalThis.document.body.querySelector(".agsdl-inspector")).not.toBeNull();
    act(() => { selector.value = "2"; selector.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(globalThis.document.body.querySelector(".agsdl-inspector")).toBeNull();
    document.graphs.pop();
    act(() => useAgsdlStore.getState().replace(target, JSON.stringify(document)));
    expect(selector.value).toBe("1");
  });

  it("retries saving the agent draft without reloading it", async () => {
    await mount();
    act(() => useAgsdlStore.setState(state => ({ sessions: { [key]: { ...state.sessions[key], dirty: true, error: "Save failed" } } })));
    const store = useAgsdlStore.getState();
    const save = spyOn(store, "save").mockResolvedValue();
    const load = spyOn(store, "load");
    const validate = spyOn(store, "validate").mockResolvedValue();
    try {
      await act(async () => container!.querySelector<HTMLButtonElement>("[role=alert] button")!.click());
      expect(save).toHaveBeenCalledWith(target);
      expect(load).not.toHaveBeenCalled();
      expect(validate).toHaveBeenCalledWith(target);
      expect(useAgsdlStore.getState().sessions[key].source).toBe(createExample("feature"));
    } finally { save.mockRestore(); load.mockRestore(); validate.mockRestore(); }
  });

  it("reloads a clean failed session when retrying", async () => {
    await mount();
    act(() => useAgsdlStore.setState(state => ({ sessions: { [key]: { ...state.sessions[key], error: "Validation unavailable" } } })));
    const store = useAgsdlStore.getState();
    const load = spyOn(store, "load").mockResolvedValue(store.sessions[key]);
    const validate = spyOn(store, "validate").mockResolvedValue();
    try {
      await act(async () => container!.querySelector<HTMLButtonElement>("[role=alert] button")!.click());
      expect(load).toHaveBeenCalledWith(target, true);
    } finally { load.mockRestore(); validate.mockRestore(); }
  });

  it("shows routes and missions without editing controls and delegates expansion to the shell", async () => {
    useAgsdlStore.setState({
      sessions: {
        [key]: {
          source: createExample("feature"),
          annexes: {},
          version: "v1",
          persistedRevision: 1,
          dirty: false,
          saving: false,
          status: "draft",
          history: [],
          future: [],
          reports: [],
          error: null,
        },
      },
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    let expanded = false;
    await act(async () => {
      root!.render(
        <AgsdlEditor
          target={target}
          onExpand={() => {
            expanded = true;
          }}
        />,
      );
    });
    expect(
      container.querySelector("textarea, input, select, [role=dialog]"),
    ).toBeNull();
    expect(container.textContent).not.toContain("Clarify the request and produce acceptance criteria.");
    expect(container.textContent).not.toContain("Specification · report");
    expect(container.querySelectorAll(".agsdl-graph-node")).toHaveLength(3);
    expect(globalThis.document.body.querySelector(".agsdl-inspector")).toBeNull();
    const expand = container.querySelector<HTMLButtonElement>(
      ".agsdl-viewer-header button",
    )!;
    act(() => expand.click());
    expect(expanded).toBe(true);
    const firstCard = container.querySelector<HTMLButtonElement>(
      ".agsdl-graph-node:not(.is-boundary)",
    )!;
    act(() => firstCard.click());
    expect(globalThis.document.body.querySelector(".agsdl-inspector")?.textContent).toContain("Clarify the request and produce acceptance criteria.");
    const nextNode = container.querySelectorAll<HTMLButtonElement>(".agsdl-graph-node:not(.is-boundary)")[1];
    act(() => nextNode.click());
    const nextDetails = globalThis.document.body.querySelector(".agsdl-inspector")!;
    expect(nextDetails.querySelector(".agsdl-prompt")?.textContent).toBeTruthy();
    expect(nextDetails.textContent).not.toContain("Specification · report");
    expect(useAgsdlStore.getState().sessions[key].source).toBe(createExample("feature"));
    expect(
      container.querySelector("textarea, input, [role=dialog]"),
    ).toBeNull();
  });
});
